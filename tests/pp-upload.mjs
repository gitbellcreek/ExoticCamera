/* Photo Points' upload engine against a simulated feature service. Node only,
   no network. The real photopoints/js/arc.js drives a fake service that can
   apply an edit and lose the reply, drop the connection mid-photo, or forget
   a half-sent upload — the things a field connection does. Whatever happens:
   one visit, one copy of each photo, every byte intact, and a resumed upload
   carries on from the chunk it stopped at. */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fail = (m) => { console.log('  FAIL', m); process.exitCode = 1; };
const ok = (m) => console.log('  ok  ', m);

const SVC = 'https://services.example.com/arcgis/rest/services/Photo_Monitoring/FeatureServer';
const norm = (g) => String(g || '').replace(/[{}]/g, '').toLowerCase();

/* ── the simulated service ─────────────────────────────────────────── */
function makeService() {
  const S = {
    stations: [], visits: [], attachments: [], uploads: new Map(),
    lose: [], drop: [], calls: [],
  };
  let oid = 1, aid = 1, up = 1;
  const meta = (fields) => ({ objectIdField: 'OBJECTID', globalIdField: 'GlobalID', fields });
  const F = (name, type, length) => ({ name, type: 'esriFieldType' + type, length });
  const STATION_META = meta([F('OBJECTID', 'OID'), F('GlobalID', 'GlobalID'), F('StationID', 'String', 25), F('PostInstalled', 'String', 3), F('Notes', 'String', 1000)]);
  const VISIT_META = meta([F('OBJECTID', 'OID'), F('GlobalID', 'GlobalID'), F('StationGUID', 'GUID'), F('StationID', 'String', 25),
    F('VisitDate', 'Date'), F('Observer', 'String', 100), F('Notes', 'String', 1000)]);
  const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const err = (details) => ({ error: { code: 400, message: '', details: [details] } });

  function edits(table, metaFor, p) {
    const out = { addResults: [], updateResults: [], deleteResults: [] };
    for (const f of JSON.parse(p.adds || '[]')) {
      const gid = f.attributes.GlobalID;
      if (table.some(r => norm(r.gid) === norm(gid))) {
        out.addResults.push({ objectId: -1, success: false, error: { code: 1000, description: "Cannot insert duplicate key row ... GlobalID. The duplicate key value is (" + norm(gid) + ")." } });
        continue;
      }
      const row = { oid: oid++, gid, attrs: f.attributes, geometry: f.geometry };
      table.push(row);
      out.addResults.push({ objectId: row.oid, globalId: gid, success: true });
    }
    for (const f of JSON.parse(p.updates || '[]')) {
      const row = table.find(r => norm(r.gid) === norm(f.attributes.GlobalID));
      if (!row) { out.updateResults.push({ success: false, error: { code: 1019, description: 'not found' } }); continue; }
      Object.assign(row.attrs, f.attributes);
      out.updateResults.push({ objectId: row.oid, success: true });
    }
    if (p.attachments) {
      out.attachments = { addResults: [] };
      for (const a of JSON.parse(p.attachments).adds || []) {
        if (S.attachments.some(x => norm(x.gid) === norm(a.globalId))) {
          out.attachments.addResults.push({ objectId: -1, globalId: a.globalId, success: false,
            error: { code: 0, description: "Cannot insert duplicate key row ... AttachmentGlobalID" } });
          continue;
        }
        const u = S.uploads.get(a.uploadId);
        if (!u || !u.committed) return err('Unable to update the attachments, the following Upload IDs are invalid: ' + a.uploadId + '.');
        const parent = S.visits.find(v => norm(v.gid) === norm(a.parentGlobalId));
        const row = { id: aid++, gid: a.globalId, parent: parent && parent.oid, name: a.name, keywords: a.keywords, bytes: u.bytes };
        S.attachments.push(row);
        S.uploads.delete(a.uploadId);                 // the service consumes the upload
        out.attachments.addResults.push({ objectId: row.id, globalId: a.globalId, success: true });
      }
    }
    return out;
  }

  S.fetch = async (url, init) => {
    const u = String(url);
    const body = init && init.body;
    const p = body instanceof FormData ? Object.fromEntries([...body.entries()].filter(([k]) => k !== 'file'))
      : Object.fromEntries(new URLSearchParams(body ? String(body) : ''));
    const op = u.replace(SVC, '');
    S.calls.push(op);
    const trip = (list) => { const i = list.findIndex(re => re.test(op)); if (i >= 0) { list.splice(i, 1); return true; } return false; };
    if (trip(S.drop)) throw new TypeError('Load failed');              // never reached the server
    let reply;
    if (op === '/0') reply = STATION_META;
    else if (op === '/1') reply = VISIT_META;
    else if (op === '/uploads/register') { const id = 'up' + (up++); S.uploads.set(id, { parts: new Map() }); reply = { success: true, item: { itemID: id } }; }
    else if (/^\/uploads\/[^/]+\/uploadPart$/.test(op)) {
      const id = op.split('/')[2], u2 = S.uploads.get(id);
      if (!u2) reply = err('Unable to upload item.');
      else { u2.parts.set(+p.partId, Buffer.from(await body.get('file').arrayBuffer())); reply = { success: true }; }
    } else if (/^\/uploads\/[^/]+\/commit$/.test(op)) {
      const id = op.split('/')[2], u2 = S.uploads.get(id);
      if (!u2) reply = err('Unable to commit uploaded items.');
      else {
        const ids = String(p.parts).split(',').map(Number);
        if (ids.some(n => !u2.parts.has(n))) reply = err('Unable to commit uploaded items.');
        else { u2.bytes = Buffer.concat(ids.map(n => u2.parts.get(n))); u2.committed = true; reply = { success: true, item: { committed: true } }; }
      }
    } else if (/^\/uploads\/[^/]+\/delete$/.test(op)) { S.uploads.delete(op.split('/')[2]); reply = { success: true }; }
    else if (op === '/0/applyEdits') reply = edits(S.stations, STATION_META, p);
    else if (op === '/1/applyEdits') reply = edits(S.visits, VISIT_META, p);
    else if (op === '/0/query' || op === '/1/query') {
      const t = op[1] === '0' ? S.stations : S.visits;
      const m = /GlobalID = '([^']+)'/.exec(p.where || '');
      reply = { objectIds: t.filter(r => m && norm(r.gid) === norm(m[1])).map(r => r.oid) };
    } else if (op === '/1/queryAttachments') {
      const ids = String(p.objectIds).split(',').map(Number);
      reply = { attachmentGroups: ids.map(id => ({ parentObjectId: id,
        attachmentInfos: S.attachments.filter(a => a.parent === id).map(a => ({ id: a.id, globalId: norm(a.gid), name: a.name, keywords: a.keywords })) })) };
    } else reply = { error: { code: 400, message: 'unexpected ' + op } };
    if (trip(S.lose)) throw new TypeError('Load failed');              // applied — but the answer never came back
    return json(reply);
  };
  return S;
}

