/* Exotic Camera — problem reports.
   Writes a row to the ExoticCameraBugs table so field problems surface without
   anyone having to describe them. Shared with the service worker, so no `window`
   and no `document` at load time. */
(function (g) {
  'use strict';

  var MAX_LOG = 40;
  var log = [];                      // recent breadcrumbs, newest last

  function clip(s, n) {
    s = s === null || s === undefined ? '' : String(s);
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }

  var Report = {
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
        return g.Arc.token();
      }).then(function (t) {
        return fetch(Report.tableUrl() + '/addFeatures', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            f: 'json', token: t,
            features: JSON.stringify([{ attributes: attrs }])
          })
        });
      }).then(function (r) { return r.json(); }).then(function (j) {
        var res = j && j.addResults && j.addResults[0];
        return !!(res && res.success);
      }).catch(function () {
        return false;                 // offline or signed out: the report is simply lost
      });
    }
  };

  g.Report = Report;
})(typeof self !== 'undefined' ? self : this);
