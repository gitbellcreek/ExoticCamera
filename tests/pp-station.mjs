/* Photo Points station details: the Schedule (how often a station is visited,
   free text). The station sheet shows it, the edit form fills it in and queues
   only what changed, and a new station starts with "Once a year: October".
   Works from a station list put straight into the phone's storage; no sign-in,
   nothing is sent. */
import { URLBASE } from './env-lite.mjs';
import { chromium, CHROME } from './browser.mjs';

const APP = new URL('photopoints/', URLBASE).href;
const fail = (m) => { console.log('  FAIL', m); process.exitCode = 1; };
const ok = (m) => console.log('  ok  ', m);

const STATIONS = [
  { gid: '{00000000-0000-4000-8000-000000000011}', oid: 1, id: 'LKD-PS01', site: 'Lake Dan Nature Preserve', mu: 'LKD_33', habitat: '',
    postInstalled: 'Yes', postType: 'T-post', postTag: '', installDate: null, status: 'Active', notes: 'by the gate',
    schedule: 'Twice a year: March and July', lat: 28.1701, lon: -82.54 },
  { gid: '{00000000-0000-4000-8000-000000000012}', oid: 2, id: 'LKD-PS02', site: 'Lake Dan Nature Preserve', mu: 'LKD_30', habitat: '',
    postInstalled: 'No', postType: '', postTag: '', installDate: null, status: 'Active', notes: '', schedule: '', lat: 28.172, lon: -82.541 },
];

// two management units: LKD_33 round the first stations (with a hole in it), LKD_30 just north
const sq = (x0, y0, x1, y1) => [[x0, y0], [x0, y1], [x1, y1], [x1, y0], [x0, y0]];
const UNITS = [
  { id: 'LKD_33', site: 'Lake Dan Nature Preserve', b: [-82.545, 28.165, -82.535, 28.175],
    r: [sq(-82.545, 28.165, -82.535, 28.175), sq(-82.5385, 28.1705, -82.5375, 28.1715)] },
  { id: 'LKD_30', site: 'Lake Dan Nature Preserve', b: [-82.545, 28.175, -82.535, 28.185], r: [sq(-82.545, 28.175, -82.535, 28.185)] },
];

const browser = await chromium.launch({ executablePath: CHROME });
const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true,
  permissions: ['geolocation'], geolocation: { latitude: 28.1702, longitude: -82.5401, accuracy: 4 } });
await ctx.route('**://*.arcgis.com/**', (r) => r.abort('internetdisconnected'));
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('dialog', (d) => d.accept());
await page.goto(APP + '?station', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => self.__ppReady, null, { timeout: 15000 });
await page.evaluate(([list, units]) => Promise.all([self.Store.set('stations', { at: Date.now(), list, stats: {} }),
  self.Store.set('units', { at: Date.now(), url: self.Config.get().unitsUrl, list: units })]), [STATIONS, UNITS]);
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => document.querySelectorAll('.st').length === 2, null, { timeout: 15000 });

// the station sheet
await page.locator('.st', { hasText: 'LKD-PS01' }).click();
await page.waitForSelector('#station-panel.open, #station-panel:not(.hidden)', { timeout: 5000 });
const facts = await page.locator('#sp-facts').innerText();
if (!/Schedule\s*Twice a year: March and July/.test(facts)) fail('the station sheet does not show the schedule: ' + JSON.stringify(facts));
else ok('the station sheet shows the schedule');

// editing it
await page.click('#sp-edit');
const pre = await page.inputValue('#ep-schedule');
if (pre !== 'Twice a year: March and July') fail('the edit form did not fill in the schedule: ' + pre); else ok('the edit form fills it in');
const suggestions = await page.locator('#schedule-list option').count();
if (suggestions < 4) fail('no schedule suggestions offered'); else ok(suggestions + ' common schedules offered as you type, any text allowed');
await page.fill('#ep-schedule', 'Once a year: November');
await page.click('#ep-save');
await page.waitForFunction(() => self.Store.edits().then((e) => e.length === 1), null, { timeout: 5000 }).catch(() => {});
const edits = await page.evaluate(() => self.Store.edits());
const ch = edits[0] && edits[0].attrs;
if (!ch || ch.Schedule !== 'Once a year: November') fail('the change to the schedule was not queued: ' + JSON.stringify(edits));
else if (Object.keys(ch).filter((k) => k !== 'GlobalID').length !== 1) fail('more than the schedule was queued: ' + JSON.stringify(ch));
else ok('only the schedule is queued to go up');
await page.locator('.st', { hasText: 'LKD-PS01' }).click();
const facts2 = await page.locator('#sp-facts').innerText();
if (!/Once a year: November/.test(facts2)) fail('the sheet still shows the old schedule'); else ok('the sheet shows the new schedule straight away');
await page.evaluate(() => document.querySelectorAll('.sheet').forEach((s) => s.classList.remove('open')));
await page.keyboard.press('Escape');

