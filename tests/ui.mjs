/* Drive the app in a real browser: fake camera, fake GPS, no network to ArcGIS
   unless we allow it. Checks capture → queue → offline → reconnect → upload. */
import { ROOT, OUT, FIXTURES, URLBASE, TOK, REFERER, arcFetch } from './env.mjs';
import { chromium, CHROME, relayArcGIS } from './browser.mjs';
import fs from 'node:fs';


const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
         '--unsafely-treat-insecure-origin-as-secure=http://127.0.0.1:8848'],
});
const ctx = await browser.newContext({
  viewport: { width: 412, height: 915 },
  isMobile: true, hasTouch: true, deviceScaleFactor: 2,
  permissions: ['camera', 'geolocation'],
  geolocation: { latitude: 30.2672, longitude: -97.7431, accuracy: 6 },
  serviceWorkers: 'allow',
});
// The sandboxed browser can't use the egress proxy, so relay ArcGIS calls
// through node. `offline` also lets us cut the link precisely.
let offline = false;
await ctx.route('**://*.arcgis.com/**', async (route) => {
  if (offline) return route.abort('internetdisconnected');
  const req = route.request();
  try {
    const res = await fetch(req.url(), {
      method: req.method(),
      headers: Object.fromEntries(Object.entries(req.headers()).filter(([k]) => !/^(host|origin|referer|connection|content-length|accept-encoding|sec-)/i.test(k))),
      body: req.postDataBuffer() ?? undefined,
    });
    const body = Buffer.from(await res.arrayBuffer());
    const headers = {};
    res.headers.forEach((v, k) => { if (!/^(content-encoding|content-length|transfer-encoding)$/i.test(k)) headers[k] = v; });
    headers['access-control-allow-origin'] = '*';
    await route.fulfill({ status: res.status, headers, body });
  } catch (e) {
    await route.abort('failed');
  }
});
// navigator.onLine has to agree with the relay
await ctx.addInitScript(() => {
  Object.defineProperty(Navigator.prototype, 'onLine', { get: () => !window.__offline, configurable: true });
});
const setOffline = async (v) => {
  offline = v;
  for (const p of ctx.pages()) {
    await p.evaluate((v) => { window.__offline = v; window.dispatchEvent(new Event(v ? 'offline' : 'online')); }, v);
  }
};

const LAYER = 'https://services.arcgis.com/apTfC6SUmnNfnxuF/arcgis/rest/services/Exotics_Camera_Points/FeatureServer/0';
// Safety rail: the test may only ever delete rows that did not exist before it
// started. Never `where=1=1` — this layer holds real field data.
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
const ids = () => idsOf(LAYER);
const BASELINE = await ids();
console.log(`baseline: ${BASELINE.size} pre-existing feature(s) — these are off limits`);
const cleanup = async () => {
  const mine = [...await ids()].filter(id => !BASELINE.has(id));
  if (!mine.length) return 'nothing of ours to remove';
  if (mine.length > MAX_OURS) return `REFUSING to delete ${mine.length} rows — more than this run could have created`;
  const r = await (await fetch(LAYER + '/deleteFeatures', {
    method: 'POST',
    body: new URLSearchParams({ f: 'json', token: TOK, objectIds: mine.join(',') }),
  })).json();
  return `removed only our own rows ${JSON.stringify(mine)}: ${JSON.stringify(r.deleteResults || r)}`;
};
process.on('exit', () => { if (process.exitCode) console.log('(cleanup ran before exit)'); });

const page = await ctx.newPage();
const downloads = [];
page.on('download', d => downloads.push(d.suggestedFilename()));
const errs = [];
page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
page.on('pageerror', e => errs.push('pageerror: ' + e.message));

await page.goto(URLBASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);

const step = (n) => console.log('\n== ' + n);
const ok = (m) => console.log('  ok  ', m);
const fail = (m) => { console.log('  FAIL', m); process.exitCode = 1; };

step('boot');
ok('title: ' + await page.title());
const video = await page.evaluate(() => {
  const v = document.getElementById('preview');
  return { w: v.videoWidth, h: v.videoHeight, playing: !v.paused };
});
if (!video.w) fail('no video frames'); else ok(`viewfinder live ${video.w}x${video.h}`);
const ticks = await page.locator('#dial line').count();
const letters = await page.locator('#labels text').count();
if (ticks < 60 || letters < 4) fail(`compass dial not drawn (${ticks} ticks, ${letters} labels)`);
else ok(`compass dial drawn (${ticks} ticks, ${letters} labels)`);
const fit = await page.evaluate(() => getComputedStyle(document.getElementById('preview')).objectFit);
if (fit !== 'contain') fail(`viewfinder is "${fit}" — the preview would crop the frame that gets captured`);
else ok('viewfinder shows the whole frame (object-fit: contain)');
ok('gps chip: ' + await page.locator('#chip-gps .label').textContent());
ok('net chip: ' + await page.locator('#chip-net .label').textContent());

