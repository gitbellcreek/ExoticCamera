/* Mint an ArcGIS token for the suites, bound to the origin they serve from.
   Writes tests/.token, which is git-ignored. Credentials are never stored. */
import fs from 'node:fs';
import path from 'node:path';
import { HERE, REFERER } from './env-lite.mjs';

const user = process.env.ARCGIS_USER;
const pass = process.env.ARCGIS_PASSWORD;
const portal = process.env.ARCGIS_PORTAL || 'https://www.arcgis.com';
if (!user || !pass) {
  console.error('Set ARCGIS_USER and ARCGIS_PASSWORD (they are not stored anywhere).');
  process.exit(1);
}

const r = await fetch(portal + '/sharing/rest/generateToken', {
  method: 'POST',
  body: new URLSearchParams({ username: user, password: pass, referer: REFERER, expiration: '240', f: 'json' }),
});
const j = await r.json();
if (!j.token) { console.error('Could not get a token:', JSON.stringify(j)); process.exit(1); }
fs.writeFileSync(path.join(HERE, '.token'), j.token);
console.log('Wrote tests/.token, bound to', REFERER, '— expires', new Date(j.expires).toLocaleString());
