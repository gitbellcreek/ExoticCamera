/* Simulate iOS: DeviceOrientationEvent.requestPermission exists and must be
   called from a user gesture. Verify the compass comes up without the user
   having to know to tap the dial. */
import { ROOT, OUT, FIXTURES, URLBASE, TOK, REFERER, arcFetch } from './env.mjs';
import { chromium, CHROME, relayArcGIS } from './browser.mjs';

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});
const fail = (m) => { console.log('  FAIL', m); process.exitCode = 1; };
const ok = (m) => console.log('  ok  ', m);

/** @param {'granted'|'denied'} verdict @param {number} delayMs how long the "dialog" sits open */
async function run(label, verdict, delayMs, action) {
  const ctx = await browser.newContext({
    viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true,
    permissions: ['camera', 'geolocation'],
    geolocation: { latitude: 30.2672, longitude: -97.7431, accuracy: 6 },
  });
  await ctx.addInitScript(([verdict, delayMs]) => {
    window.__askCount = 0;
    window.__askedWithoutGesture = false;
    // iOS-shaped API: only resolves from a gesture, after the user answers
    window.DeviceOrientationEvent.requestPermission = function () {
      window.__askCount++;
      if (!navigator.userActivation || !navigator.userActivation.isActive) window.__askedWithoutGesture = true;
      if (window.__rejectFirst && window.__askCount === 1) {
        return Promise.reject(new Error('requires a user gesture to prompt'));
      }
      return new Promise((res) => setTimeout(() => res(verdict), delayMs));
    };
    // once granted, feed it heading data like a real phone would
    const pump = () => {
      const e = new Event('deviceorientation');
      Object.assign(e, { absolute: false, webkitCompassHeading: 135, webkitCompassAccuracy: 8, alpha: 225, beta: 88, gamma: 0 });
      window.dispatchEvent(e);
    };
    window.__pump = () => setInterval(pump, 60);
  }, [verdict, delayMs]);

  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  await page.goto('http://127.0.0.1:8848/index.html?ios=' + label, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(900);

  console.log('\n== ' + label);
  if (await page.evaluate(() => window.__askCount) !== 0) fail('asked for the compass before any gesture');
  else ok('no permission request before the user touches anything');
  if ((await page.locator('#heading-deg').textContent()) !== '---') fail('heading before permission?');

  await action(page);

  const st = await page.evaluate(() => ({ n: window.__askCount, bad: window.__askedWithoutGesture }));
  if (!st.n) fail('never asked for compass permission');
  else if (st.bad) fail('asked outside a user gesture — iOS would reject this');
  else ok(`asked once, from inside the gesture (${st.n} call)`);

  return { page, ctx, errs };
}

// 1. first touch is the menu button — the compass should come up on the way past
{
  const { page, ctx, errs } = await run('first touch anywhere (menu)', 'granted', 200, async (page) => {
    await page.click('#menu-btn');
    await page.waitForTimeout(500);
    await page.keyboard.press('Escape');
  });
  await page.evaluate(() => window.__pump());
  await page.waitForTimeout(500);
  const h = await page.locator('#heading-deg').textContent();
  if (h === '---') fail('compass still dead after a tap elsewhere in the app');
  else ok(`heading live after one unrelated tap: ${h}° ${await page.locator('#heading-card').textContent()}`);
  // and it must not ask again
  const before = await page.evaluate(() => window.__askCount);
  await page.click('#menu-btn'); await page.waitForTimeout(200); await page.keyboard.press('Escape');
  if (await page.evaluate(() => window.__askCount) !== before) fail('asked again on a later tap');
  else ok('does not re-ask on later taps');
  if (errs.length) fail('page errors: ' + errs.join(' | '));
  await ctx.close();
}

// 2. first touch is the shutter — the photo must wait for the answer, not fire headingless
{
  const { page, ctx, errs } = await run('first touch is the shutter', 'granted', 900, async (page) => {
    await page.evaluate(() => { window.__pumpStarted = false; });
    // grant → start feeding data as soon as the dialog closes
    page.evaluate(() => setTimeout(() => window.__pump(), 950));
    await page.click('#shutter');
    await page.waitForTimeout(2500);
  });
  const rows = await page.evaluate(() => new Promise((res) => {
    const r = indexedDB.open('exoticcam');
    r.onsuccess = () => {
      const tx = r.result.transaction('queue', 'readonly').objectStore('queue').getAll();
      tx.onsuccess = () => res(tx.result.map(x => ({ heading: x.heading, src: x.headingSource })));
    };
  }));
  console.log('   queued:', JSON.stringify(rows));
  if (!rows.length) fail('no photo queued');
  else if (rows[0].heading === null || rows[0].heading === undefined)
    fail('first photo went to the queue with no heading — the dialog was not awaited');
  else ok(`first photo carries heading ${rows[0].heading}° from the ${rows[0].src}`);
  if (errs.length) fail('page errors: ' + errs.join(' | '));
  await ctx.close();
}

// 3. denied — the app must say so rather than silently recording nothing
{
  const { page, ctx } = await run('permission denied', 'denied', 150, async (page) => {
    await page.click('#menu-btn');
    await page.waitForTimeout(600);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
  });
  const toasts = await page.evaluate(() => [...document.querySelectorAll('.toast')].map(t => t.textContent));
  console.log('   toasts:', JSON.stringify(toasts));
  if (!toasts.some(t => /compass/i.test(t))) fail('no notice that the compass is unavailable');
  else ok('tells the user the compass is blocked');
  await page.click('#shutter');
  await page.waitForTimeout(2500);
  const t2 = await page.evaluate(() => [...document.querySelectorAll('.toast')].map(t => t.textContent));
  console.log('   after shutter:', JSON.stringify(t2));
  if (!t2.some(t => /without a heading/i.test(t))) fail('photo saved with no heading and no warning: ' + JSON.stringify(t2));
  else ok('warns when a photo is saved without a heading');
  const t0 = Date.now();
  await page.click('#shutter');
  await page.waitForFunction(() => [...document.querySelectorAll('.toast')]
    .filter(t => /without a heading/i.test(t.textContent)).length > 0, null, { timeout: 5000 });
  const lag = Date.now() - t0;
  if (lag > 900) fail(`shutter stalls ${lag}ms per shot after a denial`);
  else ok(`second shot is prompt after a denial (${lag}ms, no repeated wait)`);
  await ctx.close();
}

// 4. an origin that was already granted: data should flow with no prompt at all
{
  const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true });
  await ctx.addInitScript(() => {
    window.__askCount = 0;
    window.DeviceOrientationEvent.requestPermission = function () {
      window.__askCount++;
      return Promise.resolve('granted');
    };
    // Safari streams orientation immediately when the origin is already allowed
    setInterval(() => {
      const e = new Event('deviceorientation');
      Object.assign(e, { webkitCompassHeading: 42, alpha: 318, beta: 90, gamma: 0 });
      window.dispatchEvent(e);
    }, 60);
  });
  const page = await ctx.newPage();
  await page.goto('http://127.0.0.1:8848/index.html?granted=1', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1600);
  console.log('\n== origin already granted');
  const h = await page.locator('#heading-deg').textContent();
  if (h === '---') fail('no heading without a tap even though the origin is granted');
  else ok(`heading ${h}° with no tap and no prompt`);
  if (await page.evaluate(() => window.__askCount) !== 0) fail('prompted anyway');
  else ok('never called requestPermission — nothing for the user to dismiss');
  await ctx.close();
}