step('synthetic compass heading');
await page.evaluate(() => {
  // phone held upright, lens pointing east
  const e = new Event('deviceorientationabsolute');
  Object.assign(e, { absolute: true, alpha: 270, beta: 90, gamma: 0 });
  for (let i = 0; i < 12; i++) window.dispatchEvent(e);
});
await page.waitForTimeout(200);
const hd = await page.locator('#heading-deg').textContent();
const hc = await page.locator('#heading-card').textContent();
console.log('   heading readout:', hd, hc);
if (hd === '---') fail('heading never updated');
else if (Math.abs(Number(hd) - 90) > 2) fail(`expected ~090 for a lens pointing east, got ${hd}`);
else ok(`lens-east orientation reads ${hd}° ${hc}`);
const rot = await page.evaluate(() => getComputedStyle(document.getElementById('dial')).transform);
if (rot === 'none') fail('dial not rotating'); else ok('dial rotates with heading');

step('sign in with a pasted token');
await page.click('#menu-btn');
await page.waitForTimeout(300);
await page.click('#auth-btn');
await page.waitForTimeout(300);
await page.locator('#signin-panel details').nth(1).click();
await page.fill('#si-token', TOK);
await page.click('#si-token-go');
await page.waitForTimeout(600);
await page.click('#menu-btn');
await page.waitForTimeout(300);
ok('account: ' + (await page.locator('#acct-name').textContent()) + ' / ' + (await page.locator('#acct-sub').textContent()));
await page.keyboard.press('Escape');
await page.waitForTimeout(300);

step('layer picker');
await page.click('#menu-btn');
await page.waitForTimeout(300);
ok('menu shows current layer: ' + (await page.locator('#mi-layer-sub').textContent()));
if ((await page.locator('#mi-layer-sub').textContent()) !== 'Central') fail('default layer should be Central');
await page.click('#mi-layer');
await page.waitForTimeout(350);
const opts = await page.locator('#layer-list [data-layer]').allTextContents();
console.log('   options:', JSON.stringify(opts.map(t => t.split('\n')[0])));
if (opts.length !== 2) fail('expected two layer options');
if (!(await page.locator('#layer-list [data-layer="elapp"]').count())) fail('ELAPP All is not offered');
else ok('offers Central and ELAPP All');
if (!(await page.locator('#layer-list [data-layer="central"]').getAttribute('class')).includes('on'))
  fail('Central not marked as current — ELAPP All must not be the default');
else ok('Central is the default, ELAPP All is opt-in');
await page.screenshot({ path: OUT + '/shot-layers.png' });
await page.keyboard.press('Escape');
await page.waitForTimeout(300);

// Both presets hold real data, so writes go to a scratch layer entered by hand —
// which also exercises the custom-URL path.
await page.click('#menu-btn'); await page.waitForTimeout(300);
await page.click('#mi-settings'); await page.waitForTimeout(400);
await page.fill('#s-url', 'https://services.arcgis.com/apTfC6SUmnNfnxuF/arcgis/rest/services/Exotics_Camera_Points/FeatureServer');
await page.fill('#s-layer', '0');
await page.click('#s-save');
await page.waitForTimeout(900);
await page.click('#menu-btn'); await page.waitForTimeout(300);
if ((await page.locator('#mi-layer-sub').textContent()) !== 'Custom layer') fail('custom layer not accepted');
else ok('switched to a custom scratch layer — writes stay off both shipped layers');
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
// belt and braces: refuse to continue if the app is still pointed at Central
const target = await page.evaluate(() => new Promise((res) => {
  const r = indexedDB.open('exoticcam');
  r.onsuccess = () => {
    const q = r.result.transaction('kv', 'readonly').objectStore('kv').get('settings');
    q.onsuccess = () => res(q.result.v.serviceUrl);
  };
}));
if (!target.includes('Exotics_Camera_Points')) { console.log('ABORT: app still targets', target); process.exit(1); }

