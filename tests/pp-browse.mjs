/* Photo Points' photo browser (photopoints/browse.html). Browser, no service:
   the layers' answers are made up here and every photo is a picture of its
   own label ("2025-03-20 E"), so each check can see exactly which photo is
   on screen. The ArcGIS Maps SDK is a stand-in too: a few lines that record
   what the page asks of it and let the test tap a station. Nothing is
   written — any write is recorded and fails the run.

   - Signed out it shows the sign-in and nothing else, not even the map.
   - Signed in it opens on the map (the SDK gets the token; the station list
     is a button away); a tap on a station opens it, and back comes back.
   - It opens on the latest visit facing North; turning keeps the date,
     flipping keeps the direction, groundcover works, a slot with several
     photos pages through them, and at Post and Misc the side arrows step
     through that slot's photos instead of turning. A slot with none says so.
   - The photo is labelled with its direction; full size zooms (wheel, pinch,
     double-click, buttons) and drags, and the back button closes it.
   - Side by side and swipe compare two dates in the same direction.
   - Where you were survives a reload; swipes turn and flip; embedded in the
     experience the whole browser runs in a frame; if the map cannot load,
     the list stands in. */
import { URLBASE } from './env-lite.mjs';
import { chromium, CHROME, waitForAsync } from './browser.mjs';

const APP = new URL('photopoints/browse.html', URLBASE).href;
const fail = (m) => { console.log('  FAIL', m); process.exitCode = 1; };
const ok = (m) => console.log('  ok  ', m);
const step = (n) => console.log('\n== ' + n);

const GID = '{00000000-0000-4000-8000-0000000000C1}';
const OTHER = '{00000000-0000-4000-8000-0000000000C2}';
const SERVICE = 'https://services.arcgis.com/apTfC6SUmnNfnxuF/arcgis/rest/services/Photo_Monitoring/FeatureServer';
const day = (y, m, d) => Date.UTC(y, m - 1, d, 15, 0);
const ALL = ['N', 'E', 'S', 'W', 'LOW_N', 'LOW_E', 'LOW_S', 'LOW_W', 'LOCATOR'];
// four visits; the second has no east groundcover, two east photos, a misc photo and a PDF; the
// third has no post photo and one photo with no keyword; the fourth, an hour later the same day,
// is only extra photos — two misc — as when someone went back for a few more
const VISITS = [
  { oid: 11, when: day(2024, 3, 12), slots: ALL },
  { oid: 12, when: day(2025, 3, 20), slots: ALL.filter((s) => s !== 'LOW_E').concat(['E', 'MISC']), pdf: true },
  { oid: 13, when: day(2026, 4, 14), slots: ALL.filter((s) => s !== 'LOCATOR').concat(['']) },
  { oid: 14, when: day(2026, 4, 14) + 3600e3, slots: ['MISC', 'MISC'] },
];
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);          // 15:00 UTC is the same day in New York
const ATTS = {};
for (const v of VISITS) {
  ATTS[v.oid] = v.slots.map((kw, n) => ({ id: v.oid * 100 + n, keywords: kw, contentType: 'image/jpeg', size: 2048000,
    name: 'PB-01_' + (kw || 'X') + '_' + ymd(v.when).replace(/-/g, '') + '-150000_' + String(n * 7).padStart(3, '0') + 'T.jpg' }));
  if (v.pdf) ATTS[v.oid].push({ id: v.oid * 100 + 50, keywords: 'MISC', contentType: 'application/pdf', size: 1000, name: 'notes.pdf' });
}
const byId = {};
for (const v of VISITS) for (const a of ATTS[v.oid]) byId[a.id] = { v, a };
const idOf = (oid, kw, nth = 0) => ATTS[oid].filter((a) => a.keywords === kw)[nth].id;

/* The SDK stand-in: the parts the page imports, recording what it is asked. The map is a web map
   holding the visits layer and the station layer; the test taps a station with __view.tap(gid). */
const FAKE_SDK = `
const sdk = globalThis.__sdk = { tokens: [], cleared: 0, views: 0, destroyed: 0, webmaps: [], graphics: [], goTo: [] };
const SERVICE = ${JSON.stringify(SERVICE)};
const IM = { registerToken(o) { sdk.tokens.push(o); }, destroyCredentials() { sdk.cleared++; sdk.tokens = []; } };
class FeatureLayer { constructor(o) { Object.assign(this, { type: 'feature' }, o); } }
class WebMap {
  constructor(o) {
    sdk.webmaps.push(o.portalItem.id);
    this.layers = [new FeatureLayer({ url: SERVICE + '/1', title: 'Visits' }), new FeatureLayer({ url: SERVICE + '/0', title: 'Photo Stations' })];
    this.allLayers = { find: (f) => this.layers.find(f) };
  }
  load() { return Promise.resolve(this); }
  add(l) { this.layers.push(l); }
}
class MapView {
  constructor(o) {
    sdk.views++;
    Object.assign(this, { map: o.map, popupEnabled: o.popupEnabled, zoom: 10, handlers: {}, graphics: { add(g) { sdk.graphics.push(g); }, remove() {} } });
    this.container = document.getElementById(o.container);
    this.container.innerHTML = '<div class="fake-map" style="position:absolute;inset:0;background:#cfe3c8"></div>';
    globalThis.__view = this;
  }
  when() { return Promise.resolve(this); }
  on(type, f) { this.handlers[type] = f; return { remove() {} }; }
  hitTest(e, opt) { return Promise.resolve({ results: e.gid ? [{ graphic: { layer: opt.include[0], attributes: { GlobalID: e.gid } } }] : [] }); }
  goTo(t) { sdk.goTo.push(t); return Promise.resolve(); }
  destroy() { sdk.destroyed++; this.container.innerHTML = ''; }
  tap(gid) { this.handlers.click({ gid }); }
}
class Graphic { constructor(o) { Object.assign(this, o); } }
const MODS = { '@arcgis/core/identity/IdentityManager.js': IM, '@arcgis/core/WebMap.js': WebMap, '@arcgis/core/views/MapView.js': MapView,
  '@arcgis/core/layers/FeatureLayer.js': FeatureLayer, '@arcgis/core/Graphic.js': Graphic };
globalThis.$arcgis = { import: (names) => Promise.all(names.map((n) => MODS[n] || Promise.reject(new Error('no ' + n)))) };
`;
const sdkMode = { fail: false };