// 5. Safari refuses the call (the pointerdown trap): the next tap must retry
{
  const ctx = await browser.newContext({
    viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true,
    permissions: ['camera', 'geolocation'],
    geolocation: { latitude: 30.2672, longitude: -97.7431, accuracy: 6 },
  });
  await ctx.addInitScript(() => {
    window.__askCount = 0;
    window.__rejectFirst = true;
    window.DeviceOrientationEvent.requestPermission = function () {
      window.__askCount++;
      if (window.__askCount === 1) return Promise.reject(new Error('requires a user gesture to prompt'));
      return Promise.resolve('granted');
    };
    window.__pump = () => setInterval(() => {
      const e = new Event('deviceorientation');
      Object.assign(e, { webkitCompassHeading: 200, alpha: 160, beta: 90, gamma: 0 });
      window.dispatchEvent(e);
    }, 60);
  });
  const page = await ctx.newPage();
  await page.goto('http://127.0.0.1:8848/index.html?reject=1', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);
  console.log('\n== Safari refuses the first call');
  await page.click('#menu-btn');
  await page.waitForTimeout(400);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  await page.evaluate(() => window.__pump());
  await page.click('#chip-gps');                       // any second tap
  await page.waitForTimeout(700);
  const n = await page.evaluate(() => window.__askCount);
  if (n < 2) fail(`gave up after a refused call (asked ${n}x) — this is the bug that kept the compass dead`);
  else ok(`retried on the next tap (asked ${n}x)`);
  const h = await page.locator('#heading-deg').textContent();
  if (h === '---') fail('compass still dead after the retry');
  else ok(`compass live after the retry: ${h}°`);
  await ctx.close();
}

await browser.close();
console.log(process.exitCode ? '\nSOME CHECKS FAILED' : '\nall iOS compass checks passed');