/* ── an in-memory stand-in for photopoints/js/store.js ─────────────── */
function makeStore() {
  const kv = new Map(), visits = new Map(), shots = new Map(), photos = new Map(), edits = new Map();
  const clone = (o) => (o ? structuredClone(o) : o);
  const patch = (m) => async (id, ch) => { const r = m.get(id); if (!r) return undefined; Object.assign(r, clone(ch)); return clone(r); };
  return {
    uuid: () => crypto.randomUUID(),
    guid: () => '{' + crypto.randomUUID().toUpperCase() + '}',
    get: async (k) => (kv.has(k) ? clone(kv.get(k)) : null),
    set: async (k, v) => void kv.set(k, clone(v)),
    del: async (k) => void kv.delete(k),
    takeLock: async (key, ttl, owner) => {
      const cur = kv.get(key);
      if (cur && cur.until > Date.now() && cur.owner !== owner) return false;
      kv.set(key, { owner, until: Date.now() + ttl }); return true;
    },
    releaseLock: async (key, owner) => { const cur = kv.get(key); if (!cur || cur.owner === owner) kv.delete(key); },
    putVisit: async (v) => (visits.set(v.id, clone(v)), v),
    visit: async (id) => clone(visits.get(id)),
    visits: async () => [...visits.values()].map(clone),
    patchVisit: patch(visits),
    addShot: async (s, blob) => { s.hasPhoto = !!blob; shots.set(s.id, clone(s)); if (blob) photos.set(s.id, blob); return s; },
    shot: async (id) => clone(shots.get(id)),
    shots: async () => [...shots.values()].map(clone),
    shotsOf: async (vid) => [...shots.values()].filter(s => s.visitId === vid).sort((a, b) => a.createdAt - b.createdAt).map(clone),
    patchShot: patch(shots),
    photo: async (id) => photos.get(id) || null,
    putEdit: async (e) => (edits.set(e.id, clone(e)), e),
    edits: async () => [...edits.values()].map(clone),
    patchEdit: patch(edits),
    removeEdit: async (id) => void edits.delete(id),
  };
}

