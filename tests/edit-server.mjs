/* The server half of editing: change the text on a point already on the layer,
   in place, without creating a duplicate. Real ArcGIS, no browser. */
import { ROOT, OUT, FIXTURES, URLBASE, TOK, REFERER, arcFetch } from './env.mjs';
import fs from 'node:fs';
import vm from 'node:vm';

const LAYER = 'https://services.arcgis.com/apTfC6SUmnNfnxuF/arcgis/rest/services/El_Rat_Generic/FeatureServer';
const REF = { Referer: 'http://127.0.0.1:8848' };

const fail = (m) => { console.log('  FAIL', m); process.exitCode = 1; };
const ok = (m) => console.log('  ok  ', m);

const kv = new Map(), queue = new Map(), photos = new Map();
const Store = {
  uuid: () => crypto.randomUUID(),
  get: async (k) => (kv.has(k) ? kv.get(k) : null),
  set: async (k, v) => void kv.set(k, v),
  del: async (k) => void kv.delete(k),
  add: async (i) => { const { blob, ...m } = i; m.hasPhoto = !!blob; if (blob) photos.set(i.id, blob); queue.set(i.id, m); return m; },
  photo: async (id) => photos.get(id) || null,
  dropPhoto: async (id) => void photos.delete(id),
  photoIds: async () => [...photos.keys()],
  put: async (i) => (queue.set(i.id, i), i),
  patch: async (id, p) => { const i = queue.get(id); if (i) { Object.assign(i, p); delete i.blob; } return i; },
  item: async (id) => queue.get(id),
  all: async () => [...queue.values()],
  outstanding: async () => [...queue.values()].filter(i => i.state !== 'sent' || i.pendingEdit),
  takeLock: async () => true,
  releaseLock: async () => null,
};
// everything the app sends must carry the referer its token is bound to
const rawFetch = globalThis.fetch;
const fetchWithRef = (url, init = {}) =>
  rawFetch(url, { ...init, headers: { ...(init.headers || {}), ...REF } });

const sandbox = { self: null, console, fetch: fetchWithRef, FormData, Blob, URLSearchParams, crypto,
  TextEncoder, btoa, Date, Math, JSON, Promise, Error, String, Number, Object, Array, isFinite, parseInt,
  setTimeout, location: { origin: 'http://127.0.0.1:8848' } };
sandbox.self = sandbox;
vm.createContext(sandbox);
sandbox.Store = Store;
for (const f of ['js/config.js', 'js/arcgis.js']) vm.runInContext(fs.readFileSync(`${ROOT}/${f}`, 'utf8'), sandbox, { filename: f });
const { Config, Arc } = sandbox;

const q = async (params) => {
  const r = await fetchWithRef(LAYER + '/0/query?' + new URLSearchParams({ ...params, f: 'json', token: TOK }));
  const j = await r.json();
  if (j.error) throw new Error(JSON.stringify(j.error));
  return j;
};
const idsOf = async () => {
  const j = await q({ where: '1=1', returnIdsOnly: 'true' });
  if (!Array.isArray(j.objectIds)) throw new Error('no objectIds — refusing to guess');
  return new Set(j.objectIds);
};

await Config.load();
await Config.save({ serviceUrl: LAYER, layerId: 0 });
await Store.set('auth', { mode: 'manual', token: TOK, expires: Date.now() + 3600e3 });

const BASELINE = await idsOf();
console.log('baseline:', BASELINE.size, 'features on ELAPP All — off limits');

const item = {
  id: crypto.randomUUID(), createdAt: Date.now(), state: 'pending', attempts: 0, nextAttemptAt: 0,
  lat: 30.2672, lon: -97.7431, heading: 90, hAcc: 6,
  device: 'Exotic Camera / edit test',
  feature: 'gopher tortoise burrow', notes: 'first pass',
};

