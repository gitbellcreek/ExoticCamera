/* Landscape layout + install affordance checks. */
import { ROOT, OUT, FIXTURES, URLBASE, TOK, REFERER, arcFetch } from './env.mjs';
import { chromium, CHROME, relayArcGIS } from './browser.mjs';

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});
const fail = (m) => { console.log('  FAIL', m); process.exitCode = 1; };
const ok = (m) => console.log('  ok  ', m);

// iPhone 15 landscape, minus a chunk for Safari's bar — the case the user hit
for (const [name, w, h] of [['landscape', 852, 393], ['landscape-with-safari-bar', 852, 330], ['portrait', 393, 852]]) {
  const ctx = await browser.newContext({
    viewport: { width: w, height: h }, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
    permissions: ['camera', 'geolocation'],
    geolocation: { latitude: 30.2672, longitude: -97.7431, accuracy: 6 },
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  await page.goto('http://127.0.0.1:8848/index.html?x=' + name, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(900);
  await page.evaluate(() => {
    const e = new Event('deviceorientationabsolute');
    Object.assign(e, { absolute: true, alpha: 300, beta: 88, gamma: 4 });
    for (let i = 0; i < 15; i++) window.dispatchEvent(e);
  });
  await page.waitForTimeout(250);

  console.log('\n== ' + name + ' ' + w + 'x' + h);
  const box = async (sel) => page.locator(sel).boundingBox();
  const [shutter, bar, compass, menu, thumb] =
    await Promise.all([box('#shutter'), box('#topbar'), box('#compass'), box('#menu-btn'), box('#last-shot')]);

  // nothing may spill off-screen
  for (const [n, b] of [['shutter', shutter], ['compass', compass], ['menu', menu], ['thumb', thumb]]) {
    if (!b) { fail(n + ' missing'); continue; }
    if (b.x < 0 || b.y < 0 || b.x + b.width > w + 0.5 || b.y + b.height > h + 0.5)
      fail(`${n} off-screen: ${JSON.stringify(b)} in ${w}x${h}`);
  }
  // no overlap between the top bar and the shutter rail
  const overlaps = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
  if (overlaps(bar, shutter)) fail('top bar overlaps the shutter');

  if (w > h) {
    if (shutter.x < w * 0.75) fail(`shutter not on the right rail (x=${Math.round(shutter.x)} of ${w})`);
    else ok(`shutter on the right rail at x=${Math.round(shutter.x)}, vertically centred at y=${Math.round(shutter.y + shutter.height / 2)}`);
    const reach = Math.round(w - (shutter.x + shutter.width / 2));
    ok(`thumb reach: ${reach}px from the right edge`);
  } else {
    if (Math.abs(shutter.x + shutter.width / 2 - w / 2) > 4) fail('shutter not centred in portrait');
    else ok('shutter centred at the bottom in portrait');
  }
  ok(`compass ${Math.round(compass.width)}px, top bar height ${Math.round(bar.height)}px`);

  await page.screenshot({ path: `${OUT}/shot-${name}.png` });
  if (errs.length) fail('page errors: ' + errs.join(' | '));
  await ctx.close();
}

// install affordance
const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
await page.goto('http://127.0.0.1:8848/index.html?i=1', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(900);
console.log('\n== install affordance');
await page.click('#menu-btn');
await page.waitForTimeout(350);
if (!await page.locator('#mi-install').isVisible()) fail('no install menu item');
else ok('menu shows: ' + (await page.locator('#mi-install').innerText()).replace(/\n/g, ' — '));
await page.click('#mi-install');
await page.waitForTimeout(400);
if (!await page.locator('#install-panel').isVisible()) fail('install panel did not open');
else ok('panel opens with steps: ' + (await page.locator('#steps-other').isVisible() ? 'generic' : 'ios'));
await page.screenshot({ path: OUT + '/shot-install.png' });

// and it hides itself once installed
const ctx2 = await browser.newContext({ viewport: { width: 393, height: 852 } });
await ctx2.addInitScript(() => {
  const mm = window.matchMedia;
  window.matchMedia = (q) => (q.includes('display-mode: standalone') ? { matches: true, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} } : mm.call(window, q));
});
const p2 = await ctx2.newPage();
await p2.goto('http://127.0.0.1:8848/index.html?s=1', { waitUntil: 'domcontentloaded' });
await p2.waitForTimeout(1200);
await p2.click('#menu-btn');
await p2.waitForTimeout(300);
if (await p2.locator('#mi-install').isVisible()) fail('install item still shown when running standalone');
else ok('install item hidden when already running standalone');

await browser.close();
console.log(process.exitCode ? '\nSOME CHECKS FAILED' : '\nall layout checks passed');
