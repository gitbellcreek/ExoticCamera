/* The easter egg still has to behave: reachable from About, stops when closed,
   and never interferes with the camera or the queue. */
import { ROOT, OUT, FIXTURES, URLBASE, TOK, REFERER, arcFetch } from './env.mjs';
import { chromium, CHROME, relayArcGIS } from './browser.mjs';

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
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push(e.message));
await page.goto(URLBASE + '?snake=1', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => document.getElementById('preview').videoWidth > 0, null, { timeout: 15000 });

console.log('== getting to it');
await page.click('#menu-btn'); await page.waitForTimeout(300);
await page.click('#mi-about'); await page.waitForTimeout(400);
if (!await page.locator('#a-snake').isVisible()) fail('no way into the game from About');
else ok('About offers it');
await page.click('#a-snake');
await page.waitForTimeout(600);
if (!await page.locator('#snake-panel').isVisible()) fail('the game did not open');
else ok('opens from About');

const box = await page.locator('#snake-canvas').boundingBox();
console.log('   board:', Math.round(box.width) + '×' + Math.round(box.height));
if (Math.abs(box.width - box.height) > 2) fail('board is not square');
else if (box.width > 393) fail('board is wider than the phone');
else ok('square board that fits the screen');
await page.screenshot({ path: OUT + '/shot-snake-idle.png' });

console.log('\n== playing');
let st = await page.evaluate(() => self.Snake.state());
if (st.started || st.running) fail('it started ticking before the player did');
else ok('waits for the player before it starts');

await page.click('#snake-canvas');           // tap to start
await page.waitForTimeout(700);
st = await page.evaluate(() => self.Snake.state());
if (!st.running) fail('tap did not start it');
else ok('a tap starts it, head at ' + JSON.stringify(st.head));

const first = st.head.x;
await page.waitForTimeout(600);
const moved = (await page.evaluate(() => self.Snake.state())).head.x;
if (moved === first) fail('the snake is not moving');
else ok('it moves on its own (x ' + first + ' → ' + moved + ')');

console.log('\n== steering and eating');
await page.keyboard.press('ArrowDown');
await page.waitForTimeout(500);
const afterTurn = await page.evaluate(() => self.Snake.state());
if (afterTurn.head.y <= st.head.y) fail('arrow key did not steer it');
else ok('arrow keys steer');

const before = afterTurn.score, len = afterTurn.len;
await page.evaluate(() => self.Snake._feed());       // drop food right in front
await page.waitForTimeout(600);
const fed = await page.evaluate(() => self.Snake.state());
if (fed.score !== before + 1) fail(`eating did not score (${before} → ${fed.score})`);
else ok('eating scores: ' + fed.score);
if (fed.len !== len + 1) fail('the snake did not grow');
else ok('and it grows: ' + len + ' → ' + fed.len);

console.log('\n== dying, and remembering');
await page.evaluate(() => {                        // drive into the wall
  for (let i = 0; i < 40; i++) self.Snake.keydown({ key: 'ArrowUp', preventDefault() {} });
});
await page.waitForFunction(() => self.Snake.state().over, null, { timeout: 15000 })
  .then(() => ok('walls are fatal'))
  .catch(() => fail('never died against a wall'));
const dead = await page.evaluate(() => self.Snake.state());
if (dead.running) fail('still ticking after game over');
else ok('stops ticking when it ends');
if (dead.high < 1) fail('high score not kept: ' + dead.high);
else ok('remembers a best score of ' + dead.high);
await page.screenshot({ path: OUT + '/shot-snake-over.png' });

const stored = await page.evaluate(() => self.Store.get('snakeHigh'));
if (!stored) fail('best score never reached storage');
else ok('best score persisted (' + stored + ')');

console.log('\n== it must not haunt the rest of the app');
await page.click('#snake-canvas'); await page.waitForTimeout(500);   // restart it
if (!(await page.evaluate(() => self.Snake.state())).running) fail('did not restart');
await page.click('#snake-close');
await page.waitForTimeout(600);
if ((await page.evaluate(() => self.Snake.state())).running) fail('left running behind a closed sheet');
else ok('closing the sheet stops the game');

// the camera and the shutter must be exactly as they were
if (!(await page.evaluate(() => document.getElementById('preview').videoWidth > 0)))
  fail('the camera did not survive a game');
else ok('camera still live afterwards');
await page.click('#shutter');
// capture waits briefly on a first compass sample before it fires
await page.waitForFunction(() => self.Store.all().then(r => r.length === 1), null, { timeout: 10000 })
  .then(() => ok('the shutter still works afterwards'))
  .catch(async () => {
    const why = await page.evaluate(() => [...document.querySelectorAll('.toast')].map(t => t.textContent));
    fail('taking a photo after playing did not queue — toasts: ' + JSON.stringify(why));
  });

// arrow keys must not leak into the app when the game is closed
await page.keyboard.press('ArrowUp');
await page.waitForTimeout(200);
if ((await page.evaluate(() => self.Snake.state())).running) fail('keys still driving the game while closed');
else ok('keys no longer reach the game once closed');

if (errs.length) fail('page errors: ' + errs.join(' | '));
await browser.close();
console.log(process.exitCode ? '\nSOME CHECKS FAILED' : '\nsnake behaves');