function makeApp(service) {
  const Store = makeStore();
  const sb = { console, fetch: service.fetch, FormData, Blob, Response, URLSearchParams, TextEncoder, btoa, Date, Math, JSON,
    Promise, Error, TypeError, String, Number, Object, Array, isFinite, parseInt, setTimeout, clearTimeout, AbortController,
    crypto: globalThis.crypto, location: { origin: 'https://example.github.io', pathname: '/x/photopoints/' } };
  sb.self = sb;
  sb.Store = Store;
  vm.createContext(sb);
  for (const f of ['photopoints/js/config.js', 'photopoints/js/arc.js']) vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sb, { filename: f });
  return sb;
}

const PART = 256 * 1024;
function photoBytes(n, seed) {
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31 + seed * 7) & 0xff;
  return b;
}

async function setup({ shots = 3, size = 600 * 1024, stationPending = false } = {}) {
  const service = makeService();
  const app = makeApp(service);
  const { Config, Store } = app;
  await Config.load();
  await Config.save({ serviceUrl: SVC, partKB: PART / 1024 });
  await Store.set('auth', { mode: 'manual', token: 't', expires: Date.now() + 3600e3, username: 'test' });
  const stationGid = Store.guid();
  if (stationPending) {
    await Store.putEdit({ id: Store.uuid(), kind: 'add', globalId: stationGid, lat: 27.84, lon: -82.3, createdAt: Date.now() - 10,
      attrs: { StationID: 'NEW-01', PostInstalled: 'No' }, state: 'pending' });
  } else {
    service.stations.push({ oid: 900, gid: stationGid, attrs: { StationID: 'Test' } });
  }
  const visit = { id: Store.uuid(), globalId: Store.guid(), stationGid, stationId: 'Test', createdAt: Date.now(), state: 'queued',
    attrs: { VisitDate: Date.now(), Observer: 'robot', Notes: 'sim', NotAField: 'dropped' } };
  await Store.putVisit(visit);
  const blobs = {};
  for (let i = 0; i < shots; i++) {
    const id = Store.uuid();
    const bytes = photoBytes(size + i * 1000, i);
    blobs[id] = bytes;
    await Store.addShot({ id, visitId: visit.id, slot: ['N', 'E', 'S', 'W'][i % 4], createdAt: Date.now() + i,
      name: 'Test_' + ['N', 'E', 'S', 'W'][i % 4] + '_' + i + '.jpg', attGlobalId: Store.guid(), state: 'pending', size: bytes.length },
      new Blob([bytes], { type: 'image/jpeg' }));
  }
  return { service, app, visit, blobs, stationGid };
}

const flush = (app, force = true) => app.Arc.flush(() => {}, { force });
async function settle(app, tries = 6) {
  let last;
  for (let i = 0; i < tries; i++) {
    last = await flush(app);
    const shots = await app.Store.shots();
    const vs = await app.Store.visits();
    if (vs.every(v => v.state === 'sent') && shots.every(s => s.state === 'sent')) return last;
  }
  return last;
}

