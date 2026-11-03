/* Photo Points' photo browser (photopoints/browse.html). Browser, no service:
   the layers' answers are made up here and every photo is a picture of its
   own label ("2025-03-20 E"), so each check can see exactly which photo is
   on screen. Nothing is written — any write is recorded and fails the run.

   - It opens on the latest visit facing North; turning keeps the date,
     flipping keeps the direction, groundcover / post / misc work, a slot with
     two photos cycles, and a slot with none says so.
   - Side by side and swipe compare two dates in the same direction.
   - Where you were survives a reload; swipes turn and flip; embedded in the
     experience it opens straight on the station it was handed. */
import { URLBASE } from './env-lite.mjs';
import { chromium, CHROME, waitForAsync } from './browser.mjs';

const APP = new URL('photopoints/browse.html', URLBASE).href;
const fail = (m) => { console.log('  FAIL', m); process.exitCode = 1; };
const ok = (m) => console.log('  ok  ', m);
const step = (n) => console.log('\n== ' + n);

const GID = '{00000000-0000-4000-8000-0000000000C1}';
const OTHER = '{00000000-0000-4000-8000-0000000000C2}';
const day = (y, m, d) => Date.UTC(y, m - 1, d, 15, 0);
const ALL = ['N', 'E', 'S', 'W', 'LOW_N', 'LOW_E', 'LOW_S', 'LOW_W', 'LOCATOR'];
// four visits; the second has no east groundcover, two east photos, a misc photo and a PDF; the
// third has no post photo and one photo with no keyword; the fourth, an hour later the same day,
// is only extra photos — as when someone went back for a few more
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

const writes = [];
async function fakeArcGIS(ctx) {
  await ctx.route('**://*.arcgis.com/**', async (route) => {
    const req = route.request(), url = new URL(req.url()), path = url.pathname;
    const p = new URLSearchParams(req.postData() || '');
    const json = (o) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(o) });
    const station = (gid, id) => ({ attributes: { OBJECTID: id === 'PB-01' ? 1 : 2, GlobalID: gid.replace(/[{}]/g, '').toLowerCase(), StationID: id,
      SiteName: 'Browse test', PostInstalled: 'Yes', StationStatus: 'Active' }, geometry: { x: -82.54, y: 28.17 } });
    let m;
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
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));

const shown = (pane = 'a') => page.evaluate((p) => {
  const el = document.querySelector('#pane-' + p);
  const img = el.querySelector('img');
  if (img.classList.contains('hidden')) return { empty: el.querySelector('.empty').textContent.trim() };
  const m = /attachments\/(\d+)/.exec(img.getAttribute('src') || '');
  return { id: m ? +m[1] : null, caption: el.querySelector('figcaption').textContent };
}, pane);
async function expectPhoto(what, oid, kw, nth = 0, pane = 'a') {
  const s = await shown(pane);
  const want = idOf(oid, kw, nth);
  if (s.id !== want) fail(`${what}: expected #${want}, showing ${JSON.stringify(s)}`); else ok(`${what}: ${s.caption}`);
}
const key = async (k) => { await page.keyboard.press(k); await page.waitForTimeout(150); };
const snap = (name) => page.screenshot({ path: new URL('./.out/pp-browse-' + name + '.png', import.meta.url).pathname });