step('capture while offline');
await setOffline(true);
await page.waitForTimeout(300);
if ((await page.locator('#chip-net .label').textContent()) !== 'offline') fail('offline chip not shown');
else ok('offline indicator shown');
await page.click('#shutter');
await page.waitForTimeout(900);
await page.click('#shutter');
await page.waitForTimeout(900);
const q1 = await page.locator('#chip-queue .label').textContent();
if (q1 !== '2') fail('expected 2 queued, got ' + q1); else ok('2 photos queued offline');
await page.screenshot({ path: OUT + '/shot-offline.png' });
await page.waitForTimeout(600);
// shooting must not be interrupted: no share sheet, no download, per shot
if (downloads.length !== 0) fail(`shooting was interrupted by ${downloads.length} save(s) — this should be off by default`);
else ok('taking photos never interrupts with a share sheet or download');

step('saving the batch to the phone');

await page.click('#chip-queue');
await page.waitForTimeout(400);
const rows = await page.locator('.qrow').count();
if (rows !== 2) fail('queue panel rows: ' + rows); else ok('queue panel lists 2 rows with thumbnails');
if (await page.locator('.qsave').count() !== 2) fail('no save-to-device button on queued rows');
else ok('each row offers a save-to-device button');
console.log('   hint:', await page.locator('#q-save-hint').textContent());
await page.click('#q-save-all');
await page.waitForTimeout(1200);
if (downloads.length !== 2) fail(`"Save to phone" handed over ${downloads.length} photos, expected 2`);
else if (!/^exoticcam_\d{8}_\d{6}(_hdg\d{3})?\.jpg$/.test(downloads[0])) fail('odd filename: ' + downloads[0]);
else ok(`"Save to phone" hands the batch over at once: ${downloads.join(', ')}`);
console.log('   row text:', (await page.locator('.qrow').first().innerText()).replace(/\n/g, ' | '));
await page.screenshot({ path: OUT + '/shot-queue.png' });
await page.keyboard.press('Escape');
await page.waitForTimeout(300);

step('the queue updates while you are watching it');
await page.click('#chip-queue');
await page.waitForTimeout(500);
const beforeStates = await page.locator('.qrow').evaluateAll(rs => rs.map(r => r.className));
console.log('   rows before reconnect:', JSON.stringify(beforeStates));
if (await page.locator('.qunsend').count() !== 0) fail('remove-from-layer offered before anything was uploaded');
await setOffline(false);
// the panel stays open the whole time — no tapping away and back
await page.waitForFunction(() => {
  const rows = [...document.querySelectorAll('.qrow')];
  return rows.length > 0 && rows.every(r => r.classList.contains('sent'));
}, null, { timeout: 30000 })
  .then(() => ok('rows flipped to "sent" live, without reopening the panel'))
  .catch(async () => fail('queue did not refresh while open: ' +
    JSON.stringify(await page.locator('.qrow').evaluateAll(rs => rs.map(r => r.className)))));
if (await page.locator('.qunsend').count() !== 2) fail('the remove-from-layer control did not appear live');
else ok('and the per-row actions appeared with them');
await page.keyboard.press('Escape');
await page.waitForTimeout(400);

step('reconnect → auto upload');
await page.waitForFunction(() => document.querySelector('#chip-queue .label').textContent === '0', null, { timeout: 30000 })
  .then(() => ok('queue drained automatically on reconnect'))
  .catch(async () => fail('queue did not drain: ' + await page.locator('#chip-queue .label').textContent()));
await page.waitForTimeout(500);
await page.screenshot({ path: OUT + '/shot-main.png' });
const kept = await page.evaluate(async () => {
  const rows = await self.Store.all();
  const out = [];
  for (const r of rows) {
    const blob = await self.Store.photo(r.id);
    // the bytes live in their own store now; the queue row must stay small
    out.push({ state: r.state, hasBlob: !!blob, inline: 'blob' in r && !!r.blob, sentAt: !!r.sentAt });
  }
  return out;
});
if (kept.some(k => k.inline)) fail('queue rows still carry photo bytes: ' + JSON.stringify(kept));
if (!kept.every(k => k.state === 'sent' && k.hasBlob && k.sentAt))
  fail('local copies not retained after upload: ' + JSON.stringify(kept));
else ok('photos stay on the device after upload (pruned later by keepHours)');

step('server side');
const layer = LAYER;
const mineIds = [...await ids()].filter(id => !BASELINE.has(id));
const res = mineIds.length
  ? await (await fetch(layer + '/query?' + new URLSearchParams({ objectIds: mineIds.join(','), outFields: '*', f: 'json', token: TOK }))).json()
  : { features: [] };
