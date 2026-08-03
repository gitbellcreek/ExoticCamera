/* Reproduce: airplane mode + fully close the app + reopen.
   The key difference from "go offline in a running tab" is that the service
   worker starts from cold, so its top-level importScripts run with no network. */
import { ROOT, OUT, FIXTURES, URLBASE, TOK, REFERER, arcFetch } from './env.mjs';
import { chromium, CHROME, relayArcGIS } from './browser.mjs';

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});
const fail = (m) => { console.log('  FAIL', m); process.exitCode = 1; };
const ok = (m) => console.log('  ok  ', m);

const ctx = await browser.newContext({
  viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
  permissions: ['camera', 'geolocation'],
  geolocation: { latitude: 30.2672, longitude: -97.7431, accuracy: 6 },
  serviceWorkers: 'allow',
});

// ── 1. a normal online visit, so everything is installed and cached
const warm = await ctx.newPage();
await warm.goto(URLBASE, { waitUntil: 'networkidle' });
await warm.waitForTimeout(2500);
console.log('== warm-up');
ok('service workers: ' + (await warm.evaluate(() => navigator.serviceWorker.getRegistrations().then(r => r.length))));
ok('cached entries: ' + await warm.evaluate(() => caches.keys().then(k => caches.open(k[0]).then(c => c.keys().then(x => x.length)))));
await warm.close();

// ── 1b. simulate what a deploy that ADDS a file leaves behind: the cached
// index.html references js/report.js, but that file was never fetched, so the
// cache is one entry short.
const evict = await ctx.newPage();
await evict.goto(URLBASE, { waitUntil: 'domcontentloaded' });
await evict.waitForTimeout(800);
const evicted = await evict.evaluate(async () => {
  const names = await caches.keys();
  const c = await caches.open(names[0]);
  const keys = await c.keys();
  const target = keys.find(r => r.url.endsWith('js/report.js'));
  if (!target) return 'not cached in the first place';
  await c.delete(target);
  return target.url;
});
console.log('\n== partial cache (a deploy added a file)');
console.log('   evicted from cache:', evicted);
await evict.close();

// ── 2. airplane mode, and kill the worker so it must start cold
console.log('\n== airplane mode, worker restarted cold');
const cdp = await browser.newBrowserCDPSession();
await cdp.send('ServiceWorker.enable').catch(() => {});
await ctx.setOffline(true);
// stop every running worker: reopening a closed app starts one from scratch
const targets = await cdp.send('Target.getTargets').catch(() => ({ targetInfos: [] }));
for (const t of targets.targetInfos || []) {
  if (t.type === 'service_worker') {
    await cdp.send('Target.closeTarget', { targetId: t.targetId }).catch(() => {});
    console.log('   stopped worker:', t.url);
  }
}

// ── 3. cold open with no network at all
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

let navFailed = null;
await page.goto(URLBASE, { waitUntil: 'domcontentloaded' }).catch(e => { navFailed = e.message; });
await page.waitForTimeout(3000);

if (navFailed) fail('the app would not even load: ' + navFailed);

const st = await page.evaluate(() => ({
  html: document.documentElement.innerHTML.length,
  shutter: !!document.getElementById('shutter'),
  dialTicks: document.getElementById('dial') ? document.getElementById('dial').children.length : 0,
  novideoHidden: document.getElementById('novideo') ? document.getElementById('novideo').classList.contains('hidden') : null,
  hasStore: typeof self.Store !== 'undefined',
  hasConfig: typeof self.Config !== 'undefined',
  hasArc: typeof self.Arc !== 'undefined',
  hasReport: typeof self.Report !== 'undefined',
  hasSound: typeof self.Sound !== 'undefined',
  toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent),
  video: (() => { const v = document.getElementById('preview'); return v ? { w: v.videoWidth, paused: v.paused } : null; })(),
})).catch(e => ({ evalFailed: e.message }));

console.log('   state:', JSON.stringify(st));
console.log('   errors:', errs.length ? errs.join(' | ') : 'none');

if (st.evalFailed) fail('page is not running JS at all: ' + st.evalFailed);
else {
  if (!st.shutter || !st.dialTicks) fail('shell did not render');
  else ok('shell rendered (' + st.dialTicks + ' dial ticks)');

  for (const [n, present] of [['Store', st.hasStore], ['Config', st.hasConfig], ['Arc', st.hasArc],
                              ['Report', st.hasReport], ['Sound', st.hasSound]]) {
    if (!present) fail(`${n} failed to load offline — a script came back as something else`);
  }
  if (st.hasStore && st.hasConfig && st.hasArc && st.hasReport && st.hasSound) ok('every script loaded from cache');

  // the camera is the visible symptom: either a live preview or a clear message,
  // never a silent black rectangle
  if (st.video && st.video.w) ok('viewfinder live offline (' + st.video.w + 'px)');
  else if (st.novideoHidden === false) ok('camera unavailable, but the app says so on screen');
  else fail('black screen: no video and no message — exactly the reported symptom');
}
if (errs.length) fail('errors during a cold offline start');

