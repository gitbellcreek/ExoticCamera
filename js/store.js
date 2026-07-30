/* Exotic Camera — IndexedDB: the offline photo queue + a small key/value store.
   Shared by the page and the service worker, so: no `window`, no `document`. */
(function (g) {
  'use strict';

  var DB = 'exoticcam';
  var VERSION = 1;
  var dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB, VERSION);
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains('queue')) {
          var q = db.createObjectStore('queue', { keyPath: 'id' });
          q.createIndex('state', 'state');
          q.createIndex('createdAt', 'createdAt');
        }
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'k' });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    return dbp;
  }

  function tx(store, mode, fn) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(store, mode);
        var out;
        t.oncomplete = function () { resolve(out); };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error); };
        out = fn(t.objectStore(store), function (v) { out = v; });
      });
    });
  }

  function reqp(r) {
    return new Promise(function (res, rej) {
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
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

    /* ---- queue ---- */
    add: function (item) {
      item.id = item.id || uuid();
      item.createdAt = item.createdAt || Date.now();
      item.state = item.state || 'pending';
      item.attempts = item.attempts || 0;
      item.nextAttemptAt = item.nextAttemptAt || 0;
      return tx('queue', 'readwrite', function (s) { s.put(item); }).then(function () { return item; });
    },

    put: function (item) {
      return tx('queue', 'readwrite', function (s) { s.put(item); }).then(function () { return item; });
    },

    patch: function (id, patch) {
      return open().then(function (db) {
        return new Promise(function (resolve, reject) {
          var t = db.transaction('queue', 'readwrite');
          var s = t.objectStore('queue');
          var out = null;
          s.get(id).onsuccess = function (e) {
            var it = e.target.result;
            if (!it) return;
            Object.keys(patch).forEach(function (k) { it[k] = patch[k]; });
            out = it;
            s.put(it);
          };
          t.oncomplete = function () { resolve(out); };
          t.onerror = function () { reject(t.error); };
        });
      });
    },

    item: function (id) {
      return open().then(function (db) {
        return reqp(db.transaction('queue', 'readonly').objectStore('queue').get(id));
      });
    },

    all: function () {
      return open().then(function (db) {
        return reqp(db.transaction('queue', 'readonly').objectStore('queue').getAll());
      }).then(function (rows) {
        return (rows || []).sort(function (a, b) { return b.createdAt - a.createdAt; });
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
      return tx('queue', 'readwrite', function (s) { s.delete(id); });
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
