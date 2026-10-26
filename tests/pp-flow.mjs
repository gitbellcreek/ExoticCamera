/* Photo Points, end to end in a browser against the live Photo_Monitoring
   service: sign in, find the station, aim, shoot, go offline, finish the
   visit, come back online and check what landed on the layer.

   The rule from tests/README.md holds here too: a suite may only delete what
   it created. Everything written goes under the station called "Test" (the
   one kept for testing) or a station this run adds; both layers are
   snapshotted first, and only rows carrying this run's own GlobalIDs are
   removed afterwards. The Test station's own fields are put back as found. */
import { URLBASE, TOK, REFERER } from './env.mjs';
import { chromium, CHROME, relayArcGIS, waitForAsync } from './browser.mjs';

const SVC = 'https://services.arcgis.com/apTfC6SUmnNfnxuF/arcgis/rest/services/Photo_Monitoring/FeatureServer';
const APP = new URL('photopoints/', URLBASE).href;
const fail = (m) => { console.log('  FAIL', m); process.exitCode = 1; };
const ok = (m) => console.log('  ok  ', m);
const step = (n) => console.log('\n== ' + n);
const norm = (g) => String(g || '').replace(/[{}]/g, '').toUpperCase();

async function rest(path, params) {
  const r = await fetch(SVC + path, { method: 'POST', headers: { Referer: REFERER },
    body: new URLSearchParams({ f: 'json', token: TOK, ...params }) });
  const j = await r.json();
  if (j.error) throw new Error(path + ': ' + JSON.stringify(j.error));
  return j;
}
const ids = async (layer) => new Set((await rest('/' + layer + '/query', { where: '1=1', returnIdsOnly: 'true' })).objectIds || []);

// ── the Test station, as found ─────────────────────────────────────────
const testSt = (await rest('/0/query', { where: "StationID = 'Test'", outFields: '*', returnGeometry: 'true', outSR: '4326' })).features[0];
if (!testSt) { console.log('FAIL: no station called "Test" — this suite only writes under it'); process.exit(1); }
const TEST_GID = norm(testSt.attributes.GlobalID);
const TEST_AT = { lat: testSt.geometry.y, lon: testSt.geometry.x };
const TEST_AS_FOUND = { Notes: testSt.attributes.Notes };
const BASE_VISITS = await ids(1);
const BASE_STATIONS = await ids(0);
console.log(`Test station ${TEST_GID} at ${TEST_AT.lat.toFixed(5)}, ${TEST_AT.lon.toFixed(5)} · ${BASE_VISITS.size} visit(s), ${BASE_STATIONS.size} station(s) before — off limits`);

const ours = { visits: [], stations: [] };
async function cleanup() {
  const out = [];
  // visits: only rows that did not exist before AND carry one of our GlobalIDs
  if (ours.visits.length) {
    const where = 'GlobalID IN (' + ours.visits.map(g => "'" + g + "'").join(',') + ')';
    const found = (await rest('/1/query', { where, returnIdsOnly: 'true' })).objectIds || [];
    const mine = found.filter(id => !BASE_VISITS.has(id));
    if (mine.length > 3) out.push('REFUSING to delete ' + mine.length + ' visits');
    else if (mine.length) {
      const r = await rest('/1/applyEdits', { deletes: mine.join(',') });
      out.push('visits ' + JSON.stringify(mine) + ': ' + r.deleteResults.map(d => d.success).join(','));
    }
  }
  if (ours.stations.length) {
    const where = 'GlobalID IN (' + ours.stations.map(g => "'" + g + "'").join(',') + ')';
    const found = (await rest('/0/query', { where, returnIdsOnly: 'true' })).objectIds || [];
    const mine = found.filter(id => !BASE_STATIONS.has(id));
    if (mine.length > 2) out.push('REFUSING to delete ' + mine.length + ' stations');
    else if (mine.length) {
      const r = await rest('/0/applyEdits', { deletes: mine.join(',') });
      out.push('stations ' + JSON.stringify(mine) + ': ' + r.deleteResults.map(d => d.success).join(','));
    }
  }
  // the Test station's fields, as they were
  await rest('/0/applyEdits', { useGlobalIds: 'true', updates: JSON.stringify([{ attributes: { GlobalID: '{' + TEST_GID + '}', ...TEST_AS_FOUND } }]) });
  out.push('Test station notes restored');
  return out.join(' · ');
}

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});
// stand 20 m south of the Test station
const ctx = await browser.newContext({
  viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true,
  permissions: ['camera', 'geolocation'],
  geolocation: { latitude: TEST_AT.lat - 0.00018, longitude: TEST_AT.lon, accuracy: 4 },
});
const setOffline = await relayArcGIS(ctx, REFERER);
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push('pageerror: ' + e.message));
page.on('dialog', d => d.accept());