function intact(service, blobs, app) {
  return app.Store.shots().then((shots) => shots.every((s) => {
    const a = service.attachments.find(x => norm(x.gid) === norm(s.attGlobalId));
    return a && Buffer.compare(a.bytes, blobs[s.id]) === 0 && a.keywords === s.slot && a.name === s.name;
  }));
}

console.log('\n== a clean visit');
{
  const { service, app, blobs, visit } = await setup();
  await settle(app);
  const v = (await app.Store.visits())[0];
  if (service.visits.length !== 1 || v.state !== 'sent') fail('visit not filed: ' + JSON.stringify(v));
  else ok('one visit on the layer, marked sent on the phone');
  if (norm(service.visits[0].gid) !== norm(visit.globalId)) fail('the layer did not keep the GlobalID minted on the phone');
  else ok('the visit carries the GlobalID minted on the phone');
  if ('NotAField' in service.visits[0].attrs) fail('sent a field the layer does not have'); else ok('only fields the layer has are sent');
  if (norm(service.visits[0].attrs.StationGUID) !== norm(visit.stationGid)) fail('StationGUID missing'); else ok('linked to its station by StationGUID');
  if (service.attachments.length !== 3) fail(service.attachments.length + ' attachments');
  else ok('three photos attached');
  if (!await intact(service, blobs, app)) fail('a photo arrived changed, renamed or without its keyword');
  else ok('every photo byte-for-byte, with its name and its slot keyword');
  const parts = service.calls.filter(c => c.endsWith('/uploadPart')).length;
  if (parts !== 9) fail(`expected 3 chunks per photo (9), sent ${parts}`); else ok('sent in chunks: 3 per photo');
  if (service.uploads.size) fail('upload items left behind on the service'); else ok('no upload items left behind');
}

console.log('\n== the reply to a chunk is lost');
{
  const { service, app, blobs } = await setup({ shots: 1 });
  service.lose.push(/\/uploadPart$/);
  await settle(app);
  if (service.attachments.length !== 1) fail(service.attachments.length + ' attachments');
  else if (!await intact(service, blobs, app)) fail('photo changed');
  else ok('the chunk is simply sent again; one intact photo');
}

console.log('\n== the connection drops in the middle of a photo');
{
  const { service, app, blobs } = await setup({ shots: 1, size: 5 * PART });
  service.drop.push(/\/uploadPart$/, /\/uploadPart$/);        // first call goes through, so chunk 1 is in
  const first = service.calls.length;
  service.drop.length = 0;
  // let chunks 1 and 2 through, then cut the line on chunk 3
  let n = 0;
  const realFetch = service.fetch;
  service.fetch = async (url, init) => {
    if (String(url).endsWith('/uploadPart') && ++n === 3) throw new TypeError('Load failed');
    return realFetch(url, init);
  };
  app.fetch = service.fetch;
  const s1 = await flush(app);
  if (!s1.offline) fail('a dropped connection should stop the drain');
  else ok('the drain stops when the connection goes');
  const mid = (await app.Store.shots())[0];
  if ((mid.parts || []).length !== 2) fail('expected chunks 1 and 2 recorded, got ' + JSON.stringify(mid.parts));
  else ok('chunks 1 and 2 are recorded as done');
  const before = service.calls.filter(c => c.endsWith('/uploadPart')).length;
  await settle(app);
  const after = service.calls.filter(c => c.endsWith('/uploadPart')).length;
  if (after - before !== 3) fail(`resume sent ${after - before} chunks, expected the remaining 3`);
  else ok('the next attempt sends only chunks 3 to 5');
  if (!await intact(service, blobs, app)) fail('photo changed'); else ok('and the photo arrives intact');
  void first;
}

