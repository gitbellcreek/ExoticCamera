/* Exotic Camera — service worker.
   Precaches the shell so the app opens instantly and works with no signal, and
   drains the upload queue in the background where the browser supports it. */
'use strict';

var BUILD = '__BUILD__';
// Bump REV whenever the file list changes. GitHub Pages may publish the branch
// directly, in which case BUILD is never stamped and this is the only thing that
// forces a fresh, complete precache — a half-populated cache is what turns an
// offline launch into a blank screen.
var REV = 'r12';
var CACHE = 'exoticcam-' + BUILD + '-' + REV;

var SHELL = [
  './',
  'index.html',
  'app.css',
  'js/config.js',
  'js/store.js',
  'js/arcgis.js',
  'js/report.js',
  'js/exif.js',
  'js/heading.js',
  'js/sound.js',
  'js/snake.js',
  'js/app.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-180.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      // one bad URL shouldn't fail the whole install
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
        if (k !== CACHE) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

/* App shell: network first with a short leash, cache as the fallback.
   Cache-first would leave field users a launch behind every deploy — and since
   GitHub Pages can serve the branch directly, there is no build id to key a new
   cache on. A 2.5s timeout keeps a dead or crawling connection from delaying
   startup: past that we serve the cached copy and refresh in the background.
   Everything cross-origin — every ArcGIS call — bypasses the worker entirely. */
var NET_TIMEOUT = 2500;

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then(function (hit) {
      var net = fetch(req).then(function (res) {
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      });

      if (!hit) {
        return net.catch(function () {
          // Only a page navigation may fall back to the shell. Answering a
          // script or stylesheet with index.html hands the parser HTML, which
          // dies as a syntax error and takes the whole app down with it.
          if (req.mode === 'navigate') return caches.match('index.html');
          return new Response('', { status: 504, statusText: 'Offline and not cached' });
        });
      }

      // we have a copy: take the network if it is prompt, otherwise fall back
      return new Promise(function (resolve) {
        var settled = false;
        var done = function (r) { if (!settled) { settled = true; resolve(r); } };
        setTimeout(function () { done(hit); }, NET_TIMEOUT);
        net.then(done).catch(function () { done(hit); });
      });
    })
  );
});

/* ── background upload ─────────────────────────────────────── */

/* Imported lazily and defensively: a failure here must never stop the worker
   from serving the app offline, which is its more important job. */
var modulesLoaded = false;
function loadModules() {
  if (modulesLoaded) return true;
  try {
    importScripts('js/store.js', 'js/config.js', 'js/arcgis.js', 'js/report.js');
    modulesLoaded = true;
  } catch (e) {
    modulesLoaded = false;
  }
  return modulesLoaded;
}

/**
 * Background draining is for when the app is closed. If a window is open it is
 * already draining, and two drainers on one queue clobber each other's writes —
 * one context can finish an upload while the other is still holding a stale copy
 * of the same row. Hand it to the page instead.
 */
function drain() {
  return self.clients.matchAll({ includeUncontrolled: true, type: 'window' }).then(function (cs) {
    if (cs.length) {
      cs.forEach(function (c) { c.postMessage({ type: 'flush' }); });
      return null;
    }
    return drainHere();
  });
}

function drainHere() {
  if (!loadModules()) return Promise.resolve(null);
  return self.Config.load().then(function () {
    return self.Arc.flush(function () {});
  }).then(function (sum) {
    return self.clients.matchAll({ includeUncontrolled: true }).then(function (cs) {
      cs.forEach(function (c) { c.postMessage({ type: 'flushed', summary: sum }); });
      return sum;
    });
  });
}

self.addEventListener('sync', function (e) {
  if (e.tag === 'flush-queue') e.waitUntil(drain());
});

self.addEventListener('periodicsync', function (e) {
  if (e.tag === 'flush-queue') e.waitUntil(drain());
});

self.addEventListener('message', function (e) {
  if (e.data === 'skipWaiting') self.skipWaiting();
  if (e.data === 'flush') e.waitUntil(drain());
});
