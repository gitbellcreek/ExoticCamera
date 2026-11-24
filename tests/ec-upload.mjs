/* Exotic Camera's upload engine with full-size photos, against a simulated
   feature service. Node only, no network: the real js/arcgis.js and
   js/config.js drive a fake service that can drop the connection mid-photo,
   lose a reply, forget a half-sent upload, or be left locked by a page that
   was closed. A photo over 1.5 MB goes up in 1 MB pieces and resumes from the
   piece it stopped at; a small one still goes in one request. Whatever
   happens: one point, one copy of the photo, every byte intact. */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fail = (m) => { console.log('  FAIL', m); process.exitCode = 1; };
const ok = (m) => console.log('  ok  ', m);
const SVC = 'https://services.example.com/arcgis/rest/services/Iphone_Images/FeatureServer';
const MB = 1024 * 1024;

function makeService() {
  const S = { points: [], attachments: [], uploads: new Map(), calls: [], lose: [], drop: [] };
  let oid = 1, aid = 1, up = 1;
  const META = { objectIdField: 'OBJECTID', globalIdField: 'GlobalID', hasAttachments: true, supportsAttachmentsByUploadId: true,
    geometryType: 'esriGeometryPoint', fields: [{ name: 'OBJECTID', type: 'esriFieldTypeOID' }, { name: 'GlobalID', type: 'esriFieldTypeGlobalID' }] };
  const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const err = (d) => ({ error: { code: 400, message: '', details: [d] } });
  S.fetch = async (url, init) => {
    const u = String(url), body = init && init.body;
    const p = body instanceof FormData ? Object.fromEntries([...body.entries()].filter(([k]) => k !== 'file' && k !== 'attachment'))
      : Object.fromEntries(new URLSearchParams(body ? String(body) : ''));
    const op = u.replace(SVC, '');
    S.calls.push(op);
    const trip = (list) => { const i = list.findIndex((re) => re.test(op)); if (i >= 0) { list.splice(i, 1); return true; } return false; };
    if (trip(S.drop)) throw new TypeError('Load failed');
    let reply;
    if (op === '/0') reply = META;
    else if (op === '/0/applyEdits') {
      const out = { addResults: [] };
      for (const f of JSON.parse(p.adds || '[]')) {
        const gid = f.attributes.GlobalID;
        if (gid && S.points.some((x) => x.gid === gid)) { out.addResults.push({ success: false, error: { description: 'duplicate key GlobalID' } }); continue; }
        const row = { oid: oid++, gid }; S.points.push(row); out.addResults.push({ objectId: row.oid, success: true });
      }
      reply = out;
    } else if (op === '/0/query') {
      const m = /= '([^']+)'/.exec(p.where || '');
      reply = { objectIds: S.points.filter((x) => m && x.gid === m[1]).map((x) => x.oid) };
    } else if (op === '/uploads/register') {
      const id = 'up' + up++; S.uploads.set(id, { parts: new Map(), name: p.itemName }); reply = { success: true, item: { itemID: id } };
    } else if (/^\/uploads\/[^/]+\/uploadPart$/.test(op)) {
      const u2 = S.uploads.get(op.split('/')[2]);
      if (!u2) reply = err('Unable to upload item.');
      else { u2.parts.set(+p.partId, Buffer.from(await body.get('file').arrayBuffer())); reply = { success: true }; }
    } else if (/^\/uploads\/[^/]+\/commit$/.test(op)) {
      const u2 = S.uploads.get(op.split('/')[2]);
      const ids = String(p.parts).split(',').map(Number);
      if (!u2 || ids.some((n) => !u2.parts.has(n))) reply = err('Unable to commit uploaded items.');
      else { u2.bytes = Buffer.concat(ids.map((n) => u2.parts.get(n))); u2.committed = true; reply = { success: true, item: { committed: true } }; }
    } else if (/^\/0\/\d+\/addAttachment$/.test(op)) {
      const parent = +op.split('/')[2];
      let bytes, how, u2name;
      if (p.uploadId) {
        const u2 = S.uploads.get(p.uploadId);
        if (!u2 || !u2.committed) { reply = err('Unable to add attachment, the following Upload IDs are invalid: ' + p.uploadId); }
        else { bytes = u2.bytes; how = 'pieces'; u2name = u2.name; S.uploads.delete(p.uploadId); }   // the attachment takes the upload's name
      } else { bytes = Buffer.from(await body.get('attachment').arrayBuffer()); how = 'one request'; }
      if (bytes) {
        const name = body instanceof FormData ? body.get('attachment').name : u2name;
        const row = { id: aid++, parent, bytes, how, name }; S.attachments.push(row);
        reply = { addAttachmentResult: { objectId: row.id, success: true } };
      }
    } else if (/^\/0\/\d+\/attachments$/.test(op)) {
      const parent = +op.split('/')[2];
      reply = { attachmentInfos: S.attachments.filter((a) => a.parent === parent).map((a) => ({ id: a.id, name: a.name || 'x' })) };
    } else reply = { error: { code: 400, message: 'unexpected ' + op } };
    if (trip(S.lose)) throw new TypeError('Load failed');
    return json(reply);
  };
  return S;
}

