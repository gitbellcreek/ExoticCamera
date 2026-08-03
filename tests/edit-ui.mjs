/* The editor itself. No ArcGIS traffic: the layer schema is seeded into the
   metadata cache and the update call is stubbed, so this stays about the UI. */
import { ROOT, OUT, FIXTURES, URLBASE, TOK, REFERER, arcFetch } from './env.mjs';
import { chromium, CHROME, relayArcGIS } from './browser.mjs';
const SERVICE = 'https://services.arcgis.com/apTfC6SUmnNfnxuF/arcgis/rest/services/El_Rat_Generic/FeatureServer';

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
await ctx.route('**://*.arcgis.com/**', r => r.abort('internetdisconnected'));   // nothing real, ever
await ctx.addInitScript(() => {
  Object.defineProperty(Navigator.prototype, 'onLine', { get: () => !window.__offline, configurable: true });
});
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push(e.message));
await page.goto(URLBASE + '?editui=1', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => document.getElementById('preview').videoWidth > 0, null, { timeout: 15000 });
await page.waitForTimeout(1500);

// point at ELAPP All and seed its schema, so no network is needed
await page.evaluate(async (service) => {
  await self.Config.save({ serviceUrl: service, layerId: 0, autoSync: false });
  await self.Store.set('layerMeta:' + service + '/0', { at: Date.now(), meta: {
    name: 'Point layer', objectIdField: 'OBJECTID', hasAttachments: true,
    fields: [
      { name: 'OBJECTID', type: 'esriFieldTypeOID', editable: false },
      { name: 'Feature', alias: 'Feature', type: 'esriFieldTypeString', length: 256, editable: true },
      { name: 'Notes', alias: 'Notes', type: 'esriFieldTypeString', length: 256, editable: true },
      { name: 'esrisnsr_azimuth', type: 'esriFieldTypeDouble', editable: true },
    ],
  } });
}, SERVICE);
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2000);

// one photo already on the layer, one still waiting
await page.evaluate(async () => {
  await self.Store.add({ id: 'sent-row', createdAt: Date.now() - 60000, state: 'sent', objectId: 4242,
    attachmentId: 7, sentAt: Date.now() - 30000, lat: 30.2672, lon: -97.7431, heading: 91, hAcc: 6,
    thumb: 'data:,x', layerName: 'ELAPP All', feature: 'gopher tortoise burrow', notes: 'first pass' });
  await self.Store.add({ id: 'pending-row', createdAt: Date.now(), state: 'pending', lat: 30.2, lon: -97.7,
    heading: 12, hAcc: 8, thumb: 'data:,y', layerName: 'ELAPP All' });
});

console.log('== the editor');
await page.click('#chip-queue');
await page.waitForTimeout(600);
if (await page.locator('.qedit').count() !== 2) fail('not every row has an edit button');
else ok('every row has an edit button');

await page.locator('.qrow').first().locator('.qedit').click();     // newest first = pending row
await page.waitForTimeout(900);
let shown = await page.evaluate(() => ({
  open: !document.getElementById('edit-panel').classList.contains('hidden'),
  fMax: document.getElementById('edit-feature').maxLength,
  nMax: document.getElementById('edit-note').maxLength,
  fName: document.getElementById('edit-feature-name').textContent,
  hint: document.getElementById('edit-hint').textContent,
  meta: document.getElementById('edit-meta').innerText.replace(/\n/g, ' · '),
}));
console.log('   ', JSON.stringify(shown));
if (!shown.open) fail('the editor did not open');
else ok('opens from the row');
if (shown.fMax !== 256 || shown.nMax !== 256 || shown.fName !== 'Feature')
  fail('fields and limits do not come from the layer');
else ok('fields and limits come from the layer (Feature/Notes, 256)');
if (!/before it goes up/.test(shown.hint)) fail('wrong hint for a photo not yet uploaded: ' + shown.hint);
else ok('says the edit rides along with the upload');
await page.screenshot({ path: OUT + '/shot-edit.png' });

await page.fill('#edit-feature', 'gopher tortoise burrow');
await page.fill('#edit-note', 'transect 4');
await page.click('#edit-save');
await page.waitForTimeout(900);
let row = await page.evaluate(() => self.Store.item('pending-row'));
if (row.feature !== 'gopher tortoise burrow' || row.notes !== 'transect 4') fail('the edit did not stick');
else ok('an unsent photo takes the change straight away');
if (row.pendingEdit) fail('an unsent photo should not owe a separate push');
else ok('and owes the server nothing extra');
if (await page.locator('#edit-panel').isVisible()) fail('saving left the editor open');
else ok('saving closes it');
if (!await page.locator('#queue-panel').isVisible()) fail('saving dumped you out of the queue');
else ok('and puts you back in the queue you came from');

