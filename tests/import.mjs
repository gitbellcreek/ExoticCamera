/* Importing photos already on the phone: EXIF GPS in, queue entries out. */
import { ROOT, OUT, FIXTURES, URLBASE, TOK, REFERER, arcFetch } from './env.mjs';
import { chromium, CHROME, relayArcGIS } from './browser.mjs';

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});
const fail = (m) => { console.log('  FAIL', m); process.exitCode = 1; };
const ok = (m) => console.log('  ok  ', m);
const near = (a, b, tol) => typeof a === 'number' && Math.abs(a - b) <= tol;

const ctx = await browser.newContext({
  viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true,
  permissions: ['camera', 'geolocation'],
  geolocation: { latitude: 0, longitude: 0, accuracy: 5 },
});
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push(e.message));
await page.goto(URLBASE + '?import=1', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);

console.log('== the entry points');
await page.click('#menu-btn'); await page.waitForTimeout(300);
await page.click('#mi-queue'); await page.waitForTimeout(400);
if (!await page.locator('#q-import-label').isVisible()) fail('no import control in the queue');
else ok('queue offers "' + (await page.locator('#q-import-label').innerText()).trim() + '"');
await page.keyboard.press('Escape'); await page.waitForTimeout(300);
await page.click('#menu-btn'); await page.waitForTimeout(300);
await page.click('#mi-settings'); await page.waitForTimeout(400);
if (!await page.locator('#s-import-label').isVisible()) fail('no import control in settings');
else ok('settings offers the same');
await page.keyboard.press('Escape'); await page.waitForTimeout(400);

console.log('\n== importing a mixed batch');
await page.setInputFiles('#import-files', [
  FIXTURES + '/gps_heading.jpg',
  FIXTURES + '/gps_no_heading.jpg',
  FIXTURES + '/southern_eastern.jpg',
  FIXTURES + '/no_gps.jpg',
  FIXTURES + '/no_exif_at_all.jpg',
  FIXTURES + '/plain.jpg',
]);
await page.waitForFunction(() => /Done/.test(document.getElementById('import-status').textContent), null, { timeout: 30000 })
  .catch(() => fail('import never finished'));
const summary = (await page.locator('#import-summary').innerText()).replace(/\n/g, ' | ');
console.log('   summary:', summary);
await page.screenshot({ path: OUT + '/shot-import.png' });
if (!/3 added/.test(summary)) fail('expected the three located photos to be added');
else ok('added the three photos that carry a location');
if (!/2 with a compass heading/.test(summary)) fail('heading count wrong: ' + summary);
else ok('counted the two that also carry a compass heading');
if (!/3 skipped/.test(summary)) fail('expected the three without a location to be skipped');
else ok('skipped the three with no location, and said so');

console.log('\n== what landed in the queue');
const rows = await page.evaluate(() => self.Store.all().then(rs => rs.map(r => ({
  lat: r.lat, lon: r.lon, alt: r.alt, heading: r.heading, src: r.headingSource,
  hAcc: r.hAcc, when: r.createdAt, device: r.device, source: r.source,
  layer: r.layerName, state: r.state, hasPhoto: r.hasPhoto, filename: r.filename,
}))));
for (const r of rows) console.log('   ', JSON.stringify(r));

const tampa = rows.find(r => near(r.lat, 27.840965, 0.0002));
if (!tampa) fail('the photo with heading did not come through with its position');
else {
  if (!near(tampa.lon, -82.301417, 0.0002)) fail('longitude wrong: ' + tampa.lon);
  else ok('west longitude read as negative: ' + tampa.lon.toFixed(6));
  if (!near(tampa.heading, 143.9, 0.2)) fail('compass heading not read: ' + tampa.heading);
  else ok('compass heading read from the photo: ' + tampa.heading + '°');
  if (!near(tampa.alt, 12.5, 0.1)) fail('altitude wrong: ' + tampa.alt);
  else ok('altitude read: ' + tampa.alt + 'm');
  if (!near(tampa.hAcc, 8, 0.1)) fail('accuracy not read: ' + tampa.hAcc);
  else ok('the camera\'s own position error came across: ±' + tampa.hAcc + 'm');
  const d = new Date(tampa.when);
  if (d.getFullYear() !== 2026 || d.getMonth() !== 6 || d.getDate() !== 30) fail('capture time wrong: ' + d);
  else ok('capture time taken from the photo, not the import: ' + d.toLocaleString());
  if (!/iPhone/.test(tampa.device)) fail('camera not recorded: ' + tampa.device);
  else ok('records the camera: ' + tampa.device);
  if (tampa.source !== 'import') fail('not flagged as an import');
  if (!tampa.hasPhoto) fail('no image stored for the imported photo');
  else ok('the image itself is queued, ready to attach');
}

const sydney = rows.find(r => near(r.lat, -33.8688, 0.0002));
if (!sydney) fail('southern/eastern hemisphere photo missing');
else {
  if (!near(sydney.lon, 151.2093, 0.0002)) fail('east longitude wrong: ' + sydney.lon);
  else ok('southern latitude and eastern longitude signed correctly: ' + sydney.lat.toFixed(4) + ', ' + sydney.lon.toFixed(4));
  if (!near(sydney.alt, -4.25, 0.05)) fail('below-sea-level altitude wrong: ' + sydney.alt);
  else ok('altitude below sea level read as negative: ' + sydney.alt + 'm');
  if (sydney.src !== 'exif-mag') fail('magnetic heading reference not noted: ' + sydney.src);
  else ok('notes that the heading was magnetic, not true north');
}

const austin = rows.find(r => near(r.lat, 30.2672, 0.0002));
if (!austin) fail('the photo without a heading was not imported');
else if (austin.heading !== null && austin.heading !== undefined) fail('invented a heading: ' + austin.heading);
else ok('a photo with location but no compass is still imported, with no heading');

if (rows.some(r => r.layer !== 'Central')) fail('imports did not go to the selected layer');
else ok('all queued for the selected layer (Central)');
if (rows.some(r => !/^exoticcam_\d{8}_\d{6}/.test(r.filename || ''))) fail('filenames not normalised');
else ok('filenames follow the same convention as camera shots');

console.log('\n== queue view');
await page.click('#import-close');
await page.waitForTimeout(500);
await page.click('#chip-queue');
await page.waitForTimeout(500);
const text = await page.locator('.qrow').first().innerText();
console.log('   first row:', text.replace(/\n/g, ' | '));
if (!/imported/i.test(text)) fail('the queue does not show where these came from');
else ok('queue marks them as imported');

if (errs.length) fail('page errors: ' + errs.join(' | '));
await browser.close();
console.log(process.exitCode ? '\nSOME CHECKS FAILED' : '\nimport works');
