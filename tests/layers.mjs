/* Field resolution against BOTH layers — read only. Central holds real data and
   is never written to here. */
import { ROOT, OUT, FIXTURES, URLBASE, TOK, REFERER, arcFetch } from './env.mjs';
import fs from 'node:fs';
import vm from 'node:vm';


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
  put: async (i) => (queue.set(i.id, i), i),
  patch: async (id, p) => { const i = queue.get(id); if (i) { Object.assign(i, p); delete i.blob; } return i; },
  item: async (id) => queue.get(id),
  all: async () => [...queue.values()],
  outstanding: async () => [...queue.values()].filter(i => i.state !== 'sent'),
};
const sandbox = { self: null, console, fetch, FormData, Blob, URLSearchParams, crypto, TextEncoder, btoa, Date, Math, JSON, Promise, Error, String, Number, Object, Array, isFinite, parseInt, setTimeout, clearTimeout, AbortController, location: { origin: 'https://x.github.io' } };
sandbox.self = sandbox;
vm.createContext(sandbox);
sandbox.Store = Store;
for (const f of ['js/config.js', 'js/arcgis.js']) vm.runInContext(fs.readFileSync(`${ROOT}/${f}`, 'utf8'), sandbox, { filename: f });
const { Config, Arc } = sandbox;

const fail = (m) => { console.log('  FAIL', m); process.exitCode = 1; };
const ok = (m) => console.log('  ok  ', m);

await Config.load();
await Store.set('auth', { mode: 'manual', token: TOK, expires: Date.now() + 3600e3 });

console.log('presets:', Config.PRESETS.map(p => p.name).join(', '));
if (Config.layerName() !== 'Central') fail('default layer is ' + Config.layerName() + ', expected Central');
else ok('default target is Central');

const item = {
  id: crypto.randomUUID(), createdAt: Date.parse('2026-07-30T14:05:09Z'),
  lat: 30.2672, lon: -97.7431, alt: 149.3, hAcc: 4.2, vAcc: 6.1, speed: 1.4, course: 88.5,
  heading: 271.4, device: 'Exotic Camera / test', notes: 'test note',
  filename: 'exoticcam_20260730_140509_hdg271.jpg',
};

for (const p of Config.PRESETS) {
  console.log('\n== ' + p.name);
  await Config.useLayer(p.id);
  if (Config.layerName() !== p.name) fail('layerName() wrong after switching');
  const meta = await Arc.layerMeta(true);
  const map = Arc.resolveFields(meta);
  console.log('   ' + meta.name + ', attachments=' + meta.hasAttachments);
  for (const k of Object.keys(map)) console.log(`     ${k.padEnd(14)} -> ${map[k].name}`);
  if (!meta.hasAttachments) fail(p.name + ' has attachments disabled — photos cannot be stored');

  const f = Arc.buildFeature(item, meta);
  console.log('   attributes:', JSON.stringify(f.attributes));
  if (!map.heading) fail(p.name + ': heading has nowhere to go');
  else ok(`heading → ${map.heading.name} = ${f.attributes[map.heading.name]}`);
  if (!map.captured) fail(p.name + ': no capture-time field');
  else ok(`captured → ${map.captured.name}`);

  // nothing may target a read-only or service-managed field
  for (const name of Object.keys(f.attributes)) {
    const fld = meta.fields.find(x => x.name === name);
    if (!fld) fail(`${p.name}: sending "${name}", which is not on the layer`);
    else if (fld.editable === false) fail(`${p.name}: sending read-only field ${name}`);
  }
  if (/creationdate|creator|editdate|editor/i.test(Object.keys(f.attributes).join(',')))
    fail(p.name + ': editor-tracking fields must not be written');
  else ok('writes only editable, layer-owned fields');
  if (f.geometry.spatialReference.wkid !== 4326) fail('geometry not wgs84');
}

// Central-specific expectations
await Config.useLayer('central');
const cmeta = await Arc.layerMeta();
const cmap = Arc.resolveFields(cmeta);
console.log('\n== Central specifics');
for (const [logical, physical] of [['heading', 'direction'], ['captured', 'datetaken'], ['notes', 'notes'], ['filename', 'filename']]) {
  if (!cmap[logical] || cmap[logical].name !== physical) fail(`${logical} should map to ${physical}, got ${cmap[logical] && cmap[logical].name}`);
  else ok(`${logical} → ${physical}`);
}
const cf = Arc.buildFeature(item, cmeta);
if (cf.attributes.filename !== item.filename) fail('filename not carried onto the feature');
else ok('filename written so the row can be matched to its attachment');
if (cf.attributes.direction !== 271.4) fail('compass heading not written to direction');

// ELAPP All must never be the default
if (Config.DEFAULTS.activeLayer !== 'central') fail('ELAPP All (or something else) is the default');
else ok('Central remains the default target');
if (!Config.preset('elapp')) fail('ELAPP All is not among the presets');
else ok('ELAPP All is offered: ' + Config.preset('elapp').serviceUrl);

// a queued photo must go to the layer it was taken for, not the current one
console.log('\n== queued photos keep their destination');
const elapp = Config.preset('elapp');
const pinned = { ...item, serviceUrl: elapp.serviceUrl, layerId: elapp.layerId };
if (!Arc.targetUrl(pinned).includes('El_Rat_Generic'))
  fail('pinned photo would upload to the wrong layer: ' + Arc.targetUrl(pinned));
else ok('a photo taken on ELAPP All still uploads there after switching to Central');
if (Arc.targetUrl({}) !== Config.layerUrl()) fail('unpinned photo should follow the current layer');
else ok('a photo with no pin follows the current layer');

console.log('\nno writes were made to either layer');
console.log(process.exitCode ? '\nSOME CHECKS FAILED' : '\nall layer checks passed');
