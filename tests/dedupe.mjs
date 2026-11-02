/* A lost answer must not file a photo twice. Node only, no network: the real
   js/arcgis.js upload path runs against a simulated feature service that can
   apply an edit and then drop the connection before the reply — what a weak
   field connection does. Every retry must end with one point and one photo. */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fail = (m) => { console.log('  FAIL', m); process.exitCode = 1; };
const ok = (m) => console.log('  ok  ', m);

const LAYER = 'https://services.example.com/arcgis/rest/services/Scratch/FeatureServer/0';
const ADD_POINT = /\/(applyEdits|addFeatures)$/;       // however the app files the point

/** A feature service just big enough for the upload path. */
function makeServer({ globalIds = true } = {}) {
  const S = { features: [], attachments: [], loseNext: null, calls: [] };
  let nextOid = 1, nextAid = 1;
  const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });
  S.fetch = async (url, init) => {
    const u = String(url);
    const body = init && init.body;
    const p = body instanceof FormData ? Object.fromEntries(body.entries())
      : Object.fromEntries(new URLSearchParams(body ? String(body) : ''));
    const op = u.slice(LAYER.length) || '/';
    S.calls.push(op);
    let reply;
    if (op === '/') {
      reply = { name: 'Scratch', hasAttachments: true, objectIdField: 'OBJECTID',
        globalIdField: globalIds ? 'GlobalID' : '',
        fields: [{ name: 'OBJECTID', type: 'esriFieldTypeOID' },
                 ...(globalIds ? [{ name: 'GlobalID', type: 'esriFieldTypeGlobalID' }] : []),
                 { name: 'direction', type: 'esriFieldTypeDouble' }, { name: 'notes', type: 'esriFieldTypeString', length: 256 }] };
    } else if (op === '/applyEdits') {
      const adds = JSON.parse(p.adds || '[]');
      reply = { addResults: adds.map((f) => {
        const gid = p.useGlobalIds === 'true' ? f.attributes.GlobalID : '{' + crypto.randomUUID().toUpperCase() + '}';
        if (S.features.some(x => x.gid.toLowerCase() === String(gid).toLowerCase())) {
          return { objectId: -1, success: false, error: { code: 1000, description: 'Cannot insert duplicate key row ... GlobalID' } };
        }
        const oid = nextOid++;
        S.features.push({ oid, gid, attrs: f.attributes });
        return { objectId: oid, globalId: gid, success: true };
      }), updateResults: [], deleteResults: [] };
    } else if (op === '/addFeatures') {
      const feats = JSON.parse(p.features || '[]');           // ignores client GlobalIDs, like the real thing
      reply = { addResults: feats.map((f) => {
        const oid = nextOid++;
        S.features.push({ oid, gid: '{' + crypto.randomUUID().toUpperCase() + '}', attrs: f.attributes });
        return { objectId: oid, success: true };
      }) };
    } else if (op === '/query') {
      const m = /GlobalID = '([^']+)'/i.exec(p.where || '');
      reply = { objectIds: S.features.filter(f => m && f.gid.toLowerCase() === m[1].toLowerCase()).map(f => f.oid) };
    } else if (/^\/\d+\/addAttachment$/.test(op)) {
      const oid = +op.split('/')[1];
      const file = body.get('attachment');
      const aid = nextAid++;
      S.attachments.push({ id: aid, oid, name: file.name, size: file.size });
      reply = { addAttachmentResult: { objectId: aid, success: true } };
    } else if (/^\/\d+\/attachments$/.test(op)) {
      const oid = +op.split('/')[1];
      reply = { attachmentInfos: S.attachments.filter(a => a.oid === oid).map(({ id, name, size }) => ({ id, name, size })) };
    } else {
      reply = { error: { code: 400, message: 'unexpected ' + op } };
    }
    // the edit has been applied — now, perhaps, the connection drops before the answer
    if (S.loseNext && S.loseNext.test(op)) {
      S.loseNext = null;
      throw new TypeError('Load failed');
    }
    return json(reply);
  };
  return S;
}

/** The real config.js + arcgis.js in a sandbox with an in-memory store. */
function makeApp(server) {
  const kv = new Map(), queue = new Map(), photos = new Map();
  const Store = {
    uuid: () => crypto.randomUUID(),
    get: async (k) => (kv.has(k) ? kv.get(k) : null),
    set: async (k, v) => void kv.set(k, v),
    del: async (k) => void kv.delete(k),
    add: async (i) => { const { blob, ...meta } = i; meta.hasPhoto = !!blob; if (blob) photos.set(i.id, blob); queue.set(i.id, meta); return meta; },
    photo: async (id) => photos.get(id) || null,
    dropPhoto: async (id) => void photos.delete(id),
    photoIds: async () => [...photos.keys()],
    takeLock: async () => true,
    releaseLock: async () => null,
    patch: async (id, p) => { const i = queue.get(id); if (i) { Object.assign(i, p); delete i.blob; } return i; },
    item: async (id) => ({ ...queue.get(id) }),
    all: async () => [...queue.values()],
    outstanding: async () => [...queue.values()].filter(i => i.state !== 'sent'),
  };
  const sb = { console, fetch: server.fetch, FormData, Blob, URLSearchParams, crypto, TextEncoder, btoa, Date, Math, JSON,
               Promise, Error, String, Number, Object, Array, isFinite, parseInt, setTimeout, clearTimeout, AbortController,
               location: { origin: 'https://example.github.io' } };
  sb.self = sb;
  vm.createContext(sb);
  sb.Store = Store;
  for (const f of ['js/config.js', 'js/arcgis.js']) vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sb, { filename: f });
  return { ...sb, queue, photos, Store };
}

