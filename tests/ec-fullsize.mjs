/* Exotic Camera's full-size switch. The ⛶ button on the camera screen turns
   it on and off (and stays as set after a reload); Settings has the same
   switch. With it off, a photo added from the phone is shrunk to 1600 px as
   before; with it on, a JPEG is kept exactly as the phone has it — the same
   bytes, so every pixel and its location and bearing — and marked full size.
   Nothing is sent: the service is unreachable throughout. */
import fs from 'node:fs';
import path from 'node:path';
import { URLBASE, ROOT } from './env-lite.mjs';
import { chromium, CHROME } from './browser.mjs';

const fail = (m) => { console.log('  FAIL', m); process.exitCode = 1; };
const ok = (m) => console.log('  ok  ', m);
const BIG = path.join(ROOT, 'tests/fixtures/full_gps.jpg');            // 3200×2400, GPS and a 271.5° bearing
const bigBytes = fs.readFileSync(BIG);

const browser = await chromium.launch({ executablePath: CHROME, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true,
  permissions: ['camera', 'geolocation'], geolocation: { latitude: 27.79, longitude: -82.42, accuracy: 5 } });
await ctx.route('**://*.arcgis.com/**', (r) => r.abort('internetdisconnected'));
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(URLBASE + '?fullsize', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => self.Config && self.Store && document.getElementById('size-toggle'), null, { timeout: 15000 });
await page.waitForTimeout(800);

console.log('== the switch');
const label = () => page.locator('#size-label').innerText();
if (await label() !== '1600 px') fail('off by default should read "1600 px": ' + await label()); else ok('off by default: the button reads "1600 px"');
const box = await page.locator('#size-toggle').boundingBox();
if (!box || box.x < 0 || box.y < 0 || box.x + box.width > 393) fail('the button is not on screen: ' + JSON.stringify(box)); else ok('the button sits on the camera screen');
await page.click('#size-toggle');
await page.waitForFunction(() => self.Config.get().fullSize === true, null, { timeout: 3000 }).catch(() => {});
if (await label() !== 'Full size' || !(await page.evaluate(() => self.Config.get().fullSize))) fail('one tap did not turn it on');
else ok('one tap: "Full size", and the setting is on');
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => self.Config && document.getElementById('size-label').textContent === 'Full size', null, { timeout: 8000 })
  .then(() => ok('it stays on after the app is reopened'), () => fail('the setting did not survive a reload'));
await page.click('#menu-btn'); await page.waitForTimeout(300);
await page.click('#mi-settings'); await page.waitForTimeout(400);
if (!await page.locator('#s-fullsize').isChecked()) fail('Settings does not show it on'); else ok('Settings shows the same switch, on');
await page.locator('#s-fullsize').uncheck();
await page.click('#s-save').catch(() => page.locator('text=Save').first().click());
await page.waitForTimeout(600);
if (await label() !== '1600 px') fail('turning it off in Settings did not update the button'); else ok('turning it off in Settings updates the button');

async function importBig() {
  await page.evaluate(() => self.Store.all().then((rs) => Promise.all(rs.map((r) => self.Store.remove ? self.Store.remove(r.id) : null))));
  await page.setInputFiles('#import-files', BIG);
  await page.waitForFunction(() => /Done/.test(document.getElementById('import-status').textContent), null, { timeout: 30000 });
  await page.keyboard.press('Escape'); await page.waitForTimeout(300);
  return page.evaluate(async () => {
    const rs = (await self.Store.all()).sort((a, b) => b.createdAt - a.createdAt);
    const r = rs[0];
    const b = await self.Store.photo(r.id);
    return { w: r.w, h: r.h, full: !!r.full, bytes: r.bytes, heading: r.heading, lat: r.lat, size: b.size,
      data: Array.from(new Uint8Array(await b.arrayBuffer())) };
  });
}

console.log('\n== a photo from the phone, full size off');
{
  const r = await importBig();
  if (Math.max(r.w, r.h) !== 1600) fail('expected the long edge shrunk to 1600: ' + r.w + '×' + r.h); else ok('shrunk to ' + r.w + '×' + r.h + ', as before');
  if (r.full) fail('marked full size'); else ok('not marked full size');
}

console.log('\n== a photo from the phone, full size on');
{
  await page.click('#size-toggle');
  await page.waitForFunction(() => self.Config.get().fullSize === true, null, { timeout: 3000 });
  const r = await importBig();
  if (r.w !== 3200 || r.h !== 2400) fail('expected 3200×2400: ' + r.w + '×' + r.h); else ok('kept at 3200×2400');
  const same = r.size === bigBytes.length && Buffer.compare(Buffer.from(r.data), bigBytes) === 0;
  if (!same) fail(`the bytes changed (${r.size} vs ${bigBytes.length})`); else ok('the very same bytes as on the phone: nothing re-encoded, nothing stripped');
  if (!r.full || r.bytes !== bigBytes.length) fail('not marked full size with its size'); else ok('marked full size, ' + (r.bytes / 1024).toFixed(0) + ' KB');
  if (Math.abs(r.heading - 271.5) > 0.1 || Math.abs(r.lat - 27.79153) > 0.0001) fail('location or bearing not read: ' + JSON.stringify([r.lat, r.heading]));
  else ok('its location and bearing were read from the photo (' + r.heading + '°)');
}

console.log('\n== the queue says so');
await page.click('#menu-btn'); await page.waitForTimeout(300);
await page.click('#mi-queue'); await page.waitForTimeout(500);
const q = await page.locator('#queue-list').innerText().catch(() => '');
if (!/full size/i.test(q)) fail('the queue does not mark the full-size photo: ' + q.slice(0, 200)); else ok('the queue row says "full size" and its size');

if (errs.length) fail('page errors: ' + errs.join('; ')); else ok('no page errors');
await browser.close();
console.log(process.exitCode ? '\nFAILED' : '\nthe full-size switch works');
