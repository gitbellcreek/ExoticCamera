/* Exotic Camera — service worker.
   Precaches the shell so the app opens instantly and works with no signal, and
   drains the upload queue in the background where the browser supports it. */
'use strict';

var BUILD = '__BUILD__';
var CACHE = 'exoticcam-' + BUILD;

var SHELL = [
  './',
  'index.html',
  'app.css',
  'js/config.js',
  'js/store.js',
  'js/arcgis.js',
  'js/report.js',
  'js/sound.js',
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

      if (!hit) return net.catch(function () { return caches.match('index.html'); });

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

importScripts('js/store.js', 'js/config.js', 'js/arcgis.js', 'js/report.js');

function drain() {
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