try {
  console.log('\n== a photo goes up carrying its tag');
  await Store.add(item);
  const sum = await Arc.flush(() => {});
  if (sum.sent !== 1) fail('did not upload: ' + JSON.stringify(sum));
  const row = await Store.item(item.id);
  const oid = row.objectId;
  if (!oid) { fail('no objectId'); throw new Error('stop'); }
  let a = (await q({ objectIds: String(oid), outFields: '*' })).features[0].attributes;
  console.log('   on the layer:', JSON.stringify({ Feature: a.Feature, Notes: a.Notes }));
  if (a.Feature !== 'gopher tortoise burrow' || a.Notes !== 'first pass') fail('tag did not reach the layer');
  else ok('feature and note arrive with the photo');

  console.log('\n== change your mind afterwards');
  await Store.patch(item.id, {
    feature: 'gopher tortoise burrow (collapsed)', notes: 'second pass, burrow collapsed', pendingEdit: true,
  });
  const c = await Store.all().then(rs => rs.filter(r => r.state === 'sent' && r.pendingEdit).length);
  if (c !== 1) fail('the edit is not queued as work owed');
  else ok('an edit to a sent photo is queued like any other work');

  const sum2 = await Arc.flush(() => {});
  console.log('   flush:', JSON.stringify(sum2));
  a = (await q({ objectIds: String(oid), outFields: '*' })).features[0].attributes;
  console.log('   after the edit:', JSON.stringify({ Feature: a.Feature, Notes: a.Notes }));
  if (a.Feature !== 'gopher tortoise burrow (collapsed)' || a.Notes !== 'second pass, burrow collapsed')
    fail('the layer was not updated in place');
  else ok('the point already on ArcGIS was updated in place');
  const after = [...await idsOf()].filter(id => !BASELINE.has(id));
  if (after.length !== 1) fail('editing created a duplicate: ' + after.length);
  else ok('no duplicate point was created');
  const cleared = await Store.item(item.id);
  if (cleared.pendingEdit) fail('still marked as owing an edit');
  else ok('the queue stops owing the edit once it lands');

  console.log('\n== an edit that cannot be written');
  const other = { ...item, id: crypto.randomUUID(), objectId: 999999999, state: 'sent', pendingEdit: true };
  await Store.add(other);
  const sum3 = await Arc.flush(() => {});
  const bad = await Store.item(other.id);
  console.log('   ', JSON.stringify({ failed: sum3.failed, state: bad.state, err: bad.lastError }));
  if (!bad.lastError) fail('a rejected edit was silently forgotten');
  else ok('a rejected edit is reported and kept: "' + bad.lastError + '"');
  await Store.patch(other.id, { pendingEdit: false });

  console.log('\n== over-long text is trimmed, not rejected');
  await Store.patch(item.id, { feature: 'x'.repeat(600), notes: 'y'.repeat(600), pendingEdit: true });
  const sum4 = await Arc.flush(() => {});
  if (sum4.failed) fail('the server rejected an over-long edit: ' + JSON.stringify(sum4));
  a = (await q({ objectIds: String(oid), outFields: '*' })).features[0].attributes;
  if (a.Feature.length !== 256 || a.Notes.length !== 256)
    fail(`not trimmed to the field: ${a.Feature.length}/${a.Notes.length}`);
  else ok('trimmed to the layer\'s 256 characters and accepted');
} finally {
  const mine = [...await idsOf()].filter(id => !BASELINE.has(id));
  if (mine.length > 3) console.log('\ncleanup: REFUSING to delete', mine.length, 'rows');
  else if (mine.length) {
    const r = await fetchWithRef(LAYER + '/0/deleteFeatures', {
      method: 'POST', body: new URLSearchParams({ f: 'json', token: TOK, objectIds: mine.join(',') }),
    });
    console.log('\ncleanup: removed only our rows', mine, JSON.stringify((await r.json()).deleteResults));
  } else console.log('\ncleanup: nothing of ours to remove');
}
console.log(process.exitCode ? '\nSOME CHECKS FAILED' : '\nserver-side edits work');
