/* Photo Points GPS: a position watch that iOS stops feeding is noticed and
   started again. The field report: the arrows kept turning but the distance
   to the station stopped changing while walking away, and nothing short of
   closing the app brought the GPS back. Here a stand-in for the phone's GPS
   goes quiet (or keeps handing back the same cached fix) and the page clock
   is run forward: the app must start a new watch, take the new positions,
   and show the fix's real age meanwhile. Also: tapping the GPS chip, and the
   page coming back on screen, both get a fresh watch. No sign-in, no service. */
import { URLBASE } from './env-lite.mjs';
import { chromium, CHROME } from './browser.mjs';

const APP = new URL('photopoints/', URLBASE).href;
const fail = (m) => { console.log('  FAIL', m); process.exitCode = 1; };
const ok = (m) => console.log('  ok  ', m);

const STATIONS = [{ gid: '{00000000-0000-4000-8000-000000000010}', oid: 1, id: 'BBS-PS10', site: 'Balm Boyette Scrub', mu: '19b',
  habitat: '', postInstalled: 'Yes', postType: '', postTag: '', installDate: null, status: 'Active', notes: '', lat: 27.79, lon: -82.23 }];

const browser = await chromium.launch({ executablePath: CHROME });
const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true });
await ctx.route('**://*.arcgis.com/**', (r) => r.abort('internetdisconnected'));
// the phone's GPS, under the test's control: each watch gets an id; only the
// newest watch is fed, and the test decides when a watch "goes quiet"
await ctx.addInitScript(() => {
  const G = self.__gps = { watches: [], cleared: [], next: 1 };
  const geo = {
    watchPosition(ok, err, opts) { const id = G.next++; G.watches.push({ id, ok, err, opts, live: true }); return id; },
    clearWatch(id) { G.cleared.push(id); const w = G.watches.find(x => x.id === id); if (w) w.live = false; },
    getCurrentPosition(ok) { G.fix && ok(G.fix); },
  };
  Object.defineProperty(navigator, 'geolocation', { get: () => geo, configurable: true });
  G.feed = (lat, lon, stamp) => {
    G.fix = { coords: { latitude: lat, longitude: lon, accuracy: 4, altitude: null }, timestamp: stamp || Date.now() };
    const w = G.watches.filter(x => x.live).pop();
    if (w && !G.quiet) w.ok(G.fix);
    return !!w;
  };
});
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.clock.install();
await page.goto(APP + '?gps', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => self.__ppReady, null, { timeout: 15000 });
await page.evaluate((list) => self.Store.set('stations', { at: Date.now(), list, stats: {} }), STATIONS);
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => document.querySelectorAll('.st').length === 1, null, { timeout: 15000 });

const watches = () => page.evaluate(() => self.__gps.watches.length);
const dist = () => page.locator('.st').first().innerText();
const chip = () => page.locator('#chip-gps .label').innerText();

// walking: fixes every few seconds, the distance changes
let lat = 27.7905;
await page.evaluate((l) => self.__gps.feed(l, -82.23), lat);
await page.clock.runFor(2000);
const d0 = await dist();
// the list redraws distances every 30s or 25 m walked; keep walking past that
for (let i = 0; i < 12; i++) { lat += 0.0003; await page.evaluate((l) => self.__gps.feed(l, -82.23), lat); await page.clock.runFor(3000); }
const d1 = await dist();
if (d0 === d1) fail('the distance did not change while fixes were coming in: ' + d0);
else ok('walking: the distance follows the fixes');
const n0 = await watches();
if (n0 !== 1) fail('expected one watch at the start, got ' + n0); else ok('one position watch running');

// iOS stops feeding the watch
await page.evaluate(() => { self.__gps.quiet = true; });
await page.clock.runFor(30000);
const n1 = await watches();
if (n1 <= n0) fail('the watch went quiet for 30s and was not restarted');
else ok(`the watch went quiet and was started again (${n1 - n0} restart${n1 - n0 > 1 ? 's' : ''})`);
const cleared = await page.evaluate(() => self.__gps.cleared.length);
if (!cleared) fail('the old watch was not cleared'); else ok('the old watch is cleared first, so they do not pile up');
const label = await chip();
if (!/·/.test(label)) fail('the GPS chip does not show that the fix is old: ' + label); else ok('meanwhile the GPS chip shows the fix is old: ' + label);

// the new watch is fed: the app picks the positions up again
await page.evaluate(() => { self.__gps.quiet = false; });
lat += 0.002;
for (let i = 0; i < 12; i++) { await page.evaluate((l) => self.__gps.feed(l, -82.23), lat); await page.clock.runFor(3000); }
const d2 = await dist();
if (d2 === d1) fail('after the restart the distance still did not move: ' + d2); else ok('after the restart the distance moves again');
if (/·/.test(await chip())) fail('the chip still says the fix is old'); else ok('and the chip shows a fresh fix');

// the same cached fix handed back again is not a new fix
const stamp = await page.evaluate(() => Date.now());
await page.evaluate(([l, s]) => self.__gps.feed(l, -82.23, s), [lat, stamp]);
for (let i = 0; i < 12; i++) { await page.clock.runFor(5000); await page.evaluate(([l, s]) => self.__gps.feed(l, -82.23, s), [lat, stamp]); }
const label2 = await chip();
if (!/·/.test(label2)) fail('the same cached fix repeated for a minute still looks fresh: ' + label2);
else ok('the same cached fix, repeated, is shown as old (' + label2 + ')');

// tapping the GPS chip is a real refresh
const n3 = await watches();
await page.click('#chip-gps');
if (await watches() !== n3 + 1) fail('tapping the GPS chip did not start a fresh watch'); else ok('tapping the GPS chip starts a fresh watch');

// coming back on screen
const n4 = await watches();
await page.clock.runFor(20000);
await page.evaluate(() => {
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
});
if (await watches() <= n4) fail('coming back on screen with an old fix did not restart the watch'); else ok('coming back on screen restarts the watch');

if (errs.length) fail('page errors: ' + errs.join('; ')); else ok('no page errors');
await browser.close();
console.log(process.exitCode ? '\nFAILED' : '\nthe GPS comes back when iOS lets it go');
