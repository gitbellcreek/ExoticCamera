/* The experiment that failed: save a photo out of the queue, put it back in.
   A photo the app produces must carry its own position and heading. */
import { ROOT, OUT, FIXTURES, URLBASE, TOK, REFERER, arcFetch } from './env.mjs';
import { chromium, CHROME, relayArcGIS } from './browser.mjs';
import fs from 'node:fs';

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});
const fail = (m) => { console.log('  FAIL', m); process.exitCode = 1; };
const ok = (m) => console.log('  ok  ', m);
const near = (a, b, tol) => typeof a === 'number' && Math.abs(a - b) <= tol;

const LAT = 27.840965, LON = -82.301417;

const ctx = await browser.newContext({
  viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true,
  permissions: ['camera', 'geolocation'],
  geolocation: { latitude: LAT, longitude: LON, accuracy: 9 },
});
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push(e.message));
const downloads = [];
page.on('download', async d => downloads.push({ name: d.suggestedFilename(), path: await d.path() }));

await page.goto(URLBASE + '?rt=1', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => document.getElementById('preview').videoWidth > 0, null, { timeout: 15000 });

console.log('== take a photo with a heading');
await page.evaluate(() => {
  const e = new Event('deviceorientationabsolute');
  Object.assign(e, { absolute: true, alpha: 216, beta: 88, gamma: 2 });
  for (let i = 0; i < 15; i++) window.dispatchEvent(e);
});
await page.waitForTimeout(400);
const shownHeading = Number(await page.locator('#heading-deg').textContent());
await page.click('#shutter');
await page.waitForTimeout(2000);
const row = await page.evaluate(() => self.Store.all().then(r => r[0]));
console.log('   queued heading', row.heading, '· shown', shownHeading);

console.log('\n== the stored JPEG carries its own metadata');
const b64 = await page.evaluate(() => self.Store.photo(self.__id).then(b => new Promise((res) => {
  const fr = new FileReader();
  fr.onload = () => res(fr.result.split(',')[1]);
  fr.readAsDataURL(b);
})), await page.evaluate((id) => { self.__id = id; return id; }, row.id));
const jpeg = Buffer.from(b64, 'base64');
fs.writeFileSync(OUT + '/roundtrip.jpg', jpeg);
console.log('   wrote roundtrip.jpg,', jpeg.length, 'bytes');
if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) fail('not a JPEG any more');
if (jpeg[2] !== 0xff || jpeg[3] !== 0xe1) fail('no APP1/EXIF segment right after the SOI marker');
else ok('APP1 EXIF segment present in the stored photo');

// the app's own reader
const parsed = await page.evaluate((b) => {
  const bin = atob(b);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return self.Exif.read(new Blob([u8], { type: 'image/jpeg' }));
}, b64);
console.log('   read back:', JSON.stringify(parsed));
if (!parsed.found) fail('the app cannot read the EXIF it just wrote');
else {
  if (!near(parsed.lat, LAT, 0.00002)) fail('latitude wrong: ' + parsed.lat);
  else ok('latitude survives: ' + parsed.lat.toFixed(6));
  if (!near(parsed.lon, LON, 0.00002)) fail('longitude wrong: ' + parsed.lon);
  else ok('longitude survives, sign and all: ' + parsed.lon.toFixed(6));
  if (!near(parsed.heading, row.heading, 0.05)) fail(`heading wrong: ${parsed.heading} vs ${row.heading}`);
  else ok('compass heading survives: ' + parsed.heading + '° (' + parsed.headingRef + ')');
  if (!near(parsed.hAcc, 9, 0.1)) fail('accuracy not written: ' + parsed.hAcc);
  else ok('position accuracy written: ±' + parsed.hAcc + 'm');
  if (Math.abs(parsed.taken - row.createdAt) > 1500) fail('capture time wrong');
  else ok('capture time written');
}

console.log('\n== and the file the phone would receive');
await page.click('#chip-queue');
await page.waitForTimeout(500);
await page.click('#q-save-all');
await page.waitForTimeout(1500);
if (!downloads.length) fail('nothing was handed to the device');
else {
  const saved = fs.readFileSync(downloads[0].path);
  console.log('   saved as', downloads[0].name, saved.length, 'bytes');
  if (saved[2] !== 0xff || saved[3] !== 0xe1) fail('the file saved to the phone has no EXIF — this is the reported bug');
  else ok('the file saved to the phone carries EXIF too');
  fs.writeFileSync(OUT + '/saved-from-queue.jpg', saved);
}

console.log('\n== re-import it, the way the experiment did');
await page.evaluate(() => self.Store.all().then(rs => Promise.all(rs.map(r => self.Store.remove(r.id)))));
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
await page.setInputFiles('#import-files', [OUT + '/saved-from-queue.jpg']);
await page.waitForFunction(() => /Done/.test(document.getElementById('import-status').textContent), null, { timeout: 20000 })
  .catch(() => fail('re-import never finished'));
const summary = (await page.locator('#import-summary').innerText()).replace(/\n/g, ' | ');
console.log('   summary:', summary);
if (/skipped/.test(summary)) fail('the app still refuses its own saved photo: ' + summary);
else ok('the app accepts a photo it saved earlier: ' + summary);

const back = await page.evaluate(() => self.Store.all().then(r => r[0]));
if (!back) fail('nothing came back in');
else {
  if (!near(back.lat, LAT, 0.00002) || !near(back.lon, LON, 0.00002))
    fail(`position drifted on the round trip: ${back.lat}, ${back.lon}`);
  else ok(`position identical after save → re-import: ${back.lat.toFixed(6)}, ${back.lon.toFixed(6)}`);
  if (!near(back.heading, row.heading, 0.05)) fail(`heading drifted: ${back.heading} vs ${row.heading}`);
  else ok('heading identical too: ' + back.heading + '°');
}

if (errs.length) fail('page errors: ' + errs.join(' | '));
await browser.close();
console.log(process.exitCode ? '\nSOME CHECKS FAILED' : '\nphotos keep their position through save and re-import');
