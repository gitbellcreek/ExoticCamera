/* The upgrade path that matters: a phone already holding v1 records, with the
   photo bytes sitting on the queue row — including one stranded photo that has
   been failing to upload. Nothing may be lost. */
import { ROOT, OUT, FIXTURES, URLBASE, TOK, REFERER, arcFetch } from './env.mjs';
import { chromium, CHROME, relayArcGIS } from './browser.mjs';

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});
const fail = (m) => { console.log('  FAIL', m); process.exitCode = 1; };
const ok = (m) => console.log('  ok  ', m);

const ctx = await browser.newContext({
  viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true,
  permissions: ['camera', 'geolocation'],
  geolocation: { latitude: 27.8409, longitude: -82.3014, accuracy: 12 },
});
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push(e.message));

// land on the origin without booting the app, so we can plant a v1 database
await page.route('**/index.html', r => r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>seed</title>' }));
await page.goto(URLBASE + 'index.html');

console.log('== seed a version-1 database, photos inline on the row');
const seeded = await page.evaluate(async () => {
  await new Promise((res, rej) => {
    const r = indexedDB.open('exoticcam', 1);
    r.onupgradeneeded = (e) => {
      const db = e.target.result;
      const q = db.createObjectStore('queue', { keyPath: 'id' });
      q.createIndex('state', 'state');
      q.createIndex('createdAt', 'createdAt');
      db.createObjectStore('kv', { keyPath: 'k' });
    };
    r.onsuccess = () => { r.result.close(); res(); };
    r.onerror = () => rej(r.error);
  });

  const big = new Blob([new Uint8Array(400 * 1024)], { type: 'image/jpeg' });   // a real-sized photo
  const rows = [
    { id: 'stranded', createdAt: Date.now() - 600000, state: 'pending', attempts: 6,
      nextAttemptAt: Date.now() + 25 * 60000, lastError: 'Network unreachable',
      heading: 143.9, lat: 27.8409, lon: -82.3014, hAcc: 17, blob: big, thumb: 'data:,x',
      layerName: 'Central', filename: 'exoticcam_x.jpg' },
    { id: 'alreadysent', createdAt: Date.now() - 900000, state: 'sent', objectId: 4242,
      attachmentId: 7, sentAt: Date.now() - 60000, heading: 12, blob: big, thumb: 'data:,y',
      layerName: 'Central' },
    { id: 'noblob', createdAt: Date.now() - 100, state: 'pending', heading: 5 },
  ];
  await new Promise((res, rej) => {
    const r = indexedDB.open('exoticcam', 1);
    r.onsuccess = () => {
      const db = r.result;
      const t = db.transaction('queue', 'readwrite');
      rows.forEach(x => t.objectStore('queue').put(x));
      t.oncomplete = () => { db.close(); res(); };
      t.onerror = () => rej(t.error);
    };
  });
  return rows.length;
});
ok(`seeded ${seeded} v1 rows (two with a 400 KB photo on the row itself)`);

// now let the real app open the database and upgrade it
await page.unroute('**/index.html');
await page.goto(URLBASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);

console.log('\n== after the app upgrades it');
const after = await page.evaluate(async () => {
  const rows = await self.Store.all();
  const out = {};
  for (const r of rows) {
    const blob = await self.Store.photo(r.id);
    out[r.id] = { state: r.state, hasPhoto: r.hasPhoto, blobBytes: blob ? blob.size : 0,
                  inlineStillThere: 'blob' in r && !!r.blob, heading: r.heading,
                  objectId: r.objectId || null, nextAttemptAt: r.nextAttemptAt || 0 };
  }
  const version = await new Promise((res) => {
    const r = indexedDB.open('exoticcam');
    r.onsuccess = () => { res({ v: r.result.version, stores: [...r.result.objectStoreNames] }); r.result.close(); };
  });
  return { rows: out, version };
});
console.log('   db:', JSON.stringify(after.version));
console.log('   rows:', JSON.stringify(after.rows, null, 1));

if (after.version.v !== 2 || !after.version.stores.includes('photos')) fail('database did not reach version 2 with a photos store');
else ok('database upgraded to v2 with a separate photos store');

const s = after.rows.stranded;
if (!s) fail('the stranded photo vanished in the upgrade');
else {
  if (s.blobBytes !== 400 * 1024) fail(`the stranded photo lost its bytes (${s.blobBytes})`);
  else ok('the stranded photo kept all 400 KB, moved into the photos store');
  if (s.inlineStillThere) fail('the photo is still duplicated on the queue row');
  else ok('the queue row no longer carries the bytes, so metadata writes stay small');
  if (s.heading !== 143.9) fail('metadata was not preserved');
  else ok('metadata preserved (heading 143.9)');
}
const a = after.rows.alreadysent;
if (!a || a.blobBytes !== 400 * 1024 || a.objectId !== 4242) fail('the uploaded photo lost data in the upgrade');
else ok('an already-uploaded photo keeps its bytes and its OBJECTID');
const n = after.rows.noblob;
if (!n || n.hasPhoto) fail('a row that never had a photo should not claim one');
else ok('a point-only row is untouched');

// and the write that used to fail must now be tiny
console.log('\n== a state change must not rewrite the photo');
const patched = await page.evaluate(async () => {
  const before = await self.Store.photo('stranded');
  await self.Store.patch('stranded', { state: 'uploading' });
  const row = (await self.Store.all()).find(r => r.id === 'stranded');
  const after = await self.Store.photo('stranded');
  return { state: row.state, carriedBlob: 'blob' in row && !!row.blob,
           sizeBefore: before ? before.size : 0, sizeAfter: after ? after.size : 0 };
});
console.log('   ', JSON.stringify(patched));
if (patched.carriedBlob) fail('the metadata write still carries the photo — the iOS failure would remain');
else if (patched.sizeAfter !== patched.sizeBefore) fail('the photo changed during a metadata write');
else ok('state changed with the photo untouched — this is the write that was failing');

if (errs.length) fail('page errors: ' + errs.join(' | '));
await browser.close();
console.log(process.exitCode ? '\nSOME CHECKS FAILED' : '\nupgrade keeps every photo');
