/* Photo Points: one trip round the post, and going back into a visit.
   Browser, no service. The station list is put straight into the phone's
   storage, the visits layer's answers are made up here, and every write is
   refused before it leaves the browser — this suite never uploads anything.

   - After each shot the camera moves on: North, then North groundcover, then
     East and East groundcover, and so on round the post, then the post.
   - A finished visit — waiting, or long since uploaded — can be reopened to
     add photos or change its details; only what changed is queued. Backing
     out with no changes, or Discard, leaves it as it was.
   - A visit that is on the layer but not on this phone can be added to. */
import { URLBASE } from './env-lite.mjs';
import { chromium, CHROME, waitForAsync } from './browser.mjs';

const APP = new URL('photopoints/', URLBASE).href;
const fail = (m) => { console.log('  FAIL', m); process.exitCode = 1; };
const ok = (m) => console.log('  ok  ', m);
const step = (n) => console.log('\n== ' + n);

const GID = '{00000000-0000-4000-8000-0000000000A1}';
const STATION = { gid: GID, oid: 1, id: 'PV-01', site: 'Visit test', mu: '', habitat: '', postInstalled: 'Yes', postType: 'Rebar',
  postTag: '', installDate: null, status: 'Active', notes: '', lat: 28.17, lon: -82.54 };
const APRIL = { oid: 501, gid: '{00000000-0000-4000-8000-0000000000B2}', date: Date.UTC(2026, 3, 14, 15, 0), observer: 'Field Maps',
  atts: [{ id: 1, name: 'n.jpg', keywords: 'N' }, { id: 2, name: 'e.jpg', keywords: 'E' }, { id: 3, name: 'm.pdf', keywords: 'MISC' }] };
const META = {
  0: { fields: [{ name: 'PostType', type: 'esriFieldTypeString', domain: { type: 'codedValue', codedValues: [{ name: 'Rebar', code: 'Rebar' }] } }] },
  1: { fields: [{ name: 'PostCondition', type: 'esriFieldTypeString', domain: { type: 'codedValue', codedValues: [{ name: 'Good', code: 'Good' }] } }] },
};
let served = [];                 // the station's visits as the made-up layer reports them
const writes = [];

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});
const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true,
  serviceWorkers: 'block',      // no background drain: nothing here may try to upload
  permissions: ['camera', 'geolocation'], geolocation: { latitude: 28.1701, longitude: -82.54, accuracy: 5 } });
await ctx.route('**://*.arcgis.com/**', async (route) => {
  const req = route.request(), path = new URL(req.url()).pathname;
  const p = new URLSearchParams(req.postData() || '');
  const json = (o) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(o) });
  if (/\/Photo_Monitoring\/FeatureServer\/[01]$/.test(path)) return json(META[path.slice(-1)]);
  if (/\/FeatureServer\/1\/query$/.test(path) && /StationGUID/.test(p.get('where') || '')) {
    return json({ features: served.map((v) => ({ attributes: { OBJECTID: v.oid, GlobalID: v.gid.replace(/[{}]/g, '').toLowerCase(),
      VisitDate: v.date, Observer: v.observer, Notes: null } })) });
  }
  if (/\/FeatureServer\/1\/queryAttachments$/.test(path)) {
    const ids = String(p.get('objectIds')).split(',').map(Number);
    return json({ attachmentGroups: served.filter((v) => ids.includes(v.oid)).map((v) => ({ parentObjectId: v.oid, attachmentInfos: v.atts })) });
  }
  if (/Photo_Monitoring/.test(path) && /applyEdits|uploads|Attachment/.test(path)) writes.push(path);
  return route.abort('internetdisconnected');
});
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('dialog', (d) => d.accept());

