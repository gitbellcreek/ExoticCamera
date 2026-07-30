/* Exotic Camera — ArcGIS auth + upload.
   Shared by the page and the service worker: no `window`, no `document`.
   Interactive sign-in lives in the page (Arc.beginOAuth / Arc.signInPassword). */
(function (g) {
  'use strict';

  var AUTH_KEY = 'auth';
  var META_KEY = 'layerMeta';
  var META_TTL = 7 * 24 * 3600 * 1000;

  function NeedAuth(msg) { var e = new Error(msg || 'Sign in required'); e.needAuth = true; return e; }
  function Retryable(msg) { var e = new Error(msg); e.retryable = true; return e; }

  function form(obj) {
    var b = new URLSearchParams();
    Object.keys(obj).forEach(function (k) {
      if (obj[k] !== undefined && obj[k] !== null) b.append(k, obj[k]);
    });
    return b;
  }

  function postJson(url, body) {
    return fetch(url, {
      method: 'POST',
      body: body instanceof FormData ? body : form(body),
      headers: body instanceof FormData ? undefined : { 'Content-Type': 'application/x-www-form-urlencoded' }
    }).catch(function () {
      throw Retryable('Network unreachable');
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

  function refresh(a) {
    var c = g.Config.get();
    return postJson(c.portal.replace(/\/+$/, '') + '/sharing/rest/oauth2/token', {
      f: 'json',
      grant_type: 'refresh_token',
      client_id: a.appId || c.appId,
      refresh_token: a.refreshToken
    }).then(function (j) {
      a.token = j.access_token;
      a.expires = Date.now() + (j.expires_in || 1800) * 1000;
      if (j.refresh_token) a.refreshToken = j.refresh_token;
      return setAuth(a).then(function () { return a.token; });
    });
  }

  /** Resolve a usable token, refreshing silently when possible. */
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

  /* --- OAuth 2.0 authorization code + PKCE (page only) --- */

  function b64url(buf) {
    var s = btoa(String.fromCharCode.apply(null, new Uint8Array(buf)));
    return s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function verifier() {
    return b64url(crypto.getRandomValues(new Uint8Array(48)));
  }

  function challenge(v) {
    return crypto.subtle.digest('SHA-256', new TextEncoder().encode(v)).then(b64url);
  }

  var Arc = {
    NeedAuth: NeedAuth,
    getAuth: getAuth,
    token: token,

    redirectUri: function () {
      return location.origin + location.pathname.replace(/index\.html$/, '');
    },

    /** Kick off the interactive OAuth redirect. */
    beginOAuth: function () {
      var c = g.Config.get();
      if (!c.appId) return Promise.reject(new Error('No OAuth app id configured'));
      var v = verifier();
      return challenge(v).then(function (ch) {
        return g.Store.set('pkce', { v: v, at: Date.now() }).then(function () { return ch; });
      }).then(function (ch) {
        var u = c.portal.replace(/\/+$/, '') + '/sharing/rest/oauth2/authorize?' + form({
          client_id: c.appId,
          response_type: 'code',
          redirect_uri: Arc.redirectUri(),
          code_challenge: ch,
          code_challenge_method: 'S256',
          expiration: 20160
        }).toString();
        location.assign(u);
      });
    },

    /** Complete OAuth after the redirect back. Returns null when there's no code. */
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
        return postJson(c.portal.replace(/\/+$/, '') + '/sharing/rest/oauth2/token', {
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
            mode: 'oauth',
            appId: c.appId,
            token: j.access_token,
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
      var c = g.Config.get();
      return postJson(c.portal.replace(/\/+$/, '') + '/sharing/rest/generateToken', {
        f: 'json',
        username: username,
        password: password,
        referer: location.origin,
        expiration: 20160
      }).then(function (j) {
        if (!j.token) throw new Error(j.messages ? j.messages.join(' ') : 'Sign-in failed');
        var a = { mode: 'password', token: j.token, expires: j.expires || (Date.now() + 3600000), username: username };
        return setAuth(a).then(function () { return a; });
      });
    },

    /** Paste-a-token escape hatch (testing, or tokens minted elsewhere). */
    setManualToken: function (tok, minutes) {
      var a = { mode: 'manual', token: tok.trim(), expires: Date.now() + (minutes || 120) * 60000, username: 'token' };
      return setAuth(a).then(function () { return a; });
    },

    signOut: function () { return g.Store.del(AUTH_KEY); },

    /* ─────────────────────── layer metadata ─────────────────── */

    layerMeta: function (force) {
      var url = g.Config.layerUrl();
      var key = META_KEY + ':' + url;
      return g.Store.get(key).then(function (cached) {
        if (!force && cached && Date.now() - cached.at < META_TTL) return cached.meta;
        return token().then(function (t) {
          return postJson(url, { f: 'json', token: t });
        }).then(function (meta) {
          return g.Store.set(key, { at: Date.now(), meta: meta }).then(function () { return meta; });
        }).catch(function (e) {
          if (cached) return cached.meta;          // offline: last known schema is fine
          throw e;
        });
      });
    },

    /** Resolve logical names (heading, lat, …) to real fields on this layer. */
    resolveFields: function (meta) {
      var want = g.Config.get().fields || {};
      var cand = g.Config.CANDIDATES;
      var byLower = {};
      (meta.fields || []).forEach(function (f) {
        if (f.editable === false || g.Config.RESERVED.test(f.name)) return;
        byLower[f.name.toLowerCase()] = f;
      });
      var map = {};
      Object.keys(cand).forEach(function (key) {
        var explicit = (want[key] || '').trim();
        if (explicit === '-') return;                                  // explicitly disabled
        if (explicit) {
          var f = byLower[explicit.toLowerCase()];
          if (f) map[key] = f;
          return;
        }
        for (var i = 0; i < cand[key].length; i++) {
          var hit = byLower[cand[key][i]];
          if (hit) { map[key] = hit; return; }
        }
      });
      // position source type is a fixed coded value on Esri GNSS schemas
      if (byLower.esrignss_positionsourcetype) map.positionSource = byLower.esrignss_positionsourcetype;
      return map;
    },

    /** Shape a queue item into an ArcGIS feature for this layer. */
    buildFeature: function (item, meta) {
      var map = Arc.resolveFields(meta);
      var attrs = {};

      function set(key, value) {
        var f = map[key];
        if (!f || value === null || value === undefined || (typeof value === 'number' && !isFinite(value))) return;
        var t = f.type;
        if (t === 'esriFieldTypeString') {
          var s = String(value);
          attrs[f.name] = f.length ? s.slice(0, f.length) : s;
        } else if (t === 'esriFieldTypeDate') {
          attrs[f.name] = typeof value === 'number' ? value : new Date(value).getTime();
        } else if (t === 'esriFieldTypeInteger' || t === 'esriFieldTypeSmallInteger' || t === 'esriFieldTypeOID') {
          attrs[f.name] = Math.round(Number(value));
        } else {
          attrs[f.name] = Number(value);
        }
      }

      set('heading', item.heading);
      set('lat', item.lat);
      set('lon', item.lon);
      set('altitude', item.alt);
      set('accuracy', item.hAcc);
      set('vaccuracy', item.vAcc);
      set('speed', item.speed === null || item.speed === undefined ? null : item.speed * 3.6); // m/s → km/h
      set('course', item.course);
      set('captured', item.createdAt);
      set('device', item.device);
      set('notes', item.notes);
      if (map.positionSource) attrs[map.positionSource.name] = 2;     // integrated system location provider

      return {
        geometry: { x: item.lon, y: item.lat, spatialReference: { wkid: 4326 } },
        attributes: attrs
      };
    },

    /* ───────────────────────── upload ───────────────────────── */

    addFeature: function (item) {
      var url = g.Config.layerUrl();
      return Promise.all([token(), Arc.layerMeta()]).then(function (r) {
        var t = r[0], meta = r[1];
        return postJson(url + '/addFeatures', {
          f: 'json',
          token: t,
          rollbackOnFailure: true,
          features: JSON.stringify([Arc.buildFeature(item, meta)])
        });
      }).then(function (j) {
        var res = (j.addResults || [])[0];
        if (!res || !res.success) {
          throw new Error((res && res.error && res.error.description) || 'addFeatures rejected the point');
        }
        return res.objectId;
      });
    },

    addAttachment: function (objectId, blob, name) {
      var url = g.Config.layerUrl();
      return token().then(function (t) {
        var fd = new FormData();
        fd.append('f', 'json');
        fd.append('token', t);
        fd.append('attachment', blob, name || 'photo.jpg');
        return postJson(url + '/' + objectId + '/addAttachment', fd);
      }).then(function (j) {
        var res = j.addAttachmentResult;
        if (!res || !res.success) {
          throw new Error((res && res.error && res.error.description) || 'Attachment rejected');
        }
        return res.objectId;
      });
    },

    /** Push one queued photo. Resumes at whichever half is still missing. */
    uploadItem: function (item) {
      var step = item.objectId ? Promise.resolve(item.objectId) : Arc.addFeature(item).then(function (oid) {
        return g.Store.patch(item.id, { objectId: oid }).then(function () { return oid; });
      });
      return step.then(function (oid) {
        if (item.attachmentId) return item.attachmentId;
        if (!item.blob) return null;                       // point-only record
        return Arc.addAttachment(oid, item.blob, 'photo_' + item.id.slice(0, 8) + '.jpg');
      }).then(function (aid) {
        // the photo is deliberately kept for a while after upload: it is the only
        // local copy, and the queue view can still hand it to the device
        return g.Store.patch(item.id, {
          state: 'sent', attachmentId: aid, sentAt: Date.now(), lastError: null
        });
      });
    },

    backoff: function (attempts) {
      return Math.min(30 * 60000, 15000 * Math.pow(2, Math.max(0, attempts - 1)));
    },

    /**
     * Drain the queue. `onEvent(type, payload)` reports progress so the UI (or
     * the service worker) can react. Resolves with a summary.
     */
    flush: function (onEvent, opts) {
      opts = opts || {};
      var ev = onEvent || function () {};
      var summary = { sent: 0, failed: 0, skipped: 0, needAuth: false, offline: false };

      return g.Config.load().then(g.Store.outstanding).then(function (items) {
        var due = items.filter(function (i) {
          return opts.force || !i.nextAttemptAt || i.nextAttemptAt <= Date.now();
        });
        summary.skipped = items.length - due.length;
        if (!due.length) return summary;

        return due.reduce(function (chain, item) {
          return chain.then(function () {
            if (summary.needAuth || summary.offline) return null;
            ev('start', item);
            return g.Store.patch(item.id, { state: 'uploading' }).then(function () {
              return g.Store.item(item.id);
            }).then(function (live) {
              return Arc.uploadItem(live || item);
            }).then(function () {
              summary.sent++;
              ev('sent', item);
            }).catch(function (e) {
              var attempts = (item.attempts || 0) + 1;
              if (e.needAuth) summary.needAuth = true;
              if (e.retryable) summary.offline = true;
              summary.failed++;
              return g.Store.patch(item.id, {
                state: e.needAuth || e.retryable ? 'pending' : 'error',
                attempts: attempts,
                lastError: e.message,
                nextAttemptAt: Date.now() + Arc.backoff(attempts)
              }).then(function () { ev('failed', item, e); });
            });
          });
        }, Promise.resolve()).then(function () { return summary; });
      });
    }
  };

  g.Arc = Arc;
})(typeof self !== 'undefined' ? self : this);