await page.screenshot({ path: OUT + '/shot-coldstart.png' });

// ── 4. the worker must never answer a script request with HTML
console.log('\n== a missing file offline must not poison the app');
const probe = await page.evaluate(async () => {
  const r = await fetch('js/does-not-exist.js');
  const body = await r.text();
  return { status: r.status, startsWithHtml: /^\s*<|^<!doctype/i.test(body), len: body.length };
});
console.log('   uncached script offline →', JSON.stringify(probe));
if (probe.startsWithHtml) fail('served HTML in place of a script — this is what kills the app');
else ok(`served ${probe.status} instead of HTML`);

// the navigation that actually happens: reopening the app itself, offline
for (const target of ['', 'index.html', '?utm=x']) {
  const navPage = await ctx.newPage();
  await navPage.goto(URLBASE + target, { waitUntil: 'domcontentloaded' }).catch(() => {});
  const isShell = await navPage.evaluate(() => !!document.getElementById('shutter')).catch(() => false);
  if (!isShell) fail(`opening "${URLBASE + target}" offline did not render the app`);
  else ok(`opens offline at "${target || './'}"`);
  await navPage.close();
}

// ── 5. app must survive a module that failed to load
console.log('\n== a missing report.js must not stop the camera');
const ctx2 = await browser.newContext({
  viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true,
  permissions: ['camera', 'geolocation'],
  geolocation: { latitude: 30.2672, longitude: -97.7431, accuracy: 6 },
});
await ctx2.route('**/js/report.js', r => r.fulfill({ status: 504, body: '' }));
const p2 = await ctx2.newPage();
const e2 = [];
p2.on('pageerror', e => e2.push(e.message));
await p2.goto(URLBASE + '?noreport=1', { waitUntil: 'domcontentloaded' });
await p2.waitForTimeout(2500);
const s2 = await p2.evaluate(() => ({
  booted: !!self.__ecBooted,
  video: (() => { const v = document.getElementById('preview'); return v ? v.videoWidth : 0; })(),
  novideoHidden: document.getElementById('novideo').classList.contains('hidden'),
}));
console.log('   state:', JSON.stringify(s2), '| errors:', e2.join(' | ') || 'none');
if (!s2.booted) fail('app did not boot without report.js');
else if (!s2.video && s2.novideoHidden) fail('black screen when report.js is missing');
else ok('camera still runs with report.js missing');
await ctx2.close();

// ── 6. a camera that never answers must not leave a black screen
console.log('\n== a camera that never responds');
const ctx3 = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true });
await ctx3.addInitScript(() => {
  navigator.mediaDevices.getUserMedia = () => new Promise(() => {});   // never settles
});
const p3 = await ctx3.newPage();
await p3.goto(URLBASE + '?hang=1', { waitUntil: 'domcontentloaded' });
await p3.waitForTimeout(10000);
const s3 = await p3.evaluate(() => ({
  hidden: document.getElementById('novideo').classList.contains('hidden'),
  msg: document.getElementById('novideo-msg').textContent,
}));
console.log('   ', JSON.stringify(s3));
if (s3.hidden) fail('camera hung and the app just showed black');
else ok('camera hang surfaces a message: "' + s3.msg + '"');
await ctx3.close();

// ── 7. app.js missing entirely — the watchdog must speak up
console.log('\n== app.js itself fails to load');
const ctx4 = await browser.newContext({ viewport: { width: 393, height: 852 } });
await ctx4.route('**/js/app.js', r => r.fulfill({ status: 504, body: '' }));
const p4 = await ctx4.newPage();
await p4.goto(URLBASE + '?noapp=1', { waitUntil: 'domcontentloaded' });
await p4.waitForTimeout(5000);
const s4 = await p4.evaluate(() => ({
  hidden: document.getElementById('novideo').classList.contains('hidden'),
  msg: document.getElementById('novideo-msg').textContent,
}));
if (s4.hidden) fail('app.js missing → silent black screen');
else ok('watchdog explains it: "' + s4.msg + '"');
await ctx4.close();

await browser.close();
console.log(process.exitCode ? '\nREPRODUCED / STILL BROKEN' : '\ncold offline start is clean');