const snap = async (name) => {                        // without the toasts, which pile up with no compass here
  const hide = await page.addStyleTag({ content: '#toasts { display: none !important; }' });
  await page.screenshot({ path: new URL('./.out/pp-visit-' + name + '.png', import.meta.url).pathname });
  await hide.evaluate((el) => el.remove());
};
const visits = () => page.evaluate(() => self.Store.visits());
const shotsOf = (id) => page.evaluate((i) => self.Store.shotsOf(i), id);
const slotNow = () => page.evaluate(() => PhotoPoints.state.slot);
async function camera() {
  await page.waitForFunction(() => document.body.classList.contains('view-cam') && document.getElementById('preview').videoWidth > 0, null, { timeout: 15000 });
  await page.waitForTimeout(300);
}
async function shoot() {
  await page.click('#shutter');
  await page.waitForFunction(() => !document.getElementById('shutter').disabled && document.getElementById('saving').classList.contains('hidden'), null, { timeout: 15000 });
  await page.waitForTimeout(700);                       // the camera moves on 350 ms after a shot
}
async function home() {
  await page.waitForFunction(() => document.body.classList.contains('view-home'), null, { timeout: 10000 });
  await page.waitForTimeout(300);
}
async function openStation(rows) {
  await page.locator('.st').first().click();
  await waitForAsync(page, (n) => document.querySelectorAll('#sp-visits .vrow').length === n, rows, { timeout: 10000, polling: 200 });
}
const editRow = (i) => page.locator('#sp-visits .vrow button').nth(i).click();
async function markUploaded(id, oid) {
  await page.evaluate(async ([i, o]) => {
    for (const s of await self.Store.shotsOf(i)) await self.Store.patchShot(s.id, { state: 'sent', attachmentId: 1 });
    await self.Store.patchVisit(i, { state: 'sent', objectId: o, sentAt: Date.now() });
  }, [id, oid]);
}

