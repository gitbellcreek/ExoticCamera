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
await page.evaluate((list) => self.Store.set('stations', { at: Date.now(), list, stats: {} }), STATIONS);
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
const def = await page.inputValue('#np-schedule');
if (def !== 'Once a year: October') fail('a new station does not start with the default schedule: ' + JSON.stringify(def));
else ok('a new station starts with "Once a year: October"');
await page.fill('#np-id', 'LKD-PS03');
await page.click('#np-save');
await page.waitForFunction(() => self.Store.edits().then((e) => e.some((x) => x.kind === 'add')), null, { timeout: 5000 }).catch(() => {});
const add = (await page.evaluate(() => self.Store.edits())).find((e) => e.kind === 'add');
if (!add || add.attrs.Schedule !== 'Once a year: October') fail('the new station was queued without its schedule: ' + JSON.stringify(add && add.attrs));
else ok('and goes up with it');

if (errs.length) fail('page errors: ' + errs.join('; ')); else ok('no page errors');
await browser.close();
console.log(process.exitCode ? '\nFAILED' : '\nstation schedules work');