console.log('\n== the reply to the attach is lost');
{
  const { service, app, blobs } = await setup({ shots: 2 });
  service.lose.push(/\/1\/applyEdits$/, /\/1\/applyEdits$/);   // the visit add, then the first attach
  await settle(app);
  if (service.visits.length !== 1) fail(service.visits.length + ' visits — the retry filed the visit again');
  else ok('still one visit');
  if (service.attachments.length !== 2) fail(service.attachments.length + ' attachments — a retry attached a photo twice');
  else ok('still one copy of each photo');
  const shots = await app.Store.shots();
  if (!shots.every(s => s.attachmentId && service.attachments.some(a => a.id === s.attachmentId))) fail('rows not matched to what is on the layer');
  else ok('each row found the attachment that had already landed');
  if (!await intact(service, blobs, app)) fail('photo changed'); else ok('photos intact');
}

console.log('\n== the service forgets a half-sent upload');
{
  const { service, app, blobs } = await setup({ shots: 1, size: 3 * PART });
  let n = 0;
  const realFetch = service.fetch;
  service.fetch = async (url, init) => {
    if (String(url).endsWith('/uploadPart') && ++n === 2) {
      service.uploads.clear();                                 // expired between chunks
      throw new TypeError('Load failed');
    }
    return realFetch(url, init);
  };
  app.fetch = service.fetch;
  await flush(app);                                            // chunk 2 lost, drain stops
  await flush(app);                                            // chunk 2 again: "Unable to upload item." → reset
  const mid = (await app.Store.shots())[0];
  if (mid.uploadId) fail('kept a dead upload id'); else ok('a dead upload is dropped: ' + mid.lastError);
  if (mid.state !== 'error') fail('should show as an error until it goes up');
  await settle(app);
  if (service.attachments.length !== 1 || !await intact(service, blobs, app)) fail('did not recover with an intact photo');
  else ok('starts the photo again and it arrives intact');
}

console.log('\n== a visit at a station that is not uploaded yet');
{
  const { service, app } = await setup({ shots: 1, stationPending: true });
  service.drop.push(/\/0\/applyEdits$/);                       // the station cannot go yet
  const s1 = await flush(app);
  if (service.visits.length) fail('the visit went up before its station');
  else ok('the visit waits for its station');
  void s1;
  await settle(app);
  if (service.stations.length !== 1 || service.visits.length !== 1) fail('station or visit missing after the retry');
  else if (norm(service.visits[0].attrs.StationGUID) !== norm(service.stations[0].gid)) fail('visit not linked to the new station');
  else ok('station first, then the visit, linked by its GlobalID');
  if ((await app.Store.edits()).length) fail('the station edit is still queued'); else ok('the station edit is cleared once it is up');
}

console.log('\n== the app was closed mid-upload');
{
  const { service, app, blobs } = await setup({ shots: 1 });
  const s = (await app.Store.shots())[0];
  await app.Store.patchShot(s.id, { state: 'uploading' });
  await app.Store.patchVisit((await app.Store.visits())[0].id, { state: 'uploading' });
  const n = await app.Arc.reclaimStranded();
  if (n !== 1) fail('expected one stranded photo, got ' + n); else ok('the stranded photo is handed back');
  await settle(app);
  if (service.attachments.length !== 1 || !await intact(service, blobs, app)) fail('not uploaded after reclaiming');
  else ok('and then goes up');
}

console.log('\n== two drainers at once');
{
  const { app } = await setup({ shots: 1 });
  const [a, b] = await Promise.all([flush(app), flush(app)]);
  if (!(a.locked || b.locked)) fail('both drained the same queue'); else ok('the second one stands aside');
}

console.log('\n== a draft is never uploaded');
{
  const { service, app } = await setup({ shots: 1 });
  const v = (await app.Store.visits())[0];
  await app.Store.patchVisit(v.id, { state: 'draft' });
  await flush(app);
  if (service.visits.length || service.attachments.length) fail('a visit still being shot was uploaded');
  else ok('visits still being shot stay on the phone');
}

console.log(process.exitCode ? '\nFAILED' : '\nupload engine holds up');
