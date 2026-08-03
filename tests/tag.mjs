/* The session tag: set a feature once, every photo carries it until cleared.
   Which inputs appear, and their limits, must follow the target layer. */
import { ROOT, OUT, FIXTURES, URLBASE, TOK, REFERER, arcFetch } from './env.mjs';
import { chromium, CHROME, relayArcGIS } from './browser.mjs';
import fs from 'node:fs';
const ELAPP = 'https://services.arcgis.com/apTfC6SUmnNfnxuF/arcgis/rest/services/El_Rat_Generic/FeatureServer';
const SCRATCH = 'https://services.arcgis.com/apTfC6SUmnNfnxuF/arcgis/rest/services/Exotics_Camera_Points/FeatureServer';

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
});
// the sandboxed browser has no route to arcgis.com; relay through node
await ctx.route('**://*.arcgis.com/**', async (route) => {
  const req = route.request();
  try {
    const res = await fetch(req.url(), {
      method: req.method(),
      headers: { ...Object.fromEntries(Object.entries(req.headers()).filter(([k]) =>
        !/^(host|origin|referer|connection|content-length|accept-encoding|sec-)/i.test(k))),
        Referer: 'http://127.0.0.1:8848' },
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

const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push(e.message));
await page.goto(URLBASE + '?tag=1', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => document.getElementById('preview').videoWidth > 0, null, { timeout: 15000 });
await page.waitForTimeout(1200);

// sign in so the layer schema can be read, then start clean as a real user would
await page.evaluate((t) => self.Arc.setManualToken(t, 120), TOK);
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => document.getElementById('preview').videoWidth > 0, null, { timeout: 15000 });
await page.waitForTimeout(2000);

console.log('== the button');
const btn = await page.locator('#tag-toggle').boundingBox();
console.log('   collapsed:', Math.round(btn.width) + '×' + Math.round(btn.height) + ' at ' +
            Math.round(btn.x) + ',' + Math.round(btn.y));
if (btn.height > 34 || btn.width > 160) fail('the collapsed button is not small');
else ok('small and out of the way');
const shutter = await page.locator('#shutter').boundingBox();
const overlaps = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
if (overlaps(btn, shutter)) fail('it sits on top of the shutter');
else ok('clear of the shutter and the compass');
if (await page.locator('#tag-card').isVisible()) fail('the card is showing before it is asked for');
else ok('the card starts closed');

console.log('\n== on Central: notes only, 2560 characters');
await page.evaluate(() => self.Arc.layerMeta(true).then(() => null));
await page.waitForTimeout(1500);
await page.click('#tag-toggle');
await page.waitForTimeout(400);
if (!await page.locator('#tag-card').isVisible()) fail('the card did not open');
else ok('opens on tap');
let shown = await page.evaluate(() => ({
  feature: !document.getElementById('tag-feature-wrap').classList.contains('hidden'),
  note: !document.getElementById('tag-note-wrap').classList.contains('hidden'),
  noteMax: document.getElementById('tag-note').maxLength,
  noteName: document.getElementById('tag-note-name').textContent,
  hint: document.getElementById('tag-hint').textContent,
}));
console.log('   ', JSON.stringify(shown));
if (shown.feature) fail('offered a Feature box on a layer that has no such field');
else ok('no Feature box on Central, which has no Feature field');
if (!shown.note || shown.noteMax !== 2560) fail('note limit should match the layer: ' + shown.noteMax);
else ok('Note box capped at the layer\'s own 2560 characters');
await page.screenshot({ path: OUT + '/shot-tag-central.png' });

console.log('\n== switching to ELAPP All');
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
await page.click('#menu-btn'); await page.waitForTimeout(300);
await page.click('#mi-layer'); await page.waitForTimeout(400);
await page.click('#layer-list [data-layer="elapp"]');
await page.waitForTimeout(2500);
await page.click('#tag-toggle');
await page.waitForTimeout(400);
shown = await page.evaluate(() => ({
  feature: !document.getElementById('tag-feature-wrap').classList.contains('hidden'),
  featureMax: document.getElementById('tag-feature').maxLength,
  featureName: document.getElementById('tag-feature-name').textContent,
  noteMax: document.getElementById('tag-note').maxLength,
  noteName: document.getElementById('tag-note-name').textContent,
}));
console.log('   ', JSON.stringify(shown));
if (!shown.feature) fail('no Feature box on a layer that has one');
else ok('Feature box appears on ELAPP All, labelled "' + shown.featureName + '"');
if (shown.featureMax !== 256 || shown.noteMax !== 256) fail('limits do not match the layer: ' + JSON.stringify(shown));
else ok('both capped at the layer\'s 256 characters');

console.log('\n== setting it');
await page.fill('#tag-feature', 'gopher tortoise burrow');
await page.fill('#tag-note', 'transect 4');
await page.click('#tag-done');
await page.waitForTimeout(400);
if (await page.locator('#tag-card').isVisible()) fail('Done did not close the card');
else ok('Done closes it');
const label = await page.locator('#tag-label').textContent();
if (label !== 'gopher tortoise burrow') fail('the button does not show what is set: ' + label);
else ok('the button now reads "' + label + '"');
if (!(await page.locator('#tagger').getAttribute('class')).includes('set')) fail('no visual sign a tag is active');
else ok('and is highlighted while a tag is active');
await page.screenshot({ path: OUT + '/shot-tag-set.png' });

console.log('\n== every photo carries it');
// stay on ELAPP All so the tag fields apply, but never upload to it
await page.evaluate(() => self.Config.save({ autoSync: false }));
await page.waitForTimeout(300);
for (let i = 0; i < 2; i++) {
  await page.click('#shutter');
  await page.waitForTimeout(2200);
}
let rows = await page.evaluate(() => self.Store.all().then(r => r.map(x => ({ f: x.feature, n: x.notes }))));
console.log('   ', JSON.stringify(rows));
if (rows.length !== 2) fail('expected two photos, got ' + rows.length);
else if (!rows.every(r => r.f === 'gopher tortoise burrow' && r.n === 'transect 4'))
  fail('the tag did not ride along with every photo');
else ok('both photos carry the feature and the note');

console.log('\n== it survives a restart, and clears on demand');
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
if ((await page.locator('#tag-label').textContent()) !== 'gopher tortoise burrow')
  fail('the tag did not survive a reload');
else ok('still set after reopening the app');

await page.click('#tag-toggle');
await page.waitForTimeout(400);
await page.click('#tag-clear');
await page.waitForTimeout(500);
if ((await page.locator('#tag-label').textContent()) !== 'Tag') fail('Clear left something behind');
else ok('one tap on Clear empties it');
if ((await page.locator('#tagger').getAttribute('class')).includes('set')) fail('still looks active after clearing');
else ok('and it stops looking active');

await page.evaluate(() => self.Store.all().then(rs => Promise.all(rs.map(r => self.Store.remove(r.id)))));
await page.click('#shutter');
await page.waitForTimeout(2500);
rows = await page.evaluate(() => self.Store.all().then(r => r.map(x => ({ f: x.feature, n: x.notes }))));
if (rows.length !== 1) fail('no photo after clearing');
else if (rows[0].f || rows[0].n) fail('a cleared tag still stuck to a photo: ' + JSON.stringify(rows[0]));
else ok('photos taken after clearing carry nothing');

console.log('\n== a layer with nowhere to put it says so');
await page.click('#tag-toggle'); await page.waitForTimeout(300);
await page.fill('#tag-note', 'should warn');
await page.click('#tag-done'); await page.waitForTimeout(300);
await page.evaluate((url) => self.Config.save({ serviceUrl: url, layerId: 0 }), SCRATCH);
await page.evaluate(() => self.Arc.layerMeta(true).catch(() => null));
await page.waitForTimeout(2000);
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
if (!(await page.locator('#tag-toggle').isVisible()))
  fail('a set tag vanished on a layer that cannot store it — silently dropped');
else ok('a set tag stays visible on a layer that cannot store it');
if (!(await page.locator('#tagger').getAttribute('class')).includes('stranded'))
  fail('no warning styling for a tag that will not be written');
else ok('and is flagged as not applying here');
await page.click('#tag-toggle'); await page.waitForTimeout(400);
const warn = await page.locator('#tag-hint').textContent();
console.log('   hint:', warn);
// the message names whichever field is missing, so match the shape not the words
if (!/has no .* field, so .* will not be written/.test(warn)) fail('the card does not explain why: ' + warn);
else ok('the card explains why');
await page.click('#tag-clear'); await page.waitForTimeout(400);

console.log('\n== the button only shows what this layer will record');
await page.evaluate((url) => self.Config.save({ serviceUrl: url, layerId: 0 }), ELAPP);
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
await page.click('#tag-toggle'); await page.waitForTimeout(400);
await page.fill('#tag-feature', 'test');
await page.fill('#tag-note', '');
await page.click('#tag-done'); await page.waitForTimeout(500);
if ((await page.locator('#tag-label').textContent()) !== 'test') fail('the feature is not shown on ELAPP All');
else ok('on ELAPP All the button shows the feature: "test"');

await page.evaluate((url) => self.Config.save({ serviceUrl: url, layerId: 0 }),
  'https://services.arcgis.com/apTfC6SUmnNfnxuF/arcgis/rest/services/Iphone_Images/FeatureServer');
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
const onCentral = await page.evaluate(() => ({
  label: document.getElementById('tag-label').textContent,
  cls: document.getElementById('tagger').className,
  title: document.getElementById('tag-toggle').getAttribute('title'),
}));
console.log('   on Central:', JSON.stringify(onCentral));
if (onCentral.cls.indexOf('set') >= 0) fail('Central claims the feature is being applied, but it has no Feature field');
else ok('Central no longer claims the feature is being applied');
if (!/stranded/.test(onCentral.cls)) fail('no warning that the feature will not be written');
else ok('and flags it as not written here');
if (!/Not written to Central/.test(onCentral.title || '')) fail('the tooltip does not say so: ' + onCentral.title);
else ok('the tooltip says "' + onCentral.title + '"');
await page.click('#tag-toggle'); await page.waitForTimeout(400);
await page.click('#tag-clear'); await page.waitForTimeout(400);

console.log('\n== it reaches ArcGIS');
await page.evaluate((url) => self.Config.save({ serviceUrl: url, layerId: 0 }), ELAPP);
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
await page.evaluate(() => self.Store.all().then(rs => Promise.all(rs.map(r => self.Store.remove(r.id)))));
await page.click('#tag-toggle'); await page.waitForTimeout(300);
await page.fill('#tag-note', 'burrow survey, plot 7');
await page.click('#tag-done'); await page.waitForTimeout(400);
const meta = await page.evaluate(() => self.Arc.layerMeta());
const built = await page.evaluate((m) => {
  const item = { lat: 30.2672, lon: -97.7431, heading: 90, createdAt: Date.now(),
                 notes: 'burrow survey, plot 7', feature: 'gopher tortoise burrow' };
  return self.Arc.buildFeature(item, m);
}, meta);
console.log('   attributes:', JSON.stringify(built.attributes));
const noteField = Object.keys(built.attributes).find(k => /notes?$/i.test(k));
if (!noteField) fail('the note is not mapped onto the layer');
else ok('note maps to ' + noteField + ' = "' + built.attributes[noteField] + '"');

// over-long values must be cut to the field, not rejected by the server
const long = await page.evaluate((m) => {
  const item = { lat: 1, lon: 1, createdAt: Date.now(), notes: 'x'.repeat(5000), feature: 'y'.repeat(5000) };
  return self.Arc.buildFeature(item, m);
}, meta);
const tooLong = Object.entries(long.attributes).filter(([k, v]) => {
  const f = meta.fields.find(x => x.name === k);
  return typeof v === 'string' && f && f.length && v.length > f.length;
});
if (tooLong.length) fail('values longer than the field slipped through: ' + JSON.stringify(tooLong));
else ok('anything over the limit is trimmed to fit the field');

if (errs.length) fail('page errors: ' + errs.join(' | '));
await browser.close();
console.log(process.exitCode ? '\nSOME CHECKS FAILED' : '\nsession tag works');
