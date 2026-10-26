/* Photo Points layout: nothing off-screen or overlapping, on the smallest and
   largest iPhones, upright and on their side. All ten slots must be in view
   without scrolling — a slot you cannot see is a photo you do not take.
   Works from a station list put straight into the phone's storage, so it
   needs no sign-in and touches no service. */
import { URLBASE } from './env-lite.mjs';
import { chromium, CHROME, waitForAsync } from './browser.mjs';

const APP = new URL('photopoints/', URLBASE).href;
const fail = (m) => { console.log('  FAIL', m); process.exitCode = 1; };
const ok = (m) => console.log('  ok  ', m);

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});

const STATIONS = Array.from({ length: 12 }, (_, i) => ({
  gid: '{00000000-0000-4000-8000-0000000000' + String(10 + i) + '}', oid: i + 1, id: 'LKD-PS' + String(i + 1).padStart(2, '0'),
  site: 'Lake Dan Nature Preserve', mu: 'LKD_3' + i, habitat: '', postInstalled: i % 3 ? 'No' : 'Yes', postType: '', postTag: '',
  installDate: null, status: 'Active', notes: '', lat: 28.17 + i * 0.001, lon: -82.54,
}));

const inside = (b, w, h) => b && b.x >= -0.5 && b.y >= -0.5 && b.x + b.width <= w + 0.5 && b.y + b.height <= h + 0.5;
const overlap = (a, b) => a && b && a.x < b.x + b.width - 1 && b.x < a.x + a.width - 1 && a.y < b.y + b.height - 1 && b.y < a.y + a.height - 1;

for (const [name, w, h] of [['iPhone SE', 375, 667], ['iPhone 15', 393, 852], ['iPhone 15 Pro Max', 430, 932],
                            ['SE landscape', 667, 375], ['15 landscape', 852, 393]]) {
  console.log(`\n== ${name} ${w}x${h}`);
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: true, hasTouch: true,
    permissions: ['camera', 'geolocation'], geolocation: { latitude: 28.169, longitude: -82.54, accuracy: 5 } });
  await ctx.route('**://*.arcgis.com/**', (r) => r.abort('internetdisconnected'));
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(APP + '?land=' + w, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => self.__ppReady, null, { timeout: 15000 });
  await page.evaluate((list) => self.Store.set('stations', { at: Date.now(), list, stats: {} }), STATIONS);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelectorAll('.st').length === 12, null, { timeout: 15000 });

  // ── the station list
  const box = (sel) => page.locator(sel).first().boundingBox();
  const scrollW = await page.evaluate(() => document.documentElement.scrollWidth);
  if (scrollW > w + 1) fail(`list scrolls sideways: ${scrollW}px wide`); else ok('no sideways scroll on the list');
  const [brand, chips, menu, fab, row] = await Promise.all(['.brand', '.chips', '#menu-btn', '#new-station-btn', '.st'].map(box));
  for (const [n, b] of [['brand', brand], ['chips', chips], ['menu', menu], ['new-station button', fab], ['first row', row]])
    if (!inside(b, w, h)) fail(`${n} off-screen: ${JSON.stringify(b)}`);
  if (overlap(brand, chips) || overlap(chips, menu)) fail('header items overlap'); else ok('header fits on one line');
  if (chips.height > 40) fail('status chips wrapped onto two lines'); else ok('status chips on one line');

  // ── the camera
  await page.locator('.st').first().click();
  await page.click('#sp-start');
  await page.waitForFunction(() => document.body.classList.contains('view-cam'), null, { timeout: 10000 });
  await page.waitForTimeout(600);
  const slots = await page.locator('.slot').evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return { k: e.dataset.slot, x: r.x, y: r.y, width: r.width, height: r.height }; }));
  const hidden = slots.filter((s) => !inside(s, w, h));
  if (slots.length !== 10) fail(slots.length + ' slots drawn');
  else if (hidden.length) fail('slots off-screen: ' + hidden.map((s) => s.k).join(', '));
  else ok('all ten slots on screen');
  const crowded = slots.filter((a, i) => slots.some((b, j) => i !== j && overlap(a, b)));
  if (crowded.length) fail('slots overlap: ' + crowded.map((s) => s.k).join(', ')); else ok('no two slots overlap');
  const parts = {};
  for (const sel of ['#compass', '#cam-info', '#cam-close', '#shutter', '#finish', '#review', '#details-btn', '#chip-cal', '#aim-text', '#level']) {
    parts[sel] = await box(sel);
  }
  const off = Object.entries(parts).filter(([k, b]) => b && !inside(b, w, h)).map(([k]) => k);
  if (off.length) fail('off-screen: ' + off.join(', ')); else ok('compass, shutter, Done and the tools all on screen');
  const controls = ['#shutter', '#finish', '#review', '#details-btn', '#chip-cal'];
  const clash = [];
  for (const a of controls) for (const b of controls) if (a < b && overlap(parts[a], parts[b])) clash.push(a + '/' + b);
  for (const s of slots) for (const c of controls) if (overlap(s, parts[c])) clash.push(s.k + '/' + c);
  for (const top of ['#compass', '#cam-info', '#cam-close']) for (const c of controls) if (overlap(parts[top], parts[c])) clash.push(top + '/' + c);
  if (clash.length) fail('controls overlap: ' + clash.join(', ')); else ok('no control sits on another');

  // ── a sheet over the camera
  await page.click('#finish');
  await page.waitForTimeout(400);
  const sheet = await box('#details-panel .sheet-inner');
  const btn = await box('#dp-finish');
  if (!inside(sheet, w, h)) fail('visit details sheet is taller than the screen without scrolling: ' + JSON.stringify(sheet));
  else ok('visit details sheet fits');
  await page.locator('#dp-finish').scrollIntoViewIfNeeded();
  if (!inside(await box('#dp-finish'), w, h)) fail('cannot reach "Save & upload": ' + JSON.stringify(btn)); else ok('"Save & upload" reachable');

  await page.screenshot({ path: new URL('./.out/pp-land-' + w + 'x' + h + '.png', import.meta.url).pathname });
  if (errs.length) fail('page errors: ' + errs.join(' | '));
  await ctx.close();
}

await browser.close();
console.log(process.exitCode ? '\nFAILED' : '\nall layout checks passed');
