/* Photo Points — service worker.
   Keeps the app shell on the phone so it opens with no signal, and drains the
   upload queue in the background where the browser supports it.

   The origin is shared with Exotic Camera (one folder up) and every other
   GitHub Pages app of the account: caches are named photopoints-… and only
   those are ever deleted. */
'use strict';

var BUILD = '__BUILD__';
// Bump REV whenever the file list changes — with Pages serving the branch
// directly, BUILD is never stamped and this is the only cache key that moves.
var REV = 'r1';
var CACHE = 'photopoints-' + BUILD + '-' + REV;

var SHELL = [
  './',
  'index.html',
  'app.css',
  'manifest.webmanifest',
  'js/config.js',
  'js/store.js',
  'js/arc.js',
  'js/app.js',
  '../js/report.js',
  '../js/exif.js',
  '../js/sound.js',
  '../js/compass.js',
  'icons/icon.svg',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      return Promise.all(SHELL.map(function (u) {
        return c.add(new Request(u, { cache: 'reload' })).catch(function () {});
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== CACHE && k.indexOf('photopoints-') === 0) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

/* Network first with a short leash, the cached copy as the fallback — a field
   user gets each deploy without a reinstall, and a dead connection never holds
   up startup. Everything cross-origin (every ArcGIS call) bypasses the worker. */
var NET_TIMEOUT = 2500;

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    caches.open(CACHE).then(function (c) {
      return c.match(req, { ignoreSearch: true }).then(function (hit) {
        var net = fetch(req).then(function (res) {
          if (res && res.ok) c.put(req, res.clone());
          return res;
        });
        if (!hit) {
          return net.catch(function () {
            // Only a page navigation may fall back to the shell: answering a
            // script with HTML is a syntax error that takes the app down.
            if (req.mode === 'navigate') return c.match('index.html');
            return new Response('', { status: 504, statusText: 'Offline and not cached' });
          });
        }
        return new Promise(function (resolve) {
          var settled = false;
          var done = function (r) { if (!settled) { settled = true; resolve(r); } };
          setTimeout(function () { done(hit); }, NET_TIMEOUT);
          net.then(done).catch(function () { done(hit); });
        });
      });
    })
  );
});

/* ── background upload ─────────────────────────────────────── */

var modulesLoaded = false;
function loadModules() {
  if (modulesLoaded) return true;
  try {
    importScripts('js/store.js', 'js/config.js', 'js/arc.js', '../js/report.js');
    modulesLoaded = true;
  } catch (e) {
    modulesLoaded = false;
  }
  return modulesLoaded;
}

/* An open window is already draining, and two drainers on one queue clobber
   each other's writes: hand the job to the page if there is one. */
function drain() {
  return self.clients.matchAll({ includeUncontrolled: true, type: 'window' }).then(function (cs) {
    if (cs.length) {
      cs.forEach(function (c) { c.postMessage({ type: 'flush' }); });
      return null;
    }
    if (!loadModules()) return null;
    return self.Config.load().then(function () { return self.Arc.flush(function () {}); });
  });
}

self.addEventListener('sync', function (e) {
  if (e.tag === 'flush-queue') e.waitUntil(drain());
});

self.addEventListener('message', function (e) {
  if (e.data === 'skipWaiting') self.skipWaiting();
  if (e.data === 'flush') e.waitUntil(drain());
});
