/* Exotic Camera and Photo Points share one origin (every GitHub Pages site of
   the account does), so they share CacheStorage, service-worker registrations
   and IndexedDB. Neither may take the other down: an update or a Reinstall in
   one must leave the other's offline copy alone, and Photo Points must open
   with no signal from its own cache, not be answered with Exotic Camera. */
import { URLBASE } from './env-lite.mjs';
import { chromium, CHROME, waitForAsync } from './browser.mjs';

const ROOTURL = URLBASE;
const PP = new URL('photopoints/', URLBASE).href;
const fail = (m) => { console.log('  FAIL', m); process.exitCode = 1; };
const ok = (m) => console.log('  ok  ', m);

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});
const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, permissions: ['camera', 'geolocation'],
  geolocation: { latitude: 27.9, longitude: -82.4, accuracy: 5 } });
await ctx.route('**://*.arcgis.com/**', (r) => r.abort('internetdisconnected'));   // nothing here needs the service
const page = await ctx.newPage();
page.on('dialog', (d) => d.accept());
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));

const cacheNames = () => page.evaluate(() => caches.keys());
const scopes = () => page.evaluate(() => navigator.serviceWorker.getRegistrations().then((rs) => rs.map((r) => new URL(r.scope).pathname)));
const swReady = () => waitForAsync(page, () => navigator.serviceWorker.ready.then((r) => !!r.active && !!navigator.serviceWorker.controller), null, { timeout: 20000 });

console.log('\n== both apps installed on one origin');
await page.goto(ROOTURL + '?coexist=1', { waitUntil: 'load' });
await swReady();
await page.goto(PP + '?coexist=1', { waitUntil: 'load' });
await page.waitForFunction(() => self.__ppReady, null, { timeout: 15000 });
await swReady();
await page.waitForTimeout(800);
let names = await cacheNames();
const ec = names.filter((n) => n.startsWith('exoticcam-')), pp = names.filter((n) => n.startsWith('photopoints-'));
if (!ec.length || !pp.length) fail('expected a cache for each app, got ' + JSON.stringify(names));
else ok('each app has its own cache: ' + names.join(', '));
const sc = await scopes();
if (!sc.some((s) => /\/photopoints\/$/.test(s)) || !sc.some((s) => !/photopoints/.test(s))) fail('scopes ' + JSON.stringify(sc));
else ok('each app has its own worker: ' + sc.join(', '));
const dbs = await page.evaluate(() => indexedDB.databases().then((d) => d.map((x) => x.name)));
if (!dbs.includes('photopoints')) fail('no photopoints database: ' + JSON.stringify(dbs)); else ok('separate databases: ' + dbs.join(', '));

/* A worker only runs its clean-up when it activates. Re-registering one that
   is still in charge just revives the old registration, so the honest test
   is the real sequence: one app already installed, the other opened for the
   first time on the same phone. */
async function firstVisitAfter(firstUrl, secondUrl, probe) {
  const c = await browser.newContext({ permissions: ['camera', 'geolocation'], geolocation: { latitude: 27.9, longitude: -82.4, accuracy: 5 } });
  await c.route('**://*.arcgis.com/**', (r) => r.abort('internetdisconnected'));
  const p = await c.newPage();
  const ready = () => waitForAsync(p, () => navigator.serviceWorker.ready.then((r) => !!r.active), null, { timeout: 20000 });
  await p.goto(firstUrl, { waitUntil: 'load' });
  await ready();
  await p.waitForTimeout(800);
  await p.evaluate((name) => caches.open(name).then((cc) => cc.put('/probe', new Response('x'))), probe);
  const before = await p.evaluate(() => caches.keys());
  await p.goto(secondUrl, { waitUntil: 'load' });
  await waitForAsync(p, (want) => navigator.serviceWorker.getRegistrations().then((rs) => rs.length === 2 && rs.every((r) => r.active)), null, { timeout: 20000 });
  await p.waitForTimeout(1000);
  const after = await p.evaluate(() => caches.keys());
  await c.close();
  return { before, after };
}

console.log('\n== Exotic Camera opened for the first time, Photo Points already installed');
{
  const r = await firstVisitAfter(PP + '?coexist=2', ROOTURL + '?coexist=2', 'photopoints-probe');
  const kept = r.before.filter((n) => n.startsWith('photopoints-')).every((n) => r.after.includes(n));
  if (!kept) fail('Exotic Camera\'s activation deleted Photo Points\' caches: before ' + JSON.stringify(r.before) + ' after ' + JSON.stringify(r.after));
  else ok('Photo Points\' caches survive Exotic Camera activating: ' + r.after.join(', '));
}

console.log('\n== Photo Points opened for the first time, Exotic Camera already installed');
{
  const r = await firstVisitAfter(ROOTURL + '?coexist=3', PP + '?coexist=3', 'exoticcam-probe');
  const kept = r.before.filter((n) => n.startsWith('exoticcam-')).every((n) => r.after.includes(n));
  if (!kept) fail('Photo Points\' activation deleted Exotic Camera\'s caches: before ' + JSON.stringify(r.before) + ' after ' + JSON.stringify(r.after));
  else ok('Exotic Camera\'s caches survive Photo Points activating: ' + r.after.join(', '));
}

console.log('\n== Reinstall in Exotic Camera');
await page.goto(ROOTURL + '?coexist=4', { waitUntil: 'load' });
await page.waitForTimeout(1200);
await page.click('#menu-btn');
await page.waitForTimeout(400);
await Promise.all([page.waitForNavigation({ timeout: 20000 }), page.click('#mi-reinstall')]);
await page.waitForTimeout(1500);
const sc2 = await scopes();
names = await cacheNames();
if (!sc2.some((s) => /\/photopoints\/$/.test(s))) fail('Exotic Camera\'s Reinstall unregistered Photo Points: ' + JSON.stringify(sc2));
else ok('Photo Points is still installed after Exotic Camera\'s Reinstall');
if (!names.some((n) => n.startsWith('photopoints-') && n !== 'photopoints-probe')) fail('Reinstall wiped Photo Points\' cache: ' + JSON.stringify(names));
else ok('and keeps its offline copy');

console.log('\n== Photo Points with no signal at all');
await page.goto(PP + '?coexist=5', { waitUntil: 'load' });
await page.waitForFunction(() => self.__ppReady, null, { timeout: 15000 });
await swReady();
await page.evaluate(() => self.Store.set('stations', { at: Date.now() - 3600e3, list: [{ gid: '{00000000-0000-4000-8000-000000000001}', id: 'OFF-PS01', site: 'Offline Preserve', mu: '', postInstalled: 'No', lat: 27.9, lon: -82.4 }], stats: {} }));
await ctx.setOffline(true);
await page.reload({ waitUntil: 'load' });
let booted = false;
try { await page.waitForFunction(() => self.__ppReady, null, { timeout: 15000 }); booted = true; } catch (e) { /* reported below */ }
const title = await page.title();
if (!booted || title !== 'Photo Points') fail(`offline reload gave "${title}" (booted ${booted})`);
else ok('opens offline, served by its own worker');
const listed = await page.locator('.st-main b').allTextContents();
if (!listed.some((t) => t.startsWith('OFF-PS01'))) fail('stations not shown offline: ' + JSON.stringify(listed)); else ok('the station list works offline');
await page.goto(PP + 'js/app.js?x=' + Date.now()).catch(() => {});
await ctx.setOffline(false);

if (errs.length) fail('page errors: ' + errs.join(' | ')); else ok('no page errors');
await browser.close();
console.log(process.exitCode ? '\nFAILED' : '\nthe two apps live together');
