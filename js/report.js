/* Exotic Camera — problem reports.
   Writes a row to the ExoticCameraBugs table so field problems surface without
   anyone having to describe them. Shared with the service worker, so no `window`
   and no `document` at load time. */
(function (g) {
  'use strict';

  var MAX_LOG = 40;
  var log = [];                      // recent breadcrumbs, newest last

  var HELD_KEY = 'reportQueue';      // reports that could not be sent yet
  var HELD_MAX = 20;
  var HELD_TRIES = 10;               // then give up, so nothing retries forever

  function clip(s, n) {
    s = s === null || s === undefined ? '' : String(s);
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }

  /**
   * Put one row in the table. Rejects with a message that says what actually
   * went wrong — a permission refusal and a dead connection are different
   * problems and the user is the one who has to act on the difference.
   */
  function post(attrs) {
    return g.Arc.token().then(function (t) {
      // never wait forever: a report is the thing you reach for when the network
      // is already misbehaving
      var ctl = typeof AbortController === 'function' ? new AbortController() : null;
      var timer = setTimeout(function () { if (ctl) ctl.abort(); }, 30000);
      return fetch(Report.tableUrl() + '/addFeatures', {
        method: 'POST',
        signal: ctl ? ctl.signal : undefined,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          f: 'json', token: t,
          features: JSON.stringify([{ attributes: attrs }])
        })
      }).then(function (r) { clearTimeout(timer); return r; }, function () {
        clearTimeout(timer);
        throw new Error('the server could not be reached');
      });
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status + ' from the report table');
      return r.json().catch(function () { throw new Error('the report table did not answer with JSON'); });
    }).then(function (j) {
      if (j && j.error) {
        throw new Error((j.error.message || 'error ' + j.error.code) +
          (j.error.details && j.error.details.length ? ' — ' + j.error.details.join('; ') : ''));
      }
      var res = j && j.addResults && j.addResults[0];
      if (!res || !res.success) {
        throw new Error((res && res.error && res.error.description) || 'the report table refused the row');
      }
      return true;
    });
  }

  /* A report that cannot go now is kept, not binned: the moment something is
     wrong is exactly the moment the connection or the token is likely to be
     wrong too, and a report that only exists while the app is healthy is no
     use at all. Bounded in both directions so it can never grow unattended. */
  function hold(attrs) {
    return g.Store.get(HELD_KEY).then(function (held) {
      held = (held || []).filter(function (h) { return h && h.attrs; });
      held.push({ attrs: attrs, tries: 0 });
      while (held.length > HELD_MAX) held.shift();
      return g.Store.set(HELD_KEY, held);
    }).catch(function () { /* storage is failing too; the report is simply lost */ });
  }

  var Report = {
    /** Why the last send failed, for the UI to show. Null once one succeeds. */
    lastFailure: null,

    /** Remember something interesting. Kept in memory only until a report is sent. */
    note: function (what, extra) {
      log.push({
        t: new Date().toISOString().slice(11, 19),
        m: clip(what, 300),
        x: extra === undefined ? undefined : clip(typeof extra === 'string' ? extra : JSON.stringify(extra), 300)
      });
      if (log.length > MAX_LOG) log.shift();
    },

    breadcrumbs: function () { return log.slice(); },

    tableUrl: function () {
      var c = g.Config.get();
      return String(c.bugsUrl).replace(/\/+$/, '') + '/' + (c.bugsLayerId | 0);
    },

    /**
     * Send one report. `ctx` carries whatever the caller knows:
     *   kind, summary, note, details, sensors, queued, queueErrors, online, lat, lon
     * Never throws — a failing bug report must not become a second problem.
     */
    send: function (ctx) {
      ctx = ctx || {};
      if (!g.Config.get().reportProblems && ctx.kind !== 'manual') return Promise.resolve(false);

      var details = {
        breadcrumbs: log.slice(-MAX_LOG),
        stack: ctx.stack || null,
        extra: ctx.extra || null
      };

      var attrs = {
        reported: Date.now(),
        kind: clip(ctx.kind || 'manual', 32),
        summary: clip(ctx.summary || 'No summary', 512),
        note: clip(ctx.note || '', 1000),
        details: clip(JSON.stringify(details), 4000),
        appbuild: clip(g.Config.BUILD, 64),
        layername: clip(g.Config.layerName() + ' · ' + g.Config.layerUrl(), 128),
        device: clip(ctx.device || '', 400),
        sensors: clip(ctx.sensors || '', 256),
        queued: ctx.queued === undefined ? null : ctx.queued | 0,
        queueerrors: ctx.queueErrors === undefined ? null : ctx.queueErrors | 0,
        online: ctx.online === undefined ? null : (ctx.online ? 1 : 0),
        applat: typeof ctx.lat === 'number' ? ctx.lat : null,
        applon: typeof ctx.lon === 'number' ? ctx.lon : null
      };

      return g.Arc.getAuth().then(function (a) {
        if (a && a.username) attrs.username = clip(a.username, 128);
      }).catch(function () { /* no auth record: send it anonymously and find out why */ })
        .then(function () { return post(attrs); })
        .then(function () {
          Report.lastFailure = null;
          return true;
        }).catch(function (e) {
          Report.lastFailure = (e && e.message) || 'unknown error';
          return hold(attrs).then(function () { return false; });
        });
    },

    /**
     * Push anything that was held back. Safe to call often and from anywhere —
     * it never throws, and it stops at the first failure rather than hammering
     * a table that has just refused one.
     */
    flushHeld: function () {
      return g.Store.get(HELD_KEY).then(function (held) {
        held = (held || []).filter(function (h) { return h && h.attrs; });
        if (!held.length) return 0;
        var sent = 0, stopped = false;
        return held.reduce(function (chain, h) {
          return chain.then(function (keep) {
            var tries = (h.tries || 0) + 1;
            // one failure is enough to know the rest will fail the same way
            if (stopped) return keep.concat([h]);
            return post(h.attrs).then(function () {
              sent++;
              return keep;                              // sent: drop it from the list
            }).catch(function (e) {
              Report.lastFailure = (e && e.message) || 'unknown error';
              stopped = true;
              return tries >= HELD_TRIES ? keep : keep.concat([{ attrs: h.attrs, tries: tries }]);
            });
          });
        }, Promise.resolve([])).then(function (keep) {
          if (sent) Report.lastFailure = null;
          return g.Store.set(HELD_KEY, keep).then(function () { return sent; });
        });
      }).catch(function () { return 0; });
    },

    heldCount: function () {
      return g.Store.get(HELD_KEY).then(function (h) { return (h || []).length; }).catch(function () { return 0; });
    }
  };

  g.Report = Report;
})(typeof self !== 'undefined' ? self : this);