// a new station
await page.click('#new-station-btn');
await page.waitForFunction(() => document.getElementById('np-id').value !== '' || document.getElementById('np-where').textContent !== '', null, { timeout: 5000 });
const mu = await page.inputValue('#np-mu');
const src = await page.locator('#np-mu-src').innerText();
if (mu !== 'LKD_33') fail('the unit was not filled in from the boundaries: ' + JSON.stringify(mu));
else ok('the unit is filled in from the management unit map: ' + mu + ' (' + src + ')');
// walk north into LKD_30 with the sheet open: the unit follows
await ctx.setGeolocation({ latitude: 28.178, longitude: -82.54, accuracy: 4 });
await page.waitForFunction(() => document.getElementById('np-mu').value === 'LKD_30', null, { timeout: 8000 }).catch(() => {});
if (await page.inputValue('#np-mu') !== 'LKD_30') fail('the unit did not follow the GPS into the next unit'); else ok('walking into the next unit, it follows: LKD_30');
// type over it: it stays, even as the GPS moves again
await page.fill('#np-mu', 'LKD_30b');
await ctx.setGeolocation({ latitude: 28.1702, longitude: -82.5401, accuracy: 4 });
await page.waitForTimeout(2500);
if (await page.inputValue('#np-mu') !== 'LKD_30b') fail('a typed unit was overwritten by the GPS'); else ok('once typed over, it stays as typed');
const def = await page.inputValue('#np-schedule');
if (def !== 'Once a year: October') fail('a new station does not start with the default schedule: ' + JSON.stringify(def));
else ok('a new station starts with "Once a year: October"');
await page.fill('#np-id', 'LKD-PS03');
await page.click('#np-save');
await page.waitForFunction(() => self.Store.edits().then((e) => e.some((x) => x.kind === 'add')), null, { timeout: 5000 }).catch(() => {});
const add = (await page.evaluate(() => self.Store.edits())).find((e) => e.kind === 'add');
if (!add || add.attrs.Schedule !== 'Once a year: October') fail('the new station was queued without its schedule: ' + JSON.stringify(add && add.attrs));
else ok('and goes up with it');
if (!add || add.attrs.MgmtUnit !== 'LKD_30b') fail('the new station did not keep the typed unit: ' + JSON.stringify(add && add.attrs));
else ok('the station goes up with the unit as typed');

// the point-in-unit lookup: inside, in the hole, outside
const hits = await page.evaluate((units) => [
  [28.168, -82.542], [28.171, -82.538], [28.19, -82.54], [28.175 + 1e-6, -82.54],
].map(([la, lo]) => (self.Arc.unitAt(units, la, lo) || {}).id || null), UNITS);
if (JSON.stringify(hits) !== JSON.stringify(['LKD_33', null, null, 'LKD_30'])) fail('point-in-unit lookup wrong: ' + JSON.stringify(hits));
else ok('inside a unit, in a hole in it, outside them all, and on the line between two: ' + JSON.stringify(hits));

// fetching the boundaries from the layer, page by page, and keeping them
let calls = 0;
await ctx.route('**/CELM_MU_202405/FeatureServer/0/query', (r) => {
  calls++;
  const off = +new URLSearchParams(r.request().postData() || '').get('resultOffset');
  const feat = (id, x) => ({ attributes: { MU_ID: id, SITE_NAME: 'Test Preserve' }, geometry: { rings: [sq(x, 28, x + 0.01, 28.01)] } });
  const body = off === 0 ? { features: [feat('TST_01', -82.5), feat('TST_02', -82.49)], exceededTransferLimit: true }
    : { features: [feat('TST_03', -82.48)] };
  r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
});
const fetched = await page.evaluate(async () => {
  await self.Store.set('auth', { mode: 'manual', token: 't', expires: Date.now() + 3600e3, username: 'test' });
  const r = await self.Arc.units(true);
  const kept = await self.Store.get('units');
  return { n: r.list.length, kept: kept.list.length, at: self.Arc.unitAt(kept.list, 28.005, -82.475) };
});
if (fetched.n !== 3 || fetched.kept !== 3 || !fetched.at || fetched.at.id !== 'TST_03' || calls !== 2)
  fail('fetching the boundaries: ' + JSON.stringify({ ...fetched, calls }));
else ok('the boundaries come from the layer in pages (' + calls + ' requests) and are kept on the phone');

if (errs.length) fail('page errors: ' + errs.join('; ')); else ok('no page errors');
await browser.close();
console.log(process.exitCode ? "\nFAILED" : "\nstation schedules and unit autofill work");