try {
  step('signed out: asks to sign in');
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => self.__pbReady, null, { timeout: 15000 });
  if (!await page.locator('#b-signin').isVisible()) fail('no sign-in'); else ok('sign-in shown');

  step('a token, then the station list');
  await page.click('#b-signin summary');
  await page.fill('#si-token', 'made-up');
  await page.click('#si-token-go');
  await page.waitForFunction(() => document.querySelectorAll('.strow').length === 2, null, { timeout: 10000 });
  const rows = await page.locator('.strow').allInnerTexts();
  if (!/4 visits, last 2026-04-14/.test(rows[0]) || !/no visits yet/.test(rows[1])) fail('rows: ' + JSON.stringify(rows)); else ok('PB-01 (4 visits) and PB-02 listed');
  await snap('list');

  step('a station opens on its latest visit with a North photo, facing North');
  await page.locator('.strow', { hasText: 'PB-01' }).click();
  await waitForAsync(page, () => !document.getElementById('b-viewer').classList.contains('hidden') &&
    !!document.querySelector('#pane-a img').complete, null, { timeout: 10000, polling: 200 });
  await expectPhoto('opens on', 13, 'N');
  if (!/station=/.test(page.url())) fail('the station is not in the address'); else ok('the station is in the address');
  const chips = await page.locator('.chip').allInnerTexts();
  if (chips.join() !== '2024-03-12,2025-03-20,2026-04-14 11:00,2026-04-14 12:00') fail('dates ' + chips.join());
  else ok('dates oldest to newest, with times where two share a day: ' + chips.join(', '));

  step('turn: the date stays');
  await page.click('#b-turn-right');
  await expectPhoto('turn right', 13, 'E');
  await page.click('#b-turn-left');
  await page.click('#b-turn-left');
  await expectPhoto('turn left twice', 13, 'W');
  await page.click('#b-turn-right');
  await page.click('#b-turn-right');

  step('flip dates: the direction stays');
  await page.click('#b-older');
  await expectPhoto('a date back', 12, 'E');
  const multi = await page.locator('#pane-a .multi');
  if (!await multi.isVisible() || (await multi.textContent()) !== '1 of 2') fail('no "1 of 2" for two east photos');
  else ok('two east photos that day: 1 of 2');
  await multi.click();
  await expectPhoto('the second east photo', 12, 'E', 1);
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

  step('the post, and misc');
  await key('p');
  await expectPhoto('P', 11, 'LOCATOR');
  await key('ArrowUp');
  await key('ArrowUp');
  const nopost = await shown();
  if (!/^No post photo on 2026-04-14/.test(nopost.empty || '')) fail('post: ' + JSON.stringify(nopost)); else ok('no post photo on the latest visit');
  await key('m');
  await expectPhoto('M — a photo with no keyword is misc', 13, '');
  await key('ArrowDown');
  await expectPhoto('misc a date back', 12, 'MISC');
  const files = await page.textContent('#b-details');
  if (!/notes\.pdf/.test(files)) fail('the PDF is not listed'); else ok('its PDF is listed under Files');
  await key('ArrowRight');
  await expectPhoto('turn right from misc: North, still at groundcover', 12, 'LOW_N');
  await key('g');
  await expectPhoto('G back to eye level', 12, 'N');
  await snap('one');

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

  step('swipes turn and flip');
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

  step('embedded in the experience');
  const em = await ctx.newPage();
  em.on('pageerror', (e) => errs.push('embed: ' + e.message));
  await em.goto(APP + '?embed=1&station=' + encodeURIComponent(GID), { waitUntil: 'domcontentloaded' });
  await waitForAsync(em, () => self.__pbReady && !document.getElementById('b-viewer').classList.contains('hidden'), null, { timeout: 10000, polling: 200 });
  const ui = await em.evaluate(() => ({ back: getComputedStyle(document.getElementById('b-back')).display, list: getComputedStyle(document.getElementById('b-list-btn')).display,
    title: document.getElementById('b-title').textContent }));
  if (ui.back !== 'none' || ui.list !== 'none' || ui.title !== 'PB-01') fail('embedded: ' + JSON.stringify(ui)); else ok('straight to PB-01, no back or list buttons');
  // the experience first loads the page with its field placeholder, then with the station
  await em.goto(APP + '?embed=1&station=' + encodeURIComponent('﻿﻿{GlobalID}'), { waitUntil: 'domcontentloaded' });
  await em.waitForFunction(() => self.__pbReady, null, { timeout: 10000 });
  const wait = await em.evaluate(() => ({ msg: document.getElementById('b-msg').textContent, viewer: !document.getElementById('b-viewer').classList.contains('hidden') }));
  if (wait.msg !== 'Loading the station…' || wait.viewer) fail('placeholder: ' + JSON.stringify(wait)); else ok('the placeholder load just says "Loading the station…"');
  // and inside a frame sandboxed exactly as the experience's Embed widget does it
  await em.setContent('<iframe sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-presentation allow-popups-to-escape-sandbox" ' +
    'style="border:0;width:100vw;height:100vh" src="' + APP + '?embed=1&station=' + encodeURIComponent(GID.toLowerCase()) + '"></iframe>');
  const fr = em.frameLocator('iframe');
  await fr.locator('#b-signin, #b-viewer:not(.hidden)').first().waitFor({ timeout: 10000 });
  if (await fr.locator('#b-signin').isVisible()) {                // an embedded page keeps its own sign-in
    await fr.locator('#b-signin summary').click();
    await fr.locator('#si-token').fill('made-up');
    await fr.locator('#si-token-go').click();
  }
  await fr.locator('#pane-a img:not(.hidden)').waitFor({ timeout: 10000 });
  const inFrame = await fr.locator('#pane-a figcaption').textContent();
  if (!/North/.test(inFrame)) fail('in the sandboxed frame: ' + inFrame); else ok('works inside the experience\'s sandboxed frame: ' + inFrame);
  await em.close();

  step('side by side on a desktop screen');
  await page.setViewportSize({ width: 1280, height: 800 });
  await key('ArrowDown');
  await key('2');
  await page.waitForTimeout(300);
  const hs = await page.evaluate(() => ['pane-a', 'pane-b'].map((id) => Math.round(document.getElementById(id).getBoundingClientRect().height)));
  if (hs.some((h) => h < 300)) fail('pane heights ' + hs.join(', ')); else ok('both photos full height: ' + hs.join(' and ') + ' px');
  await snap('side-desktop');
  await key('1');

  step('nothing off-screen, phone and desktop');
  for (const [w, h] of [[393, 852], [375, 667], [1280, 800]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(250);
    const r = await page.evaluate(() => {
      const vw = innerWidth;
      const out = ['#b-turn-left', '#b-turn-right', '#b-rose', '.extras', '#b-chips', '#b-older', '#b-newer']
        .map((s) => [s, document.querySelector(s).getBoundingClientRect()])
        .filter(([, b]) => b.left < -1 || b.right > vw + 1 || b.width === 0).map(([s]) => s);
      return { scroll: document.documentElement.scrollWidth > vw + 1, out };
    });
    if (r.scroll || r.out.length) fail(`${w}×${h}: ${JSON.stringify(r)}`); else ok(`${w}×${h}: everything in view, no sideways scroll`);
    await snap(w + 'x' + h);
  }

  if (writes.length) fail('tried to write: ' + writes.join(', ')); else ok('nothing was written');
  if (errs.length) fail('page errors: ' + errs.join(' | ')); else ok('no page errors');
} catch (e) {
  fail('crashed: ' + (e && e.stack || e));
} finally {
  await browser.close();
}
console.log(process.exitCode ? '\nFAILED' : '\nthe photo browser works');