console.log('\n== editing one that is already up');
// stub the layer call before saving: the app syncs straight after a save, and
// this test is about the editor, not the network. Start offline so the
// "waiting to go up" state can be seen at all.
await page.evaluate(() => {
  window.__updates = [];
  self.Arc.updateFeature = (item) => {
    window.__updates.push({ oid: item.objectId, notes: item.notes, feature: item.feature });
    return Promise.resolve(true);
  };
  window.__offline = true;
  window.dispatchEvent(new Event('offline'));
});
await page.locator('.qrow').nth(1).locator('.qedit').click();
await page.waitForTimeout(900);
shown = await page.evaluate(() => ({
  feature: document.getElementById('edit-feature').value,
  note: document.getElementById('edit-note').value,
  hint: document.getElementById('edit-hint').textContent,
}));
console.log('   ', JSON.stringify(shown));
if (shown.feature !== 'gopher tortoise burrow' || shown.note !== 'first pass')
  fail('the editor did not show what is already on the photo');
else ok('prefilled with what the photo already carries');
if (!/already on the layer/.test(shown.hint)) fail('wrong hint for an uploaded photo: ' + shown.hint);
else ok('warns that saving updates the layer');

await page.fill('#edit-note', 'second pass, burrow collapsed');
await page.click('#edit-save');
await page.waitForTimeout(1200);
row = await page.evaluate(() => self.Store.item('sent-row'));
if (row.notes !== 'second pass, burrow collapsed') fail('the edit was not stored');
else ok('the change is stored immediately');
if (!row.pendingEdit) fail('the edit was not queued for the layer');
else ok('and queued as work owed to the layer');

const chip = await page.locator('#chip-queue .label').textContent();
if (chip !== '2') fail('the queue count ignores the pending edit: ' + chip);
else ok('the queue chip counts it (2: one photo, one edit)');
const rowText = await page.locator('.qrow').nth(1).innerText();
if (!/edit waiting/.test(rowText)) fail('the row does not say an edit is waiting: ' + rowText.replace(/\n/g, ' | '));
else ok('the row reads "edit waiting to go up"');
await page.screenshot({ path: OUT + '/shot-edit-waiting.png' });

console.log('\n== the edit reaches the layer');
await page.evaluate(async () => {
  await self.Config.save({ autoSync: true });
  window.__offline = false;
  window.dispatchEvent(new Event('online'));
});
await page.waitForFunction(() => self.Store.item('sent-row').then(r => !r.pendingEdit),
  null, { timeout: 15000, polling: 400 }).catch(() => {});
const pushed = await page.evaluate(async () => ({
  seen: window.__updates, row: await self.Store.item('sent-row'),
}));
console.log('   update sent:', JSON.stringify(pushed.seen));
if (pushed.seen.length !== 1 || pushed.seen[0].oid !== 4242)
  fail('the edit was not pushed to the right feature');
else ok('the edit goes to OBJECTID 4242 with the new text');
if (pushed.row.pendingEdit) fail('still owing an edit after it went through');
else ok('and the queue stops owing it');
if (pushed.row.state !== 'sent') fail('the row is left in state ' + pushed.row.state);
else ok('the row settles back to sent');

console.log('\n== a layer with nothing to edit');
await page.evaluate(async (service) => {
  await self.Store.set('layerMeta:' + service + '/0', { at: Date.now(), meta: {
    name: 'Bare layer', objectIdField: 'OBJECTID', hasAttachments: true,
    fields: [{ name: 'OBJECTID', type: 'esriFieldTypeOID', editable: false },
             { name: 'esrisnsr_azimuth', type: 'esriFieldTypeDouble', editable: true }],
  } });
}, SERVICE);
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2000);
await page.click('#chip-queue');
await page.waitForTimeout(600);
await page.locator('.qrow').first().locator('.qedit').click();
await page.waitForTimeout(900);
const bare = await page.evaluate(() => ({
  hint: document.getElementById('edit-hint').textContent,
  saveDisabled: document.getElementById('edit-save').disabled,
  fHidden: document.getElementById('edit-feature-wrap').classList.contains('hidden'),
  nHidden: document.getElementById('edit-note-wrap').classList.contains('hidden'),
}));
console.log('   ', JSON.stringify(bare));
if (!bare.fHidden || !bare.nHidden) fail('offered boxes the layer cannot store');
else if (!/nothing to edit/.test(bare.hint)) fail('no explanation: ' + bare.hint);
else ok('says there is nothing to edit and disables Save');
if (!bare.saveDisabled) fail('Save is still enabled with nowhere to write');

if (errs.length) fail('page errors: ' + errs.join(' | '));
await browser.close();
console.log(process.exitCode ? '\nSOME CHECKS FAILED' : '\nthe editor behaves');
