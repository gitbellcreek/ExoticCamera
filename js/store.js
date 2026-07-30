/* Exotic Camera — IndexedDB: the offline photo queue + a small key/value store.
   Shared by the page and the service worker, so: no `window`, no `document`. */
(function (g) {
  'use strict';

  var DB = 'exoticcam';
  var VERSION = 2;
  var dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB, VERSION);
      req.onblocked = function () { reject(new Error('Device storage is busy in another tab')); };
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains('queue')) {
          var q = db.createObjectStore('queue', { keyPath: 'id' });
          q.createIndex('state', 'state');
          q.createIndex('createdAt', 'createdAt');
        }
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'k' });

        /* v2: photos live in their own store.
           They used to sit on the queue record, so every state change rewrote
           the whole JPEG — and on iOS that write fails for a photo that has
           survived an app restart, which strands it in the queue forever while
           newer photos sail past. Metadata is tiny; keep it that way. */
        if (!db.objectStoreNames.contains('photos')) db.createObjectStore('photos', { keyPath: 'id' });
        if (e.oldVersion < 2) {
          var t = e.target.transaction;
          var qs = t.objectStore('queue');
          var ps = t.objectStore('photos');
          qs.openCursor().onsuccess = function (ev) {
            var cur = ev.target.result;
            if (!cur) return;
            var row = cur.value;
            if (row && row.blob) {
              ps.put({ id: row.id, blob: row.blob });
              delete row.blob;
              cur.update(row);
            }
            cur.continue();
          };
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () {
        dbp = null;                                  // let a later call try again
        reject(dbError(req, 'Device storage unavailable'));
      };
    });
    return dbp;
  }

  /* IndexedDB hands back a null `error` in several failure paths (notably an
     aborted transaction on Safari). Rejecting with null makes every downstream
     `catch (e) { e.something }` throw a second, useless error, so always reject
     with a real Error. */
  function dbError(src, what) {
    var e = src && src.error;
    if (e) return e;
    var err = new Error(what);
    err.name = 'UnknownError';
    return err;
  }

  function tx(store, mode, fn) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(store, mode);
        var out;
        t.oncomplete = function () { resolve(out); };
        t.onerror = function () { reject(dbError(t, 'Device storage write failed')); };
        t.onabort = function () { reject(dbError(t, 'Device storage write was aborted — the device may be out of space')); };
        out = fn(t.objectStore(store), function (v) { out = v; });
      });
    });
  }

  function reqp(r) {
    return new Promise(function (res, rej) {
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(dbError(r, 'Device storage read failed')); };
    });
  }

  function uuid() {
    if (g.crypto && g.crypto.randomUUID) return g.crypto.randomUUID();
    var b = g.crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    return Array.prototype.map.call(b, function (x, i) {
      return (i === 4 || i === 6 || i === 8 || i === 10 ? '-' : '') + ('0' + x.toString(16)).slice(-2);
    }).join('');
  }

  var Store = {
    uuid: uuid,

    /* ---- key/value ---- */
    get: function (k) {
      return open().then(function (db) {
        return reqp(db.transaction('kv', 'readonly').objectStore('kv').get(k));
      }).then(function (r) { return r ? r.v : null; });
    },
    set: function (k, v) {
      return tx('kv', 'readwrite', function (s) { s.put({ k: k, v: v }); });
    },
    del: function (k) {
      return tx('kv', 'readwrite', function (s) { s.delete(k); });
    },

    /* ---- photos: bytes only, written once and never rewritten ---- */
    photo: function (id) {
      return open().then(function (db) {
        return reqp(db.transaction('photos', 'readonly').objectStore('photos').get(id));
      }).then(function (r) { return r ? r.blob : null; });
    },

    dropPhoto: function (id) {
      return tx('photos', 'readwrite', function (s) { s.delete(id); });
    },

    photoIds: function () {
      return open().then(function (db) {
        return reqp(db.transaction('photos', 'readonly').objectStore('photos').getAllKeys());
      }).then(function (k) { return k || []; });
    },

    /* ---- queue ---- */
    add: function (item) {
      item.id = item.id || uuid();
      item.createdAt = item.createdAt || Date.now();
      item.state = item.state || 'pending';
      item.attempts = item.attempts || 0;
      item.nextAttemptAt = item.nextAttemptAt || 0;
      var blob = item.blob;
      delete item.blob;
      item.hasPhoto = !!blob;

      return open().then(function (db) {
        return new Promise(function (resolve, reject) {
          // one transaction over both stores: never a queue row without its photo
          var t = db.transaction(['queue', 'photos'], 'readwrite');
          t.objectStore('queue').put(item);
          if (blob) t.objectStore('photos').put({ id: item.id, blob: blob });
          t.oncomplete = function () { resolve(item); };
          t.onerror = function () { reject(dbError(t, 'Could not save the photo to the device')); };
          t.onabort = function () { reject(dbError(t, 'Could not save the photo — the device may be out of space')); };
        });
      });
    },

    put: function (item) {
      var copy = {};
      Object.keys(item).forEach(function (k) { if (k !== 'blob') copy[k] = item[k]; });
      return tx('queue', 'readwrite', function (s) { s.put(copy); }).then(function () { return copy; });
    },

    patch: function (id, patch) {
      return open().then(function (db) {
        return new Promise(function (resolve, reject) {
          var t = db.transaction('queue', 'readwrite');
          var s = t.objectStore('queue');
          var out = null;
          t.onabort = function () { reject(dbError(t, 'Device storage write was aborted — the device may be out of space')); };
          s.get(id).onsuccess = function (e) {
            var it = e.target.result;
            if (!it) return;
            Object.keys(patch).forEach(function (k) { it[k] = patch[k]; });
            delete it.blob;              // bytes never travel with a metadata write
            out = it;
            s.put(it);
          };
          t.oncomplete = function () { resolve(out); };
          t.onerror = function () { reject(dbError(t, 'Device storage write failed')); };
        });
      });
    },

    item: function (id) {
      return open().then(function (db) {
        return reqp(db.transaction('queue', 'readonly').objectStore('queue').get(id));
      });
    },

    all: function () {
      return Promise.all([
        open().then(function (db) {
          return reqp(db.transaction('queue', 'readonly').objectStore('queue').getAll());
        }),
        Store.photoIds()
      ]).then(function (r) {
        var have = {};
        r[1].forEach(function (id) { have[id] = true; });
        return (r[0] || []).map(function (row) {
          row.hasPhoto = !!have[row.id] || !!row.blob;
          return row;
        }).sort(function (a, b) { return b.createdAt - a.createdAt; });
      });
    },

    /** Everything still owed to the server, oldest first. */
    outstanding: function () {
      return Store.all().then(function (rows) {
        return rows.filter(function (r) { return r.state !== 'sent'; })
                   .sort(function (a, b) { return a.createdAt - b.createdAt; });
      });
    },

    remove: function (id) {
      return tx('queue', 'readwrite', function (s) { s.delete(id); })
        .then(function () { return Store.dropPhoto(id); });
    },

    removeSent: function () {
      return Store.all().then(function (rows) {
        return Promise.all(rows.filter(function (r) { return r.state === 'sent'; })
                              .map(function (r) { return Store.remove(r.id); }));
      });
    },

    counts: function () {
      return Store.all().then(function (rows) {
        var c = { total: rows.length, pending: 0, uploading: 0, error: 0, sent: 0 };
        rows.forEach(function (r) { if (c[r.state] !== undefined) c[r.state]++; });
        c.outstanding = c.pending + c.uploading + c.error;
        return c;
      });
    }
  };

  g.Store = Store;
})(typeof self !== 'undefined' ? self : this);
