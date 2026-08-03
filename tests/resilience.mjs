/* Regression for the reported crash — "null is not an object (evaluating
   'e.needAuth')" — plus the problem-report round trip. */
import { ROOT, OUT, FIXTURES, URLBASE, TOK, REFERER, arcFetch } from './env.mjs';
import fs from 'node:fs';
import vm from 'node:vm';

const fail = (m) => { console.log('  FAIL', m); process.exitCode = 1; };
const ok = (m) => console.log('  ok  ', m);

const NO_REJECT = Symbol('no-reject');

function makeApp({ patchRejectsWith = NO_REJECT } = {}) {
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
    patch: async (id, p) => {
      if (patchRejectsWith !== NO_REJECT) return Promise.reject(patchRejectsWith);
      const i = queue.get(id); if (i) { Object.assign(i, p); delete i.blob; } return i;
    },
    item: async (id) => queue.get(id),
    all: async () => [...queue.values()],
    outstanding: async () => [...queue.values()].filter(i => i.state !== 'sent'),
  };
  const sandbox = { self: null, console, fetch, FormData, Blob, File, URLSearchParams, crypto, TextEncoder, btoa, Date, Math, JSON, Promise, Error, String, Number, Object, Array, isFinite, parseInt, setTimeout, screen: { width: 393, height: 852 }, navigator: { userAgent: 'test' }, location: { origin: 'https://x.github.io' } };
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  sandbox.Store = Store;
  for (const f of ['js/config.js', 'js/arcgis.js', 'js/report.js']) {
    vm.runInContext(fs.readFileSync(`${ROOT}/${f}`, 'utf8'), sandbox, { filename: f });
  }
  return { ...sandbox, Store, queue };
}

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const photo = () => ({
  id: crypto.randomUUID(), createdAt: Date.now(), blob: new Blob([png], { type: 'image/jpeg' }),
  lat: 30.2672, lon: -97.7431, hAcc: 5, heading: 90, state: 'pending', attempts: 0, nextAttemptAt: 0,
});

console.log('== storage failures must not become a second crash');
// This is exactly the field report: IndexedDB rejects with null, and the old
// catch did `e.needAuth` on it.
for (const [label, value] of [['null', null], ['a string', 'QuotaExceededError'], ['a number', 0],
                              ['a DOMException-like object', { name: 'QuotaExceededError', message: 'out of space' }]]) {
  const { Config, Arc, Store } = makeApp({ patchRejectsWith: value });
  await Config.load();
  await Store.set('auth', { mode: 'manual', token: TOK, expires: Date.now() + 3600e3 });
  await Store.add(photo());
  let summary, threw = null;
  try { summary = await Arc.flush(() => {}, { force: true }); } catch (e) { threw = e; }
  if (threw) {
    const msg = threw && threw.message ? threw.message : String(threw);
    if (/is not an object|undefined is not|cannot read/i.test(msg)) fail(`rejecting with ${label} still crashes: ${msg}`);
    else ok(`rejecting with ${label} → clean error "${msg}"`);
  } else {
    ok(`rejecting with ${label} → handled, summary ${JSON.stringify(summary)}`);
  }
}

// and asError itself
{
  const { Arc } = makeApp();
  for (const v of [null, undefined, 'boom', 0, { message: 'x', needAuth: true }, new Error('real')]) {
    const e = Arc.asError(v);
    if (!(e instanceof Error) || typeof e.message !== 'string') fail('asError returned something unusable for ' + JSON.stringify(v));
  }
  if (!Arc.asError({ message: 'x', needAuth: true }).needAuth) fail('asError dropped needAuth');
  else ok('asError normalises null/undefined/strings and preserves needAuth');
}

console.log('\n== problem report round trip');
{
  const { Config, Arc, Store, Report } = makeApp();
  await Config.load();
  await Store.set('auth', { mode: 'manual', token: TOK, expires: Date.now() + 3600e3, username: 'james.robe.hc' });

  const before = await ids(Report.tableUrl());
  Report.note('boot', 'test harness');
  Report.note('captured', { heading: 90 });
  const sent = await Report.send({
    kind: 'crash', summary: "null is not an object (evaluating 'e.needAuth')",
    note: 'raised from the field', sensors: 'compass=live gps=±5m', device: 'iPhone test',
    queued: 3, queueErrors: 1, online: true, lat: 30.2672, lon: -97.7431,
    stack: 'at flush (arcgis.js:1)',
  });
  if (!sent) fail('report was not accepted by the table');
  else ok('report written to ExoticCameraBugs');

  const mine = [...await ids(Report.tableUrl())].filter(i => !before.has(i));
  if (mine.length !== 1) { fail('expected exactly one new row, got ' + mine.length); process.exit(1); }
  const row = await q(Report.tableUrl(), mine);
  const a = row.features[0].attributes;
  console.log('   row:', JSON.stringify({ kind: a.kind, summary: a.summary, build: a.appbuild, layer: a.layername, user: a.username, queued: a.queued, online: a.online }));
  for (const f of ['reported', 'kind', 'summary', 'details', 'appbuild', 'layername', 'username', 'queued', 'online', 'applat'])
    if (a[f] === null || a[f] === undefined) fail(`field "${f}" came back empty`);
  if (!JSON.parse(a.details).breadcrumbs.length) fail('breadcrumbs missing from details');
  else ok(`details carry ${JSON.parse(a.details).breadcrumbs.length} breadcrumbs and the stack`);
  if (a.layername.indexOf('Central') !== 0) fail('layer name not recorded: ' + a.layername);
  else ok('records which layer the user was on: ' + a.layername);

  // a failing report must never take the app down with it
  await Store.del('auth');
  const outcome = await Report.send({ kind: 'crash', summary: 'no auth' });
  if (outcome !== false) fail('signed-out report should resolve false, not throw');
  else ok('a report that cannot be sent resolves false instead of throwing');

  // opt-out is honoured for automatic reports, manual always goes
  await Store.set('auth', { mode: 'manual', token: TOK, expires: Date.now() + 3600e3 });
  await Config.save({ reportProblems: false });
  if (await Report.send({ kind: 'crash', summary: 'should not send' }) !== false) fail('opt-out ignored for automatic reports');
  else ok('automatic reports respect the opt-out');

  await Config.save({ reportProblems: true });
  const del = await fetch(Report.tableUrl() + '/deleteFeatures', {
    method: 'POST', body: new URLSearchParams({ f: 'json', token: TOK, objectIds: mine.join(',') }),
  });
  console.log('   cleanup:', JSON.stringify((await del.json()).deleteResults));
}

async function ids(url) {
  const res = await fetch(url + '/query?' + new URLSearchParams({ where: '1=1', returnIdsOnly: 'true', f: 'json', token: TOK }));
  const text = await res.text();
  let j;
  try { j = JSON.parse(text); } catch (e) { throw new Error('query did not return JSON: ' + text.slice(0, 120)); }
  if (j.error) throw new Error('query failed: ' + JSON.stringify(j.error));
  if (!Array.isArray(j.objectIds)) throw new Error('query returned no objectIds array — refusing to guess');
  return new Set(j.objectIds);
}
async function q(url, objectIds) {
  return (await fetch(url + '/query?' + new URLSearchParams({ objectIds: objectIds.join(','), outFields: '*', f: 'json', token: TOK }))).json();
}

console.log(process.exitCode ? '\nSOME CHECKS FAILED' : '\nall resilience checks passed');