function makeStore() {
  const kv = new Map(), rows = new Map(), photos = new Map();
  const clone = (o) => (o ? structuredClone(o) : o);
  return {
    uuid: () => crypto.randomUUID(),
    get: async (k) => (kv.has(k) ? clone(kv.get(k)) : null),
    set: async (k, v) => void kv.set(k, clone(v)),
    del: async (k) => void kv.delete(k),
    takeLock: async (key, ttl, owner) => {
      const cur = kv.get(key);
      if (cur && cur.until > Date.now() && cur.owner !== owner) return false;
      kv.set(key, { owner, until: Date.now() + ttl }); return true;
    },
    releaseLock: async (key, owner) => { const cur = kv.get(key); if (!cur || cur.owner === owner) kv.delete(key); },
    add: async (item, blob) => { item.hasPhoto = !!blob; rows.set(item.id, clone(item)); if (blob) photos.set(item.id, blob); return item; },
    item: async (id) => clone(rows.get(id)),
    all: async () => [...rows.values()].map(clone),
    outstanding: async () => [...rows.values()].filter((r) => r.state !== 'sent').map(clone),
    patch: async (id, ch) => { const r = rows.get(id); if (r) Object.assign(r, clone(ch)); return clone(r); },
    photo: async (id) => photos.get(id) || null,
  };
}

async function setup(sizes) {
  const service = makeService();
  const Store = makeStore();
  const sb = { console, fetch: service.fetch, FormData, Blob, Response, URLSearchParams, TextEncoder, btoa, Date, Math, JSON, Promise,
    Error, TypeError, String, Number, Object, Array, isFinite, parseInt, setTimeout, clearTimeout, setInterval, clearInterval,
    AbortController, crypto: globalThis.crypto, location: { origin: 'https://example.github.io', pathname: '/ExoticCamera/', href: 'https://example.github.io/ExoticCamera/' } };
  sb.self = sb; sb.Store = Store;
  vm.createContext(sb);
  for (const f of ['js/config.js', 'js/arcgis.js']) vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sb, { filename: f });
  await sb.Config.load();
  await sb.Config.save({ serviceUrl: SVC, layerId: 0 });
  await Store.set('auth', { mode: 'manual', token: 't', expires: Date.now() + 3600e3, username: 'test' });
  const blobs = {};
  for (const [i, size] of sizes.entries()) {
    const id = Store.uuid(), bytes = crypto.randomBytes(size);
    blobs[id] = bytes;
    await Store.add({ id, createdAt: Date.now() + i, lat: 27.9, lon: -82.4, heading: 90, state: 'pending', full: size > MB,
      filename: 'photo_' + i + '.jpg', serviceUrl: SVC, layerId: 0 }, new Blob([bytes], { type: 'image/jpeg' }));
  }
  return { service, app: sb, Store, blobs };
}

const flush = (app) => app.Arc.flush(() => {}, { force: true });
async function settle(app, n = 6) { let s; for (let i = 0; i < n; i++) { s = await flush(app); if (!(await app.Store.outstanding()).length) break; } return s; }
async function intact(service, Store, blobs) {
  const rows = await Store.all();
  return rows.every((r) => { const a = service.attachments.find((x) => x.id === r.attachmentId); return a && Buffer.compare(a.bytes, blobs[r.id]) === 0; });
}
const parts = (service) => service.calls.filter((c) => c.endsWith('/uploadPart')).length;

console.log('\n== a standard-size photo still goes in one request');
{
  const { service, app, Store, blobs } = await setup([500 * 1024]);
  await settle(app);
  if (service.attachments.length !== 1 || service.attachments[0].how !== 'one request') fail('expected one plain attachment: ' + JSON.stringify(service.attachments.map((a) => a.how)));
  else if (!await intact(service, Store, blobs)) fail('bytes changed'); else ok('one request, every byte intact');
}