const writes = [];
async function fakeArcGIS(ctx) {
  await ctx.route('**://*.arcgis.com/**', async (route) => {
    const req = route.request(), url = new URL(req.url()), path = url.pathname;
    const p = new URLSearchParams(req.postData() || '');
    const json = (o) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(o) });
    const station = (gid, id) => ({ attributes: { OBJECTID: id === 'PB-01' ? 1 : 2, GlobalID: gid.replace(/[{}]/g, '').toLowerCase(), StationID: id,
      SiteName: 'Browse test', PostInstalled: 'Yes', StationStatus: 'Active' }, geometry: { x: -82.54, y: 28.17 } });
    let m;
    if (url.host === 'js.arcgis.com') {
      if (sdkMode.fail) return route.abort('internetdisconnected');
      if (path === '/5.1/core.js') return route.fulfill({ status: 200, contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' }, body: FAKE_SDK });
      if (/\.css$/.test(path)) return route.fulfill({ status: 200, contentType: 'text/css', body: '/* the SDK stylesheet */' });
      return route.abort('internetdisconnected');
    }
    if (/\/FeatureServer\/0\/query$/.test(path)) {
      const where = p.get('where') || '';
      if (/GlobalID/.test(where)) return json({ features: where.toUpperCase().includes(GID.slice(1, -1)) ? [station(GID, 'PB-01')] : [] });
      return json({ features: [station(GID, 'PB-01'), station(OTHER, 'PB-02')] });
    }
    if (/\/FeatureServer\/1\/query$/.test(path)) {
      if (p.get('outStatistics')) return json({ features: [{ attributes: { StationGUID: GID, lastvisit: VISITS[3].when, nvisits: 4 } }] });
      const mine = (p.get('where') || '').toUpperCase().includes(GID.slice(1, -1));
      return json({ features: mine ? VISITS.map((v) => ({ attributes: { OBJECTID: v.oid, GlobalID: 'aaaaaaaa-0000-4000-8000-0000000000' + v.oid,
        StationGUID: GID, VisitDate: v.when, Observer: 'Browse test', MonitoringEvent: 'Spring ' + ymd(v.when).slice(0, 4), Notes: null } })) : [] });
    }
    if (/\/FeatureServer\/1\/queryAttachments$/.test(path)) {
      const ids = String(p.get('objectIds')).split(',').map(Number);
      return json({ attachmentGroups: ids.map((id) => ({ parentObjectId: id, attachmentInfos: ATTS[id] || [] })) });
    }
    if ((m = /\/FeatureServer\/1\/(\d+)\/attachments\/(\d+)$/.exec(path)) && req.method() === 'GET') {
      const hit = byId[+m[2]];
      if (!hit) return route.fulfill({ status: 404, body: '' });
      const label = ymd(hit.v.when) + ' ' + (hit.a.keywords || 'none') + ' #' + hit.a.id;
      return route.fulfill({ status: 200, contentType: 'image/svg+xml', headers: { 'access-control-allow-origin': '*' },
        body: `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1200"><rect width="100%" height="100%" fill="#2c4a6e"/>` +
          `<text x="50%" y="50%" font-size="110" text-anchor="middle" fill="#fff" font-family="sans-serif">${label}</text></svg>` });
    }
    if (/applyEdits|addFeatures|updateFeatures|deleteFeatures|uploads|Attachment(s)?$/.test(path) && req.method() !== 'GET') writes.push(path);
    return route.abort('internetdisconnected');
  });
}

const browser = await chromium.launch({ executablePath: CHROME });
const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true, serviceWorkers: 'block',
  timezoneId: 'America/New_York' });
await fakeArcGIS(ctx);
// anything the page's Content-Security-Policy blocks is recorded
await ctx.addInitScript(() => {
  window.__csp = [];
  document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI));
});
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));

