/* The camera freeze: iOS can hand back a stream whose tracks look live while no
   frames arrive. The preview sticks on its last image and only a new stream —
   what flipping the camera does — clears it. */
import { ROOT, OUT, FIXTURES, URLBASE, TOK, REFERER, arcFetch } from './env.mjs';
import { chromium, CHROME, relayArcGIS } from './browser.mjs';

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});
const fail = (m) => { console.log('  FAIL', m); process.exitCode = 1; };
const ok = (m) => console.log('  ok  ', m);

async function open(label) {
  const ctx = await browser.newContext({
    viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true,
    permissions: ['camera', 'geolocation'],
    geolocation: { latitude: 30.2672, longitude: -97.7431, accuracy: 6 },
  });
  // count how many times a fresh stream is opened
  await ctx.addInitScript(() => {
    window.__gum = 0;
    const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = (c) => { window.__gum++; return real(c); };
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  await page.goto(URLBASE + '?cam=' + label, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.getElementById('preview').videoWidth > 0, null, { timeout: 15000 });
  console.log('\n== ' + label);
  return { ctx, page, errs };
}

// 1. a healthy camera must be left alone
{
  const { ctx, page, errs } = await open('healthy camera is left alone');
  const before = await page.evaluate(() => window.__gum);
  await page.waitForTimeout(9000);
  const after = await page.evaluate(() => window.__gum);
  if (after !== before) fail(`restarted a working camera ${after - before} time(s)`);
  else ok('no spurious restarts over 9s of normal running');
  if (errs.length) fail('errors: ' + errs.join(' | '));
  await ctx.close();
}

// 2. the track dies outright — the app should notice without being told
{
  const { ctx, page, errs } = await open('video track ends');
  const before = await page.evaluate(() => window.__gum);
  await page.evaluate(() => {
    document.getElementById('preview').srcObject.getVideoTracks()[0].stop();
  });
  await page.waitForFunction((n) => window.__gum > n, before, { timeout: 15000 })
    .then(() => ok('opened a fresh stream after the track ended'))
    .catch(() => fail('a dead track was never noticed — the preview would stay frozen'));
  await page.waitForFunction(() => document.getElementById('preview').videoWidth > 0, null, { timeout: 15000 })
    .then(() => ok('preview is live again'))
    .catch(() => fail('preview never came back'));
  if (errs.length) fail('errors: ' + errs.join(' | '));
  await ctx.close();
}

// 3. the real symptom: tracks claim to be live, but no frames arrive
{
  const { ctx, page, errs } = await open('frames stop while the track claims to be live');
  const before = await page.evaluate(() => window.__gum);
  await page.evaluate(() => {
    const v = document.getElementById('preview');
    // freeze the clock the way a suspended capture session does
    Object.defineProperty(v, 'currentTime', { get: () => 3.5, configurable: true });
  });
  const recovered = await page.waitForFunction((n) => window.__gum > n, before, { timeout: 15000 })
    .then(() => true).catch(() => false);
  if (!recovered) fail('a frozen preview was never detected — this is the reported bug');
  else ok('detected a frozen preview and rebuilt the stream, without the user flipping cameras');
  const toasts = await page.evaluate(() => [...document.querySelectorAll('.toast')].map(t => t.textContent));
  if (!toasts.some(t => /stall/i.test(t))) console.log('   (no toast visible by now:', JSON.stringify(toasts) + ')');
  else ok('and it says so on screen: ' + JSON.stringify(toasts.filter(t => /stall/i.test(t))));
  if (errs.length) fail('errors: ' + errs.join(' | '));
  await ctx.close();
}

// 4. a stalled preview must not be photographed — that records a stale frame
{
  const { ctx, page, errs } = await open('shutter while stalled');
  await page.evaluate(() => {
    const v = document.getElementById('preview');
    v.srcObject.getVideoTracks()[0].stop();          // live=false, videoWidth may persist
  });
  await page.waitForTimeout(300);
  await page.click('#shutter');
  await page.waitForTimeout(1200);
  const queued = await page.evaluate(() => self.Store.all().then(r => r.length));
  if (queued !== 0) fail(`captured ${queued} photo(s) from a preview that was not delivering frames`);
  else ok('refused to capture a stale frame');
  const toasts = await page.evaluate(() => [...document.querySelectorAll('.toast')].map(t => t.textContent));
  if (!toasts.some(t => /stall/i.test(t))) fail('no explanation given: ' + JSON.stringify(toasts));
  else ok('told the user to take it again');
  if (errs.length) fail('errors: ' + errs.join(' | '));
  await ctx.close();
}

// 5. coming back to the app with a dead camera restarts it
{
  const { ctx, page, errs } = await open('returning to the app');
  const before = await page.evaluate(() => window.__gum);
  await page.evaluate(() => document.getElementById('preview').srcObject.getVideoTracks()[0].stop());
  // simulate the app being backgrounded and brought back, faster than the watchdog
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { get: () => 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForFunction((n) => window.__gum > n, before, { timeout: 8000 })
    .then(() => ok('restarts the camera when you come back to the app'))
    .catch(() => fail('came back to a dead camera and did nothing'));
  if (errs.length) fail('errors: ' + errs.join(' | '));
  await ctx.close();
}

await browser.close();
console.log(process.exitCode ? '\nSOME CHECKS FAILED' : '\ncamera recovers on its own');
