/* Shared setup for the suites: where the app is, where scratch output goes, and
   the ArcGIS token. Nothing here is a secret — the token comes from the
   environment or from tests/.token, which is git-ignored. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');
export const OUT = path.join(HERE, '.out');
export const FIXTURES = path.join(HERE, 'fixtures');
export const URLBASE = process.env.APP_URL || 'http://127.0.0.1:8848/';
export const REFERER = new URL(URLBASE).origin;

fs.mkdirSync(OUT, { recursive: true });

function readToken() {
  if (process.env.ARCGIS_TOKEN) return process.env.ARCGIS_TOKEN.trim();
  const f = path.join(HERE, '.token');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  throw new Error(
    'No ArcGIS token. Run `node tests/token.mjs` with ARCGIS_USER and ARCGIS_PASSWORD set,\n' +
    'or export ARCGIS_TOKEN yourself. The token must be bound to ' + REFERER + '.');
}

export const TOK = readToken();

/** ArcGIS checks the referer the token was minted for, so send it explicitly. */
export function arcFetch(url, init = {}) {
  return fetch(url, { ...init, headers: { ...(init.headers || {}), Referer: REFERER } });
}