const shown = (pane = 'a', pg = page) => pg.evaluate((p) => {
  const el = document.querySelector('#pane-' + p);
  const img = el.querySelector('img');
  if (img.classList.contains('hidden')) return { empty: el.querySelector('.empty').textContent.trim() };
  const m = /\/(\d+)$/.exec(img.dataset.att || '');
  return { id: m ? +m[1] : null, caption: el.querySelector('figcaption').textContent, label: el.querySelector('.slotlabel').textContent };
}, pane);
async function expectPhoto(what, oid, kw, nth = 0, pane = 'a') {
  const s = await shown(pane);
  const want = idOf(oid, kw, nth);
  if (s.id !== want) fail(`${what}: expected #${want}, showing ${JSON.stringify(s)}`); else ok(`${what}: ${s.label} · ${s.caption}`);
}
const key = async (k) => { await page.keyboard.press(k); await page.waitForTimeout(150); };
const snap = (name, pg = page) => pg.screenshot({ path: new URL('./.out/pp-browse-' + name + '.png', import.meta.url).pathname });
const visible = (sel, pg = page) => pg.evaluate((s) => { const e = document.querySelector(s); return !!e && !!e.offsetParent && getComputedStyle(e).visibility !== 'hidden'; }, sel);
const viewIs = (pg = page) => pg.evaluate(() => window.PhotoBrowser.state.view);
const tapStation = (gid, pg = page) => pg.evaluate((g) => window.__view.tap(g), gid);
// the full-size photo: its scale and where its top left is, from its transform
const zoomNow = () => page.evaluate(() => {
  const im = document.querySelector('#b-full-body img');
  const m = /translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([-\d.]+)\)/.exec(im ? im.style.transform : '');
  return m ? { x: +m[1], y: +m[2], s: +m[3] } : null;
});

