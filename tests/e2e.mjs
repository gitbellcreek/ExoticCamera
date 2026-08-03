/* Exercise the real js/arcgis.js upload path against the live feature service.
   Uses a token generated in this session only; nothing is written to the repo. */
import { ROOT, OUT, FIXTURES, URLBASE, TOK, REFERER, arcFetch } from './env.mjs';
import fs from 'node:fs';
import vm from 'node:vm';


// --- in-memory stand-in for store.js (IndexedDB isn't available in node) ---
const kv = new Map();
const queue = new Map();
const photos = new Map();
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
  put: async (i) => (queue.set(i.id, i), i),
  patch: async (id, p) => { const i = queue.get(id); if (i) { Object.assign(i, p); delete i.blob; } return i; },
  item: async (id) => queue.get(id),
  all: async () => [...queue.values()],
  outstanding: async () => [...queue.values()].filter(i => i.state !== 'sent'),
};

const sandbox = { self: null, console, fetch, FormData, Blob, URLSearchParams, crypto, TextEncoder, btoa, Date, Math, JSON, Promise, Error, String, Number, Object, Array, isFinite, parseInt, setTimeout, clearTimeout, AbortController, location: { origin: 'https://example.github.io' } };
sandbox.self = sandbox;
vm.createContext(sandbox);
sandbox.Store = Store;
for (const f of ['js/config.js', 'js/arcgis.js']) {
  vm.runInContext(fs.readFileSync(`${ROOT}/${f}`, 'utf8'), sandbox, { filename: f });
}
const { Config, Arc } = sandbox;

const fail = (m) => { console.log('FAIL:', m); process.exitCode = 1; };
const ok = (m) => console.log('  ok  ', m);

// Safety rail: only rows created by this run may be deleted.
const MAX_OURS = 6;                 // this run never creates more than a handful
const idsOf = async (url) => {
  const res = await fetch(url + '/query?' + new URLSearchParams({ where: '1=1', returnIdsOnly: 'true', f: 'json', token: TOK }));
  const text = await res.text();
  let j;
  try { j = JSON.parse(text); } catch (e) { throw new Error('layer query did not return JSON: ' + text.slice(0, 120)); }
  if (j.error) throw new Error('layer query failed: ' + JSON.stringify(j.error));
  if (!Array.isArray(j.objectIds)) throw new Error('layer query returned no objectIds array — refusing to guess');
  return new Set(j.objectIds);
};
const layerIds = () => idsOf(Config.layerUrl());

await Config.load();
// Both shipped layers hold real field data, so writes go to a scratch layer
await Config.save({
  serviceUrl: 'https://services.arcgis.com/apTfC6SUmnNfnxuF/arcgis/rest/services/Exotics_Camera_Points/FeatureServer',
  layerId: 0,
});
await Store.set('auth', { mode: 'manual', token: TOK, expires: Date.now() + 3600e3, username: 'test' });

console.log('layer:', Config.layerName(), Config.layerUrl());
if (!Config.layerUrl().includes('Exotics_Camera_Points')) { console.log('FAIL: refusing to write outside Exotics'); process.exit(1); }
const BASELINE = await layerIds();
console.log('baseline:', BASELINE.size, 'pre-existing feature(s) — off limits');

// 1. metadata + field resolution
const meta = await Arc.layerMeta(true);
ok(`metadata: ${meta.name}, attachments=${meta.hasAttachments}`);
const map = Arc.resolveFields(meta);
console.log('  resolved mapping:');
for (const k of Object.keys(map)) console.log(`     ${k.padEnd(14)} -> ${map[k].name} (${map[k].type.replace('esriFieldType', '')})`);
for (const need of ['heading', 'lat', 'lon', 'accuracy', 'altitude', 'captured', 'device'])
  if (!map[need]) fail(`no field resolved for "${need}"`);