console.log('\n== a full-size photo goes in 1 MB pieces');
{
  const { service, app, Store, blobs } = await setup([5 * MB + 12345]);
  const seen = [];
  await app.Arc.flush((type, item, p) => { if (type === 'progress') seen.push(p.done + '/' + p.total); }, { force: true });
  if (service.attachments.length !== 1 || service.attachments[0].how !== 'pieces') fail('not sent in pieces');
  else ok('sent in pieces: ' + parts(service) + ' of them');
  if (!await intact(service, Store, blobs)) fail('bytes changed'); else ok('every byte of the 5 MB photo intact');
  if (seen.join(' ') !== '0/6 1/6 2/6 3/6 4/6 5/6 6/6') fail('progress: ' + seen.join(' ')); else ok('progress reported piece by piece: ' + seen.join(' '));
  if (service.uploads.size) fail('upload left behind on the service'); else ok('nothing left behind on the service');
  const r = (await Store.all())[0];
  if (r.uploadId || (r.upParts || []).length) fail('the row kept its upload bookkeeping'); else ok('the row is tidy once it is up');
}

console.log('\n== the connection drops in the middle of a full-size photo');
{
  const { service, app, Store, blobs } = await setup([5 * MB]);
  let n = 0; const real = service.fetch;
  app.fetch = async (u, i) => { if (String(u).endsWith('/uploadPart') && ++n === 3) throw new TypeError('Load failed'); return real(u, i); };
  const s1 = await flush(app);
  if (!s1.offline) fail('a dropped connection should stop the drain'); else ok('the drain stops when the connection goes');
  const mid = (await Store.all())[0];
  if (JSON.stringify(mid.upParts) !== '[1,2]') fail('pieces recorded: ' + JSON.stringify(mid.upParts)); else ok('pieces 1 and 2 are recorded as done');
  app.fetch = real;
  const before = parts(service);
  await settle(app);
  if (parts(service) - before !== 3) fail(`resume sent ${parts(service) - before} pieces, expected 3`); else ok('the next try sends only pieces 3 to 5');
  if (service.attachments.length !== 1 || !await intact(service, Store, blobs)) fail('not one intact photo'); else ok('one photo, intact');
}

console.log('\n== the app is closed mid-photo, leaving its upload lock behind');
{
  const { service, app, Store, blobs } = await setup([4 * MB]);
  let n = 0; const real = service.fetch;
  app.fetch = async (u, i) => { if (String(u).endsWith('/uploadPart') && ++n === 2) throw new Error('page killed'); return real(u, i); };
  await flush(app).catch(() => {});
  app.fetch = real;
  const r = (await Store.all())[0];
  await Store.patch(r.id, { state: 'uploading' });
  await Store.set('flushLock', { owner: 'the-page-that-was-closed', until: Date.now() + 5 * 60000 });
  if (!(await flush(app)).locked) fail('the leftover lock should block until startup clears it'); else ok('the leftover lock blocks uploads (as the field saw)');
  await app.Arc.reclaimStranded();
  if ((await flush(app)).locked) fail('reopening did not free the queue'); else ok('reopening the app frees the queue at once');
  await settle(app);
  if (service.attachments.length !== 1 || !await intact(service, Store, blobs)) fail('not one intact photo after resuming'); else ok('the photo resumes and arrives once, intact');
  if (service.points.length !== 1) fail(service.points.length + ' points'); else ok('still one point');
}

console.log('\n== the service forgets a half-sent upload');
{
  const { service, app, Store, blobs } = await setup([3 * MB]);
  let n = 0; const real = service.fetch;
  app.fetch = async (u, i) => { if (String(u).endsWith('/uploadPart') && ++n === 2) { service.uploads.clear(); throw new TypeError('Load failed'); } return real(u, i); };
  await flush(app);
  app.fetch = real;
  await flush(app);                                  // "Unable to upload item." → the photo starts again
  const mid = (await Store.all())[0];
  if (mid.uploadId) fail('kept a dead upload id'); else ok('a dead upload is dropped: ' + mid.lastError);
  await settle(app);
  if (service.attachments.length !== 1 || !await intact(service, Store, blobs)) fail('did not recover with one intact photo'); else ok('starts the photo again and it arrives intact');
}

console.log('\n== the reply to the attach is lost');
{
  const { service, app, Store, blobs } = await setup([3 * MB]);
  service.lose.push(/\/addAttachment$/);
  await settle(app);
  if (service.attachments.length !== 1) fail(service.attachments.length + ' attachments — the retry attached it twice'); else ok('still one copy of the photo');
  if (!await intact(service, Store, blobs)) fail('bytes changed'); else ok('and it is intact');
}

console.log('\n== a drainer that goes quiet lets the lock lapse');
{
  const { app, Store } = await setup([100]);
  await Store.takeLock('flushLock', 60000, 'someone-else');
  if (!(await flush(app)).locked) fail('a held lock should block'); else ok('a live drainer holds the queue (one-minute lock)');
  await Store.set('flushLock', { owner: 'someone-else', until: Date.now() - 1 });
  if ((await flush(app)).locked) fail('an expired lock still blocks'); else ok('once it stops renewing, the next drain goes ahead');
}

console.log(process.exitCode ? '\nFAILED' : '\nfull-size uploads hold up');
process.exit(process.exitCode || 0);
