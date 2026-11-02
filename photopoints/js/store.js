/* Photo Points — IndexedDB: visits, their photos, station edits, and a small
   key/value store. Shared by the page and the service worker, so: no
   `window`, no `document`.

   Lessons carried over from Exotic Camera, each learned in the field:
   - photo bytes live in their own store and are written once; queue rows stay
     tiny, because on iOS rewriting a row that carries a JPEG can fail after
     an app restart and strand it;
   - IndexedDB rejects with null in some failure paths, so every rejection is
     turned into a real Error;
   - a short lock keeps the page and the worker from draining at once.
   The origin is shared with every other GitHub Pages app of the account, so
   the database has its own name and never touches Exotic Camera's. */
(function (g) {
  'use strict';

  var DB = 'photopoints';
  var VERSION = 1;
  var dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB, VERSION);
      req.onblocked = function () { reject(new Error('Device storage is busy in another tab')); };
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'k' });
        if (!db.objectStoreNames.contains('visits')) db.createObjectStore('visits', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('shots')) {
          var s = db.createObjectStore('shots', { keyPath: 'id' });
          s.createIndex('visitId', 'visitId');
        }
        if (!db.objectStoreNames.contains('photos')) db.createObjectStore('photos', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('edits')) db.createObjectStore('edits', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('ghosts')) db.createObjectStore('ghosts', { keyPath: 'k' });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () {
        dbp = null;                                  // let a later call try again
        reject(dbError(req, 'Device storage unavailable'));
      };
    });
    return dbp;
  }

  function dbError(src, what) {
    var e = src && src.error;
    if (e) return e;
    var err = new Error(what);
    err.name = 'UnknownError';
    return err;
  }

  /** Run `fn(stores…)` in one transaction; resolves with whatever `fn` set via `out`. */
  function tx(names, mode, fn) {
    names = [].concat(names);
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(names, mode);
        var box = { v: undefined };
        t.oncomplete = function () { resolve(box.v); };
        t.onerror = function () { reject(dbError(t, 'Device storage write failed')); };
        t.onabort = function () { reject(dbError(t, 'Device storage write was aborted — the device may be out of space')); };
        fn.apply(null, names.map(function (n) { return t.objectStore(n); }).concat([box]));
      });
    });
  }

  function reqp(r) {
    return new Promise(function (res, rej) {
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(dbError(r, 'Device storage read failed')); };
    });
  }

  function getOne(store, key) {
    return open().then(function (db) {
      return reqp(db.transaction(store, 'readonly').objectStore(store).get(key));
    });
  }

  function getAll(store) {
    return open().then(function (db) {
      return reqp(db.transaction(store, 'readonly').objectStore(store).getAll());
    }).then(function (r) { return r || []; });
  }

  /** Read-modify-write one row in a single transaction. */
  function patch(store, id, changes) {
    return tx(store, 'readwrite', function (s, box) {
      s.get(id).onsuccess = function (e) {
        var row = e.target.result;
        if (!row) return;
        Object.keys(changes).forEach(function (k) { row[k] = changes[k]; });
        box.v = row;
        s.put(row);
      };
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

    /** A GlobalID minted on the phone: the server keeps it, so a retry can never file twice. */
    guid: function () { return '{' + uuid().toUpperCase() + '}'; },

    /* ---- key/value ---- */
    get: function (k) {
      return getOne('kv', k).then(function (r) { return r ? r.v : null; });
    },
    set: function (k, v) {
      return tx('kv', 'readwrite', function (s) { s.put({ k: k, v: v }); });
    },
    del: function (k) {
      return tx('kv', 'readwrite', function (s) { s.delete(k); });
    },

    takeLock: function (key, ttlMs, owner) {
      return open().then(function (db) {
        return new Promise(function (resolve) {
          var t = db.transaction('kv', 'readwrite');
          var s = t.objectStore('kv');
          var got = false;
          s.get(key).onsuccess = function (e) {
            var cur = e.target.result && e.target.result.v;
            if (cur && cur.until > Date.now() && cur.owner !== owner) return;   // someone else has it
            got = true;
            s.put({ k: key, v: { owner: owner, until: Date.now() + ttlMs } });
          };
          t.oncomplete = function () { resolve(got); };
          t.onerror = function () { resolve(false); };
          t.onabort = function () { resolve(false); };
        });
      }).catch(function () { return true; });          // never block work on the lock itself
    },

    releaseLock: function (key, owner) {
      return Store.get(key).then(function (cur) {
        if (cur && cur.owner !== owner) return null;
        return Store.del(key);
      }).catch(function () { return null; });
    },

    /* ---- visits ---- */
    putVisit: function (v) {
      return tx('visits', 'readwrite', function (s) { s.put(v); }).then(function () { return v; });
    },
    visit: function (id) { return getOne('visits', id); },
    visits: function () {
      return getAll('visits').then(function (r) {
        return r.sort(function (a, b) { return b.createdAt - a.createdAt; });
      });
    },
    patchVisit: function (id, changes) { return patch('visits', id, changes); },

    /** A visit and everything under it — rows and photo bytes, in one go. */
    removeVisit: function (id) {
      return Store.shotsOf(id).then(function (shots) {
        return tx(['visits', 'shots', 'photos'], 'readwrite', function (v, s, p) {
          v.delete(id);
          shots.forEach(function (sh) { s.delete(sh.id); p.delete(sh.id); });
        });
      });
    },

    /* ---- shots: one row per photo, bytes kept apart ---- */
    addShot: function (shot, blob) {
      shot.hasPhoto = !!blob;
      return tx(['shots', 'photos'], 'readwrite', function (s, p) {
        // one transaction over both: never a row without its photo
        s.put(shot);
        if (blob) p.put({ id: shot.id, blob: blob });
      }).then(function () { return shot; });
    },
    shot: function (id) { return getOne('shots', id); },
    shotsOf: function (visitId) {
      return open().then(function (db) {
        return reqp(db.transaction('shots', 'readonly').objectStore('shots').index('visitId').getAll(visitId));
      }).then(function (r) {
        return (r || []).sort(function (a, b) { return a.createdAt - b.createdAt; });
      });
    },
    shots: function () { return getAll('shots'); },
    patchShot: function (id, changes) { return patch('shots', id, changes); },
    removeShot: function (id) {
      return tx(['shots', 'photos'], 'readwrite', function (s, p) { s.delete(id); p.delete(id); });
    },
    photo: function (id) {
      return getOne('photos', id).then(function (r) { return r ? r.blob : null; });
    },
    dropPhoto: function (id) {
      return tx(['shots', 'photos'], 'readwrite', function (s, p) {
        p.delete(id);
        s.get(id).onsuccess = function (e) {
          var row = e.target.result;
          if (row) { row.hasPhoto = false; s.put(row); }
        };
      });
    },

    /* ---- station edits: new stations and changes, waiting to go up ---- */
    putEdit: function (e) {
      return tx('edits', 'readwrite', function (s) { s.put(e); }).then(function () { return e; });
    },
    edits: function () {
      return getAll('edits').then(function (r) {
        return r.sort(function (a, b) { return a.createdAt - b.createdAt; });
      });
    },
    patchEdit: function (id, changes) { return patch('edits', id, changes); },
    removeEdit: function (id) { return tx('edits', 'readwrite', function (s) { s.delete(id); }); },

    /* ---- the last visit's photos, for lining up the next one ---- */
    ghost: function (k) { return getOne('ghosts', k); },
    putGhost: function (rec) { return tx('ghosts', 'readwrite', function (s) { s.put(rec); }); },
    ghostKeys: function () {
      return open().then(function (db) {
        return reqp(db.transaction('ghosts', 'readonly').objectStore('ghosts').getAllKeys());
      }).then(function (k) { return k || []; });
    },

    /** What is still owed to the server. */
    counts: function () {
      return Promise.all([Store.visits(), Store.shots(), Store.edits()]).then(function (r) {
        var visits = r[0], shots = r[1], edits = r[2];
        var queued = {};
        visits.forEach(function (v) { if (v.state !== 'draft') queued[v.id] = v; });
        var c = { visits: 0, photos: 0, edits: 0, errors: 0, drafts: 0, bytes: 0, outstanding: 0 };
        visits.forEach(function (v) {
          if (v.state === 'draft') c.drafts++;
          else if (v.state !== 'sent' || v.pendingEdit) c.visits++;
          if (v.state === 'error') c.errors++;
        });
        shots.forEach(function (s) {
          if (!queued[s.visitId] || s.state === 'sent') return;
          c.photos++;
          c.bytes += s.size || 0;
          if (s.state === 'error') c.errors++;
        });
        edits.forEach(function (e) {
          if (e.state === 'sent') return;
          c.edits++;
          if (e.state === 'error') c.errors++;
        });
        c.outstanding = c.photos + c.edits +
          visits.filter(function (v) { return v.state !== 'draft' && (!v.objectId || v.pendingEdit); }).length;
        return c;
      });
    }
  };

  g.Store = Store;
})(typeof self !== 'undefined' ? self : this);