// 2. feature shaping
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');
const item = {
  id: crypto.randomUUID(),
  createdAt: Date.now(),
  blob: new Blob([png], { type: 'image/jpeg' }),
  lat: 30.2672, lon: -97.7431, alt: 149.3,
  hAcc: 4.2, vAcc: 6.1, speed: 1.4, course: 88.5,
  heading: 271.4, headingSource: 'sensor',
  device: 'Exotic Camera / e2e test',
  state: 'pending', attempts: 0,
};
const feat = Arc.buildFeature(item, meta);
console.log('  feature:', JSON.stringify(feat));
if (feat.geometry.spatialReference.wkid !== 4326) fail('geometry not wgs84');
if (feat.attributes.esrisnsr_azimuth !== 271.4) fail('heading not mapped');
if (Math.abs(feat.attributes.esrignss_speed - 1.4 * 3.6) > 1e-6) fail('speed not converted to km/h');
if (typeof feat.attributes.esrignss_fixdatetime !== 'number') fail('date not epoch ms');
if (feat.attributes.OBJECTID !== undefined || feat.attributes.GlobalID !== undefined) fail('reserved field sent');
ok('feature shaped correctly');

// 3. real round trip through the queue flush
await Store.add(item);
const events = [];
const sum = await Arc.flush((t, i, e) => events.push(t + (e ? ':' + e.message : '')));
console.log('  flush:', JSON.stringify(sum), events.join(','));
if (sum.sent !== 1) fail('flush did not send');
const done = await Store.item(item.id);
if (done.state !== 'sent') fail('item not marked sent: ' + done.lastError);
if (!done.objectId) fail('no objectId');
if (!done.attachmentId) fail('no attachmentId');
if (!(await Store.photo(item.id))) fail('local copy dropped at upload — nothing left to save to the phone');
if (!done.sentAt) fail('no sentAt stamp, so the local copy can never be pruned');
if ('blob' in done) fail('metadata write carried the photo bytes along — this is what fails on iOS');
ok(`uploaded OBJECTID=${done.objectId} attachment=${done.attachmentId}, photo kept in its own store`);

// 4. verify server side
const q = new URLSearchParams({ where: `OBJECTID=${done.objectId}`, outFields: '*', f: 'json', token: TOK });
const back = await (await fetch(Config.layerUrl() + '/query?' + q)).json();
const a = back.features[0].attributes;
console.log('  server row:', JSON.stringify({ azimuth: a.esrisnsr_azimuth, lat: a.esrignss_latitude, hrms: a.esrignss_h_rms, recv: a.esrignss_receiver, fix: a.esrignss_fixdatetime }));
if (a.esrisnsr_azimuth !== 271.4) fail('heading wrong on server');
const att = await (await fetch(`${Config.layerUrl()}/${done.objectId}/attachments?f=json&token=${TOK}`)).json();
if (!att.attachmentInfos || !att.attachmentInfos.length) fail('no attachment on server');
else ok(`attachment on server: ${att.attachmentInfos[0].name} ${att.attachmentInfos[0].size}B ${att.attachmentInfos[0].contentType}`);

// 5. resume semantics: a half-finished item must not create a second point
const half = { ...item, id: crypto.randomUUID(), objectId: done.objectId, attachmentId: null, state: 'pending', blob: new Blob([png], { type: 'image/jpeg' }) };
await Store.add(half);
await Arc.flush(() => {});
const halfDone = await Store.item(half.id);
if (halfDone.state !== 'sent') fail('resume did not complete');
const mine = [...await layerIds()].filter(id => !BASELINE.has(id));
if (mine.length !== 1) fail(`resume created a duplicate point (this run made ${mine.length})`);
else ok('retry after a dropped connection reuses the existing point');