try {
  step('signed out: the sign-in, and nothing else — not even the map');
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => self.__pbReady, null, { timeout: 15000 });
  const before = await page.evaluate(() => ({ signin: !document.getElementById('b-signin').classList.contains('hidden'),
    map: !document.getElementById('b-map').classList.contains('hidden'), sdk: !!document.querySelector('script[src*="js.arcgis.com"]') }));
  if (!before.signin || before.map || before.sdk) fail('signed out: ' + JSON.stringify(before)); else ok('sign-in shown; no map, and the map library not even fetched');

  step('a token, then the map');
  await page.click('#b-signin summary');
  await page.fill('#si-token', 'made-up');
  await page.click('#si-token-go');
  await waitForAsync(page, () => !!window.PhotoBrowser.map(), null, { timeout: 10000, polling: 100 });
  const m0 = await page.evaluate(() => ({ view: PhotoBrowser.state.view, title: document.getElementById('b-title').textContent, sub: document.getElementById('b-sub').textContent,
    list: !document.getElementById('b-list-btn').classList.contains('hidden'), webmaps: __sdk.webmaps, layer: PhotoBrowser.map().layer.url,
    fields: PhotoBrowser.map().layer.outFields, popups: __view.popupEnabled,
    tokens: __sdk.tokens.map((t) => t.server + (t.token === 'made-up' ? ' ✓' : ' ✗')) }));
  if (m0.view !== 'b-map' || !m0.list || m0.sub !== 'Tap a station to see its photos') fail('the map view: ' + JSON.stringify(m0)); else ok('the map, with the station list a button away');
  if (m0.webmaps.join() !== 'e785cab8a5f745e8acd63a95d8966b90') fail('web map ' + m0.webmaps); else ok('the stations web map');
  if (!/\/FeatureServer\/0$/.test(m0.layer) || !m0.fields.includes('GlobalID') || m0.popups !== false) fail('the station layer: ' + JSON.stringify(m0));
  else ok('taps go to the station layer (not the visits), no popups');
  const wantTok = ['https://www.arcgis.com/sharing/rest ✓', 'https://services.arcgis.com/apTfC6SUmnNfnxuF/arcgis/rest/services ✓'];
  if (m0.tokens.join() !== wantTok.join()) fail('tokens for the SDK: ' + JSON.stringify(m0.tokens)); else ok('the SDK has the token for the portal and the layer: ' + m0.tokens.length + ' servers');
  await snap('map');
  // where am I: a dot, and the map goes to that dot's own geometry (the SDK's goTo does not cast a plain object)
  await ctx.grantPermissions(['geolocation'], { origin: new URL(URLBASE).origin });
  await ctx.setGeolocation({ latitude: 28.1712, longitude: -82.5401, accuracy: 5 });
  await page.click('#b-locate');
  await waitForAsync(page, () => __sdk.goTo.length > 0, null, { timeout: 10000, polling: 100 });
  const loc = await page.evaluate(() => { const g = __sdk.graphics[0], t = __sdk.goTo[0];
    return { same: !!g && t.target === g.geometry, zoom: t.zoom, at: g && [g.geometry.longitude, g.geometry.latitude] }; });
  if (!loc.same || loc.zoom < 17 || loc.at.join() !== '-82.5401,28.1712') fail('locate: ' + JSON.stringify(loc)); else ok('◎ puts a dot where you are and zooms there (' + loc.zoom + ')');

  step('the station list, and back to the map');
  await page.click('#b-list-btn');
  await page.waitForFunction(() => document.querySelectorAll('.strow').length === 2, null, { timeout: 10000 });
  const rows = await page.locator('.strow').allInnerTexts();
  if (!/4 visits, last 2026-04-14/.test(rows[0]) || !/no visits yet/.test(rows[1])) fail('rows: ' + JSON.stringify(rows)); else ok('PB-01 (4 visits) and PB-02 listed');
  if (!/view=list/.test(page.url())) fail('the list is not in the address'); else ok('the list is in the address');
  await snap('list');
  await page.click('#b-back');
  await page.waitForFunction(() => window.PhotoBrowser.state.view === 'b-map', null, { timeout: 5000 });
  const views = await page.evaluate(() => __sdk.views);
  if (views !== 1) fail('the map was built ' + views + ' times'); else ok('back on the same map (built once)');

  step('a tap on a station opens it on its latest visit with a North photo, facing North');
  await tapStation(GID.slice(1, -1).toLowerCase());                // as the layer gives it: lower case, no braces
  await waitForAsync(page, () => window.PhotoBrowser.state.view === 'b-viewer' &&
    !!document.querySelector('#pane-a img').complete, null, { timeout: 10000, polling: 200 });
  await expectPhoto('opens on', 13, 'N');
  if (!/station=/.test(page.url()) || (await page.evaluate(() => history.state && history.state.from)) !== 'map') fail('the station is not in the address, from the map');
  else ok('the station is in the address, and back leads to the map');
  const chips = await page.locator('.chip').allInnerTexts();
  if (chips.join() !== '2024-03-12,2025-03-20,2026-04-14 11:00,2026-04-14 12:00') fail('dates ' + chips.join());
  else ok('dates oldest to newest, with times where two share a day: ' + chips.join(', '));
  const over = await page.evaluate(() => {
    const st = document.getElementById('b-stage').getBoundingClientRect(), r = (s) => document.querySelector(s).getBoundingClientRect();
    const lab = r('#pane-a .slotlabel'), full = r('#pane-a .fullbtn');
    return { label: Math.abs((lab.left + lab.right) / 2 - (st.left + st.right) / 2) < 2 && lab.top - st.top < 20, full: st.right - full.right < 20 && full.top - st.top < 20 };
  });
  if (!over.label || !over.full) fail('on the photo: ' + JSON.stringify(over)); else ok('the direction at the top of the photo, full size at its top right');

  step('turn: the date stays');
  await page.click('#b-turn-right');
  await expectPhoto('turn right', 13, 'E');
  await page.click('#b-turn-left');
  await page.click('#b-turn-left');
  await expectPhoto('turn left twice', 13, 'W');
  await page.click('#b-turn-right');
  await page.click('#b-turn-right');

  step('flip dates: the direction stays; two photos facing one way page');
  await page.click('#b-older');
  await expectPhoto('a date back', 12, 'E');
  const pager = page.locator('#pane-a .pager');
  if (!await pager.isVisible() || (await pager.locator('span').textContent()) !== '1 of 2') fail('no "1 of 2" for two east photos');
  else ok('two east photos that day: ‹ 1 of 2 ›');
  await page.click('#pane-a .pg-next');
  await expectPhoto('the second east photo', 12, 'E', 1);
  await key(']');
  await expectPhoto('] goes round to the first', 12, 'E', 0);
  await key('[');
  await expectPhoto('[ back to the second', 12, 'E', 1);
  await page.locator('.chip', { hasText: '2024-03-12' }).click();
  await expectPhoto('tap a date', 11, 'E');

  step('keys: up and down for dates, G for groundcover');
  await key('ArrowUp');
  await key('ArrowUp');
  await expectPhoto('↑ ↑', 13, 'E');
  await key('g');
  await expectPhoto('G', 13, 'LOW_E');
  await key('ArrowDown');
  const none = await shown();
  if (!/^No east groundcover photo on 2025-03-20/.test(none.empty || '')) fail('missing slot: ' + JSON.stringify(none)); else ok('a slot with no photo says so: ' + none.empty);
  if (!(await page.locator('.chip.on.none').count())) fail('the date chip is not dimmed for the missing photo'); else ok('and its date is dimmed');
  await key('ArrowDown');
  await expectPhoto('↓ again', 11, 'LOW_E');
  await key('ArrowDown');
  if ((await page.evaluate(() => PhotoBrowser.state.i)) !== 0) fail('went past the first date'); else ok('stops at the first date');

  step('the post, and misc: the side arrows step through the photos there, not round the post');
  await key('p');
  await expectPhoto('P', 11, 'LOCATOR');
  if (await visible('#b-turn-right')) fail('side arrows shown for a lone post photo'); else ok('one post photo: no side arrows');
  await key('ArrowUp');
  await key('ArrowUp');
  const nopost = await shown();
  if (!/^No post photo on 2026-04-14/.test(nopost.empty || '')) fail('post: ' + JSON.stringify(nopost)); else ok('no post photo on the latest visit');
  await key('m');
  await expectPhoto('M — a photo with no keyword is misc', 13, '');
  await key('ArrowRight');
  await expectPhoto('→ with one misc photo: stays put', 13, '');
  await key('ArrowDown');
  await expectPhoto('misc a date back', 12, 'MISC');
  const files = await page.textContent('#b-details');
  if (!/notes\.pdf/.test(files)) fail('the PDF is not listed'); else ok('its PDF is listed under Files');
  await key('ArrowUp');
  await key('ArrowUp');
  await expectPhoto('the visit of two misc photos', 14, 'MISC', 0);
  if (!await visible('#b-turn-right') || (await page.getAttribute('#b-turn-right', 'aria-label')) !== 'Next photo here') fail('no "next photo" arrow');
  else ok('side arrows now page: "' + await page.getAttribute('#b-turn-right', 'aria-label') + '"');
  await key('ArrowRight');
  await expectPhoto('→ the next misc photo (not North)', 14, 'MISC', 1);
  await page.click('#b-turn-right');
  await expectPhoto('› goes round to the first', 14, 'MISC', 0);
  await key('ArrowLeft');
  await expectPhoto('← the other way', 14, 'MISC', 1);
  await key('n');
  const north = await shown();
  if (!/^No north groundcover photo/.test(north.empty || '')) fail('N: ' + JSON.stringify(north)); else ok('N faces north again, still at groundcover: ' + north.empty.replace(/(\d)(\d+ other)/, '$1 — $2'));
  await key('ArrowDown');
  await key('ArrowDown');
  await expectPhoto('two dates back', 12, 'LOW_N');
  await key('g');
  await expectPhoto('G back to eye level', 12, 'N');
  await snap('one');

  step('the token stays out of the page');
  await page.waitForFunction(() => /^blob:/.test(document.querySelector('#pane-a img').getAttribute('src') || ''), null, { timeout: 10000 });
  ok('the photo is shown from memory: ' + (await page.getAttribute('#pane-a img', 'src')).slice(0, 22) + '…');
  const leaks = await page.evaluate(() => ['made-up'].filter((t) => document.documentElement.outerHTML.includes(t) ||
    [...document.querySelectorAll('[href],[src]')].some((el) => (el.getAttribute('href') || el.getAttribute('src') || '').includes('token='))));
  if (leaks.length) fail('the token is in the page'); else ok('no token in the page: not in an image address, not in a link');

  step('full size: zoom in and out, drag, and back closes it');
  const atUrl = page.url();
  await page.click('#pane-a .fullbtn');
  await page.waitForFunction(() => { const i = document.querySelector('#b-full-body img'); return i && /^blob:/.test(i.src) && i.style.transform; }, null, { timeout: 10000 });
  const name = await page.textContent('#b-full-name');
  const fit = await zoomNow();
  if (!/^PB-01_N_20250320/.test(name) || !fit || Math.abs(fit.s - 393 / 1600) > 0.01) fail('full size: ' + name + ' ' + JSON.stringify(fit)); else ok('the whole photo fits: ' + name + ' at ' + fit.s.toFixed(3));
  if (!await page.isDisabled('#b-zoom-out') || await page.isDisabled('#b-zoom-in')) fail('zoom buttons at the fit'); else ok('at the fit: zoom out off, zoom in on');
  const fb = await page.locator('#b-full-body').boundingBox();
  const px = fb.x + fb.width * 0.3, py = fb.y + fb.height * 0.45;
  const under = (z) => ({ x: (px - fb.x - z.x) / z.s, y: (py - fb.y - z.y) / z.s });   // the photo's pixel under the pointer
  await page.mouse.move(px, py);
  // twice: after the first it is still shorter than the screen, so it stays centred top to bottom;
  // after the second it is bigger both ways, and the spot under the pointer stays put
  await page.mouse.wheel(0, -400);
  await page.waitForTimeout(150);
  const zm = await zoomNow();
  await page.mouse.wheel(0, -400);
  await page.waitForTimeout(150);
  const zw = await zoomNow(), u0 = under(zm), u1 = under(zw);
  if (!(zm.s > fit.s * 1.5) || !(zw.s > zm.s * 1.5) || Math.hypot(u1.x - u0.x, u1.y - u0.y) > 2) fail('wheel zoom: ' + JSON.stringify({ fit, zm, zw, u0, u1 }));
  else ok(`the wheel zooms in (×${(zw.s / fit.s).toFixed(1)}) about the pointer: pixel ${Math.round(u0.x)},${Math.round(u0.y)} stays under it`);
  await page.mouse.down();
  await page.mouse.move(px + 60, py + 40, { steps: 4 });
  await page.mouse.up();
  const zd = await zoomNow();
  if (Math.abs(zd.x - zw.x - 60) > 1 || Math.abs(zd.y - zw.y - 40) > 1) fail('drag: ' + JSON.stringify({ zw, zd })); else ok('a drag moves it with the pointer');
  await page.mouse.move(fb.x + 5, fb.y + 5);
  await page.mouse.down();
  await page.mouse.move(fb.x + 3000, fb.y + 3000, { steps: 3 });
  await page.mouse.up();
  const ze = await zoomNow();
  if (ze.x > 0.5 || ze.y > 0.5) fail('dragged off the edge: ' + JSON.stringify(ze)); else ok('but never past its edges');
  await key('0');
  const z0 = await zoomNow();
  if (Math.abs(z0.s - fit.s) > 1e-6) fail('0: ' + JSON.stringify(z0)); else ok('0 goes back to the whole photo');
  await page.mouse.dblclick(px, py);
  await page.waitForTimeout(100);
  const zz = await zoomNow();
  if (Math.abs(zz.s / fit.s - 3) > 0.05) fail('double-click: ' + JSON.stringify(zz)); else ok('a double-click zooms in ×3 there');
  await page.waitForTimeout(400);
  await page.mouse.dblclick(px, py);
  await page.waitForTimeout(100);
  if (Math.abs((await zoomNow()).s - fit.s) > 1e-6) fail('the second double-click did not go back'); else ok('and another goes back out');
  // two fingers spreading apart
  const cdp = await ctx.newCDPSession(page);
  const cx = Math.round(fb.x + fb.width / 2), cy = Math.round(fb.y + fb.height / 2);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: cx - 40, y: cy, id: 1 }, { x: cx + 40, y: cy, id: 2 }] });
  for (let k = 1; k <= 6; k++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: cx - 40 - k * 10, y: cy, id: 1 }, { x: cx + 40 + k * 10, y: cy, id: 2 }] });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(150);
  const zp = await zoomNow();
  if (Math.abs(zp.s / fit.s - 200 / 80) > 0.05) fail('pinch: ' + JSON.stringify({ fit, zp })); else ok(`a pinch zooms with the fingers: ×${(zp.s / fit.s).toFixed(2)} for 80 → 200 px apart`);
  await page.click('#b-zoom-in');
  const zi = await zoomNow();
  if (!(zi.s > zp.s * 1.5)) fail('+ button: ' + JSON.stringify(zi)); else ok('+ zooms in');
  await page.click('#b-zoom-fit');
  if (Math.abs((await zoomNow()).s - fit.s) > 1e-6) fail('the whole-photo button'); else ok('⤢ the whole photo again');
  await page.keyboard.press('Escape');
  await page.locator('#b-full').waitFor({ state: 'hidden', timeout: 5000 });
  if (page.url() !== atUrl || (await viewIs()) !== 'b-viewer') fail('Escape: ' + page.url()); else ok('Escape closes it, on the same photo');
  await key('f');
  await page.locator('#b-full').waitFor({ timeout: 5000 });
  await page.goBack();
  await page.locator('#b-full').waitFor({ state: 'hidden', timeout: 5000 });
  if (page.url() !== atUrl || (await viewIs()) !== 'b-viewer') fail('back: ' + page.url() + ' ' + await viewIs()); else ok('F opens it; the back button closes it and stays on the station');

  step('side by side');
  await key('ArrowUp');
  await key('2');
  if ((await page.getAttribute('#b-stage', 'class')) !== 'stage side') fail('not side by side'); else ok('side by side');
  await expectPhoto('A', 13, 'N');
  await expectPhoto('B, the visit before', 12, 'N', 0, 'b');
  await page.selectOption('#b-with', '0');
  await page.waitForTimeout(150);
  await expectPhoto('B, picked', 11, 'N', 0, 'b');
  await key('ArrowRight');
  await expectPhoto('both turn: A', 13, 'E');
  await expectPhoto('both turn: B', 11, 'E', 0, 'b');
  await page.click('#pane-b .fullbtn');
  await page.locator('#b-full-body img').waitFor({ timeout: 5000 });
  const bname = await page.textContent('#b-full-name');
  if (!/^PB-01_E_20240312/.test(bname)) fail('B full size: ' + bname); else ok('B\'s own full size: ' + bname);
  await page.keyboard.press('Escape');
  await page.locator('#b-full').waitFor({ state: 'hidden', timeout: 5000 });
  await snap('side');

  step('swipe');
  await key('3');
  if (!await page.locator('#b-divider').isVisible()) fail('no divider'); else ok('a divider over the two dates');
  await page.fill('#b-split', '30');
  await page.dispatchEvent('#b-split', 'input');
  const clip = await page.evaluate(() => document.getElementById('pane-a').style.clipPath);
  if (clip !== 'inset(0px 70% 0px 0px)' && clip !== 'inset(0 70% 0 0)') fail('clip ' + clip); else ok('A shows left of the divider, B right of it');
  await snap('swipe');

  step('it remembers where it was');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForAsync(page, () => self.__pbReady && !!window.PhotoBrowser.state.visits.length, null, { timeout: 10000, polling: 200 });
  await page.waitForTimeout(300);
  const st = await page.evaluate(() => { const s = PhotoBrowser.state; return [s.mode, s.i, s.j, s.dir, s.level].join(); });
  if (st !== 'swipe,2,0,E,eye') fail('after reload: ' + st); else ok('same view after a reload: ' + st);

  step('swipes turn and flip, and page at misc');
  await key('1');
  const box = await page.locator('#b-stage').boundingBox();
  const drag = async (dx, dy) => {
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx / 2, y + dy / 2);
    await page.mouse.move(x + dx, y + dy);
    await page.mouse.up();
    await page.waitForTimeout(200);
  };
  await drag(-140, 0);
  await expectPhoto('swipe left turns right', 13, 'S');
  await drag(0, 140);
  await expectPhoto('swipe down goes a date back', 12, 'S');
  await drag(0, -140);
  await expectPhoto('swipe up comes forward', 13, 'S');
  await key('ArrowUp');
  const extra = await shown();
  if (!/^No south photo on 2026-04-14 12:00/.test(extra.empty || '')) fail('the extra-photos visit: ' + JSON.stringify(extra));
  else ok('the later visit of extra photos: ' + extra.empty.replace(/(\d\d:\d\d)(\d+ other)/, '$1 — $2'));
  await key('m');
  await drag(-140, 0);
  await expectPhoto('at misc, a swipe left is the next misc photo', 14, 'MISC', 1);
  await key('s');

  step('embedded in the experience: the whole browser, the map first');
  const em = await ctx.newPage();
  em.on('pageerror', (e) => errs.push('embed: ' + e.message));
  await em.goto(APP + '?embed=1', { waitUntil: 'domcontentloaded' });
  await waitForAsync(em, () => self.__pbReady && !!window.PhotoBrowser.map(), null, { timeout: 10000, polling: 200 });
  const e0 = await em.evaluate(() => ({ view: PhotoBrowser.state.view, back: !document.getElementById('b-back').classList.contains('hidden'),
    list: !document.getElementById('b-list-btn').classList.contains('hidden') }));
  if (e0.view !== 'b-map' || e0.back || !e0.list) fail('embedded start: ' + JSON.stringify(e0)); else ok('the map, with no back button (nowhere to go back to) and the list button');
  await tapStation(GID.slice(1, -1).toLowerCase(), em);
  await waitForAsync(em, () => window.PhotoBrowser.state.view === 'b-viewer' && !!document.querySelector('#pane-a img').complete, null, { timeout: 10000, polling: 200 });
  const e1 = await em.evaluate(() => ({ title: document.getElementById('b-title').textContent, back: !document.getElementById('b-back').classList.contains('hidden'), url: location.search }));
  if (e1.title !== 'PB-01' || !e1.back || !/embed=1/.test(e1.url)) fail('embedded station: ' + JSON.stringify(e1)); else ok('a tap opens PB-01, still embedded, with a back button');
  await snap('embed-station', em);
  await em.click('#b-back');
  await em.waitForFunction(() => window.PhotoBrowser.state.view === 'b-map', null, { timeout: 5000 });
  ok('back to the map');

  step('embedded and handed a station (the experience\'s earlier layout)');
  await em.goto(APP + '?embed=1&station=' + encodeURIComponent(GID), { waitUntil: 'domcontentloaded' });
  await waitForAsync(em, () => self.__pbReady && !document.getElementById('b-viewer').classList.contains('hidden'), null, { timeout: 10000, polling: 200 });
  const ui = await em.evaluate(() => ({ back: getComputedStyle(document.getElementById('b-back')).display, list: getComputedStyle(document.getElementById('b-list-btn')).display,
    title: document.getElementById('b-title').textContent, sdk: !!document.querySelector('script[src*="js.arcgis.com"]') }));
  if (ui.back !== 'none' || ui.list !== 'none' || ui.title !== 'PB-01' || ui.sdk) fail('embedded: ' + JSON.stringify(ui)); else ok('straight to PB-01, no back or list buttons, no map loaded');
  // the experience first loads the page with its field placeholder, then with the station
  await em.goto(APP + '?embed=1&station=' + encodeURIComponent('﻿﻿{GlobalID}'), { waitUntil: 'domcontentloaded' });
  await em.waitForFunction(() => self.__pbReady, null, { timeout: 10000 });
  const wait = await em.evaluate(() => ({ msg: document.getElementById('b-msg').textContent, viewer: !document.getElementById('b-viewer').classList.contains('hidden') }));
  if (wait.msg !== 'Loading the station…' || wait.viewer) fail('placeholder: ' + JSON.stringify(wait)); else ok('the placeholder load just says "Loading the station…"');

  step('inside a frame sandboxed as the experience\'s Embed widget does it');
  // a parent on another site, as experience.arcgis.com is: localhost and 127.0.0.1 are different sites
  await em.goto(URLBASE.replace('127.0.0.1', 'localhost') + 'tests/README.md');
  await em.setContent('<iframe sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-presentation allow-popups-to-escape-sandbox" ' +
    'allow="local-network-access; geolocation" style="border:0;width:100vw;height:100vh" src="' + APP + '?embed=1"></iframe>');
  const fr = em.frameLocator('iframe');
  await fr.locator('#b-signin:not(.hidden), #b-map:not(.hidden)').first().waitFor({ timeout: 10000 });
  if (await fr.locator('#b-signin').isVisible()) {                // an embedded page keeps its own sign-in
    if (await fr.locator('#b-map').isVisible()) fail('the map shows before signing in, in the frame');
    else ok('in the frame, the sign-in first and no map');
    await fr.locator('#b-signin summary').click();
    await fr.locator('#si-token').fill('made-up');
    await fr.locator('#si-token-go').click();
  }
  await fr.locator('#b-map:not(.hidden)').waitFor({ timeout: 10000 });
  const frame = em.frames().find((f) => f !== em.mainFrame());
  await waitForAsync(frame, () => !!window.PhotoBrowser.map(), null, { timeout: 10000, polling: 200 });
  await frame.evaluate((g) => window.__view.tap(g), GID.slice(1, -1).toLowerCase());
  await fr.locator('#pane-a img:not(.hidden)').waitFor({ timeout: 10000 });
  const inFrame = await fr.locator('#pane-a .slotlabel').textContent();
  if (inFrame !== 'North') fail('in the sandboxed frame: ' + inFrame); else ok('works inside the experience\'s sandboxed frame: the map, a tap, then ' + inFrame);
  await em.close();

  step('if the map cannot load, the station list stands in');
  sdkMode.fail = true;
  const nm = await ctx.newPage();
  nm.on('pageerror', (e) => errs.push('no map: ' + e.message));
  await nm.goto(APP + '?embed=1', { waitUntil: 'domcontentloaded' });
  await nm.waitForFunction(() => document.querySelectorAll('.strow').length === 2, null, { timeout: 15000 });
  const nmv = await nm.evaluate(() => ({ msg: document.getElementById('b-msg').textContent, back: !document.getElementById('b-back').classList.contains('hidden') }));
  if (!/^The map did not load .*here is the list of stations\.$/.test(nmv.msg) || nmv.back) fail('no map: ' + JSON.stringify(nmv)); else ok(nmv.msg);
  await nm.close();
  sdkMode.fail = false;

  step('side by side on a desktop screen; the words on a photo step aside for the pointer');
  await page.setViewportSize({ width: 1280, height: 800 });
  await key('ArrowDown');
  await key('2');
  await page.waitForTimeout(300);
  const hs = await page.evaluate(() => ['pane-a', 'pane-b'].map((id) => Math.round(document.getElementById(id).getBoundingClientRect().height)));
  if (hs.some((h) => h < 300)) fail('pane heights ' + hs.join(', ')); else ok('both photos full height: ' + hs.join(' and ') + ' px');
  await snap('side-desktop');
  await key('1');
  const op = () => page.evaluate(() => getComputedStyle(document.querySelector('#pane-a .slotlabel')).opacity);
  const before2 = await op();
  await page.hover('#pane-a .slotlabel');
  await page.waitForTimeout(350);
  const during = await op();
  await page.mouse.move(5, 5);
  await page.waitForTimeout(350);
  const after2 = await op();
  if (before2 !== '1' || during !== '0' || after2 !== '1') fail('label on hover: ' + [before2, during, after2].join(' → ')); else ok('the direction label fades while the pointer is on it, and comes back');

  step('nothing off-screen, phone and desktop');
  for (const [w, h] of [[393, 852], [375, 667], [1280, 800]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(250);
    const r = await page.evaluate(() => {
      const vw = innerWidth;
      const out = ['#b-turn-left', '#b-turn-right', '#b-rose', '.extras', '#b-chips', '#b-older', '#b-newer', '#pane-a .fullbtn', '#pane-a .slotlabel']
        .map((s) => [s, document.querySelector(s).getBoundingClientRect()])
        .filter(([, b]) => b.left < -1 || b.right > vw + 1 || b.width === 0).map(([s]) => s);
      const rose = document.querySelector('[data-level="eye"]').getBoundingClientRect(), gnd = document.querySelector('[data-level="ground"]').getBoundingClientRect();
      return { scroll: document.documentElement.scrollWidth > vw + 1, out, eyeAbove: rose.bottom <= gnd.top + 1 && Math.abs(rose.left - gnd.left) < 2 };
    });
    if (r.scroll || r.out.length || !r.eyeAbove) fail(`${w}×${h}: ${JSON.stringify(r)}`); else ok(`${w}×${h}: everything in view, no sideways scroll, Eye above Ground`);
    await snap(w + 'x' + h);
  }

  step('a file, then signing out');
  await page.locator('.chip', { hasText: '2025-03-20' }).click();
  await page.locator('[data-full="0"]').click();
  await page.waitForFunction(() => /^blob:/.test((document.querySelector('#b-full-body iframe') || {}).src || ''), null, { timeout: 10000 });
  const zb = await page.evaluate(() => ['b-zoom-in', 'b-zoom-out', 'b-zoom-fit'].some((id) => !document.getElementById(id).classList.contains('hidden')));
  if (zb) fail('zoom buttons for a PDF'); else ok('the PDF opens in the page, from memory (no zoom buttons for it)');
  await page.click('#b-full-close');
  await page.locator('#b-full').waitFor({ state: 'hidden', timeout: 5000 });
  // this page was reloaded on the station, so its map is built only now: back to it, and the station again
  await page.click('#b-back');
  await waitForAsync(page, () => window.PhotoBrowser.state.view === 'b-map' && !!window.PhotoBrowser.map(), null, { timeout: 10000, polling: 200 });
  await tapStation(GID.slice(1, -1).toLowerCase());
  await waitForAsync(page, () => window.PhotoBrowser.state.view === 'b-viewer', null, { timeout: 10000, polling: 200 });
  await page.locator('#b-viewer .signout').click();
  await page.locator('#b-signin').waitFor({ timeout: 5000 });
  const after = await page.evaluate(() => self.Store.get('auth').then((a) => ({ auth: !!a, src: document.querySelector('#pane-a img').getAttribute('src'),
    map: !!window.PhotoBrowser.map(), destroyed: __sdk.destroyed, cleared: __sdk.cleared, tokens: __sdk.tokens.length })));
  if (after.auth || after.src || after.map || after.destroyed !== 1 || !after.cleared || after.tokens) fail('after signing out: ' + JSON.stringify(after));
  else ok('signed out: the token is gone, the photos and the map with it, and the SDK holds no token');

  const csp = await page.evaluate(() => window.__csp);
  if (csp.length) fail('blocked by the security policy: ' + csp.join(' | ')); else ok('the security policy blocked nothing the page needs');
  if (writes.length) fail('tried to write: ' + writes.join(', ')); else ok('nothing was written');
  if (errs.length) fail('page errors: ' + errs.join(' | ')); else ok('no page errors');
} catch (e) {
  fail('crashed: ' + (e && e.stack || e));
} finally {
  await browser.close();
}
console.log(process.exitCode ? '\nFAILED' : '\nthe photo browser works');