try {
  step('a station on the phone, signed in, nothing uploads');
  await page.goto(APP + '?visit=1', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => self.__ppReady, null, { timeout: 15000 });
  await page.evaluate(async (st) => {
    await self.Store.set('stations', { at: Date.now(), list: [st], stats: { [st.gid]: { last: Date.UTC(2026, 3, 14), count: 1 } } });
    await self.Store.set('auth', { mode: 'manual', token: 'made-up', expires: Date.now() + 3600e3, username: 'test' });
    await self.Config.save({ autoSync: false });
  }, STATION);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelectorAll('.st').length === 1, null, { timeout: 15000 });
  ok('PV-01 listed');

  step('one trip round the post');
  await page.locator('.st').first().click();
  await page.click('#sp-start');
  await camera();
  const order = [];
  for (let i = 0; i < 9; i++) { order.push(await slotNow()); await shoot(); }
  const want = ['N', 'LOW_N', 'E', 'LOW_E', 'S', 'LOW_S', 'W', 'LOW_W', 'LOCATOR'];
  if (order.join() !== want.join()) fail('order ' + order.join(' → ')); else ok(order.join(' → '));
  if ((await page.locator('.slot.has').count()) !== 9) fail('not every slot shows its photo'); else ok('nine slots show a photo');

  step('finish it, and it goes up');
  await page.click('#finish');
  await page.fill('#dp-observer', 'Visit test');
  await page.click('#dp-finish');
  await home();
  let v1 = (await visits())[0];
  if (v1.state !== 'queued' || (await shotsOf(v1.id)).length !== 9) fail('after Done: ' + v1.state); else ok('queued with nine photos');
  await markUploaded(v1.id, 4242);
  served = [{ oid: 4242, gid: v1.globalId, date: v1.attrs.VisitDate, observer: 'Visit test',
    atts: want.map((k, i) => ({ id: 10 + i, name: k + '.jpg', keywords: k })) }, APRIL];

  step('the station sheet lists its visits');
  await openStation(2);
  await page.waitForTimeout(400);
  await snap('station');
  const rows = await page.locator('#sp-visits .vrow').allInnerTexts();
  if (!/uploaded/.test(rows[0]) || !/9 photos/.test(rows[0])) fail('first row: ' + rows[0]); else ok('this phone\'s visit, uploaded, 9 photos — once, not twice');
  if (!/on the layer/.test(rows[1]) || !/2026-04-14/.test(rows[1]) || !/3 photos/.test(rows[1])) fail('second row: ' + rows[1]);
  else ok('and the April visit that is only on the layer');

  step('add a photo to the uploaded visit');
  await editRow(0);
  await camera();
  const head = await page.textContent('#cam-station');
  v1 = (await visits()).find((v) => v.id === v1.id);
  if (v1.state !== 'draft' || !v1.reopened) fail('not reopened: ' + v1.state); else ok('reopened: ' + head);
  await page.click('.slot[data-slot="MISC"]');
  await shoot();
  await snap('camera');
  await page.click('#finish');
  await page.waitForTimeout(400);
  await snap('details');
  const summary = await page.textContent('#dp-summary');
  if (!/^1 new photo · 9 already in this visit$/.test(summary)) fail('summary: ' + summary); else ok(summary);
  if ((await page.textContent('#dp-discard')).trim() !== 'Discard changes') fail('discard button says ' + await page.textContent('#dp-discard'));
  if ((await page.textContent('#dp-finish')).trim() !== 'Save & upload changes') fail('finish button says ' + await page.textContent('#dp-finish'));
  await page.click('#dp-finish');
  await home();
  v1 = (await visits()).find((v) => v.id === v1.id);
  const owed = (await shotsOf(v1.id)).filter((s) => s.state !== 'sent');
  if (v1.state !== 'queued' || v1.reopened || v1.objectId !== 4242) fail('after Done: ' + JSON.stringify({ s: v1.state, r: !!v1.reopened, o: v1.objectId }));
  else ok('queued again, same visit on the layer');
  if (owed.length !== 1 || owed[0].slot !== 'MISC') fail(owed.length + ' photos owed'); else ok('only the new photo is owed');
  if (v1.pendingEdit) fail('unchanged details marked to be sent again'); else ok('unchanged details are not sent again');

  step('reopen from the upload queue, change nothing, back out');
  await page.click('#chip-queue');
  await page.locator('.qrow [data-reopen]').first().click();
  await camera();
  await page.click('#cam-close');
  await home();
  v1 = (await visits()).find((v) => v.id === v1.id);
  if (v1.state !== 'queued' || v1.reopened || (await shotsOf(v1.id)).length !== 10) fail('not as it was: ' + v1.state); else ok('as it was');

  step('change the details of an uploaded visit');
  await markUploaded(v1.id, 4242);
  await openStation(2);
  await editRow(0);
  await camera();
  await page.click('#finish');
  await page.fill('#dp-observer', 'Someone else');
  await page.fill('#dp-notes', 'Added later');
  await page.click('#dp-finish');
  await home();
  v1 = (await visits()).find((v) => v.id === v1.id);
  if (!v1.pendingEdit || v1.attrs.Notes !== 'Added later' || v1.state !== 'queued') fail('change not queued: ' + JSON.stringify(v1.attrs));
  else ok('the change is queued for the visit on the layer');
  const remembered = await page.evaluate(() => self.Config.get().observer);
  if (remembered !== 'Visit test') fail('an older visit\'s observer became the default: ' + remembered); else ok('today\'s default observer is left alone');

  step('discard changes');
  await openStation(2);
  await editRow(0);
  await camera();
  await shoot();
  await page.click('#finish');
  await page.click('#dp-discard');
  await home();
  v1 = (await visits()).find((v) => v.id === v1.id);
  if ((await shotsOf(v1.id)).length !== 10) fail('the new photo was kept'); else ok('the new photo is gone');
  if (v1.state !== 'queued' || !v1.pendingEdit || v1.attrs.Notes !== 'Added later' || v1.reopened) fail('not put back: ' + JSON.stringify({ s: v1.state, p: v1.pendingEdit }));
  else ok('and the visit is back as it was, its earlier change still owed');

  step('one open visit per station');
  await page.locator('.st').first().click();
  await page.click('#sp-start');
  await camera();
  await shoot();
  await page.click('#cam-close');
  await home();
  await openStation(2);
  await editRow(0);
  await page.waitForTimeout(800);
  const drafts = (await visits()).filter((v) => v.state === 'draft');
  const view = await page.evaluate(() => document.body.className);
  if (drafts.length !== 1 || /view-cam/.test(view)) fail(drafts.length + ' open visits'); else ok('the visit in progress has to be finished first');
  await page.click('#sp-start');                       // Resume, then throw it away
  await camera();
  await page.click('#finish');
  await page.click('#dp-discard');
  await home();
  if ((await visits()).some((v) => v.state === 'draft')) fail('the new visit was not discarded'); else ok('(discarded it)');

  step('a visit only on the layer: look, change nothing');
  const before = (await visits()).length;
  await openStation(2);
  await editRow(1);
  await camera();
  await page.click('#cam-close');
  await home();
  if ((await visits()).length !== before) fail('a copy was left on the phone'); else ok('nothing left behind');

  step('a visit only on the layer: add to it');
  await openStation(2);
  await editRow(1);
  await camera();
  const s0 = await slotNow();
  const has = await page.locator('.slot.has').evaluateAll((els) => els.map((e) => e.dataset.slot).join());
  if (s0 !== 'LOW_N') fail('started at ' + s0); else ok('starts at the first slot it has no photo for: LOW_N');
  if (has !== 'N,E,MISC') fail('slots shown as done: ' + has); else ok('its photos on the layer show in N, E and +');
  await shoot();
  if ((await slotNow()) !== 'LOW_E') fail('moved on to ' + await slotNow()); else ok('then on to LOW_E, skipping E');
  await page.click('#finish');
  const s2 = await page.textContent('#dp-summary');
  if (!/^1 new photo · 3 already in this visit$/.test(s2)) fail('summary: ' + s2); else ok(s2);
  await page.click('#dp-finish');
  await home();
  const a = (await visits()).find((v) => v.globalId === APRIL.gid);
  if (!a || a.objectId !== APRIL.oid || a.state !== 'queued' || a.pendingEdit) fail('adopted visit: ' + JSON.stringify(a && { o: a.objectId, s: a.state, p: a.pendingEdit }));
  else ok('queued as the April visit on the layer — photos only, its details untouched');
  if ((await shotsOf(a.id)).length !== 1) fail('photos: ' + (await shotsOf(a.id)).length); else ok('one photo to add to it');

  step('the compass after the phone was locked: north learned again, and said so until checked');
  // A simulated iPhone: CoreMotion's attitude in an arbitrary gyro frame, split into alpha/beta/gamma
  // as WebKit does, and Core Location's heading (the top of the phone while near level, else its back).
  // What went wrong on 3 Nov 2026: north checked, the phone locked on the way to the next post, iOS
  // back with a new gyro frame — and the old code kept the old north, 180° out, still saying "✓".
  await page.evaluate(() => {
    const D = Math.PI / 180;
    const Rz = (a) => { const c = Math.cos(a * D), s = Math.sin(a * D); return [c, -s, 0, s, c, 0, 0, 0, 1]; };
    const Rx = (a) => { const c = Math.cos(a * D), s = Math.sin(a * D); return [1, 0, 0, 0, c, -s, 0, s, c]; };
    const mul = (A, B) => { const C = Array(9).fill(0); for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) C[r * 3 + c] += A[r * 3 + k] * B[k * 3 + c]; return C; };
    const brg = (x, y) => ((Math.atan2(x, y) / D) % 360 + 360) % 360;
    window.__pose = { yaw: 30, pitch: -50, quarter: 0 };          // looking at the screen
    window.__frame = 130;
    // a hand moves between poses, it does not teleport: at most 4° a reading (120°/s) on each axis
    const step = (a, b) => a + Math.max(-4, Math.min(4, b - a));
    window.__pump = () => {
      window.__cur = { ...window.__pose };                         // after a pause the person is wherever they are now
      return setInterval(() => {
      const c = window.__cur, w = window.__pose;
      c.yaw = step(c.yaw, w.yaw); c.pitch = step(c.pitch, w.pitch); c.quarter = step(c.quarter, w.quarter);
      const p = c;
      const truth = mul(mul(mul(Rz(-p.yaw), [1, 0, 0, 0, 0, -1, 0, 1, 0]), Rx(p.pitch)), Rz(p.quarter));
      const R = mul(Rz(window.__frame), truth);
      let z, x, y;
      if (R[8] > 0) { z = Math.atan2(-R[1], R[4]); x = Math.asin(R[7]); y = Math.atan2(-R[6], R[8]); }
      else { z = Math.atan2(R[1], -R[4]); x = -Math.asin(R[7]); x += x >= 0 ? -Math.PI : Math.PI; y = Math.atan2(R[6], -R[8]); }
      const top = [truth[1], truth[4], truth[7]], back = [-truth[2], -truth[5], -truth[8]];
      const H = Math.hypot(top[0], top[1]) >= Math.SQRT1_2 ? brg(top[0], top[1]) : brg(back[0], back[1]);
      const e = new Event('deviceorientation');
      Object.assign(e, { alpha: ((z / D) + 360) % 360, beta: x / D, gamma: y / D, absolute: false, webkitCompassHeading: H, webkitCompassAccuracy: 8 });
      window.dispatchEvent(e);
    }, 33);
    };
    window.__pumping = window.__pump();
  });
  await page.waitForTimeout(2500);
  const c0 = await page.evaluate(() => ({ settled: PhotoPoints.state.settled, mag: PhotoPoints.state.mag }));
  if (!c0.settled || Math.abs(c0.mag - 30) > 2) fail('north at home: ' + JSON.stringify(c0)); else ok(`north checked while looking at the screen (${c0.mag.toFixed(1)}° magnetic)`);
  await page.locator('.st').first().click();
  await page.click('#sp-start');
  await camera();
  if (await page.isVisible('#aim-check')) fail('"not checked" shown with north checked'); else ok('no warning on the picture while north is checked');
  await page.evaluate(() => { window.__pose = { yaw: 30, pitch: 3, quarter: 90 }; });   // as for the photos: landscape, upright
  await page.waitForTimeout(1500);
  if (!(await page.evaluate(() => PhotoPoints.state.settled))) fail('turning the phone to landscape cost the check'); else ok('turned to landscape: still checked');
  // locked on the way to the next post: no readings at all, then iOS back with a new gyro frame, facing somewhere else
  await page.evaluate(() => {
    clearInterval(window.__pumping);
    Object.defineProperty(document, 'visibilityState', { get: () => 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(2500);
  await page.evaluate(() => {
    window.__frame += 180;
    window.__pose = { yaw: 120, pitch: 3, quarter: 90 };
    Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    window.__pumping = window.__pump();
  });
  const blank = await page.waitForFunction(() => document.getElementById('heading-deg').textContent === '---', null, { timeout: 1500 }).then(() => true, () => false);
  if (!blank) fail('kept showing the heading from before the lock'); else ok('back from the lock: no heading for a moment, not the old one');
  await camera();
  await page.waitForFunction(() => document.getElementById('heading-deg').textContent !== '---', null, { timeout: 4000 });
  const c1 = await page.evaluate(() => ({ heading: PhotoPoints.state.heading, banner: !document.getElementById('aim-check').classList.contains('hidden'),
    text: document.getElementById('aim-check').textContent, chip: document.getElementById('chip-cal').textContent }));
  if (Math.abs(((c1.heading - 113.7) % 360 + 540) % 360 - 180) > 3) fail('heading after the lock: ' + c1.heading); else ok(`then the new heading, right: ${c1.heading.toFixed(1)}° true (facing 120° magnetic)`);
  if (!c1.banner || !/^Compass not checked — hold the phone in portrait, tilted as if you were reading it/.test(c1.text) || c1.chip !== 'compass not checked') fail('after the lock: ' + JSON.stringify(c1));
  else ok('and says on the picture that north is not checked, and how to check it');
  await snap('compass-unchecked');
  const vid = await page.evaluate(() => PhotoPoints.state.visit.id);
  await shoot();
  const shot = (await shotsOf(vid)).pop();
  const warned = await page.evaluate(() => [...document.querySelectorAll('.toast')].some((t) => /^Taken before the compass was checked/.test(t.textContent)));
  if (!shot || shot.compassSettled || Math.abs(((shot.heading - 113.7) % 360 + 540) % 360 - 180) > 3) fail('the shot: ' + JSON.stringify(shot && { h: shot.heading, s: shot.compassSettled }));
  else ok(`a shot taken meanwhile has the right bearing (${shot.heading}°), marked as taken before the check`);
  if (!warned) fail('no warning that the photo was taken before the check'); else ok('and the first such shot of the visit says so');
  await page.evaluate(() => { window.__pose = { yaw: 120, pitch: -50, quarter: 0 }; });   // one look at the screen
  await page.waitForFunction(() => PhotoPoints.state.settled, null, { timeout: 5000 });
  await page.waitForTimeout(300);
  const c2 = await page.evaluate(() => ({ banner: !document.getElementById('aim-check').classList.contains('hidden'), chip: document.getElementById('chip-cal').textContent,
    toast: [...document.querySelectorAll('.toast')].some((t) => t.textContent === 'Compass checked ✓'),
    crumbs: self.Report.breadcrumbs().filter((c) => /^compass|^photo$/.test(c.m)).map((c) => c.m + (c.x ? ' ' + c.x : '')) }));
  if (c2.banner || c2.chip !== 'compass ✓' || !c2.toast) fail('after one look at the screen: ' + JSON.stringify(c2)); else ok('one look at the screen: "Compass checked ✓", and the warning goes');
  const crumbs = c2.crumbs.join(' | ');
  if (!/compass reset hidden/.test(crumbs) || !/"settled":false,"compass":\{"settled":false,"resets":1,"why":"hidden"/.test(crumbs) || !/compass checked/.test(crumbs)) fail('breadcrumbs: ' + crumbs);
  else ok('a problem report would show it: the reset, the photo taken before the check, the check');
  await page.evaluate(() => clearInterval(window.__pumping));

  if (writes.length) fail('tried to write: ' + writes.join(', ')); else ok('nothing was sent anywhere');
  if (errs.length) fail('page errors: ' + errs.join(' | ')); else ok('no page errors');
} catch (e) {
  fail('crashed: ' + (e && e.stack || e));
} finally {
  await browser.close();
}
console.log(process.exitCode ? '\nFAILED' : '\ngoing back into a visit works');