// 6. bad token surfaces as needAuth, not as a hard failure
await Store.set('auth', { mode: 'manual', token: 'not-a-real-token', expires: Date.now() + 3600e3 });
await Store.add({ ...item, id: crypto.randomUUID(), objectId: null, attachmentId: null, state: 'pending', attempts: 0, nextAttemptAt: 0, blob: new Blob([png]) });
const s2 = await Arc.flush(() => {}, { force: true });
if (!s2.needAuth) fail('invalid token did not raise needAuth: ' + JSON.stringify(s2));
else ok('invalid token → needAuth (item stays pending for retry)');
// restore the good token before the remaining steps
await Store.set('auth', { mode: 'manual', token: TOK, expires: Date.now() + 3600e3 });
for (const r of await Store.all()) if (r.state !== 'sent') queue.delete(r.id);

// 7. an offline failure must not push the retry further and further out
{
  const netFail = 60000, hardFail = 30 * 60000;
  const netCurve = [1, 2, 3, 6, 10].map(n => Arc.backoff(n, true));
  const hardCurve = [1, 2, 3, 6, 10].map(n => Arc.backoff(n, false));
  console.log('  network backoff (s):', netCurve.map(v => v / 1000).join(', '));
  console.log('  server  backoff (s):', hardCurve.map(v => v / 1000).join(', '));
  if (Math.max(...netCurve) > netFail) fail('a photo taken with no signal can wait more than a minute to retry');
  else ok('being out of signal never delays a retry beyond a minute');
  if (Math.max(...hardCurve) !== hardFail) fail('server errors should still back off hard');
  else ok('genuine server errors still back off up to 30 minutes');
}

// 8. reconnecting makes everything due again
{
  const stuck = { ...item, id: crypto.randomUUID(), objectId: null, attachmentId: null,
                  state: 'pending', attempts: 4, nextAttemptAt: Date.now() + 25 * 60000,
                  lastError: 'Network unreachable', blob: new Blob([png], { type: 'image/jpeg' }) };
  await Store.add(stuck);
  const skipped = await Arc.flush(() => {});
  if (skipped.skipped < 1 || skipped.sent > 0) fail('a photo on a retry timer should be skipped by a normal sync: ' + JSON.stringify(skipped));
  else ok('a photo waiting on its timer is skipped by routine syncs');

  await Arc.clearBackoff();
  const after = await Store.item(stuck.id);
  if (after.nextAttemptAt !== 0) fail('reconnecting did not clear the retry timer');
  else ok('reconnecting clears the timer, so the stranded photo goes on the next sync');

  const drained = await Arc.flush(() => {});
  if (drained.sent !== 1) fail('the previously stranded photo still did not upload: ' + JSON.stringify(drained));
  else ok('the airplane-mode photo uploads as soon as the connection returns');
}

// 9. taking it back off the layer
{
  const row = await Store.item(item.id);
  const removed = await Arc.deleteFeature(row);
  if (!removed) fail('deleteFeature reported nothing');
  const still = await (await fetch(Config.layerUrl() + '/query?' + new URLSearchParams({
    objectIds: String(row.objectId), returnCountOnly: 'true', f: 'json', token: TOK }))).json();
  if (still.count !== 0) fail('the feature is still on the layer after a delete');
  else ok(`OBJECTID ${row.objectId} removed from the layer again`);
}

// cleanup: leave the layer as we found it
await Store.set('auth', { mode: 'manual', token: TOK, expires: Date.now() + 3600e3 });
const ours = [...await layerIds()].filter(id => !BASELINE.has(id));
if (ours.length > MAX_OURS) {
  console.log(`  cleanup: REFUSING to delete ${ours.length} rows — more than this run could have created`);
} else if (ours.length) {
  const del = await fetch(Config.layerUrl() + '/deleteFeatures', {
    method: 'POST',
    body: new URLSearchParams({ f: 'json', token: TOK, objectIds: ours.join(',') }),
  });
  console.log('  cleanup: removed only our rows', ours, JSON.stringify(await del.json()).slice(0, 160));
} else {
  console.log('  cleanup: nothing of ours to remove');
}
console.log(process.exitCode ? '\nSOME CHECKS FAILED' : '\nall checks passed');
