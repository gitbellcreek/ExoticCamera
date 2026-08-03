/* Regression for the reported crash — "null is not an object (evaluating
   'e.needAuth')" — plus the problem-report round trip. */
import { ROOT, OUT, FIXTURES, URLBASE, TOK, REFERER, arcFetch } from './env.mjs';
import fs from 'node:fs';
import vm from 'node:vm';

const fail = (m) => { console.log('  FAIL', m); process.exitCode = 1; };
const ok = (m) => console.log('  ok  ', m);

const NO_REJECT = Symbol('no-reject');

function makeApp({ patchRejectsWith = NO_REJECT, fetchImpl = null } = {}) {
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
  const sandbox = { self: null, console, fetch: fetchImpl || fetch, AbortController, FormData, Blob, File, URLSearchParams, crypto, TextEncoder, btoa, Date, Math, JSON, Promise, Error, String, Number, Object, Array, isFinite, parseInt, setTimeout, clearTimeout, screen: { width: 393, height: 852 }, navigator: { userAgent: 'test' }, location: { origin: 'https://x.github.io' } };
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
  if (!Report.lastFailure) fail('a failed report did not record why');
  else ok('failure reason recorded: ' + Report.lastFailure);
  await Store.set('reportQueue', []);            // that one was sent with no auth on purpose

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

/* Tyler's report never arrived and nobody could say why: the old code binned a
   report it could not send and blamed the token. */
console.log('\n== a report that cannot be sent is held, and says why');
{
  const { Config, Store, Report } = makeApp();
  await Config.load();
  await Store.set('auth', { mode: 'manual', token: TOK, expires: Date.now() + 3600e3, username: 'james.robe.hc' });
  const good = Config.get().bugsUrl;
  const before = await ids(Report.tableUrl());

  await Config.save({ bugsUrl: good.replace(/ExoticCameraBugs/, 'NoSuchTable_ExoticCamera') });
  Report.note('boot', 'held-report test');
  if (await Report.send({ kind: 'manual', summary: 'held report round trip' }) !== false) {
    fail('a report to a table that does not exist reported success');
  } else {
    ok('refused report resolves false, reason: ' + Report.lastFailure);
  }
  if (/offline|signed out/i.test(Report.lastFailure || '')) fail('still guessing at the cause instead of quoting the table');
  if ((await Report.heldCount()) !== 1) fail('the report was dropped instead of held');
  else ok('held for a later attempt');

  await Config.save({ bugsUrl: good });
  const sent = await Report.flushHeld();
  if (sent !== 1) fail('held report did not go up once the table was reachable, sent=' + sent);
  else ok('held report went up on the next flush');
  if ((await Report.heldCount()) !== 0) fail('a sent report was left in the hold queue');
  else ok('hold queue emptied');
  if (Report.lastFailure !== null) fail('lastFailure not cleared after a success');

  const mine = [...await ids(Report.tableUrl())].filter(i => !before.has(i));
  if (mine.length !== 1) { fail('expected exactly one new row, got ' + mine.length); process.exit(1); }
  const a = (await q(Report.tableUrl(), mine)).features[0].attributes;
  if (a.summary !== 'held report round trip') fail('the held report arrived with the wrong body: ' + a.summary);
  else ok('the row that arrived is the one that was held');
  const del = await fetch(Report.tableUrl() + '/deleteFeatures', {
    method: 'POST', body: new URLSearchParams({ f: 'json', token: TOK, objectIds: mine.join(',') }),
  });
  console.log('   cleanup:', JSON.stringify((await del.json()).deleteResults));
}

/* Tyler's points landed on Central with no photos behind them and the app
   chimed as though they had uploaded. Losing the bytes is bad; calling it a
   success is worse, because nobody goes looking. */
console.log('\n== a photo whose bytes are gone must not be reported as uploaded');
{
  const { Config, Arc, Store, queue } = makeApp();
  await Config.load();
  await Store.set('auth', { mode: 'manual', token: TOK, expires: Date.now() + 3600e3 });
  const p = photo();
  await Store.add(p);
  // the point is already on the layer, so nothing here touches the service
  await Store.patch(p.id, { objectId: 999999 });
  await Store.dropPhoto(p.id);

  const summary = await Arc.flush(() => {}, { force: true });
  const row = queue.get(p.id);
  if (summary.sent) fail('a photo with no bytes was counted as sent');
  else ok('not counted as sent');
  if (row.state !== 'error') fail('expected state "error", got "' + row.state + '"');
  else ok('row left in error: ' + row.lastError);
  if (row.attachmentId) fail('invented an attachment id');

  // and a record that never had a photo is still allowed through
  const q2 = photo();
  delete q2.blob;
  await Store.add(q2);
  await Store.patch(q2.id, { objectId: 999998 });
  const s2 = await Arc.flush(() => {}, { force: true });
  if (queue.get(q2.id).state !== 'sent') fail('a genuine point-only record was blocked, state=' + queue.get(q2.id).state);
  else ok('a record that never had a photo still goes up (sent ' + s2.sent + ')');
}

/* The field bug: three photos owed, zero errors recorded, "waiting" forever.
   The first attachment upload hung with no deadline, and because the queue
   drains one at a time nothing behind it was ever attempted. */
console.log('\n== an upload that hangs must time out, and must not block the queue');
{
  let attachTries = 0;
  const stub = (url, opts) => {
    if (String(url).includes('/addAttachment')) {
      attachTries++;
      // a half-open connection: it answers nothing, ever
      return new Promise((_, reject) => {
        if (opts && opts.signal) opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }
    return fetch(url, opts);
  };
  const { Config, Arc, Store, queue } = makeApp({ fetchImpl: stub });
  await Config.load();
  Arc.timeouts.upload = 400;                       // 120s in the field, 0.4s here
  await Store.set('auth', { mode: 'manual', token: TOK, expires: Date.now() + 3600e3 });

  const a = photo(), b = photo();
  b.createdAt = a.createdAt + 1;
  for (const p of [a, b]) { await Store.add(p); await Store.patch(p.id, { objectId: 900001 }); }

  const started = Date.now();
  const summary = await Arc.flush(() => {}, { force: true });
  const took = Date.now() - started;

  if (took > 5000) fail('flush took ' + took + 'ms — the deadline did not fire');
  else ok('a hung upload gives up after ' + took + 'ms instead of never');
  if (attachTries !== 2) fail('expected both photos to be attempted, got ' + attachTries);
  else ok('the photo behind it was still attempted — one slow upload no longer blocks the queue');
  if (summary.offline) fail('a timeout was treated as being offline, which stops the drain');
  else ok('a deadline is not mistaken for having no signal');
  let clean = true;
  for (const p of [a, b]) {
    const row = queue.get(p.id);
    const before = process.exitCode;
    if (!/timed out/i.test(row.lastError || '')) fail('row recorded "' + row.lastError + '" instead of a timeout');
    if (row.attempts) fail('a timeout must not count against the photo itself');
    if (!row.netAttempts) fail('a timeout was not counted at all — this is the "waiting forever" bug');
    if (process.exitCode !== before) clean = false;
  }
  if (clean) ok('both rows carry a visible timeout and a network-attempt count');
}

console.log('\n== a row stranded mid-upload is handed back to the queue');
{
  const { Config, Arc, Store, queue } = makeApp();
  await Config.load();
  const p = photo();
  await Store.add(p);
  await Store.patch(p.id, { state: 'uploading' });   // iOS suspended the app here
  const n = await Arc.reclaimStranded();
  const row = queue.get(p.id);
  if (n !== 1) fail('expected one stranded row, got ' + n);
  if (row.state !== 'pending') fail('stranded row left as "' + row.state + '"');
  else ok('handed back as pending: ' + row.lastError);
  if (!row.netAttempts) fail('the interruption was not counted');
  if (await Arc.reclaimStranded() !== 0) fail('reclaiming twice found work the second time');
  else ok('nothing to reclaim on a clean queue');
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