async function setup(opts) {
  const server = makeServer(opts);
  const app = makeApp(server);
  await app.Config.load();
  await app.Config.save({ serviceUrl: LAYER.replace(/\/0$/, ''), layerId: 0 });
  await app.Store.set('auth', { mode: 'manual', token: 't', expires: Date.now() + 3600e3, username: 'test' });
  const id = crypto.randomUUID();
  await app.Store.add({ id, createdAt: Date.now(), state: 'pending', attempts: 0, nextAttemptAt: 0,
    blob: new Blob([new Uint8Array(2048)], { type: 'image/jpeg' }), filename: 'exoticcam_20261026_101500_hdg090.jpg',
    lat: 27.9, lon: -82.4, heading: 90, serviceUrl: LAYER.replace(/\/0$/, ''), layerId: 0 });
  return { server, app, id };
}

const drainUntilDone = async (app, id, tries = 4) => {
  for (let i = 0; i < tries; i++) {
    await app.Arc.flush(() => {}, { force: true });
    if (app.queue.get(id).state === 'sent') return true;
  }
  return false;
};

console.log('\n== a clean upload');
{
  const { server, app, id } = await setup();
  await drainUntilDone(app, id);
  const row = app.queue.get(id);
  if (row.state !== 'sent') fail('did not finish: ' + row.lastError);
  else ok(`one point (${server.features.length}) and one photo (${server.attachments.length})`);
  if (!/^\{[0-9A-F-]{36}\}$/.test(row.globalId || '')) fail('no GlobalID minted'); else ok('GlobalID minted on the phone and kept');
  if (server.features[0] && server.features[0].gid !== row.globalId) fail('the layer did not keep our GlobalID');
}

console.log('\n== the answer to the point is lost');
{
  const { server, app, id } = await setup();
  server.loseNext = ADD_POINT;
  await drainUntilDone(app, id);
  const row = app.queue.get(id);
  if (server.features.length !== 1) fail(`${server.features.length} points on the layer — the retry filed it again`);
  else ok('still one point after the retry');
  if (row.state !== 'sent' || row.objectId !== server.features[0].oid) fail('row not matched to the point that was already there');
  else ok('the retry found the point it had already filed');
  if (server.attachments.length !== 1) fail(`${server.attachments.length} photos`); else ok('and one photo');
}

console.log('\n== the answer to the photo is lost');
{
  const { server, app, id } = await setup();
  server.loseNext = /\/addAttachment$/;
  await drainUntilDone(app, id);
  const row = app.queue.get(id);
  if (server.attachments.length !== 1) fail(`${server.attachments.length} copies of the photo — the retry sent it again`);
  else ok('still one photo after the retry');
  if (row.state !== 'sent' || row.attachmentId !== server.attachments[0].id) fail('row not matched to the photo already there');
  else ok('the retry found the photo it had already sent');
}

console.log('\n== both answers lost, one after the other');
{
  const { server, app, id } = await setup();
  server.loseNext = ADD_POINT;
  await app.Arc.flush(() => {}, { force: true });
  server.loseNext = /\/addAttachment$/;
  await drainUntilDone(app, id);
  if (server.features.length !== 1 || server.attachments.length !== 1)
    fail(`${server.features.length} point(s), ${server.attachments.length} photo(s)`);
  else ok('one point, one photo');
}

console.log('\n== a layer with no GlobalID field');
{
  const { server, app, id } = await setup({ globalIds: false });
  await drainUntilDone(app, id);
  const row = app.queue.get(id);
  if (row.state !== 'sent' || server.features.length !== 1) fail('upload failed without GlobalIDs: ' + row.lastError);
  else ok('still uploads, just without the duplicate guard on the point');
}

console.log('\n== a photo queued before this change (no GlobalID yet)');
{
  const { server, app, id } = await setup();
  delete app.queue.get(id).globalId;
  server.loseNext = ADD_POINT;
  await app.Arc.flush(() => {}, { force: true });
  const minted = app.queue.get(id).globalId;
  await drainUntilDone(app, id);
  if (!minted) fail('GlobalID was not written down before the first attempt');
  else if (app.queue.get(id).globalId !== minted) fail('the retry used a different GlobalID');
  else if (server.features.length !== 1) fail(`${server.features.length} points`);
  else ok('gets a GlobalID before its first attempt, and keeps it');
}

console.log(process.exitCode ? '\nFAILED' : '\nno duplicates');