try {
  step('boot, signed out');
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => self.__ppReady, null, { timeout: 15000 });
  if (!await page.locator('#signin-nudge').isVisible()) fail('no sign-in prompt when signed out'); else ok('asks to sign in');

  step('sign in with a pasted token');
  await page.click('#nudge-signin');
  await page.click('#signin-panel summary >> text=Paste a token');
  await page.fill('#si-token', TOK);
  await page.click('#si-token-go');
  await page.waitForFunction(() => document.querySelectorAll('.st').length >= 2, null, { timeout: 20000, polling: 500 });
  const n = await page.locator('.st').count();
  const first = (await page.locator('.st-main b').first().textContent()).trim();
  ok(`${n} stations listed, nearest first: ${first} (${await page.locator('.st-dist').first().textContent()})`);
  if (!/^Test/.test(first)) fail('the Test station should be nearest');

  step('the compass: an iPhone held upright, gyro frame offset, magnetic heading');
  // the phone is held square for a moment (looking at the screen), then raised
  await page.evaluate(() => {
    // People raise a phone over a moment, and it is never exactly vertical:
    // the pitch eases towards its target at 150°/s, and "upright" is 1° off.
    window.__mag = 20; window.__pitch = -50; window.__p = -50;
    setInterval(() => {
      const D = Math.PI / 180;
      window.__p += Math.max(-5, Math.min(5, window.__pitch - window.__p));
      // build the true attitude: face __mag (magnetic), lens raised __p, no roll
      const yaw = window.__mag, p = window.__p;
      const Rz = (a) => { const c = Math.cos(a * D), s = Math.sin(a * D); return [c, -s, 0, s, c, 0, 0, 0, 1]; };
      const Rx = (a) => { const c = Math.cos(a * D), s = Math.sin(a * D); return [1, 0, 0, 0, c, -s, 0, s, c]; };
      const mul = (A, B) => { const C = Array(9).fill(0); for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) C[r * 3 + c] += A[r * 3 + k] * B[k * 3 + c]; return C; };
      const R = mul(Rz(130), mul(mul(Rz(-yaw), [1, 0, 0, 0, 0, -1, 0, 1, 0]), Rx(p)));   // 130°: iOS's arbitrary gyro frame
      const z = Math.atan2(-R[1], R[4]), x = Math.asin(R[7]), y = Math.atan2(-R[6], R[8]);
      const e = new Event('deviceorientation');
      Object.assign(e, { alpha: ((z / D) + 360) % 360, beta: x / D, gamma: y / D, absolute: false,
        webkitCompassHeading: ((yaw % 360) + 360) % 360, webkitCompassAccuracy: 8 });
      window.dispatchEvent(e);
    }, 33);
  });
  await page.waitForTimeout(1500);
  await page.evaluate(() => { window.__pitch = -1; });
  await page.waitForTimeout(800);
  const comp = await page.evaluate(() => ({ mag: PhotoPoints.state.mag, heading: PhotoPoints.state.heading, settled: PhotoPoints.state.settled }));
  if (Math.abs(comp.mag - 20) > 1.5) fail('magnetic heading ' + comp.mag); else ok(`magnetic ${comp.mag.toFixed(1)}° → true ${comp.heading.toFixed(1)}° (declination −6.3)`);
  if (!comp.settled) fail('compass never settled after a look at the screen'); else ok('compass settled');

  step('open the station and start a visit');
  await page.locator('.st').filter({ hasText: 'Test' }).first().click();
  await page.waitForTimeout(400);
  ok('sheet: ' + (await page.locator('#sp-dist').textContent()) + ' · ' + (await page.locator('#sp-dir').textContent()));
  await page.click('#sp-start');
  await page.waitForFunction(() => document.getElementById('preview').videoWidth > 0, null, { timeout: 15000 });
  const video = await page.evaluate(() => { const v = document.getElementById('preview'); return [v.videoWidth, v.videoHeight]; });
  ok(`camera live ${video[0]}×${video[1]}`);

  step('aiming at North');
  await page.evaluate(() => { window.__mag = 40; });              // 40 M = 33.7 T: well right of north
  await page.waitForTimeout(400);
  const off = await page.locator('#aim-text').textContent();
  if (!/Turn 3\d° left/.test(off)) fail('expected "Turn ~34° left", got ' + off); else ok(off);
  await page.evaluate(() => { window.__mag = 6.3; });             // true north
  await page.waitForTimeout(400);
  const on = await page.locator('#aim-text').textContent();
  if (!/On target/.test(on)) fail('expected on target, got ' + on); else ok(on);

  step('shooting: N, then E (auto-advanced), a second N, and the post');
  const shoot = async () => {
    await page.click('#shutter');
    await page.waitForFunction(() => !document.getElementById('shutter').disabled && document.getElementById('saving').classList.contains('hidden'), null, { timeout: 15000 });
    await page.waitForTimeout(500);
  };
  await shoot();
  const slotNow = await page.evaluate(() => PhotoPoints.state.slot);
  if (slotNow !== 'E') fail('did not move on to East, at ' + slotNow); else ok('moved on to East by itself');
  await page.evaluate(() => { window.__mag = 96.3; });            // true east
  await page.waitForTimeout(400);
  await shoot();
  await page.click('.slot[data-slot="N"]');
  await page.evaluate(() => { window.__mag = 7.5; });
  await page.waitForTimeout(400);
  await shoot();
  await page.click('.slot[data-slot="LOCATOR"]');
  await shoot();
  const shots = await page.evaluate(() => self.Store.shots().then(s => s.sort((a, b) => a.createdAt - b.createdAt)
    .map(x => ({ slot: x.slot, name: x.name, heading: x.heading, ref: x.headingRef, w: x.w, h: x.h, size: x.size, gid: x.attGlobalId }))));
  if (shots.length !== 4) fail(shots.length + ' photos stored'); else ok('4 photos stored: ' + shots.map(s => s.slot).join(', '));
  const n1 = shots.find(s => s.slot === 'N');
  if (!/^Test_N_\d{8}-\d{6}_(359|000|001)T\.jpg$/.test(n1.name)) fail('name ' + n1.name); else ok('named with its bearing: ' + n1.name);
  if (n1.w !== video[0] || n1.h !== video[1]) fail(`saved ${n1.w}×${n1.h}, camera gives ${video[0]}×${video[1]}`); else ok('saved at the camera\'s full resolution');
  const ex = await page.evaluate(() => self.Store.shots().then(s => s.find(x => x.slot === 'E')).then(s => self.Store.photo(s.id)).then(b => self.Exif.read(b)));
  if (!ex.found || Math.abs(ex.heading - 90) > 1.5 || ex.headingRef !== 'T' || ex.lat === null) fail('EXIF: ' + JSON.stringify(ex));
  else ok(`EXIF carries the bearing ${ex.heading.toFixed(1)}°${ex.headingRef} and the position`);
  const slotsWithCount = await page.locator('.slot.has').count();
  if (slotsWithCount !== 3) fail(slotsWithCount + ' slots marked as done'); else ok('three slots show photos (N has two)');

  step('finish the visit with no signal');
  await setOffline(true);
  await page.click('#finish');
  await page.fill('#dp-observer', 'Photo Points test');
  await page.fill('#dp-event', 'pp-flow test run');
  await page.selectOption('#dp-condition', { index: 1 });
  await page.fill('#dp-notes', 'Written by tests/pp-flow.mjs — deleted at the end of the run.');
  await page.click('#dp-finish');
  await page.waitForTimeout(1500);
  const view = await page.evaluate(() => document.body.className);
  if (!/view-home/.test(view)) fail('still in the camera after finishing'); else ok('back at the station list');
  const q = await page.evaluate(() => self.Store.counts());
  if (q.photos !== 4) fail('queue shows ' + JSON.stringify(q)); else ok(`queued offline: ${q.photos} photos, ${(q.bytes / 1024).toFixed(0)} KB`);
  const local = await page.evaluate(() => self.Store.visits().then(v => v[0]));
  ours.visits.push(norm(local.globalId));
  if (local.state !== 'queued' || local.objectId) fail('visit state ' + local.state); else ok('nothing went up while offline');

  step('edit the Test station while offline');
  await page.locator('.st').filter({ hasText: 'Test' }).first().click();
  await page.click('#sp-edit');
  await page.fill('#ep-notes', 'pp-flow test note');
  await page.click('#ep-save');
  await page.waitForTimeout(500);
  if ((await page.evaluate(() => self.Store.edits())).length !== 1) fail('station change not queued'); else ok('station change queued');

  step('back online: everything goes up');
  await setOffline(false);
  await waitForAsync(page, () => self.Store.counts().then(c => c.outstanding === 0), null, { timeout: 120000, polling: 1000 });
  ok('queue drained');
  const vrow = (await rest('/1/query', { where: "GlobalID = '" + local.globalId + "'", outFields: '*' })).features[0];
  if (!vrow) fail('the visit is not on the layer');
  else {
    const a = vrow.attributes;
    if (norm(a.StationGUID) !== TEST_GID) fail('StationGUID ' + a.StationGUID); else ok('visit on the layer, linked to the Test station');
    if (a.Observer !== 'Photo Points test' || a.MonitoringEvent !== 'pp-flow test run' || !a.PostCondition || a.StationID !== 'Test')
      fail('attributes ' + JSON.stringify(a)); else ok('observer, event, post condition and station id all landed');
    const att = await rest('/1/queryAttachments', { objectIds: String(a.OBJECTID), returnMetadata: 'true' });
    const infos = (att.attachmentGroups[0] || {}).attachmentInfos || [];
    const want = shots.map(s => s.slot).sort().join(',');
    const got = infos.map(i => i.keywords).sort().join(',');
    if (got !== want) fail(`keywords on the layer ${got}, expected ${want}`); else ok('4 photos attached, keyworded by slot: ' + got);
    const sizesOk = shots.every(s => infos.some(i => i.name === s.name && i.size === s.size));
    if (!sizesOk) fail('sizes/names differ: ' + JSON.stringify(infos.map(i => [i.name, i.size])));
    else ok('every photo arrived at full size, under its own name');
    const exifOk = infos.every(i => (i.exifInfo || []).length);
    if (!exifOk) fail('the layer read no EXIF from some photos'); else ok('the layer read the EXIF of every photo');
  }
  const st = (await rest('/0/query', { where: "GlobalID = '{" + TEST_GID + "}'", outFields: 'Notes' })).features[0].attributes;
  if (st.Notes !== 'pp-flow test note') fail('station note on the layer: ' + st.Notes); else ok('the station change landed');

  step('the next visit lines up with this one');
  await page.click('#refresh-btn');
  await page.waitForTimeout(2500);
  await page.locator('.st').filter({ hasText: 'Test' }).first().click();
  await waitForAsync(page, (gid) => self.Store.ghostKeys().then((k) => k.filter((x) => x.indexOf(gid) === 0).length >= 3),
    '{' + TEST_GID + '}', { timeout: 30000, polling: 500 });
  ok('last visit\'s photos brought onto the phone: ' + await page.locator('#sp-ghost').textContent());
  await page.click('#sp-start');
  await page.waitForFunction(() => document.getElementById('preview').videoWidth > 0, null, { timeout: 15000 });
  await page.waitForTimeout(600);
  const g = await page.evaluate(() => ({ shown: !document.getElementById('ghost').classList.contains('hidden'),
    w: document.getElementById('ghost').naturalWidth, target: document.getElementById('cam-target').textContent }));
  if (!g.shown || !g.w) fail('the last visit\'s North photo is not over the camera'); else ok(`last visit's photo over the camera (${g.w}px wide)`);
  if (!/last visit/.test(g.target)) fail('target not taken from the last visit: ' + g.target); else ok('target from the last visit: ' + g.target);
  await page.click('.slot[data-slot="E"]');
  await page.waitForTimeout(400);
  const ge = await page.evaluate(() => document.getElementById('cam-target').textContent);
  if (!/^face 09\d°T \(last visit\)/.test(ge)) fail('East target: ' + ge); else ok('East too: ' + ge);
  await page.click('#cam-close');                 // nothing shot: the empty draft is dropped
  await page.waitForTimeout(500);
  if ((await page.evaluate(() => self.Store.visits().then((v) => v.filter((x) => x.state === 'draft').length))) !== 0) fail('an empty visit was kept');
  else ok('backing out of an empty visit leaves nothing behind');

  step('a new station, and a visit to it before it is uploaded');
  await setOffline(true);
  await page.click('#new-station-btn');
  await page.fill('#np-id', 'PP-TEST-' + Date.now().toString(36).toUpperCase());
  await page.fill('#np-notes', 'Written by tests/pp-flow.mjs — deleted at the end of the run.');
  await page.click('#np-save');
  await page.waitForTimeout(600);
  const added = await page.evaluate(() => self.Store.edits().then(e => e[0]));
  ours.stations.push(norm(added.globalId));
  if (!await page.locator('#station-panel').isVisible()) fail('new station sheet did not open'); else ok('station added on the phone: ' + added.attrs.StationID);
  await page.click('#sp-start');
  await page.waitForFunction(() => document.getElementById('preview').videoWidth > 0, null, { timeout: 15000 });
  await page.evaluate(() => { window.__mag = 6.3; });
  await page.waitForTimeout(300);
  await shoot();
  await page.click('#finish');
  await page.click('#dp-post-seg button[data-v="Yes"]');          // a post went in on this visit
  if (!await page.locator('#dp-post-new').isVisible()) fail('no post-type fields after choosing Installed');
  await page.selectOption('#dp-post-type', 'Rebar');
  await page.fill('#dp-post-tag', 'PP test tag');
  await page.click('#dp-finish');
  await page.waitForTimeout(800);
  const v2 = await page.evaluate(() => self.Store.visits().then(v => v.find(x => x.state !== 'sent')));
  ours.visits.push(norm(v2.globalId));
  await setOffline(false);
  await waitForAsync(page, () => self.Store.counts().then(c => c.outstanding === 0), null, { timeout: 120000, polling: 1000 });
  const nst = (await rest('/0/query', { where: "GlobalID = '" + added.globalId + "'", outFields: '*', returnGeometry: 'true', outSR: '4326' })).features[0];
  const nv = (await rest('/1/query', { where: "GlobalID = '" + v2.globalId + "'", outFields: 'StationGUID' })).features[0];
  if (!nst) fail('new station not on the layer');
  else if (Math.abs(nst.geometry.y - (TEST_AT.lat - 0.00018)) > 0.00005) fail('new station placed wrong: ' + JSON.stringify(nst.geometry));
  else ok('new station on the layer, where the phone was');
  if (nst && (nst.attributes.PostInstalled !== 'Yes' || nst.attributes.PostType !== 'Rebar' || nst.attributes.PostTag !== 'PP test tag' || !nst.attributes.InstallDate))
    fail('post installed on the visit did not update the station: ' + JSON.stringify(nst.attributes));
  else if (nst) ok('the post installed on the visit updated the station (Yes, Rebar, tag, install date)');
  if (!nv || norm(nv.attributes.StationGUID) !== norm(added.globalId)) fail('visit not linked to the new station');
  else ok('its visit went up after it, linked by the GlobalID minted on the phone');

  step('queue view');
  await page.click('#chip-queue');
  await page.waitForTimeout(400);
  const rowsUp = await page.locator('.qrow.sent').count();
  if (rowsUp !== 2) fail(rowsUp + ' visits shown as uploaded'); else ok('both visits shown as uploaded');

  if (errs.length) fail('page errors: ' + errs.join(' | ')); else ok('no page errors');
} catch (e) {
  fail('crashed: ' + (e && e.stack || e));
} finally {
  try { console.log('\ncleanup: ' + await cleanup()); } catch (e) { fail('cleanup: ' + e.message); }
  const after = await ids(1);
  if (after.size !== BASE_VISITS.size) fail(`visits: ${BASE_VISITS.size} before, ${after.size} after`);
  else ok('visits back to what they were');
  const afterSt = await ids(0);
  if (afterSt.size !== BASE_STATIONS.size) fail(`stations: ${BASE_STATIONS.size} before, ${afterSt.size} after`);
  else ok('stations back to what they were');
  await browser.close();
}
console.log(process.exitCode ? '\nFAILED' : '\nPhoto Points flow works end to end');