console.log('   features uploaded by this run:', res.features.length);
for (const f of res.features) {
  const a = f.attributes;
  const att = await (await fetch(`${layer}/${a.OBJECTID}/attachments?f=json&token=${TOK}`)).json();
  const info = (att.attachmentInfos || [])[0];
  console.log(`   OBJECTID ${a.OBJECTID}: azimuth=${a.esrisnsr_azimuth} lat=${a.esrignss_latitude} hrms=${a.esrignss_h_rms} recv="${a.esrignss_receiver}" attachment=${info ? info.name + ' ' + info.size + 'B' : 'NONE'}`);
  if (!info) fail('feature ' + a.OBJECTID + ' has no photo attached');
  if (info && info.size < 5000) fail('attachment suspiciously small: ' + info.size);
  if (a.esrisnsr_azimuth === null) fail('heading not recorded on server');
}
if (res.features.length !== 2) fail('expected 2 features from this run');
else ok('both photos on the server with attachments and headings');

step('take one back off the layer');
page.on('dialog', d => d.accept());
await page.click('#chip-queue');
await page.waitForTimeout(500);
const unsendable = await page.locator('.qunsend').count();
if (unsendable !== 2) fail(`expected an "undo upload" control on both sent rows, got ${unsendable}`);
else ok('uploaded rows offer a remove-from-layer control');
const targetOid = mineIds[0];
await page.locator('.qunsend').first().click();
await page.waitForTimeout(2500);
const left = await (await fetch(layer + '/query?' + new URLSearchParams({
  where: '1=1', returnIdsOnly: 'true', f: 'json', token: TOK }))).json();
const stillMine = (left.objectIds || []).filter(id => !BASELINE.has(id));
if (stillMine.length !== 1) fail(`expected one of our two features to be gone, ${stillMine.length} remain`);
else ok(`removed a photo from the layer after upload (${stillMine.length} of ours left)`);
if (await page.locator('.qrow').count() !== 1) fail('the row should leave the queue once it is off the layer');
else ok('and it leaves the queue');
await page.keyboard.press('Escape');
await page.waitForTimeout(300);

step('settings + schema probe');
await page.click('#menu-btn'); await page.waitForTimeout(250);
await page.click('#mi-settings'); await page.waitForTimeout(350);
await page.locator('#settings-panel details').first().click();
await page.click('#s-probe');
await page.waitForTimeout(2500);
console.log('   probe:', (await page.locator('#s-schema').innerText()).replace(/\n/g, ' | '));
if (!(await page.locator('#s-schema').innerText()).includes('esrisnsr_azimuth')) fail('schema probe did not resolve fields');
else ok('schema probe resolves live fields');
await page.screenshot({ path: OUT + '/shot-settings.png' });
await page.keyboard.press('Escape'); await page.waitForTimeout(300);

step('menu + service worker');
await page.click('#menu-btn'); await page.waitForTimeout(350);
await page.screenshot({ path: OUT + '/shot-menu.png' });
const sw = await page.evaluate(() => navigator.serviceWorker.getRegistrations().then(r => r.length));
if (!sw) fail('service worker not registered'); else ok('service worker registered');
const cached = await page.evaluate(() => caches.keys().then(k => caches.open(k[0]).then(c => c.keys().then(ks => ({ name: k[0], n: ks.length })))));
console.log('   cache:', JSON.stringify(cached));
if (cached.n < 8) fail('app shell not fully precached');
else ok(`app shell precached (${cached.n} entries in ${cached.name})`);
await page.keyboard.press('Escape'); await page.waitForTimeout(200);

step('cold start with no network at all (true offline launch)');
await setOffline(true);
await ctx.setOffline(true);
const p2 = await ctx.newPage();
const errs2 = [];
p2.on('pageerror', e => errs2.push(e.message));
await p2.goto(URLBASE, { waitUntil: 'domcontentloaded' });
await p2.waitForTimeout(1500);
const shellOk = await p2.evaluate(() => !!document.getElementById('shutter') && !!document.getElementById('dial').children.length);
if (!shellOk) fail('offline cold start did not render'); else ok('app boots fully offline from cache');
if (errs2.length) console.log('   offline page errors:', errs2.join(' | '));
await p2.screenshot({ path: OUT + '/shot-coldoffline.png' });
await ctx.setOffline(false);
await setOffline(false);

step('cleanup server');
console.log('   ', await cleanup());

console.log('\nconsole errors:', errs.length ? errs.join('\n  ') : 'none');
if (errs.filter(e => !/favicon/i.test(e)).length) fail('console errors present');
await browser.close();
console.log(process.exitCode ? '\nSOME CHECKS FAILED' : '\nall UI checks passed');
