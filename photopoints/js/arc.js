/* Photo Points — ArcGIS: sign-in, reading stations, and the upload engine.
   Shared by the page and the service worker: no `window`, no `document`.

   How a visit goes up, and why:
   - Everything carries a GlobalID minted on the phone (station, visit, each
     photo) and goes through applyEdits with useGlobalIds. If an answer is lost
     on a bad connection the edit may well have landed; the retry is then
     refused as a duplicate, which is the cue to look the record up instead of
     filing it twice. (addFeatures quietly ignores client GlobalIDs — only
     applyEdits keeps them.)
   - A photo is sent in chunks (uploads/register → uploadPart → commit), one
     photo at a time and one chunk at a time. A dropped connection costs one
     chunk, not the photo, and the next attempt carries on from the chunk it
     stopped at — even after the app was closed. Sending many photos at once
     on two bars of signal is how every one of them fails together.
   - Every request has a deadline; a deadline is not the same as no signal. */
(function (g) {
  'use strict';

  var AUTH_KEY = 'auth';
  var META_TTL = 7 * 24 * 3600 * 1000;

  function asError(e) {
    if (e instanceof Error) return e;
    if (e && typeof e === 'object') {
      var w = new Error(e.message || e.name || 'Unexpected error');
      ['needAuth', 'retryable', 'timeout', 'code'].forEach(function (k) { if (e[k]) w[k] = e[k]; });
      return w;
    }
    return new Error(e ? String(e) : 'Unexpected error');
  }

  function NeedAuth(msg) { var e = new Error(msg || 'Sign in required'); e.needAuth = true; return e; }
  function Retryable(msg) { var e = new Error(msg); e.retryable = true; return e; }
  function Timeout(msg) { var e = Retryable(msg); e.timeout = true; return e; }

  function form(obj) {
    var b = new URLSearchParams();
    Object.keys(obj).forEach(function (k) {
      if (obj[k] !== undefined && obj[k] !== null) b.append(k, obj[k]);
    });
    return b;
  }

  // a chunk is ~1 MB: at the 20 KB/s of a bad field connection that is under a minute
  var TIMEOUTS = { json: 30000, edit: 60000, part: 90000 };

  function postJson(url, body, timeoutMs) {
    var ms = timeoutMs || TIMEOUTS.json;
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var late = 'Timed out after ' + Math.round(ms / 1000) + 's';
    var timedOut = false, timer = null;

    var req = fetch(url, {
      method: 'POST',
      signal: ctl ? ctl.signal : undefined,
      body: body instanceof FormData ? body : form(body),
      headers: body instanceof FormData ? undefined : { 'Content-Type': 'application/x-www-form-urlencoded' }
    }).catch(function () {
      throw timedOut ? Timeout(late) : Retryable('Network unreachable');
    });

    return new Promise(function (resolve, reject) {
      timer = setTimeout(function () {
        timedOut = true;
        if (ctl) ctl.abort();
        reject(Timeout(late));
      }, ms);
      req.then(resolve, reject);
    }).then(function (r) {
      clearTimeout(timer);
      return r;
    }, function (e) {
      clearTimeout(timer);
      throw e;
    }).then(function (r) {
      if (!r.ok) throw Retryable('HTTP ' + r.status);
      return r.json().catch(function () { throw Retryable('Bad response'); });
    }).then(function (j) {
      if (j && j.error) {
        var code = j.error.code;
        var msg = j.error.message || 'ArcGIS error ' + code;
        if (code === 498 || code === 499) throw NeedAuth(msg);
        var e = new Error(msg + (j.error.details && j.error.details.length ? ' — ' + j.error.details.join('; ') : ''));
        e.code = code;
        throw e;
      }
      return j;
    });
  }

  /* ─────────────────────────── auth ─────────────────────────── */

  function getAuth() { return g.Store.get(AUTH_KEY); }
  function setAuth(a) { return g.Store.set(AUTH_KEY, a); }
  function fresh(a) { return a && a.token && a.expires && a.expires - Date.now() > 120000; }
  function portal() { return g.Config.get().portal.replace(/\/+$/, ''); }

  function refresh(a) {
    return postJson(portal() + '/sharing/rest/oauth2/token', {
      f: 'json',
      grant_type: 'refresh_token',
      client_id: a.appId || g.Config.get().appId,
      refresh_token: a.refreshToken
    }).then(function (j) {
      a.token = j.access_token;
      a.expires = Date.now() + (j.expires_in || 1800) * 1000;
      if (j.refresh_token) a.refreshToken = j.refresh_token;
      return setAuth(a).then(function () { return a.token; });
    });
  }

  function token() {
    return getAuth().then(function (a) {
      if (fresh(a)) return a.token;
      if (a && a.refreshToken) {
        return refresh(a).catch(function (e) {
          if (e.retryable) throw e;
          throw NeedAuth('Session expired — sign in again');
        });
      }
      throw NeedAuth();
    });
  }

  function b64url(buf) {
    var s = btoa(String.fromCharCode.apply(null, new Uint8Array(buf)));
    return s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  /* ───────────────────────── helpers ───────────────────────── */

  function applyEdits(url, params, t) {
    var body = { f: 'json', token: t, useGlobalIds: true, rollbackOnFailure: true };
    Object.keys(params).forEach(function (k) { body[k] = typeof params[k] === 'string' ? params[k] : JSON.stringify(params[k]); });
    return postJson(url + '/applyEdits', body, TIMEOUTS.edit);
  }

  function failure(res, what) {
    return (res && res.error && (res.error.description || res.error.message)) || what;
  }

  function isDuplicate(msg) { return /duplicate/i.test(msg || ''); }

  /**
   * The service no longer has the half-sent upload — it expired, or was used.
   * It says so only in the details: "Unable to upload item.", "Unable to
   * commit uploaded items.", "…the following Upload IDs are invalid…".
   */
  function uploadGone(e) {
    var m = (e && e.message) || '';
    return !!e && !e.retryable && !e.needAuth && /upload/i.test(m) && /unable|invalid|not found|expired/i.test(m);
  }

  /** Only send what the layer has, cut to what it accepts. */
  function shape(attrs, meta) {
    var byName = {};
    (meta && meta.fields || []).forEach(function (f) { byName[f.name.toLowerCase()] = f; });
    var out = {};
    Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === undefined) return;
      var f = byName[k.toLowerCase()];
      if (!f) return;                                   // this layer has no such field
      if (g.Config.RESERVED.test(f.name) && f.type !== 'esriFieldTypeGlobalID') return;
      if (v !== null && f.type === 'esriFieldTypeString') {
        v = String(v);
        if (f.length) v = v.slice(0, f.length);
      }
      out[f.name] = v;
    });
    return out;
  }

  function lockStep(me) { return g.Store.takeLock('flushLock', 5 * 60000, me); }

  var Arc = {
    asError: asError,
    timeouts: TIMEOUTS,
    NeedAuth: NeedAuth,
    getAuth: getAuth,
    token: token,
    postJson: postJson,

    redirectUri: function () {
      return location.origin + location.pathname.replace(/index\.html$/, '');
    },

    beginOAuth: function () {
      var c = g.Config.get();
      if (!c.appId) return Promise.reject(new Error('No OAuth app id configured'));
      var v = b64url(crypto.getRandomValues(new Uint8Array(48)));
      return crypto.subtle.digest('SHA-256', new TextEncoder().encode(v)).then(b64url).then(function (ch) {
        return g.Store.set('pkce', { v: v, at: Date.now() }).then(function () { return ch; });
      }).then(function (ch) {
        location.assign(portal() + '/sharing/rest/oauth2/authorize?' + form({
          client_id: c.appId,
          response_type: 'code',
          redirect_uri: Arc.redirectUri(),
          code_challenge: ch,
          code_challenge_method: 'S256',
          expiration: 20160
        }).toString());
      });
    },

    completeOAuth: function () {
      var p = new URLSearchParams(location.search);
      var code = p.get('code');
      var err = p.get('error');
      if (err) {
        history.replaceState(null, '', Arc.redirectUri());
        return Promise.reject(new Error(p.get('error_description') || err));
      }
      if (!code) return Promise.resolve(null);
      history.replaceState(null, '', Arc.redirectUri());
      var c = g.Config.get();
      return g.Store.get('pkce').then(function (pk) {
        if (!pk) throw new Error('Sign-in expired, try again');
        return postJson(portal() + '/sharing/rest/oauth2/token', {
          f: 'json',
          grant_type: 'authorization_code',
          client_id: c.appId,
          redirect_uri: Arc.redirectUri(),
          code: code,
          code_verifier: pk.v
        });
      }).then(function (j) {
        return g.Store.del('pkce').then(function () {
          var a = {
            mode: 'oauth', appId: c.appId, token: j.access_token,
            expires: Date.now() + (j.expires_in || 1800) * 1000,
            refreshToken: j.refresh_token,
            username: j.username || (j.user && j.user.username) || 'ArcGIS user'
          };
          return setAuth(a).then(function () { return a; });
        });
      });
    },

    /** Named-user sign-in without a registered app. The password is never stored. */
    signInPassword: function (username, password) {
      return postJson(portal() + '/sharing/rest/generateToken', {
        f: 'json', username: username, password: password,
        referer: location.origin, expiration: 20160
      }).then(function (j) {
        if (!j.token) throw new Error(j.messages ? j.messages.join(' ') : 'Sign-in failed');
        var a = { mode: 'password', token: j.token, expires: j.expires || (Date.now() + 3600000), username: username };
        return setAuth(a).then(function () { return a; });
      });
    },

    setManualToken: function (tok, minutes) {
      var a = { mode: 'manual', token: tok.trim(), expires: Date.now() + (minutes || 120) * 60000, username: 'token' };
      return setAuth(a).then(function () { return a; });
    },

    signOut: function () { return g.Store.del(AUTH_KEY); },

    /* ─────────────────────── reading ─────────────────────── */

    layerMeta: function (url, force) {
      var key = 'meta:' + url;
      return g.Store.get(key).then(function (cached) {
        if (!force && cached && Date.now() - cached.at < META_TTL) return cached.meta;
        return token().then(function (t) {
          return postJson(url, { f: 'json', token: t });
        }).then(function (meta) {
          return g.Store.set(key, { at: Date.now(), meta: meta }).then(function () { return meta; });
        }).catch(function (e) {
          if (cached) return cached.meta;            // offline: the last known schema is fine
          throw e;
        });
      });
    },

    /** Coded values of a field's domain: [{code, name}], or [] if it has none. */
    domain: function (meta, field) {
      var f = (meta && meta.fields || []).filter(function (x) { return x.name === field; })[0];
      return f && f.domain && f.domain.codedValues ? f.domain.codedValues : [];
    },

    /**
     * Every station, with when each was last visited. Cached on the device,
     * so the list and the guidance work with no signal at all.
     */
    stations: function (force) {
      return g.Store.get('stations').then(function (cached) {
        if (!force && cached && Date.now() - cached.at < 10 * 60000) return cached;
        var t;
        return token().then(function (tok) {
          t = tok;
          return postJson(g.Config.stationsUrl() + '/query', {
            f: 'json', token: t, where: '1=1', outFields: '*', returnGeometry: true, outSR: 4326,
            resultRecordCount: 4000
          });
        }).then(function (j) {
          var list = (j.features || []).map(Arc.normStation).filter(function (s) { return s.gid; });
          return Arc.visitStats(t).catch(function () { return cached ? cached.stats : {}; }).then(function (stats) {
            var rec = { at: Date.now(), list: list, stats: stats };
            return g.Store.set('stations', rec).then(function () { return rec; });
          });
        }).catch(function (e) {
          if (cached) return Object.assign({ stale: true, error: asError(e).message }, cached);
          throw e;
        });
      });
    },

    normStation: function (f) {
      var a = f.attributes || {};
      var gm = f.geometry || {};
      return {
        gid: a.GlobalID ? '{' + String(a.GlobalID).replace(/[{}]/g, '').toUpperCase() + '}' : null,
        oid: a.OBJECTID,
        id: a.StationID || ('#' + a.OBJECTID),
        site: a.SiteName || '',
        mu: a.MgmtUnit || '',
        habitat: a.Habitat || '',
        postInstalled: a.PostInstalled || '',
        postType: a.PostType || '',
        postTag: a.PostTag || '',
        installDate: a.InstallDate || null,
        status: a.StationStatus || '',
        notes: a.Notes || '',
        lat: typeof gm.y === 'number' ? gm.y : null,
        lon: typeof gm.x === 'number' ? gm.x : null
      };
    },

    /** Last visit date and visit count per station GlobalID. */
    visitStats: function (t) {
      return postJson(g.Config.visitsUrl() + '/query', {
        f: 'json', token: t, where: '1=1',
        groupByFieldsForStatistics: 'StationGUID',
        outStatistics: JSON.stringify([
          { statisticType: 'max', onStatisticField: 'VisitDate', outStatisticFieldName: 'lastvisit' },
          { statisticType: 'count', onStatisticField: 'OBJECTID', outStatisticFieldName: 'nvisits' }
        ])
      }).then(function (j) {
        var out = {};
        (j.features || []).forEach(function (f) {
          var a = f.attributes, k = a.StationGUID || a.stationguid;
          if (!k) return;
          k = '{' + String(k).replace(/[{}]/g, '').toUpperCase() + '}';
          out[k] = { last: a.lastvisit || a.LASTVISIT || null, count: a.nvisits || a.NVISITS || 0 };
        });
        return out;
      });
    },

    /**
     * Fetch the most recent earlier visit's photos for a station, one per slot,
     * scaled down, and keep them on the device for lining up the next shots.
     * Resolves with the number of slots that now have one.
     */
    fetchGhosts: function (stationGid, skipVisitGid) {
      var url = g.Config.visitsUrl(), t;
      return token().then(function (tok) {
        t = tok;
        return postJson(url + '/query', {
          f: 'json', token: t, where: "StationGUID = '" + stationGid + "'",
          outFields: 'OBJECTID,GlobalID,VisitDate', orderByFields: 'VisitDate DESC,OBJECTID DESC', resultRecordCount: 5
        });
      }).then(function (j) {
        var visits = (j.features || []).map(function (f) { return f.attributes; }).filter(function (a) {
          return !skipVisitGid || String(a.GlobalID).replace(/[{}]/g, '').toUpperCase() !== skipVisitGid.replace(/[{}]/g, '');
        });
        if (!visits.length) return 0;
        return postJson(url + '/queryAttachments', {
          f: 'json', token: t, objectIds: visits.map(function (v) { return v.OBJECTID; }).join(','),
          returnMetadata: true
        }).then(function (q) {
          // newest visit first; within it, the first photo taken for each slot
          var byOid = {};
          (q.attachmentGroups || []).forEach(function (gr) { byOid[gr.parentObjectId] = gr.attachmentInfos || []; });
          var pick = {};
          visits.forEach(function (v) {
            (byOid[v.OBJECTID] || []).slice().sort(function (a, b) { return a.id - b.id; }).forEach(function (a) {
              var kw = String(a.keywords || '').trim().toUpperCase();
              if (!g.Config.slot(kw) || kw === 'MISC' || pick[kw]) return;
              pick[kw] = { oid: v.OBJECTID, att: a, visitDate: v.VisitDate };
            });
          });
          var keys = Object.keys(pick);
          return keys.reduce(function (chain, kw) {
            return chain.then(function (n) {
              var p = pick[kw];
              var src = url + '/' + p.oid + '/attachments/' + p.att.id + '?' + form({ w: 1280, token: t }).toString();
              var ctl = typeof AbortController === 'function' ? new AbortController() : null;
              var timer = setTimeout(function () { if (ctl) ctl.abort(); }, TIMEOUTS.edit);
              return fetch(src, { signal: ctl ? ctl.signal : undefined }).then(function (r) {
                clearTimeout(timer);
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.blob();
              }).then(function (blob) {
                return g.Store.putGhost({
                  k: stationGid + '|' + kw, blob: blob, at: Date.now(), name: p.att.name,
                  visitDate: p.visitDate, bearing: Arc.bearingFromName(p.att.name)
                }).then(function () { return n + 1; });
              }).catch(function () { clearTimeout(timer); return n; });   // one missing ghost is no reason to stop
            });
          }, Promise.resolve(0));
        });
      });
    },

    /** Photos from this app carry their bearing in the name: …_003T.jpg */
    bearingFromName: function (name) {
      var m = /_(\d{3})([TM])\.jpe?g$/i.exec(name || '');
      return m ? { deg: +m[1], ref: m[2].toUpperCase() } : null;
    },

    /* ─────────────────────── uploading ─────────────────────── */

    backoff: function (attempts, retryable) {
      if (retryable) return Math.min(60000, 5000 * Math.max(1, attempts));
      return Math.min(30 * 60000, 15000 * Math.pow(2, Math.max(0, attempts - 1)));
    },

    /**
     * Rows left mid-flight belong to nobody: iOS suspends the app during a slow
     * upload and the drain never returns. Hand them back at startup.
     */
    reclaimStranded: function () {
      var n = 0;
      return Promise.all([g.Store.shots(), g.Store.visits()]).then(function (r) {
        var jobs = [];
        r[0].forEach(function (s) {
          if (s.state !== 'uploading') return;
          n++;
          jobs.push(g.Store.patchShot(s.id, {
            state: 'pending', netAttempts: (s.netAttempts || 0) + 1, nextAttemptAt: 0,
            lastError: 'Interrupted — the app closed mid-upload'
          }));
        });
        r[1].forEach(function (v) {
          if (v.state === 'uploading') jobs.push(g.Store.patchVisit(v.id, { state: 'queued' }));
        });
        return Promise.all(jobs);
      }).then(function () { return n; }).catch(function () { return 0; });
    },

    /** Everything held back by a retry timer becomes due again (the connection is back). */
    clearBackoff: function () {
      return Promise.all([g.Store.shots(), g.Store.visits(), g.Store.edits()]).then(function (r) {
        var jobs = [];
        r[0].forEach(function (s) { if (s.nextAttemptAt && s.state !== 'sent') jobs.push(g.Store.patchShot(s.id, { nextAttemptAt: 0 })); });
        r[1].forEach(function (v) { if (v.nextAttemptAt) jobs.push(g.Store.patchVisit(v.id, { nextAttemptAt: 0 })); });
        r[2].forEach(function (e) { if (e.nextAttemptAt) jobs.push(g.Store.patchEdit(e.id, { nextAttemptAt: 0 })); });
        return Promise.all(jobs);
      });
    },

    /**
     * Push everything owed: station edits, then visits, then each visit's
     * photos one by one. `onEvent(type, payload, err)` reports progress.
     */
    flush: function (onEvent, opts) {
      opts = opts || {};
      var ev = onEvent || function () {};
      var sum = { sent: 0, photos: 0, failed: 0, needAuth: false, offline: false, locked: false, waiting: 0 };
      var me = g.Store.uuid();
      return g.Store.takeLock('flushLock', 5 * 60000, me).then(function (got) {
        if (!got) { sum.locked = true; return sum; }
        return Arc._drain(ev, opts, sum, me).then(function (r) {
          return g.Store.releaseLock('flushLock', me).then(function () { return r; });
        }, function (e) {
          return g.Store.releaseLock('flushLock', me).then(function () { throw asError(e); });
        });
      });
    },

    _due: function (row, opts) {
      return opts.force || !row.nextAttemptAt || row.nextAttemptAt <= Date.now();
    },

    /** Record a failure on a row in the way the queue view and the retry timer expect. */
    _fail: function (patcher, row, raw, sum) {
      var e = asError(raw);
      if (e.needAuth) sum.needAuth = true;
      if (e.retryable && !e.timeout) sum.offline = true;
      sum.failed++;
      var attempts = (row.attempts || 0) + 1;
      return patcher(row.id, {
        state: e.needAuth || e.retryable ? 'pending' : 'error',
        attempts: e.retryable ? (row.attempts || 0) : attempts,     // no signal is not the row's fault
        netAttempts: e.retryable ? (row.netAttempts || 0) + 1 : (row.netAttempts || 0),
        lastError: e.message,
        nextAttemptAt: Date.now() + Arc.backoff(attempts, e.retryable)
      }).catch(function () { /* storage itself is failing; the error is still reported */ })
        .then(function () { return e; });
    },

    _drain: function (ev, opts, sum, me) {
      var stop = function () { return sum.needAuth || sum.offline; };
      return g.Config.load().then(function () {
        return g.Store.edits();
      }).then(function (edits) {
        // stations first: a visit may belong to a station that is not up yet
        return edits.filter(function (e) { return e.state !== 'sent' && Arc._due(e, opts); }).reduce(function (chain, e) {
          return chain.then(function () {
            if (stop()) return null;
            ev('start', e);
            return Arc.sendEdit(e).then(function () {
              sum.sent++;
              ev('edit-sent', e);
            }, function (raw) {
              return Arc._fail(g.Store.patchEdit, e, raw, sum).then(function (err) { ev('failed', e, err); });
            });
          });
        }, Promise.resolve());
      }).then(function () {
        return Promise.all([g.Store.visits(), g.Store.edits()]);
      }).then(function (r) {
        var waitingStations = {};
        r[1].forEach(function (e) { if (e.kind === 'add' && e.state !== 'sent') waitingStations[e.globalId] = true; });
        var visits = r[0].filter(function (v) {
          return v.state !== 'draft' && (v.state !== 'sent' || v.pendingEdit);
        }).sort(function (a, b) { return a.createdAt - b.createdAt; });

        return visits.reduce(function (chain, v) {
          return chain.then(function () {
            if (stop()) return null;
            if (waitingStations[v.stationGid]) { sum.waiting++; return null; }   // its station goes first
            return lockStep(me).then(function () { return Arc.sendVisit(v, ev, opts, sum, me); });
          });
        }, Promise.resolve());
      }).then(function () { return sum; });
    },

    /** One station add or change. */
    sendEdit: function (e) {
      var url = g.Config.stationsUrl(), t;
      return g.Store.patchEdit(e.id, { state: 'uploading' }).then(function () {
        return Promise.all([token(), Arc.layerMeta(url)]);
      }).then(function (r) {
        t = r[0];
        var attrs = shape(Object.assign({}, e.attrs, { GlobalID: e.globalId }), r[1]);
        attrs.GlobalID = e.globalId;
        if (e.kind === 'add') {
          return applyEdits(url, { adds: [{ geometry: { x: e.lon, y: e.lat, spatialReference: { wkid: 4326 } }, attributes: attrs }] }, t)
            .then(function (j) {
              var res = (j.addResults || [])[0];
              if (res && res.success) return res.objectId;
              var why = failure(res, 'the layer refused the station');
              if (isDuplicate(why)) return Arc.findByGlobalId(url, e.globalId, t);
              throw new Error(why);
            });
        }
        return applyEdits(url, { updates: [{ attributes: attrs }] }, t).then(function (j) {
          var res = (j.updateResults || [])[0];
          if (res && res.success) return res.objectId;
          throw new Error(failure(res, 'the layer refused the change to the station'));
        });
      }).then(function (oid) {
        return g.Store.removeEdit(e.id).then(function () { return oid; });
      });
    },

    findByGlobalId: function (url, gid, t) {
      return postJson(url + '/query', {
        f: 'json', token: t, where: "GlobalID = '" + gid + "'", returnIdsOnly: true
      }).then(function (j) {
        if (j.objectIds && j.objectIds.length) return j.objectIds[0];
        throw new Error('the layer said it already had ' + gid + ', but it cannot be found');
      });
    },

    /** A visit record, any change to it, then its photos one at a time. */
    sendVisit: function (v, ev, opts, sum, me) {
      var url = g.Config.visitsUrl(), t, meta;
      return Promise.all([token(), Arc.layerMeta(url)]).then(function (r) {
        t = r[0];
        meta = r[1];
        if (v.objectId && !v.pendingEdit) return v.objectId;
        if (!Arc._due(v, opts)) return null;
        ev('start', v);
        var attrs = shape(Object.assign({}, v.attrs, { StationGUID: v.stationGid, StationID: v.stationId }), meta);
        attrs.GlobalID = v.globalId;
        var write = v.objectId
          ? applyEdits(url, { updates: [{ attributes: attrs }] }, t).then(function (j) {
            var res = (j.updateResults || [])[0];
            if (res && res.success) return v.objectId;
            throw new Error(failure(res, 'the layer refused the change to the visit'));
          })
          : applyEdits(url, { adds: [{ attributes: attrs }] }, t).then(function (j) {
            var res = (j.addResults || [])[0];
            if (res && res.success) return res.objectId;
            var why = failure(res, 'the layer refused the visit');
            if (isDuplicate(why)) return Arc.findByGlobalId(url, v.globalId, t);
            throw new Error(why);
          });
        return write.then(function (oid) {
          return g.Store.patchVisit(v.id, { objectId: oid, pendingEdit: false, state: 'uploading', lastError: null })
            .then(function () { v.objectId = oid; return oid; });
        }, function (raw) {
          return Arc._fail(g.Store.patchVisit, v, raw, sum).then(function (err) {
            ev('failed', v, err);
            return null;
          });
        });
      }).then(function (oid) {
        if (!oid) return null;
        return g.Store.shotsOf(v.id).then(function (shots) {
          var todo = shots.filter(function (s) { return s.state !== 'sent'; });
          return todo.reduce(function (chain, s) {
            return chain.then(function () {
              if (sum.needAuth || sum.offline) return null;
              if (!Arc._due(s, opts)) return null;
              return lockStep(me).then(function () {
                ev('start', s);
                return g.Store.patchShot(s.id, { state: 'uploading' });
              }).then(function () {
                return g.Store.shot(s.id);
              }).then(function (live) {
                return Arc.sendShot(live || s, v, t, ev);
              }).then(function () {
                sum.photos++;
                ev('sent', s);
              }, function (raw) {
                return Arc._fail(g.Store.patchShot, s, raw, sum).then(function (err) { ev('failed', s, err); });
              });
            });
          }, Promise.resolve()).then(function () {
            return g.Store.shotsOf(v.id);
          }).then(function (after) {
            if (after.every(function (s) { return s.state === 'sent'; })) {
              sum.sent++;
              return g.Store.patchVisit(v.id, { state: 'sent', sentAt: Date.now(), lastError: null })
                .then(function () { ev('visit-sent', v); });
            }
            return g.Store.patchVisit(v.id, { state: 'queued' });
          });
        });
      });
    },

    /** One photo: chunks, commit, attach. Resumes at whichever step it stopped. */
    sendShot: function (s, v, t, ev) {
      if (s.attachmentId) return g.Store.patchShot(s.id, { state: 'sent' });
      var svc = g.Config.serviceUrl(), url = g.Config.visitsUrl();
      var partSize = Math.max(64, g.Config.get().partKB | 0 || 1024) * 1024;
      return g.Store.photo(s.id).then(function (blob) {
        if (!blob) throw new Error('This photo is no longer on the device — it cannot be uploaded');
        var total = Math.max(1, Math.ceil(blob.size / partSize));

        var register = s.uploadId ? Promise.resolve(s.uploadId) : postJson(svc + '/uploads/register', {
          f: 'json', token: t, itemName: s.name, description: 'Photo Points ' + s.slot
        }).then(function (j) {
          var id = j.item && j.item.itemID;
          if (!id) throw new Error('The service did not accept the upload');
          s.uploadId = id;
          s.parts = [];
          return g.Store.patchShot(s.id, { uploadId: id, parts: [], committed: false, partSize: partSize, size: blob.size })
            .then(function () { return id; });
        });

        return register.then(function (upId) {
          // a resumed upload keeps the chunk size it started with
          var size = s.partSize || partSize;
          total = Math.max(1, Math.ceil(blob.size / size));
          var done = {};
          (s.parts || []).forEach(function (p) { done[p] = true; });
          var ids = [];
          for (var i = 1; i <= total; i++) ids.push(i);

          return ids.reduce(function (chain, n) {
            return chain.then(function () {
              if (done[n] || s.committed) return null;
              var fd = new FormData();
              fd.append('f', 'json');
              fd.append('token', t);
              fd.append('partId', String(n));
              fd.append('file', blob.slice((n - 1) * size, Math.min(blob.size, n * size)), 'part' + n);
              return postJson(svc + '/uploads/' + upId + '/uploadPart', fd, TIMEOUTS.part).catch(function (e) {
                // as in Exotic Camera: a stored Blob that cannot be read fails like a network error
                if (!e || !e.retryable) throw e;
                return blob.slice(0, 1).arrayBuffer().then(function () { throw e; }, function () {
                  throw new Error('The photo could not be read back from this device');
                });
              }).then(function () {
                done[n] = true;
                var list = Object.keys(done).map(Number);
                ev('progress', s, { done: list.length, total: total, bytes: Math.min(blob.size, list.length * size), size: blob.size });
                return g.Store.patchShot(s.id, { parts: list });
              });
            });
          }, Promise.resolve()).then(function () {
            if (s.committed) return null;
            var all = ids.join(',');
            return postJson(svc + '/uploads/' + upId + '/commit', { f: 'json', token: t, parts: all }, TIMEOUTS.edit)
              .catch(function (e) {
                if (/commit/i.test(e.message || '') && /already/i.test(e.message || '')) return null;
                throw e;
              }).then(function () {
                s.committed = true;
                return g.Store.patchShot(s.id, { committed: true });
              });
          }).then(function () {
            return applyEdits(url, { attachments: { adds: [{
              globalId: s.attGlobalId, parentGlobalId: v.globalId, uploadId: upId,
              name: s.name, contentType: 'image/jpeg', keywords: s.slot
            }] } }, t);
          }).then(function (j) {
            var res = ((j.attachments || {}).addResults || [])[0];
            if (res && res.success) return res.objectId;
            var why = failure(res, 'the layer refused the photo');
            if (isDuplicate(why)) return Arc.findAttachment(url, v.objectId, s.attGlobalId, t);
            var err = new Error(why);
            err.code = res && res.error && res.error.code;
            throw err;
          }).then(function (aid) {
            postJson(svc + '/uploads/' + upId + '/delete', { f: 'json', token: t }).catch(function () {});
            return g.Store.patchShot(s.id, { state: 'sent', attachmentId: aid, sentAt: Date.now(), lastError: null });
          });
        }).catch(function (e) {
          // The service no longer has the half-sent upload: next time, start the
          // photo again from its first chunk. Not a "no signal" retry — if this
          // keeps happening something is wrong, and the backoff should grow.
          if (s.uploadId && uploadGone(asError(e))) {
            return g.Store.patchShot(s.id, { uploadId: null, parts: [], committed: false }).then(function () {
              throw new Error('The server dropped the half-sent upload (' + asError(e).message + ') — it will start again');
            });
          }
          throw e;
        });
      });
    },

    /** The attachment id of a photo already attached, found by its GlobalID. */
    findAttachment: function (url, oid, gid, t) {
      return postJson(url + '/queryAttachments', {
        f: 'json', token: t, objectIds: String(oid), returnMetadata: false
      }).then(function (j) {
        var want = String(gid).replace(/[{}]/g, '').toLowerCase();
        var hit = null;
        (j.attachmentGroups || []).forEach(function (gr) {
          (gr.attachmentInfos || []).forEach(function (a) {
            if (String(a.globalId || '').replace(/[{}]/g, '').toLowerCase() === want) hit = a.id;
          });
        });
        if (hit === null) throw new Error('the layer said the photo was already there, but it cannot be found');
        return hit;
      });
    },

    /** Take a visit off the layer again (and its photos with it). */
    deleteVisit: function (v) {
      if (!v || !v.objectId) return Promise.resolve(false);
      return token().then(function (t) {
        return postJson(g.Config.visitsUrl() + '/applyEdits', {
          f: 'json', token: t, deletes: String(v.objectId)
        }, TIMEOUTS.edit);
      }).then(function (j) {
        var res = (j.deleteResults || [])[0];
        if (!res || !res.success) throw new Error(failure(res, 'the layer refused the delete'));
        return true;
      });
    }
  };

  g.Arc = Arc;
})(typeof self !== 'undefined' ? self : this);
