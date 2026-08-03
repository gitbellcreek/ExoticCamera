/* Paths only, with no token requirement — used by token.mjs itself. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');
export const URLBASE = process.env.APP_URL || 'http://127.0.0.1:8848/';
export const REFERER = new URL(URLBASE).origin;
