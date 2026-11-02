/* Photo Points — stations, the visit camera, and the upload loop.

   A visit is shot as a set of slots (N/E/S/W at eye level, the same four for
   groundcover, the locator, misc). For each directional slot the camera shows
   the bearing to face — the last visit's own bearing when there is one, so
   repeat photos line up — and how far off you are, plus a level. Photos are
   saved at the camera's full resolution with their bearing in the EXIF and
   in the file name, kept on the phone, and uploaded one at a time in chunks
   once the visit is done. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  // Reporting and sound are niceties; the camera is not. Carry on without them.
  if (typeof Report === 'undefined') {
    self.Report = { note: function () {}, breadcrumbs: function () { return []; },
                    send: function () { return Promise.resolve(false); }, flushHeld: function () { return Promise.resolve(0); } };
  }
  if (typeof Sound === 'undefined') {
    self.Sound = new Proxy({}, { get: function () { return function () {}; } });
  }

  var state = {
    view: 'home',
    stations: [], stats: {}, stationsAt: 0, stale: false,
    pos: null, posAt: 0, gpsError: null, gpsDenied: false,
    mag: null, heading: null, pitch: null, roll: null, accuracy: null, settled: false,
    online: navigator.onLine, flushing: false,
    counts: { outstanding: 0, errors: 0, drafts: 0, photos: 0, visits: 0, edits: 0, bytes: 0 },
    auth: null,
    visit: null, shots: [], slot: 'N', target: null, ghost: null, busy: false,
    stream: null,
    meta: { stations: null, visits: null },
    progress: {},
    sheetStation: null
  };

  /* ───────────────────────────── basics ───────────────────────────── */

  function toast(msg, kind, ms) {
    var live = $('toasts').lastElementChild;
    if (live && live.dataset.msg === msg) {
      clearTimeout(+live.dataset.t);
      live.dataset.t = setTimeout(function () { live.classList.remove('in'); setTimeout(function () { live.remove(); }, 300); }, ms || 2600);
      return;
    }
    var el = document.createElement('div');
    el.dataset.msg = msg;
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.textContent = msg;
    $('toasts').appendChild(el);
    requestAnimationFrame(function () { el.classList.add('in'); });
    el.dataset.t = setTimeout(function () {
      el.classList.remove('in');
      setTimeout(function () { el.remove(); }, 300);
    }, ms || 2600);
  }

  function esc(v) {
    return String(v === null || v === undefined ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function errText(e) { return Arc.asError(e).message; }

  function buildLabel() {
    return /^__/.test(Config.BUILD) ? 'branch deploy (unstamped)' : Config.BUILD;
  }

  function buzz(pattern) {
    if (!Config.get().haptics || !navigator.vibrate) return;
    try { navigator.vibrate(pattern); } catch (e) { /* not fatal */ }
  }

  function pad(n, w) { return String(n).padStart(w || 2, '0'); }
  function wrap180(a) { a = ((a + 180) % 360 + 360) % 360; return a - 180; }
  function norm360(a) { return ((a % 360) + 360) % 360; }
  function round1(v) { return v === null || v === undefined || isNaN(v) ? null : Math.round(v * 10) / 10; }
  function card(h) { return self.Compass ? Compass.card(h) : ''; }

  function fmtDate(ms) {
    if (!ms) return '';
    var d = new Date(ms);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function fmtDist(m) {
    if (m === null || m === undefined) return '';
    if (m < 1000) return Math.round(m) + ' m';
    return (m / 1000).toFixed(m < 10000 ? 1 : 0) + ' km';
  }

  function fmtBytes(b) {
    if (!b) return '0 MB';
    return b < 1048576 ? Math.round(b / 1024) + ' KB' : (b / 1048576).toFixed(1) + ' MB';
  }

  var R_EARTH = 6371008.8;
  function distance(lat1, lon1, lat2, lon2) {
    var D = Math.PI / 180;
    var dLat = (lat2 - lat1) * D, dLon = (lon2 - lon1) * D;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * D) * Math.cos(lat2 * D) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(a)));
  }
  /** True bearing from one point to another. */
  function bearingTo(lat1, lon1, lat2, lon2) {
    var D = Math.PI / 180;
    var y = Math.sin((lon2 - lon1) * D) * Math.cos(lat2 * D);
    var x = Math.cos(lat1 * D) * Math.sin(lat2 * D) - Math.sin(lat1 * D) * Math.cos(lat2 * D) * Math.cos((lon2 - lon1) * D);
    return norm360(Math.atan2(y, x) / D);
  }

  function devicePlatform() {
    var m = navigator.userAgent.match(/\((?:Linux; )?(?:U; )?([^;)]+)/);
    return (m ? m[1] : 'web').trim();
  }

  function isIOS() {
    return /iP(hone|ad|od)/.test(navigator.platform || '') ||
           (/Mac/.test(navigator.userAgent) && 'ontouchend' in document);
  }

  function isStandalone() {
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
  }

  /* ───────────────────────────── compass ──────────────────────────── */

  /* The bearing maths is ../js/compass.js, shared with Exotic Camera: the
     attitude as a whole rotation (no Euler-angle jumps when the phone is
     upright), iOS's compass reading used only to learn where north is, and a
     lens aimed at the ground reading the direction of the top of the photo. */
  var tracker = self.Compass ? Compass.create() : null;
  var gotOrientation = false, listening = false, compassArmed = false, compassPending = null;
  var compassDenied = false, headingHopeless = false, headingWaiters = [];

  function screenAngle() {
    var o = screen.orientation;
    return o && typeof o.angle === 'number' ? o.angle : (window.orientation || 0);
  }

  function onOrientation(e) {
    if (!tracker) return;
    var r = tracker.update(e, screenAngle(), e.timeStamp || performance.now());
    if (!r) return;
    state.pitch = r.pitch;
    state.roll = r.roll;
    state.settled = r.settled;
    state.accuracy = r.accuracy;
    if (r.heading !== null) {
      gotOrientation = true;
      compassDenied = headingHopeless = false;
      // a touch of smoothing for the display only; the gyro is already steady
      state.mag = state.mag === null ? r.heading : norm360(state.mag + wrap180(r.heading - state.mag) * 0.35);
      state.heading = Config.reference(state.mag);
      while (headingWaiters.length) headingWaiters.pop()(false);
    }
    scheduleRender();
  }

  function firstHeading(ms) {
    if (gotOrientation || !listening || compassDenied || headingHopeless) return Promise.resolve();
    return new Promise(function (res) {
      var done = false;
      var fin = function (timedOut) {
        if (done) return;
        done = true;
        if (timedOut === true) headingHopeless = true;
        res();
      };
      headingWaiters.push(fin);
      setTimeout(function () { fin(true); }, ms);
    });
  }

  function listenOrientation(warnIfSilent) {
    if (!listening) {
      listening = true;
      window.addEventListener('deviceorientationabsolute', onOrientation, true);
      window.addEventListener('deviceorientation', onOrientation, true);
    }
    if (warnIfSilent) {
      setTimeout(function () {
        if (!gotOrientation) toast('No compass data — check Settings → Safari → Motion & Orientation Access', 'warn', 7000);
      }, 5000);
    }
  }

  function needsGesture() {
    var DOE = window.DeviceOrientationEvent;
    return !!DOE && typeof DOE.requestPermission === 'function';
  }

  function startCompass() {
    var DOE = window.DeviceOrientationEvent;
    if (!DOE) { toast('No compass on this device', 'warn'); return Promise.resolve(false); }
    if (!needsGesture()) { listenOrientation(true); return Promise.resolve(true); }
    if (compassPending) return compassPending;
    var p;
    try { p = DOE.requestPermission(); } catch (e) { return Promise.resolve(false); }
    compassPending = Promise.resolve(p).then(function (r) {
      compassPending = null;
      if (r === 'granted') { listenOrientation(true); return true; }
      compassDenied = true;
      toast('Compass blocked — tap the compass to ask again', 'warn', 5000);
      return 'denied';
    }).catch(function () {
      compassPending = null;
      return false;
    });
    return compassPending;
  }

  /* iOS hands out compass data only after asking, and only from a tap: ask on
     the first touch anywhere (touchend/click — Safari ignores pointerdown). */
  function armCompass() {
    if (compassArmed || !needsGesture()) return;
    compassArmed = true;
    var unarm = function () {
      compassArmed = false;
      document.removeEventListener('touchend', fire, true);
      document.removeEventListener('click', fire, true);
    };
    var fire = function () {
      if (gotOrientation) return unarm();
      startCompass().then(function (r) { if (r === true || r === 'denied') unarm(); });
    };
    document.addEventListener('touchend', fire, true);
    document.addEventListener('click', fire, true);
  }

  /* ── drawing it ─────────────────────────────────────────────── */

  var CARDS = [[0, 'N', '#ff6b6b', 20], [90, 'E', '#e6edf7', 17], [180, 'S', '#e6edf7', 17], [270, 'W', '#e6edf7', 17]];

  function buildDial() {
    var parts = [];
    for (var d = 0; d < 360; d += 5) {
      var major = d % 30 === 0, mid = d % 15 === 0;
      var len = major ? 14 : mid ? 9 : 5;
      parts.push('<line x1="100" y1="11" x2="100" y2="' + (11 + len) + '" stroke="' + (major ? '#e6edf7' : '#61708c') +
        '" stroke-width="' + (major ? 2.4 : 1.2) + '" transform="rotate(' + d + ' 100 100)"/>');
    }
    parts.push('<path d="M100 32 l8 68 -16 0 z" fill="#ff6b6b"/>');
    parts.push('<path d="M100 168 l8 -68 -16 0 z" fill="#7f8ea8"/>');
    parts.push('<circle cx="100" cy="100" r="46" fill="#111826" stroke="#3d4a63" stroke-width="2"/>');
    $('dial').innerHTML = parts.join('');
    $('labels').innerHTML = CARDS.map(function (c) {
      return '<g class="lbl"><text x="100" y="41" text-anchor="middle" font-size="' + c[3] +
        '" font-weight="700" fill="' + c[2] + '">' + c[1] + '</text></g>';
    }).join('');
    placeLabels(0);
  }

  function placeLabels(h) {
    var els = $('labels').children;
    for (var i = 0; i < els.length; i++) {
      var a = CARDS[i][0] - h;
      els[i].setAttribute('transform', 'rotate(' + a + ' 100 100)');
      els[i].firstChild.setAttribute('transform', 'rotate(' + (-a) + ' 100 35)');
    }
  }

  var renderQueued = false, lastListRender = 0;
  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(function () {
      renderQueued = false;
      if (state.view === 'cam') { renderCompass(); renderAim(); }
      else if (Date.now() - lastListRender > 120) { lastListRender = Date.now(); renderArrows(); }
    });
  }

  function renderCompass() {
    var h = state.heading;
    var comp = $('compass');
    if (h === null) {
      $('heading-deg').textContent = '---';
      $('heading-card').textContent = '';
      comp.classList.add('stale');
      return;
    }
    comp.classList.remove('stale');
    // The dial needs the bearing the needle points at; with true north selected
    // the card is turned so that its N is true north.
    // CSS transform, not the SVG attribute: the stylesheet's transform-origin
    // applies to both, and with the attribute's own centre it rotated twice
    // about different points
    $('dial').style.transform = 'rotate(' + (-h) + 'deg)';
    placeLabels(h);
    $('heading-deg').textContent = pad(Math.round(norm360(h)) % 360, 3);
    $('heading-ref').textContent = Config.ref();
    $('heading-card').textContent = card(h);
    comp.classList.toggle('unsure', !state.settled || (state.accuracy !== null && state.accuracy > 25));
    renderCal();
  }

  var lastCal = '';
  function renderCal() {
    var chip = $('chip-cal');
    var txt, cls;
    if (state.heading === null) { txt = gotOrientation ? 'compass…' : 'compass off'; cls = 'bad'; }
    else if (state.accuracy !== null && state.accuracy > 25) { txt = 'compass ±' + Math.round(state.accuracy) + '°'; cls = 'warn'; }
    else if (!state.settled) { txt = 'compass settling'; cls = 'warn'; }
    else { txt = 'compass ✓'; cls = 'ok'; }
    if (txt + cls === lastCal) return;
    lastCal = txt + cls;
    chip.textContent = txt;
    chip.className = 'chip ' + cls;
  }

  /* ───────────────────────────── location ─────────────────────────── */

  function fixAge() { return state.posAt ? Date.now() - state.posAt : Infinity; }

  function ago(ms) {
    var s = Math.round(ms / 1000);
    return s < 60 ? s + 's' : s < 3600 ? Math.round(s / 60) + 'm' : Math.round(s / 3600) + 'h';
  }

  function renderGPS() {
    var chip = $('chip-gps');
    var label = chip.querySelector('.label');
    if (state.gpsDenied) { chip.className = 'chip bad'; label.textContent = 'denied'; return; }
    if (!state.pos) { chip.className = 'chip bad'; label.textContent = state.gpsError ? 'searching' : 'no fix'; return; }
    var acc = state.pos.coords.accuracy, age = fixAge();
    label.textContent = (acc ? '±' + Math.round(acc) + 'm' : '--') + (age > 45000 ? ' · ' + ago(age) : '');
    chip.className = 'chip ' + (age > 180000 ? 'bad' : age > 45000 || acc > 30 ? 'warn' : acc <= 10 ? 'ok' : 'warn');
  }

  var lastSortAt = 0, lastSortPos = null;
  function startGPS() {
    if (!navigator.geolocation) { toast('No GPS on this device', 'warn'); return; }
    setInterval(renderGPS, 5000);
    navigator.geolocation.watchPosition(function (p) {
      state.pos = p;
      state.posAt = Date.now();
      state.gpsError = null;
      state.gpsDenied = false;
      renderGPS();
      // re-sort the list now and then as you walk, not on every fix
      var moved = lastSortPos ? distance(lastSortPos.latitude, lastSortPos.longitude, p.coords.latitude, p.coords.longitude) : Infinity;
      if (state.view === 'home' && (moved > 25 || Date.now() - lastSortAt > 30000)) {
        lastSortAt = Date.now();
        lastSortPos = p.coords;
        renderStations();
      } else {
        scheduleRender();
      }
      if (sheetOpen('station-panel')) renderStationGuide();
    }, function (err) {
      state.gpsError = err.code;
      if (err.code === err.PERMISSION_DENIED) {
        state.gpsDenied = true;
        state.pos = null;
        toast('Location permission denied — distances and photo positions need it', 'bad', 4000);
      }
      renderGPS();
    }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 60000 });
  }

  /** The position to stamp on a photo: a recent fix, or failing that the station itself. */
  function photoPosition() {
    if (state.pos && fixAge() < 120000) {
      var c = state.pos.coords;
      return { lat: c.latitude, lon: c.longitude, alt: c.altitude, hAcc: c.accuracy, source: 'gps' };
    }
    var v = state.visit;
    return { lat: v.stationLat, lon: v.stationLon, alt: null, hAcc: null, source: 'station' };
  }

  /* ───────────────────────────── stations ─────────────────────────── */

  function findStation(gid) {
    for (var i = 0; i < state.stations.length; i++) if (state.stations[i].gid === gid) return state.stations[i];
    return null;
  }

  /** Station adds and changes still on the phone show as if they were already up. */
  function mergeLocalEdits() {
    return Store.edits().then(function (edits) {
      edits.forEach(function (e) {
        var s = findStation(e.globalId);
        if (e.kind === 'add' && !s) {
          state.stations.push({
            gid: e.globalId, oid: null, id: e.attrs.StationID, site: e.attrs.SiteName || '', mu: e.attrs.MgmtUnit || '',
            habitat: '', postInstalled: e.attrs.PostInstalled || '', postType: e.attrs.PostType || '', postTag: '',
            installDate: e.attrs.InstallDate || null, status: e.attrs.StationStatus || '', notes: e.attrs.Notes || '',
            lat: e.lat, lon: e.lon, pending: true
          });
        } else if (s) {
          applyStationAttrs(s, e.attrs);
          s.pending = true;
        }
      });
    });
  }

  function applyStationAttrs(s, a) {
    if ('PostInstalled' in a) s.postInstalled = a.PostInstalled;
    if ('PostType' in a) s.postType = a.PostType;
    if ('PostTag' in a) s.postTag = a.PostTag;
    if ('InstallDate' in a) s.installDate = a.InstallDate;
    if ('StationStatus' in a) s.status = a.StationStatus;
    if ('Notes' in a) s.notes = a.Notes;
    if ('StationID' in a) s.id = a.StationID;
    if ('SiteName' in a) s.site = a.SiteName;
    if ('MgmtUnit' in a) s.mu = a.MgmtUnit;
  }

  function useStations(rec) {
    state.stations = (rec && rec.list || []).slice();
    state.stats = (rec && rec.stats) || {};
    state.stationsAt = rec ? rec.at : 0;
    state.stale = !!(rec && rec.stale);
    return mergeLocalEdits().then(renderStations);
  }

  /** Resolves true when the list came fresh from the service. */
  function loadStations(force) {
    $('refresh-btn').classList.add('busy');
    var fresh = false;
    return Arc.stations(force).then(function (rec) {
      fresh = !rec.stale;
      if (rec.stale && force) toast('Offline — showing the stations saved ' + ago(Date.now() - rec.at) + ' ago', 'warn', 3500);
      return useStations(rec);
    }).then(function () {
      return refreshMeta();
    }).catch(function (e) {
      e = Arc.asError(e);
      if (e.needAuth) {
        $('signin-nudge').classList.remove('hidden');
        if (force) toast('Sign in to load the stations', 'warn', 3500);
      } else toast('Could not load stations: ' + e.message, 'bad', 4000);
      renderStations();
    }).then(function () {
      $('refresh-btn').classList.remove('busy');
      return fresh;
    });
  }

  /** Layer schemas, for the drop-down lists. Cached, so they work offline. */
  function refreshMeta() {
    return Promise.all([
      Arc.layerMeta(Config.stationsUrl()).catch(function () { return null; }),
      Arc.layerMeta(Config.visitsUrl()).catch(function () { return null; })
    ]).then(function (r) {
      if (r[0]) state.meta.stations = r[0];
      if (r[1]) state.meta.visits = r[1];
    });
  }

  // used until the layer's own domains have been read once
  var FALLBACK = {
    PostCondition: ['Good', 'Leaning / bent', 'Damaged', 'Missing - replaced', 'Missing - not replaced'],
    PostType: ['Rebar', 'T-post', 'PVC', 'Wood stake', 'Other'],
    StationStatus: ['Active', 'Damaged', 'Missing', 'Retired']
  };

  function options(meta, field) {
    var cv = meta ? Arc.domain(meta, field) : [];
    if (cv.length) return cv.map(function (c) { return { code: c.code, name: c.name }; });
    return (FALLBACK[field] || []).map(function (v) { return { code: v, name: v }; });
  }

  function fillSelect(el, opts, value, blank) {
    el.innerHTML = (blank ? '<option value="">' + esc(blank) + '</option>' : '') + opts.map(function (o) {
      return '<option value="' + esc(o.code) + '"' + (String(o.code) === String(value) ? ' selected' : '') + '>' + esc(o.name) + '</option>';
    }).join('');
  }

  function stationDistance(s) {
    if (!state.pos || s.lat === null || s.lon === null) return null;
    return distance(state.pos.coords.latitude, state.pos.coords.longitude, s.lat, s.lon);
  }

  function lastVisit(s) {
    var st = state.stats[s.gid];
    return st && st.last ? st.last : null;
  }

  var rows = {};
  var drafts = {};

  function renderStations() {
    var q = $('search').value.trim().toLowerCase();
    var list = state.stations.filter(function (s) {
      if (!q) return true;
      return (s.id + ' ' + s.site + ' ' + s.mu + ' ' + s.habitat).toLowerCase().indexOf(q) !== -1;
    });
    list.forEach(function (s) { s._d = stationDistance(s); });
    list.sort(function (a, b) {
      if (a._d !== null && b._d !== null) return a._d - b._d;
      if (a._d !== null) return -1;
      if (b._d !== null) return 1;
      return String(a.id).localeCompare(String(b.id), undefined, { numeric: true });
    });

    var status = '';
    if (!state.stations.length) status = state.auth ? 'No stations loaded yet.' : '';
    else {
      status = list.length + ' station' + (list.length === 1 ? '' : 's') + (q ? ' matching' : '') +
        (state.pos ? ', nearest first' : ' — waiting for GPS to sort by distance');
      if (state.stale) status += ' · offline copy from ' + ago(Date.now() - state.stationsAt) + ' ago';
    }
    $('list-status').textContent = status;
    $('list-status').className = 'hint';

    rows = {};
    $('station-list').innerHTML = list.map(function (s) {
      var lv = lastVisit(s);
      var bits = [];
      bits.push(lv ? 'Last visit ' + fmtDate(lv) : 'Not visited in this app yet');
      var tags = '';
      if (s.postInstalled !== 'Yes') tags += '<span class="tag nopost">no post</span>';
      if (drafts[s.gid]) tags += '<span class="tag draft">in progress</span>';
      if (s.pending) tags += '<span class="tag">not uploaded</span>';
      return '<button class="st' + (s.pending ? ' pending' : '') + '" role="listitem" data-gid="' + esc(s.gid) + '">' +
        '<div class="st-arrow"><svg viewBox="0 0 40 40" aria-hidden="true"><path d="M20 3 L30 33 L20 26 L10 33 Z"/></svg>' +
        '<span class="st-dist">' + esc(s._d === null ? '' : fmtDist(s._d)) + '</span></div>' +
        '<div class="st-main"><b>' + esc(s.id) + tags + '</b>' +
        '<span>' + esc([s.site, s.mu].filter(Boolean).join(' · ') || '—') + '</span>' +
        '<em>' + esc(bits.join(' · ')) + '</em></div></button>';
    }).join('');
    Array.prototype.forEach.call($('station-list').querySelectorAll('.st'), function (el) {
      rows[el.dataset.gid] = { arrow: el.querySelector('.st-arrow'), svg: el.querySelector('svg') };
      el.addEventListener('click', function () { openStation(el.dataset.gid); });
    });
    renderArrows();
  }

  /** Point each row's arrow at its station, relative to where the phone is facing. */
  function renderArrows() {
    if (!state.pos) return;
    var p = state.pos.coords;
    var facing = state.mag === null ? null : norm360(state.mag + (+Config.get().declination || 0));   // true
    state.stations.forEach(function (s) {
      var r = rows[s.gid];
      if (!r || s.lat === null) return;
      var b = bearingTo(p.latitude, p.longitude, s.lat, s.lon);
      var d = s._d === undefined || s._d === null ? stationDistance(s) : s._d;
      r.svg.style.transform = 'rotate(' + (facing === null ? b : b - facing) + 'deg)';
      r.arrow.classList.toggle('here', d !== null && d < Math.max(8, p.accuracy || 0));
    });
  }

  function renderDrafts() {
    return Store.visits().then(function (vs) {
      drafts = {};
      var open = vs.filter(function (v) { return v.state === 'draft'; });
      open.forEach(function (v) { drafts[v.stationGid] = v; });
      $('drafts').innerHTML = open.map(function (v) {
        return '<div class="draft-banner"><span><b>' + esc(v.stationId) + '</b> — visit in progress (' +
          esc(fmtDate(v.createdAt)) + ')</span><div class="row"><button class="btn small" data-resume="' + v.id +
          '">Resume</button></div></div>';
      }).join('');
      Array.prototype.forEach.call($('drafts').querySelectorAll('[data-resume]'), function (b) {
        b.addEventListener('click', function () {
          Store.visit(b.dataset.resume).then(function (v) { if (v) enterCamera(v); });
        });
      });
    });
  }

  /* ── one station ─────────────────────────────────────────────── */

  function openStation(gid) {
    var s = findStation(gid);
    if (!s) return;
    state.sheetStation = s;
    $('sp-title').textContent = s.id;
    var lv = lastVisit(s);
    var facts = [
      ['Site', s.site], ['Unit', s.mu], ['Habitat', s.habitat],
      ['Post', s.postInstalled === 'Yes' ? 'Installed' + (s.postType ? ' · ' + s.postType : '') + (s.postTag ? ' · ' + s.postTag : '') : 'No post'],
      ['Installed', s.installDate ? fmtDate(s.installDate) : ''],
      ['Status', s.status], ['Last visit', lv ? fmtDate(lv) + ((state.stats[gid] || {}).count > 1 ? ' (' + state.stats[gid].count + ' visits)' : '') : ''],
      ['Notes', s.notes]
    ].filter(function (f) { return f[1]; });
    $('sp-facts').innerHTML = facts.map(function (f) { return '<dt>' + esc(f[0]) + '</dt><dd>' + esc(f[1]) + '</dd>'; }).join('');
    $('sp-start').textContent = drafts[gid] ? 'Resume visit' : 'Start visit';
    var maps = isIOS() ? 'https://maps.apple.com/?daddr=' + s.lat + ',' + s.lon + '&dirflg=w'
      : 'https://www.google.com/maps/dir/?api=1&destination=' + s.lat + ',' + s.lon + '&travelmode=walking';
    $('sp-maps').href = maps;
    $('sp-maps').classList.toggle('hidden', s.lat === null);
    renderStationGuide();
    renderGhostNote(s);
    openSheet('station-panel');
    // pick up the last visit's photos while there is signal, for lining up the new ones
    if (state.online && state.auth && lv && !s.pending) {
      Arc.fetchGhosts(gid).then(function () { renderGhostNote(s); }).catch(function () { /* offline: fine */ });
    }
  }

  function renderStationGuide() {
    var s = state.sheetStation;
    if (!s) return;
    if (!state.pos || s.lat === null) {
      $('sp-dist').textContent = state.pos ? '—' : 'No GPS fix';
      $('sp-dir').textContent = '';
      return;
    }
    var p = state.pos.coords;
    var d = distance(p.latitude, p.longitude, s.lat, s.lon);
    var b = bearingTo(p.latitude, p.longitude, s.lat, s.lon);
    var facing = state.mag === null ? null : norm360(state.mag + (+Config.get().declination || 0));
    $('sp-arrow').style.transform = 'rotate(' + (facing === null ? b : b - facing) + 'deg)';
    $('sp-dist').textContent = fmtDist(d);
    $('sp-dir').textContent = (d < Math.max(8, p.accuracy) ? 'You are here · ' : card(b) + ' · ' + Math.round(b) + '°T · ') +
      'GPS ±' + Math.round(p.accuracy) + ' m' + (facing === null ? ' · arrow points north-up' : '');
  }

  function renderGhostNote(s) {
    return Store.ghostKeys().then(function (keys) {
      var n = keys.filter(function (k) { return k.indexOf(s.gid + '|') === 0; }).length;
      $('sp-ghost').textContent = n
        ? n + ' photo' + (n === 1 ? '' : 's') + ' from the last visit on this phone — shown over the camera to line up the new ones.'
        : lastVisit(s) ? 'Open this station once with signal to bring the last visit\'s photos onto the phone.' : '';
    });
  }

  /* ───────────────────────────── visit ────────────────────────────── */

  function startVisit(s) {
    return Store.visits().then(function (vs) {
      var d = vs.filter(function (v) { return v.state === 'draft' && v.stationGid === s.gid; })[0];
      if (d) return d;
      var c = Config.get();
      return Store.putVisit({
        id: Store.uuid(), globalId: Store.guid(),
        stationGid: s.gid, stationId: s.id, stationSite: s.site, stationLat: s.lat, stationLon: s.lon,
        postWas: s.postInstalled || '',
        createdAt: Date.now(), state: 'draft',
        attrs: { VisitDate: Date.now(), Observer: c.observer || '', MonitoringEvent: c.monitoringEvent || '', PostCondition: null, Notes: '' }
      });
    }).then(function (v) {
      Report.note('visit started', v.stationId);
      return enterCamera(v);
    });
  }

  function enterCamera(v) {
    closeSheets();
    state.visit = v;
    return Store.shotsOf(v.id).then(function (shots) {
      state.shots = shots;
      setView('cam');
      $('cam-station').textContent = v.stationId;
      renderSlots();
      selectSlot(nextEmpty(null) || 'N');
      renderReviewThumb();
      startCamera();
      if (needsGesture() && !gotOrientation) startCompass();      // entering was a tap: a valid moment to ask
      return Arc.getAuth();
    });
  }

  function leaveCamera() {
    closeSheets(true);                         // the details sheet is usually still up
    stopCamera();
    state.visit = null;
    state.ghost = null;
    setView('home');
    return renderDrafts().then(renderStations);
  }

  function setView(v) {
    state.view = v;
    document.body.classList.toggle('view-home', v === 'home');
    document.body.classList.toggle('view-cam', v === 'cam');
    window.scrollTo(0, 0);
  }

  function shotsIn(slot) { return state.shots.filter(function (s) { return s.slot === slot; }); }

  /** The next slot with no photo yet, after `from`, eye level then groundcover then the post. */
  function nextEmpty(from) {
    var keys = Config.SLOTS.map(function (s) { return s.key; }).filter(function (k) { return k !== 'MISC'; });
    var start = from ? keys.indexOf(from) + 1 : 0;
    for (var i = 0; i < keys.length; i++) {
      var k = keys[(start + i) % keys.length];
      if (!shotsIn(k).length) return k;
    }
    return null;
  }

  function slotButton(sl) {
    var n = shotsIn(sl.key).length;
    return '<button class="slot' + (sl.group === 'low' ? ' low' : '') + (n ? ' has' : '') +
      (sl.key === state.slot ? ' on' : '') + '" data-slot="' + sl.key + '" role="tab" aria-selected="' +
      (sl.key === state.slot) + '" aria-label="' + esc(sl.label) + (n ? ', ' + n + ' photo' + (n === 1 ? '' : 's') : '') +
      '">' + esc(sl.short) + '<i>' + (n || '') + '</i></button>';
  }

  /** Two rows — eye level, then groundcover — each with its extra slot at the end. */
  function renderSlots() {
    var by = function (g) { return Config.SLOTS.filter(function (s) { return s.group === g; }); };
    var other = by('other');
    var row = function (label, slots, extra) {
      return '<div class="slot-row"><span class="slot-lbl">' + label + '</span>' + slots.map(slotButton).join('') +
        (extra ? '<span class="slot-gap"></span>' + slotButton(extra) : '') + '</div>';
    };
    $('slots').innerHTML = row('Eye', by('eye'), other[0]) + row('Ground', by('low'), other[1]);
    Array.prototype.forEach.call($('slots').querySelectorAll('.slot'), function (b) {
      b.addEventListener('click', function () { Sound.tick(); selectSlot(b.dataset.slot); });
    });
  }

  function selectSlot(key) {
    state.slot = key;
    var sl = Config.slot(key);
    Array.prototype.forEach.call($('slots').querySelectorAll('.slot'), function (b) {
      var on = b.dataset.slot === key;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', on);
    });
    $('cam-slot').textContent = sl.label + (sl.group === 'low' ? ' — hold low, aim at the ground' : '');
    state.ghost = null;
    updateTarget();
    loadGhost();
  }

  /** What to face for this slot: the last visit's bearing if it is known, otherwise the cardinal one. */
  function updateTarget() {
    var sl = Config.slot(state.slot);
    var t = null;
    if (sl && sl.bearing !== null) {
      t = { deg: sl.bearing, from: sl.label.replace('Groundcover · ', '') };
      var g = state.ghost && state.ghost.bearing;
      if (g) {
        var deg = g.deg, decl = +Config.get().declination || 0;
        if (g.ref === 'M' && Config.ref() === 'T') deg += decl;
        if (g.ref === 'T' && Config.ref() === 'M') deg -= decl;
        // only trust it if it is plausibly the same direction
        if (Math.abs(wrap180(deg - sl.bearing)) <= 45) t = { deg: norm360(deg), from: 'last visit' };
      }
    }
    state.target = t;
    $('cam-target').textContent = t ? 'face ' + pad(Math.round(t.deg) % 360, 3) + '°' + Config.ref() + ' (' + t.from + ')'
      : state.slot === 'LOCATOR' ? 'show the post and what is around it' : 'anything else worth keeping';
    $('target-mark').classList.toggle('hidden', !t);
    renderAim();
  }

  var wasOn = false;
  function renderAim() {
    if (state.view !== 'cam') return;
    var t = state.target, h = state.heading, el = $('aim-text');
    var tol = +Config.get().tolerance || 5;
    var on = false;
    if (!t) {
      el.textContent = '';
      el.className = '';
    } else if (h === null) {
      el.textContent = 'Waiting for the compass…';
      el.className = 'near';
    } else {
      var d = wrap180(t.deg - h), a = Math.abs(d);
      on = a <= tol;
      el.textContent = on ? 'On target · ' + pad(Math.round(norm360(h)) % 360, 3) + '°' :
        d > 0 ? 'Turn ' + Math.round(a) + '° right ▸' : '◂ Turn ' + Math.round(a) + '° left';
      el.className = on ? 'on' : a <= tol * 3 ? 'near' : 'far';
      $('target-mark').style.transform = 'rotate(' + d + 'deg)';
      $('compass').classList.toggle('off', !on);
    }
    document.body.classList.toggle('ontarget', on);
    if (on && !wasOn) buzz(8);
    wasOn = on;

    // the level: a horizon that stays put while the phone tilts
    var lv = $('level');
    if (state.pitch === null) { lv.classList.add('hidden-level'); return; }
    lv.classList.remove('hidden-level');
    var steep = Math.abs(state.pitch) > 60;
    $('horizon').style.visibility = steep ? 'hidden' : 'visible';
    $('horizon').style.transform = 'rotate(' + (-state.roll) + 'deg)';
    lv.classList.toggle('level', !steep && Math.abs(state.roll) <= 1.5);
    var p = Math.round(state.pitch);
    $('pitch-read').textContent = steep ? (p < 0 ? '↓ ' + (-p) + '° — pointing at the ground' : '↑ ' + p + '°')
      : (p < -1 ? '↓ ' + (-p) + '°' : p > 1 ? '↑ ' + p + '°' : 'level') + (Math.abs(state.roll) > 1.5 ? ' · tilted ' + Math.round(Math.abs(state.roll)) + '°' : '');
  }

  /* ── the last visit's photo, over the camera ──────────────────── */

  var ghostUrl = null, ghostMode = 1;           // 0 off, 1 faint, 2 strong
  function loadGhost() {
    var v = state.visit, img = $('ghost'), key = state.slot;
    var set = function (rec) {
      if (ghostUrl) { URL.revokeObjectURL(ghostUrl); ghostUrl = null; }
      state.ghost = rec || null;
      $('ghost-btn').classList.toggle('hidden', !rec);
      if (!rec || !Config.get().ghost || ghostMode === 0) {
        img.classList.add('hidden');
      } else {
        ghostUrl = URL.createObjectURL(rec.blob);
        img.src = ghostUrl;
        img.classList.remove('hidden');
        img.classList.toggle('strong', ghostMode === 2);
      }
      $('ghost-btn').setAttribute('aria-pressed', rec && ghostMode ? 'true' : 'false');
      $('ghost-btn').textContent = rec ? 'Last visit' + (rec.visitDate ? ' ' + fmtDate(rec.visitDate) : '') +
        (ghostMode === 0 ? ' · off' : ghostMode === 2 ? ' · strong' : '') : 'Last visit';
      updateTarget();
    };
    if (!v || key === 'MISC') return set(null);
    return Store.ghost(v.stationGid + '|' + key).then(function (rec) {
      if (state.slot === key) set(rec);
    }).catch(function () { set(null); });
  }

  /* ───────────────────────────── camera ───────────────────────────── */

  var lastFrameTime = -1, staleTicks = 0, lastRecovery = 0, cameraStartedAt = 0, camWatch = null;

  function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showNoVideo('This browser has no camera access.');
      return Promise.resolve();
    }
    stopCamera(true);
    var settled = false;
    var deadline = new Promise(function (res) {
      setTimeout(function () { if (!settled) { showNoVideo('The camera did not start. Tap to try again.'); res(); } }, 8000);
    });
    // Ask for the most the camera will give, in the photo shape (4:3). What
    // actually arrives is recorded with each photo.
    var open = navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 4032 }, height: { ideal: 3024 }, aspectRatio: { ideal: 4 / 3 } }
    }).then(function (s) {
      settled = true;
      if (state.view !== 'cam') { s.getTracks().forEach(function (t) { t.stop(); }); return; }
      state.stream = s;
      var v = $('preview');
      v.srcObject = s;
      $('novideo').classList.add('hidden');
      lastFrameTime = -1;
      staleTicks = 0;
      cameraStartedAt = Date.now();
      var track = s.getVideoTracks()[0];
      if (track) {
        track.addEventListener('ended', function () { recoverCamera('track ended'); });
        track.addEventListener('unmute', function () { staleTicks = 0; v.play().catch(function () {}); });
        var st = track.getSettings ? track.getSettings() : {};
        Report.note('camera', (st.width || '?') + 'x' + (st.height || '?'));
      }
      return v.play().catch(function () {});
    }).catch(function (e) {
      settled = true;
      var name = (e && e.name) || 'error';
      Report.note('camera failed', name);
      showNoVideo(name === 'NotAllowedError' ? 'Camera permission denied. Tap to try again.' : 'Camera unavailable (' + name + '). Tap to try again.');
    });
    if (!camWatch) camWatch = setInterval(watchCamera, 2000);
    return Promise.race([open, deadline]);
  }

  function videoTrack() { return state.stream ? state.stream.getVideoTracks()[0] : null; }

  function cameraHealthy() {
    var v = $('preview'), t = videoTrack();
    return !!(state.stream && t && t.readyState === 'live' && v.videoWidth);
  }

  function previewStalled() {
    if (!state.stream) return false;
    var t = videoTrack();
    if (!t || t.readyState === 'ended') return true;
    return staleTicks >= 2;
  }

  function recoverCamera(why) {
    if (state.view !== 'cam' || Date.now() - lastRecovery < 8000) return Promise.resolve();
    lastRecovery = Date.now();
    staleTicks = 0;
    lastFrameTime = -1;
    Report.note('camera recovery', why);
    toast('Camera stalled — restarting it', 'warn');
    return startCamera();
  }

  /* iOS freezes a stream without ending it (a call, a thermal pause). Only an
     ended track or a stopped frame clock counts — `muted` is noise on iOS. */
  function watchCamera() {
    if (state.view !== 'cam' || document.visibilityState !== 'visible' || !state.stream) return;
    if (Date.now() - cameraStartedAt < 6000) return;
    var v = $('preview'), t = videoTrack();
    if (!t || t.readyState === 'ended') return void recoverCamera('track ended');
    if (!v.videoWidth || v.currentTime === lastFrameTime) staleTicks++;
    else staleTicks = 0;
    lastFrameTime = v.currentTime;
    if (staleTicks === 1 && v.paused) v.play().catch(function () {});
    if (staleTicks >= 3) recoverCamera('no new frames for ~6s');
  }

  function stopCamera(keepWatch) {
    if (state.stream) {
      state.stream.getTracks().forEach(function (t) { t.stop(); });
      state.stream = null;
    }
    $('preview').srcObject = null;
    if (!keepWatch && camWatch) { clearInterval(camWatch); camWatch = null; }
  }

  function showNoVideo(msg) {
    $('novideo-msg').textContent = msg;
    $('novideo').classList.remove('hidden');
  }

  function flashScreen() {
    var f = $('flash');
    f.classList.remove('go');
    void f.offsetWidth;
    f.classList.add('go');
  }

  /* ── taking a photo ───────────────────────────────────────────── */

  /**
   * The frame at full size. One big canvas, emptied straight after: iOS is
   * slow to give canvas memory back, and a 12-megapixel frame is 48 MB of it.
   */
  function grab(source, sw, sh) {
    var c = Config.get();
    var md = +c.maxDim || 0;
    var scale = md ? Math.min(1, md / Math.max(sw, sh)) : 1;
    var w = Math.round(sw * scale), h = Math.round(sh * scale);
    var cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    cv.getContext('2d').drawImage(source, 0, 0, w, h);
    var tc = document.createElement('canvas');
    var ts = Math.min(1, 240 / Math.max(w, h));
    tc.width = Math.round(w * ts); tc.height = Math.round(h * ts);
    tc.getContext('2d').drawImage(cv, 0, 0, tc.width, tc.height);
    var thumb = tc.toDataURL('image/jpeg', 0.65);
    tc.width = tc.height = 0;
    return new Promise(function (res, rej) {
      cv.toBlob(function (b) {
        cv.width = cv.height = 0;
        if (b) res({ blob: b, w: w, h: h, thumb: thumb });
        else rej(new Error('the camera frame could not be encoded'));
      }, 'image/jpeg', +c.quality || 0.92);
    });
  }

  function safeName(s) { return String(s || 'station').replace(/[^A-Za-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'station'; }

  /** e.g. LKD-PS01_N_20261026-144012_003T.jpg — the bearing travels with the file. */
  function photoName(v, shot) {
    var d = new Date(shot.createdAt);
    return safeName(v.stationId) + '_' + shot.slot + '_' +
      d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()) +
      (shot.heading === null ? '' : '_' + pad(Math.round(shot.heading) % 360, 3) + shot.headingRef) + '.jpg';
  }

  function capture() {
    if (state.busy || !state.visit) return Promise.resolve();
    var v = $('preview');
    if (!state.stream || !v.videoWidth) { Sound.error(); toast('The camera is not running yet', 'warn'); return Promise.resolve(); }
    if (previewStalled()) {
      Sound.error();
      toast('The preview had stalled — restarting it, take it again', 'warn', 3500);
      recoverCamera('stalled at the shutter');
      return Promise.resolve();
    }
    state.busy = true;
    $('shutter').disabled = true;
    // the bearing at the moment of the click, not after the save
    var snap = { at: Date.now(), slot: state.slot };
    var settle = compassPending || Promise.resolve();
    return settle.then(function () {
      return state.mag === null ? firstHeading(1500) : null;
    }).then(function () {
      snap.heading = state.heading; snap.mag = state.mag; snap.pitch = state.pitch; snap.roll = state.roll;
      snap.settled = state.settled; snap.accuracy = state.accuracy; snap.target = state.target;
      Sound.shutter();
      buzz(12);
      flashScreen();
      $('saving').classList.remove('hidden');
      return grab(v, v.videoWidth, v.videoHeight);
    }).then(function (img) {
      return saveShot(img, snap);
    }).catch(function (e) {
      Sound.error();
      toast('Photo not saved: ' + errText(e), 'bad', 4500);
      Report.send(reportContext('capture', errText(e), { stack: Arc.asError(e).stack }));
    }).then(function () {
      state.busy = false;
      $('shutter').disabled = false;
      $('saving').classList.add('hidden');
    });
  }

  function saveShot(img, snap) {
    var v = state.visit;
    var pos = photoPosition();
    var ref = Config.ref();
    var shot = {
      id: Store.uuid(), visitId: v.id, slot: snap.slot, createdAt: snap.at,
      heading: round1(snap.heading), headingRef: ref, magHeading: round1(snap.mag),
      pitch: round1(snap.pitch), roll: round1(snap.roll),
      compassSettled: !!snap.settled, compassAccuracy: snap.accuracy,
      target: snap.target ? round1(snap.target.deg) : null,
      lat: pos.lat, lon: pos.lon, alt: pos.alt, hAcc: pos.hAcc, posSource: pos.source,
      w: img.w, h: img.h, thumb: img.thumb,
      attGlobalId: Store.guid(), state: 'pending', attempts: 0
    };
    shot.name = photoName(v, shot);
    var meta = {
      lat: shot.lat, lon: shot.lon, alt: shot.alt,
      heading: shot.heading, headingRef: ref, hAcc: shot.hAcc,
      taken: shot.createdAt, device: 'Photo Points', model: devicePlatform()
    };
    var stamp = self.Exif ? Exif.write(img.blob, meta) : Promise.resolve(img.blob);
    return stamp.then(function (blob) {
      shot.size = blob.size;
      return Store.addShot(shot, blob);
    }).then(function () {
      state.shots.push(shot);
      Report.note('photo', { slot: shot.slot, hdg: shot.heading, settled: shot.compassSettled, px: img.w + 'x' + img.h });
      Sound.queued();
      renderSlots();
      renderReviewThumb(true);
      if (shot.heading === null) toast('Saved without a bearing — the compass was not available', 'warn', 3500);
      keepStorage();
      advance(shot);
    });
  }

  /** After a directional shot, move on to the next slot that has no photo. */
  function advance(shot) {
    var sl = Config.slot(shot.slot);
    var next = Config.get().autoAdvance && sl.group !== 'other' ? nextEmpty(shot.slot) : null;
    if (next) {
      toast(sl.label + ' ✓ — next: ' + Config.slot(next).label, 'ok', 2200);
      setTimeout(function () { if (state.view === 'cam') selectSlot(next); }, 350);
    } else if (sl.group !== 'other' && !nextEmpty(null)) {
      toast('Every slot has a photo — tap Done when you are finished', 'ok', 3500);
    } else {
      toast(sl.label + ' saved', 'ok', 1600);
    }
  }

  var persistAsked = false;
  /** Ask the browser not to evict the photos under storage pressure. */
  function keepStorage() {
    if (persistAsked || !navigator.storage || !navigator.storage.persist) return;
    persistAsked = true;
    navigator.storage.persist().then(function (ok) { Report.note('storage persist', ok); }).catch(function () {});
  }

  function renderReviewThumb(pop) {
    var last = state.shots[state.shots.length - 1];
    $('review').style.backgroundImage = last && last.thumb ? 'url(' + last.thumb + ')' : '';
    $('review-count').textContent = state.shots.length ? String(state.shots.length) : '';
    if (pop) {
      $('review').classList.add('pop');
      setTimeout(function () { $('review').classList.remove('pop'); }, 400);
    }
  }

  /* ── reviewing and finishing ─────────────────────────────────── */

  function openReview() {
    var v = state.visit;
    if (!v) return;
    $('rv-title').textContent = v.stationId + ' — ' + state.shots.length + ' photo' + (state.shots.length === 1 ? '' : 's');
    var html = [];
    Config.SLOTS.forEach(function (sl) {
      var list = shotsIn(sl.key);
      if (!list.length) return;
      html.push('<div class="rv-slot">' + esc(sl.label) + '</div><div class="rv-grid">' + list.map(function (s) {
        return '<button class="rv-ph" data-shot="' + s.id + '" style="background-image:url(' + s.thumb + ')" aria-label="' +
          esc(sl.label + ' photo') + '"></button>';
      }).join('') + '</div>');
    });
    $('rv-list').innerHTML = html.join('') || '<p class="hint">No photos yet.</p>';
    Array.prototype.forEach.call($('rv-list').querySelectorAll('[data-shot]'), function (b) {
      b.addEventListener('click', function () { openPhoto(b.dataset.shot); });
    });
    openSheet('review-panel');
  }

  var photoUrl = null, photoShot = null;
  function openPhoto(id) {
    return Promise.all([Store.shot(id), Store.photo(id)]).then(function (r) {
      var s = r[0], blob = r[1];
      if (!s) return;
      photoShot = s;
      if (photoUrl) URL.revokeObjectURL(photoUrl);
      photoUrl = blob ? URL.createObjectURL(blob) : null;
      $('pv-img').src = photoUrl || s.thumb;
      var sl = Config.slot(s.slot);
      $('pv-meta').textContent = [
        sl ? sl.label : s.slot,
        new Date(s.createdAt).toLocaleTimeString(),
        s.heading === null ? 'no bearing' : Math.round(s.heading) + '°' + s.headingRef + (s.target !== null ? ' (target ' + Math.round(s.target) + '°)' : ''),
        s.pitch === null ? '' : (s.pitch < 0 ? '↓' + Math.round(-s.pitch) : '↑' + Math.round(s.pitch)) + '°',
        s.w + '×' + s.h, fmtBytes(s.size),
        s.state === 'sent' ? 'uploaded' : ''
      ].filter(Boolean).join(' · ');
      $('pv-delete').disabled = s.state === 'sent' || s.state === 'uploading';
      $('pv-delete').textContent = s.state === 'sent' ? 'Uploaded — delete it in ArcGIS' : 'Delete photo';
      openSheet('photo-panel');
    });
  }

  function deletePhoto() {
    var s = photoShot;
    if (!s || s.state === 'sent' || s.state === 'uploading') return Promise.resolve();
    if (!confirm('Delete this ' + (Config.slot(s.slot) || {}).label + ' photo?')) return Promise.resolve();
    return Store.removeShot(s.id).then(function () {
      state.shots = state.shots.filter(function (x) { return x.id !== s.id; });
      Sound.tick();
      renderSlots();
      renderReviewThumb();
      toast('Photo deleted', 'ok');
      return refreshCounts();
    }).then(openReview);
  }

  var postChoice = null;
  function openDetails(finishing) {
    var v = state.visit;
    if (!v) return;
    var st = findStation(v.stationGid);
    var a = v.attrs || {};
    $('dp-title').textContent = v.stationId + (finishing ? ' — finish visit' : ' — visit details');
    $('dp-when').textContent = 'Started ' + new Date(v.createdAt).toLocaleString() + (v.objectId ? ' · already on the layer' : '');
    $('dp-observer').value = a.Observer || '';
    $('dp-event').value = a.MonitoringEvent || '';
    $('dp-notes').value = a.Notes || '';
    fillSelect($('dp-condition'), options(state.meta.visits, 'PostCondition'), a.PostCondition, '—');
    postChoice = v.postNow || (st ? st.postInstalled : v.postWas) || 'No';
    renderPostSeg(st);
    fillSelect($('dp-post-type'), options(state.meta.stations, 'PostType'), v.postType || (st && st.postType) || '', '—');
    $('dp-post-tag').value = v.postTag || (st && st.postTag) || '';
    var n = state.shots.length;
    var missing = Config.SLOTS.filter(function (sl) { return sl.group !== 'other' && !shotsIn(sl.key).length; })
      .map(function (sl) { return (sl.group === 'low' ? 'ground ' : '') + sl.short; });
    $('dp-summary').textContent = n + ' photo' + (n === 1 ? '' : 's') + (missing.length ? ' · no photo yet for ' + missing.join(', ') : ' · every direction covered');
    $('dp-finish').textContent = v.objectId ? 'Save & upload changes' : 'Save & upload';
    openSheet('details-panel');
  }

  function renderPostSeg(st) {
    var was = st ? st.postInstalled : '';
    Array.prototype.forEach.call($('dp-post-seg').children, function (b) {
      b.classList.toggle('on', b.dataset.v === postChoice);
    });
    $('dp-post-new').classList.toggle('hidden', !(postChoice === 'Yes' && was !== 'Yes'));
  }

  function readDetails() {
    var v = state.visit;
    v.attrs = Object.assign({}, v.attrs, {
      Observer: $('dp-observer').value.trim(),
      MonitoringEvent: $('dp-event').value.trim(),
      PostCondition: $('dp-condition').value || null,
      Notes: $('dp-notes').value.trim()
    });
    v.postNow = postChoice;
    v.postType = $('dp-post-type').value || '';
    v.postTag = $('dp-post-tag').value.trim();
    return Config.save({ observer: v.attrs.Observer, monitoringEvent: v.attrs.MonitoringEvent });
  }

  function saveDetails() {
    return readDetails().then(function () { return Store.putVisit(state.visit); });
  }

  /** Done: the visit joins the upload queue, and the station is updated if its post changed. */
  function finishVisit() {
    var v = state.visit;
    if (!v) return Promise.resolve();
    if (!state.shots.length && !confirm('Save this visit with no photos?')) return Promise.resolve();
    return readDetails().then(function () {
      var st = findStation(v.stationGid);
      var was = st ? st.postInstalled : v.postWas;
      var jobs = [];
      if (v.postNow && v.postNow !== was) {
        var attrs = { PostInstalled: v.postNow };
        if (v.postNow === 'Yes') {
          attrs.InstallDate = v.attrs.VisitDate || Date.now();
          if (v.postType) attrs.PostType = v.postType;
          if (v.postTag) attrs.PostTag = v.postTag;
        }
        jobs.push(queueStationEdit(v.stationGid, attrs));
      }
      if (v.objectId) v.pendingEdit = true;          // already on the layer: send the changes
      v.state = 'queued';
      v.finishedAt = Date.now();
      jobs.push(Store.putVisit(v));
      return Promise.all(jobs);
    }).then(function () {
      Report.note('visit finished', { station: v.stationId, photos: state.shots.length });
      Sound.allClear();
      toast(v.stationId + ' saved — ' + state.shots.length + ' photo' + (state.shots.length === 1 ? '' : 's') +
        (state.online ? ' uploading' : ' will upload when back online'), 'ok', 3500);
      return leaveCamera();
    }).then(refreshCounts).then(function () {
      if (state.online && Config.get().autoSync) sync(true);
    });
  }

  function discardVisit() {
    var v = state.visit;
    if (!v) return Promise.resolve();
    if (v.objectId) { toast('Part of this visit is already uploaded — remove it in the upload queue', 'warn', 4000); return Promise.resolve(); }
    if (!confirm('Discard this visit and its ' + state.shots.length + ' photo(s)? This cannot be undone.')) return Promise.resolve();
    return Store.removeVisit(v.id).then(function () {
      Report.note('visit discarded', v.stationId);
      closeSheets();
      toast('Visit discarded', 'ok');
      return leaveCamera();
    }).then(refreshCounts);
  }

  /* ───────────────────────────── stations: edits ──────────────────── */

  function queueStationEdit(gid, attrs) {
    return Store.edits().then(function (edits) {
      // fold into a change already waiting for this station, if there is one
      var waiting = edits.filter(function (e) { return e.globalId === gid && e.state !== 'sent' && e.state !== 'uploading'; })[0];
      var e = waiting || { id: Store.uuid(), kind: 'update', globalId: gid, attrs: {}, createdAt: Date.now(), state: 'pending', attempts: 0 };
      e.attrs = Object.assign({}, e.attrs, attrs);
      e.state = 'pending';
      e.nextAttemptAt = 0;
      return Store.putEdit(e);
    }).then(function () {
      var s = findStation(gid);
      if (s) { applyStationAttrs(s, attrs); s.pending = true; }
    });
  }

  var editing = null, editPost = null;
  function openStationEdit(s) {
    editing = s;
    editPost = s.postInstalled === 'Yes' ? 'Yes' : 'No';
    $('ep-title').textContent = 'Edit ' + s.id;
    Array.prototype.forEach.call($('ep-post-seg').children, function (b) { b.classList.toggle('on', b.dataset.v === editPost); });
    fillSelect($('ep-post-type'), options(state.meta.stations, 'PostType'), s.postType, '—');
    $('ep-post-tag').value = s.postTag || '';
    $('ep-install').value = s.installDate ? fmtDate(s.installDate) : '';
    fillSelect($('ep-status'), options(state.meta.stations, 'StationStatus'), s.status, '—');
    $('ep-notes').value = s.notes || '';
    openSheet('edit-panel');
  }

  function saveStationEdit() {
    var s = editing;
    if (!s) return Promise.resolve();
    var day = $('ep-install').value;
    var next = {
      PostInstalled: editPost,
      PostType: $('ep-post-type').value || null,
      PostTag: $('ep-post-tag').value.trim(),
      InstallDate: day ? new Date(day + 'T12:00:00').getTime() : null,
      StationStatus: $('ep-status').value || null,
      Notes: $('ep-notes').value.trim()
    };
    var now = {
      PostInstalled: s.postInstalled || null, PostType: s.postType || null, PostTag: s.postTag || '',
      InstallDate: s.installDate || null, StationStatus: s.status || null, Notes: s.notes || ''
    };
    var changed = {};
    Object.keys(next).forEach(function (k) {
      if (String(next[k] === null ? '' : next[k]) !== String(now[k] === null ? '' : now[k])) changed[k] = next[k];
    });
    if (!Object.keys(changed).length) { closeSheets(); return Promise.resolve(); }
    return queueStationEdit(s.gid, changed).then(function () {
      Sound.tick();
      toast(s.id + ' updated on the phone' + (state.online ? '' : ' — it goes up when back online'), 'ok');
      closeSheets();
      renderStations();
      return refreshCounts();
    }).then(function () { if (state.online && Config.get().autoSync) sync(true); });
  }

  var newPost = 'No';
  function openNewStation() {
    if (!state.pos) { toast('Waiting for a GPS fix to place the station', 'warn', 3500); return; }
    var p = state.pos.coords;
    var near = null, nearD = Infinity;
    state.stations.forEach(function (s) {
      if (s.lat === null) return;
      var d = distance(p.latitude, p.longitude, s.lat, s.lon);
      if (d < nearD) { nearD = d; near = s; }
    });
    $('np-where').textContent = p.latitude.toFixed(6) + ', ' + p.longitude.toFixed(6) + ' · GPS ±' + Math.round(p.accuracy) + ' m' +
      (p.accuracy > 15 ? ' — wait for a better fix if you can' : '') +
      (near ? ' · nearest station ' + near.id + ' (' + fmtDist(nearD) + ')' : '');
    $('np-id').value = suggestId(near);
    $('np-site').value = near && nearD < 3000 ? near.site : '';
    $('np-mu').value = near && nearD < 300 ? near.mu : '';
    $('np-notes').value = '';
    newPost = 'No';
    Array.prototype.forEach.call($('np-post-seg').children, function (b) { b.classList.toggle('on', b.dataset.v === newPost); });
    openSheet('new-panel');
  }

  /** The next free number after the nearest station's prefix: LKD-PS17 → LKD-PS18. */
  function suggestId(near) {
    if (!near) return '';
    var m = /^(.*?)(\d+)$/.exec(near.id || '');
    if (!m) return '';
    var prefix = m[1], width = m[2].length, max = 0;
    state.stations.forEach(function (s) {
      var k = /^(.*?)(\d+)$/.exec(s.id || '');
      if (k && k[1] === prefix) max = Math.max(max, +k[2]);
    });
    return prefix + pad(max + 1, width);
  }

  function saveNewStation() {
    var id = $('np-id').value.trim();
    if (!id) { toast('Give the station an ID', 'warn'); return Promise.resolve(); }
    if (state.stations.some(function (s) { return String(s.id).toLowerCase() === id.toLowerCase(); })) {
      if (!confirm('There is already a station called ' + id + '. Add another?')) return Promise.resolve();
    }
    var p = state.pos.coords;
    var e = {
      id: Store.uuid(), kind: 'add', globalId: Store.guid(), lat: p.latitude, lon: p.longitude, hAcc: p.accuracy,
      attrs: {
        StationID: id, SiteName: $('np-site').value.trim(), MgmtUnit: $('np-mu').value.trim(),
        PostInstalled: newPost, StationStatus: 'Active', Notes: $('np-notes').value.trim(),
        InstallDate: newPost === 'Yes' ? Date.now() : null
      },
      createdAt: Date.now(), state: 'pending', attempts: 0
    };
    return Store.putEdit(e).then(function () {
      return mergeLocalEdits();
    }).then(function () {
      Sound.queued();
      closeSheets();
      renderStations();
      toast('Station ' + id + ' added', 'ok');
      return refreshCounts();
    }).then(function () {
      if (state.online && Config.get().autoSync) sync(true);
      openStation(e.globalId);
    });
  }

  /* ─────────────────────────── upload loop ────────────────────────── */

  function sheetOpen(id) { var el = $(id); return el && !el.classList.contains('hidden'); }

  function refreshCounts() {
    return Store.counts().then(function (c) {
      state.counts = c;
      var chip = $('chip-queue');
      chip.querySelector('.label').textContent = String(c.outstanding);
      chip.className = 'chip' + (c.errors ? ' bad' : c.outstanding ? ' warn' : ' ok') + (state.flushing ? ' busy' : '');
      $('mi-queue-sub').textContent = c.outstanding
        ? [c.photos ? c.photos + ' photo' + (c.photos === 1 ? '' : 's') + ' (' + fmtBytes(c.bytes) + ')' : '',
           c.visits ? c.visits + ' visit' + (c.visits === 1 ? '' : 's') : '',
           c.edits ? c.edits + ' station change' + (c.edits === 1 ? '' : 's') : ''].filter(Boolean).join(', ') + ' waiting'
        : 'nothing waiting';
      if (sheetOpen('queue-panel')) renderQueue();
      return c;
    });
  }

  function setNet(online) {
    var was = state.online;
    state.online = online;
    var chip = $('chip-net');
    chip.className = 'chip ' + (online ? 'ok' : 'bad');
    chip.querySelector('.label').textContent = online ? 'online' : 'offline';
    if (was === online) return;
    if (online) {
      Sound.online();
      toast('Back online', 'ok');
      Arc.clearBackoff().then(function () {
        if (Config.get().autoSync) sync(true);
        Report.flushHeld();
      });
    } else {
      Sound.offline();
      buzz([8, 60, 8]);
      toast('Connection lost — everything is kept on the phone', 'warn', 3200);
    }
  }

  function sync(force) {
    if (state.flushing) return Promise.resolve();
    if (!state.counts.outstanding && !force) return Promise.resolve();
    state.flushing = true;
    document.body.classList.add('syncing');
    $('chip-queue').classList.add('busy');
    var sentPhotos = 0;
    return Arc.flush(function (type, row, extra) {
      if (type === 'progress') {
        state.progress[row.id] = extra;
        renderProgress(row.id);
      } else if (type === 'sent') {
        sentPhotos++;
        delete state.progress[row.id];
        Sound.sent();
        pulseSent();
        refreshCounts();
      } else if (type === 'visit-sent') {
        toast(row.stationId + ' is up — visit and photos', 'ok', 3000);
        if (state.stats[row.stationGid]) state.stats[row.stationGid].last = row.attrs.VisitDate;
        else state.stats[row.stationGid] = { last: row.attrs.VisitDate, count: 1 };
      } else if (type === 'edit-sent') {
        var s = findStation(row.globalId);
        if (s) s.pending = false;
      } else if (type === 'failed') {
        var e = Arc.asError(extra);
        Report.note('upload failed', e.message);
        if (!e.retryable && !e.needAuth) {
          toast('Upload problem: ' + e.message, 'bad', 5000);
          Report.send(reportContext('upload', e.message, { extra: (row.slot || row.kind || 'visit') + ' ' + row.id }));
        }
        refreshCounts();
      }
    }, { force: force }).then(function (sum) {
      state.flushing = false;
      document.body.classList.remove('syncing');
      $('chip-queue').classList.remove('busy');
      return refreshCounts().then(function (c) {
        if (sum.needAuth) { Sound.error(); toast('Sign in to ArcGIS to upload', 'bad', 5000); }
        else if (sum.offline) { Sound.retry(); toast('No connection to the server — it will keep trying', 'warn'); }
        else if (sentPhotos && !c.outstanding) { Sound.allClear(); toast('Everything is uploaded', 'ok'); }
        if (sentPhotos || sum.sent) renderStations();
        return sum;
      });
    }).catch(function (e) {
      state.flushing = false;
      document.body.classList.remove('syncing');
      $('chip-queue').classList.remove('busy');
      toast(errText(e), 'bad', 4000);
      Report.send(reportContext('sync', errText(e), { stack: Arc.asError(e).stack }));
    });
  }

  function pulseSent() {
    var chip = $('chip-queue');
    chip.classList.remove('sent-pulse');
    void chip.offsetWidth;
    chip.classList.add('sent-pulse');
  }

  var syncTimer = null;
  function scheduleSync() {
    clearInterval(syncTimer);
    syncTimer = setInterval(function () {
      if (state.online && state.counts.outstanding && Config.get().autoSync) sync();
    }, 30000);
    if ('serviceWorker' in navigator && 'SyncManager' in window) {
      navigator.serviceWorker.ready.then(function (reg) { return reg.sync.register('flush-queue'); }).catch(function () {});
    }
  }

  /** Once a visit is safely up, its full-size photos stay on the phone for a while, then go. */
  function pruneLocalCopies() {
    var keep = (Config.get().keepHours || 72) * 3600000;
    return Promise.all([Store.visits(), Store.shots()]).then(function (r) {
      var sent = {};
      r[0].forEach(function (v) { if (v.state === 'sent' && v.sentAt && Date.now() - v.sentAt > keep) sent[v.id] = true; });
      return Promise.all(r[1].filter(function (s) { return sent[s.visitId] && s.hasPhoto && s.state === 'sent'; })
        .map(function (s) { return Store.dropPhoto(s.id); }));
    }).catch(function () {});
  }

  /* ── the queue sheet ──────────────────────────────────────────── */

  function renderQueue() {
    return Promise.all([Store.visits(), Store.shots(), Store.edits()]).then(function (r) {
      var visits = r[0].filter(function (v) { return v.state !== 'draft'; });
      var byVisit = {};
      r[1].forEach(function (s) { (byVisit[s.visitId] = byVisit[s.visitId] || []).push(s); });
      var edits = r[2];
      var html = [];
      if (edits.length) {
        html.push('<div class="qrow' + (edits.some(function (e) { return e.state === 'error'; }) ? ' error' : '') + '"><div class="qhead"><b>Stations</b><div class="qmeta"><span>' +
          edits.length + ' change' + (edits.length === 1 ? '' : 's') + ' waiting: ' +
          esc(edits.map(function (e) { return (e.kind === 'add' ? 'new ' : '') + (e.attrs.StationID || (findStation(e.globalId) || {}).id || 'station'); }).join(', ')) +
          '</span></div></div>' +
          edits.filter(function (e) { return e.lastError; }).map(function (e) { return '<div class="qerr">' + esc(e.lastError) + '</div>'; }).join('') + '</div>');
      }
      visits.forEach(function (v) {
        var shots = (byVisit[v.id] || []).sort(function (a, b) { return a.createdAt - b.createdAt; });
        var up = shots.filter(function (s) { return s.state === 'sent'; }).length;
        var left = shots.filter(function (s) { return s.state !== 'sent'; }).reduce(function (n, s) { return n + (s.size || 0); }, 0);
        var err = v.lastError || (shots.filter(function (s) { return s.state === 'error' || (s.lastError && s.state !== 'sent'); })[0] || {}).lastError;
        var cls = v.state === 'sent' ? 'sent' : v.state === 'error' || shots.some(function (s) { return s.state === 'error'; }) ? 'error' :
          shots.some(function (s) { return s.state === 'uploading'; }) || v.state === 'uploading' ? 'uploading' : '';
        var sub = v.state === 'sent' ? 'uploaded · ' + up + ' photo' + (up === 1 ? '' : 's') +
            (shots.some(function (s) { return s.hasPhoto; }) ? ' · still on this phone' : '')
          : (v.objectId ? 'visit is up · ' : 'waiting · ') + up + ' of ' + shots.length + ' photos up' + (left ? ' · ' + fmtBytes(left) + ' to go' : '');
        var active = shots.filter(function (s) { return state.progress[s.id]; })[0];
        html.push('<div class="qrow ' + cls + '" data-visit="' + v.id + '"><div class="qhead"><div class="qmeta"><b>' + esc(v.stationId) + '</b>' +
          '<span>' + esc(new Date(v.createdAt).toLocaleString()) + '</span><span>' + esc(sub) + '</span></div>' +
          (shots.some(function (s) { return s.hasPhoto; }) ? '<button class="qbtn" data-save="' + v.id + '" aria-label="Save photos to the phone">⤓</button>' : '') +
          (v.state !== 'sent' ? '<button class="qbtn" data-reopen="' + v.id + '" aria-label="Add photos or change details">✎</button>' : '') +
          '<button class="qbtn del" data-del="' + v.id + '" aria-label="Remove from this phone">✕</button></div>' +
          '<div class="qstrip">' + shots.map(function (s) {
            return '<div class="qph ' + s.state + '" style="background-image:url(' + (s.thumb || '') + ')"><b>' + esc((Config.slot(s.slot) || {}).short || s.slot) + '</b></div>';
          }).join('') + '</div>' +
          (active ? '<div class="bar"><div class="bar-fill" id="bar-' + active.id + '" style="width:' +
            Math.round(state.progress[active.id].done / state.progress[active.id].total * 100) + '%"></div></div>' : '') +
          (err && v.state !== 'sent' ? '<div class="qerr">' + esc(err) + '</div>' : '') + '</div>');
      });
      $('queue-list').innerHTML = html.join('') || '<p class="hint">Nothing here yet — finished visits wait here until they are uploaded.</p>';

      Array.prototype.forEach.call($('queue-list').querySelectorAll('[data-save]'), function (b) {
        b.addEventListener('click', function () { saveVisitPhotos(b.dataset.save); });
      });
      Array.prototype.forEach.call($('queue-list').querySelectorAll('[data-reopen]'), function (b) {
        b.addEventListener('click', function () {
          Store.visit(b.dataset.reopen).then(function (v) {
            if (!v) return;
            v.state = 'draft';
            return Store.putVisit(v).then(function () { return enterCamera(v); });
          });
        });
      });
      Array.prototype.forEach.call($('queue-list').querySelectorAll('[data-del]'), function (b) {
        b.addEventListener('click', function () { removeVisit(b.dataset.del); });
      });
      return estimateStorage();
    });
  }

  function renderProgress(shotId) {
    var p = state.progress[shotId], el = $('bar-' + shotId);
    if (el && p) el.style.width = Math.round(p.done / p.total * 100) + '%';
    else if (sheetOpen('queue-panel') && p && p.done === 1) renderQueue();
  }

  function estimateStorage() {
    if (!navigator.storage || !navigator.storage.estimate) { $('q-hint').textContent = ''; return Promise.resolve(); }
    return navigator.storage.estimate().then(function (e) {
      $('q-hint').textContent = 'This app is using ' + fmtBytes(e.usage) + ' on the phone. Photos stay here ' +
        (Config.get().keepHours || 72) + ' h after they are uploaded.' + (isStandalone() ? '' : ' Add it to the Home Screen so Safari never clears them.');
    }).catch(function () {});
  }

  function removeVisit(id) {
    return Promise.all([Store.visit(id), Store.shotsOf(id)]).then(function (r) {
      var v = r[0], shots = r[1];
      if (!v) return;
      var unsent = shots.filter(function (s) { return s.state !== 'sent'; }).length;
      var msg = v.state === 'sent'
        ? 'Remove ' + v.stationId + ' from this phone? It stays on the layer.'
        : 'Remove ' + v.stationId + ' from this phone? ' + (unsent ? unsent + ' photo(s) have NOT been uploaded and will be lost.' : '');
      if (!confirm(msg)) return;
      return Store.removeVisit(id).then(function () {
        Sound.tick();
        return refreshCounts();
      }).then(renderQueue);
    });
  }

  /** Hand a visit's photos to the phone in one go — iOS offers "Save N Images". */
  function saveVisitPhotos(id) {
    return Store.shotsOf(id).then(function (shots) {
      shots = shots.filter(function (s) { return s.hasPhoto; }).slice(0, 30);
      return Promise.all(shots.map(function (s) { return Store.photo(s.id); })).then(function (blobs) {
        var files = [];
        shots.forEach(function (s, i) {
          if (!blobs[i]) return;
          try { files.push(new File([blobs[i]], s.name, { type: 'image/jpeg' })); } catch (e) { /* old browser */ }
        });
        if (!files.length) return toast('No photos left on the phone for this visit', 'warn');
        if (navigator.canShare && navigator.canShare({ files: files })) {
          return navigator.share({ files: files }).then(function () { Sound.sent(); }).catch(function (e) {
            if (e && e.name !== 'AbortError') toast('Could not share: ' + e.message, 'warn');
          });
        }
        files.forEach(function (f) {
          var url = URL.createObjectURL(f), a = document.createElement('a');
          a.href = url; a.download = f.name;
          document.body.appendChild(a); a.click(); a.remove();
          setTimeout(function () { URL.revokeObjectURL(url); }, 15000);
        });
        toast('Saved ' + files.length + ' photo(s)', 'ok');
      });
    });
  }

  /* ───────────────────────────── sheets ───────────────────────────── */

  function openSheet(id) {
    closeSheets(true);
    $(id).classList.remove('hidden');
    requestAnimationFrame(function () { $(id).classList.add('open'); });
  }

  function closeSheets(quick) {
    Array.prototype.forEach.call(document.querySelectorAll('.sheet'), function (el) {
      if (el.classList.contains('hidden')) return;
      el.classList.remove('open');
      if (quick) el.classList.add('hidden');
      else setTimeout(function () { el.classList.add('hidden'); }, 220);
    });
  }

  /* ── settings ─────────────────────────────────────────────────── */

  var northChoice = 'true';
  function loadSettingsForm() {
    var c = Config.get();
    northChoice = c.north;
    Array.prototype.forEach.call($('s-north').children, function (b) { b.classList.toggle('on', b.dataset.v === northChoice); });
    $('s-decl').value = c.declination;
    $('s-tol').value = c.tolerance;
    $('s-advance').checked = c.autoAdvance;
    $('s-ghost').checked = c.ghost;
    $('s-maxdim').value = String(c.maxDim || 0);
    $('s-quality').value = c.quality;
    $('s-quality-out').textContent = c.quality;
    $('s-sound').checked = c.sound;
    $('s-haptics').checked = c.haptics;
    $('s-autosync').checked = c.autoSync;
    $('s-report').checked = c.reportProblems;
    $('s-url').value = c.serviceUrl;
    $('s-appid').value = c.appId;
    $('s-portal').value = c.portal;
    $('s-part').value = c.partKB;
    $('s-redirect').textContent = Arc.redirectUri();
  }

  function saveSettings() {
    var num = function (id, d) { var v = parseFloat($(id).value); return isFinite(v) ? v : d; };
    return Config.save({
      north: northChoice,
      declination: num('s-decl', -6.3),
      tolerance: Math.max(1, Math.min(30, num('s-tol', 5))),
      autoAdvance: $('s-advance').checked,
      ghost: $('s-ghost').checked,
      maxDim: parseInt($('s-maxdim').value, 10) || 0,
      quality: num('s-quality', 0.92),
      sound: $('s-sound').checked,
      haptics: $('s-haptics').checked,
      autoSync: $('s-autosync').checked,
      reportProblems: $('s-report').checked,
      serviceUrl: $('s-url').value.trim() || Config.DEFAULTS.serviceUrl,
      appId: $('s-appid').value.trim(),
      portal: $('s-portal').value.trim() || 'https://www.arcgis.com',
      partKB: Math.max(128, parseInt($('s-part').value, 10) || 1024)
    }).then(function (c) {
      Sound.setEnabled(c.sound);
      Sound.tick();
      state.heading = Config.reference(state.mag);
      toast('Settings saved', 'ok');
      closeSheets();
    });
  }

  function renderAuth() {
    return Arc.getAuth().then(function (a) {
      state.auth = a;
      var live = a && a.expires > Date.now();
      $('acct-name').textContent = a ? (a.username || 'signed in') : 'Not signed in';
      $('acct-sub').textContent = a ? (live ? 'signed in until ' + new Date(a.expires).toLocaleString() : 'session expired') : 'ArcGIS Online';
      $('auth-btn').textContent = a ? 'Sign out' : 'Sign in';
      $('signin-nudge').classList.toggle('hidden', !!a);
    });
  }

  function afterSignIn() {
    closeSheets();
    return renderAuth().then(function () { return loadStations(true); }).then(function () { return sync(true); });
  }

  /* ── offline prep ─────────────────────────────────────────────── */

  /** Fresh stations, and the last visit's photos for the stations nearest you. */
  function prepareOffline() {
    closeSheets();
    if (!state.online) return toast('Needs a connection — do this before heading out', 'warn');
    toast('Fetching stations…', 'ok', 2000);
    return loadStations(true).then(function (fresh) {
      if (!fresh) { toast('Could not reach the stations — nothing was saved for offline', 'bad', 4500); return null; }
      var list = state.stations.filter(function (s) { return lastVisit(s) && !s.pending; });
      if (state.pos) {
        list.forEach(function (s) { s._d = stationDistance(s); });
        list.sort(function (a, b) { return (a._d || 0) - (b._d || 0); });
      }
      list = list.slice(0, 25);
      if (!list.length) { toast('Stations saved for offline. No earlier visits to bring along yet.', 'ok', 4000); return null; }
      var done = 0, got = 0;
      return list.reduce(function (chain, s) {
        return chain.then(function () {
          return Arc.fetchGhosts(s.gid).then(function (n) { got += n; }).catch(function () {}).then(function () {
            done++;
            toast('Last visits: ' + done + ' of ' + list.length + ' stations', 'ok', 1500);
          });
        });
      }, Promise.resolve()).then(function () {
        toast('Ready for offline — ' + state.stations.length + ' stations, ' + got + ' earlier photos', 'ok', 4500);
      });
    });
  }

  /* ── problem reports ──────────────────────────────────────────── */

  function sensorState() {
    return [
      'compass=' + (!tracker ? 'missing' : gotOrientation ? (state.settled ? 'live' : 'unsettled') : listening ? 'listening' : 'off'),
      'hdg=' + (state.heading === null ? 'none' : Math.round(state.heading) + Config.ref()),
      'acc=' + (state.accuracy === null ? '-' : Math.round(state.accuracy)),
      'gps=' + (state.pos ? '±' + Math.round(state.pos.coords.accuracy) + 'm/' + ago(fixAge()) : 'none') + (state.gpsDenied ? ' denied' : ''),
      'cam=' + (state.stream ? (cameraHealthy() ? 'live' : 'stalled') : 'off'),
      'view=' + state.view,
      'standalone=' + (isStandalone() ? 'yes' : 'no')
    ].join(' ');
  }

  function reportContext(kind, summary, extra) {
    var p = state.pos && state.pos.coords;
    return {
      kind: kind, summary: summary, sensors: sensorState(),
      device: navigator.userAgent + ' | ' + screen.width + 'x' + screen.height + ' | ' + window.innerWidth + 'x' + window.innerHeight,
      queued: state.counts.outstanding, queueErrors: state.counts.errors, online: state.online,
      lat: p ? p.latitude : undefined, lon: p ? p.longitude : undefined,
      stack: extra && extra.stack, extra: extra && extra.extra
    };
  }

  function watchForProblems() {
    window.addEventListener('error', function (e) {
      var msg = e.message || 'Script error';
      Report.note('window.error', msg);
      Report.send(reportContext('crash', msg, { stack: e.error && e.error.stack, extra: e.filename + ':' + e.lineno }));
    });
    window.addEventListener('unhandledrejection', function (e) {
      var r = Arc.asError(e.reason);
      Report.note('unhandled rejection', r.message);
      Report.send(reportContext('crash', r.message, { stack: r.stack }));
    });
  }

  /* ── service worker, install, reinstall ───────────────────────── */

  function registerSW() {
    if (!('serviceWorker' in navigator)) return Promise.resolve();
    return navigator.serviceWorker.register('sw.js').then(function (reg) {
      reg.addEventListener('updatefound', function () {
        var w = reg.installing;
        if (!w) return;
        w.addEventListener('statechange', function () {
          if (w.state === 'installed' && navigator.serviceWorker.controller) toast('Update ready — reopen the app to use it', 'ok', 4000);
        });
      });
      navigator.serviceWorker.addEventListener('message', function (e) {
        if (e.data && e.data.type === 'flush') refreshCounts().then(function () { sync(); });
      });
      return reg;
    }).catch(function () { /* still works, just without offline caching */ });
  }

  var deferredPrompt = null;
  function offerInstall() {
    if (deferredPrompt) {
      var p = deferredPrompt;
      deferredPrompt = null;
      closeSheets();
      p.prompt();
      return p.userChoice.catch(function () {});
    }
    $('steps-ios').classList.toggle('hidden', !isIOS());
    $('steps-other').classList.toggle('hidden', isIOS());
    var warn = $('install-queue-warn');
    warn.classList.toggle('hidden', !state.counts.outstanding);
    if (state.counts.outstanding) warn.textContent = 'Some photos are still waiting to upload. Finish them here first — the installed app will not see them.';
    openSheet('install-panel');
    return Promise.resolve();
  }

  /** Only this app's own worker and caches: the origin is shared with Exotic Camera and every other Pages app. */
  function reinstall() {
    if (state.counts.outstanding && !confirm('Photos waiting to upload stay on the phone through a reinstall. Continue?')) return;
    toast('Reinstalling…', 'ok', 4000);
    var jobs = [];
    if ('serviceWorker' in navigator) {
      jobs.push(navigator.serviceWorker.getRegistration().then(function (r) { return r ? r.unregister() : null; }));
    }
    if (window.caches) {
      jobs.push(caches.keys().then(function (keys) {
        return Promise.all(keys.filter(function (k) { return k.indexOf('photopoints-') === 0; }).map(function (k) { return caches.delete(k); }));
      }));
    }
    Promise.all(jobs).catch(function () {}).then(function () {
      location.replace(Arc.redirectUri() + '?fresh=' + Date.now());
    });
  }

  /* ────────────────────────────── wiring ──────────────────────────── */

  function seg(id, set) {
    Array.prototype.forEach.call($(id).children, function (b) {
      b.addEventListener('click', function () {
        Array.prototype.forEach.call($(id).children, function (o) { o.classList.toggle('on', o === b); });
        Sound.tick();
        set(b.dataset.v);
      });
    });
  }

  function wire() {
    // home
    $('search').addEventListener('input', renderStations);
    $('refresh-btn').addEventListener('click', function () { Sound.unlock(); loadStations(true); });
    $('new-station-btn').addEventListener('click', function () { Sound.unlock(); openNewStation(); });
    $('nudge-signin').addEventListener('click', function () { openSheet('signin-panel'); });
    $('menu-btn').addEventListener('click', function () {
      Sound.unlock(); Sound.tick();
      renderAuth().then(refreshCounts).then(function () { openSheet('menu'); });
    });
    $('chip-queue').addEventListener('click', function () { renderQueue().then(function () { openSheet('queue-panel'); }); });
    $('chip-net').addEventListener('click', function () { sync(true); });
    $('chip-gps').addEventListener('click', function () {
      var p = state.pos && state.pos.coords;
      toast(p ? p.latitude.toFixed(6) + ', ' + p.longitude.toFixed(6) + ' ±' + Math.round(p.accuracy) + 'm, ' + ago(fixAge()) + ' ago'
             : state.gpsDenied ? 'Location permission denied' : 'No fix yet');
    });

    // station sheet
    $('sp-start').addEventListener('click', function () {
      Sound.unlock();
      if (state.sheetStation) startVisit(state.sheetStation);
    });
    $('sp-edit').addEventListener('click', function () { if (state.sheetStation) openStationEdit(state.sheetStation); });
    $('sp-close').addEventListener('click', function () { closeSheets(); });

    // camera
    $('shutter').addEventListener('click', function () { Sound.unlock(); capture(); });
    $('preview').addEventListener('click', function () {
      if (!cameraHealthy() || previewStalled()) { lastRecovery = 0; recoverCamera('tapped the preview'); }
    });
    $('start-cam').addEventListener('click', function () { Sound.unlock(); startCompass(); startCamera(); });
    $('cam-close').addEventListener('click', function () {
      Sound.tick();
      if (state.visit && state.shots.length) toast('Visit kept — resume it from the station list', 'ok', 2500);
      else if (state.visit && !state.shots.length && state.visit.state === 'draft' && !state.visit.objectId) {
        Store.removeVisit(state.visit.id);       // nothing in it: no point keeping it
      }
      leaveCamera();
    });
    $('review').addEventListener('click', function () { if (state.shots.length) openReview(); });
    $('finish').addEventListener('click', function () { Sound.tick(); openDetails(true); });
    $('details-btn').addEventListener('click', function () { openDetails(false); });
    $('ghost-btn').addEventListener('click', function () {
      ghostMode = (ghostMode + 1) % 3;
      Sound.tick();
      loadGhost();
    });
    $('chip-cal').addEventListener('click', function () {
      if (state.heading === null) {
        compassDenied = headingHopeless = false;
        startCompass().then(function (r) { if (r !== true) armCompass(); });
        return;
      }
      toast(state.settled
        ? 'Compass is steady. Bearings are ' + (Config.ref() === 'T' ? 'true (declination ' + Config.get().declination + '°)' : 'magnetic') + '.'
        : 'Compass is settling — hold the phone tilted towards you for a moment so it can check north.', state.settled ? 'ok' : 'warn', 4500);
    });
    $('compass').addEventListener('click', function () { Sound.unlock(); if (state.heading === null) startCompass(); });

    // details
    seg('dp-post-seg', function (v) { postChoice = v; renderPostSeg(findStation(state.visit && state.visit.stationGid)); });
    $('dp-finish').addEventListener('click', function () { finishVisit(); });
    $('dp-keep').addEventListener('click', function () { saveDetails().then(function () { closeSheets(); }); });
    $('dp-discard').addEventListener('click', function () { discardVisit(); });

    // review + photo
    $('rv-close').addEventListener('click', function () { closeSheets(); });
    $('pv-close').addEventListener('click', function () { openReview(); });
    $('pv-delete').addEventListener('click', deletePhoto);

    // queue
    $('q-sync').addEventListener('click', function () { closeSheets(); Arc.clearBackoff().then(function () { return sync(true); }); });
    $('q-clear-done').addEventListener('click', function () {
      Store.visits().then(function (vs) {
        return Promise.all(vs.filter(function (v) { return v.state === 'sent'; }).map(function (v) { return Store.removeVisit(v.id); }));
      }).then(refreshCounts).then(renderQueue);
    });

    // station edit / new
    seg('ep-post-seg', function (v) { editPost = v; });
    $('ep-save').addEventListener('click', saveStationEdit);
    $('ep-cancel').addEventListener('click', function () { if (editing) openStation(editing.gid); });
    seg('np-post-seg', function (v) { newPost = v; });
    $('np-save').addEventListener('click', saveNewStation);
    $('np-cancel').addEventListener('click', function () { closeSheets(); });

    // menu
    $('mi-queue').addEventListener('click', function () { renderQueue().then(function () { openSheet('queue-panel'); }); });
    $('mi-sync').addEventListener('click', function () { closeSheets(); Arc.clearBackoff().then(function () { return sync(true); }); });
    $('mi-offline').addEventListener('click', prepareOffline);
    $('mi-settings').addEventListener('click', function () { loadSettingsForm(); openSheet('settings-panel'); });
    $('mi-install').addEventListener('click', offerInstall);
    $('i-close').addEventListener('click', function () { closeSheets(); });
    $('mi-reinstall').addEventListener('click', reinstall);
    $('mi-bug').addEventListener('click', function () {
      $('bug-preview').textContent = sensorState() + ' · ' + state.counts.outstanding + ' waiting · build ' + buildLabel();
      $('bug-note').value = '';
      openSheet('bug-panel');
    });
    $('bug-close').addEventListener('click', function () { closeSheets(); });
    $('bug-send').addEventListener('click', function () {
      var note = $('bug-note').value.trim();
      $('bug-send').disabled = true;
      Report.send(Object.assign(reportContext('manual', note || 'Manual report'), { note: note })).then(function (sent) {
        $('bug-send').disabled = false;
        closeSheets();
        if (sent) { Sound.sent(); toast('Report sent — thank you', 'ok'); }
        else toast('Report held — ' + (Report.lastFailure || 'could not send it') + '. It goes up on its own later.', 'warn', 6000);
      });
    });
    $('mi-about').addEventListener('click', function () {
      $('about-body').innerHTML = 'Build <b>' + esc(buildLabel()) + '</b><br>' +
        'Stations: <code>' + esc(Config.stationsUrl()) + '</code><br>Visits: <code>' + esc(Config.visitsUrl()) + '</code><br>' +
        'Bearings are ' + (Config.ref() === 'T' ? 'true north (declination ' + esc(Config.get().declination) + '°)' : 'magnetic') +
        '. The compass is the gyro, kept on north by the magnetometer, so it holds steady with the phone upright.<br>' +
        'Photos are kept at full size, uploaded one at a time in ' + esc(Config.get().partKB) + ' KB chunks, and never sent twice.';
      openSheet('about-panel');
    });
    $('a-close').addEventListener('click', function () { closeSheets(); });

    // settings
    seg('s-north', function (v) { northChoice = v; });
    $('s-save').addEventListener('click', saveSettings);
    $('s-close').addEventListener('click', function () { closeSheets(); });
    $('s-quality').addEventListener('input', function () { $('s-quality-out').textContent = this.value; });

    // sign-in
    $('auth-btn').addEventListener('click', function () {
      if (state.auth) Arc.signOut().then(renderAuth).then(function () { toast('Signed out'); });
      else openSheet('signin-panel');
    });
    $('si-oauth').addEventListener('click', function () { Arc.beginOAuth().catch(function (e) { toast(e.message, 'bad', 4000); }); });
    $('si-go').addEventListener('click', function () {
      var u = $('si-user').value.trim(), p = $('si-pass').value;
      if (!u || !p) return toast('Username and password needed', 'warn');
      $('si-go').disabled = true;
      Arc.signInPassword(u, p).then(function () {
        $('si-pass').value = '';
        Sound.sent();
        toast('Signed in', 'ok');
        return afterSignIn();
      }).catch(function (e) {
        Sound.error();
        toast(errText(e), 'bad', 4000);
      }).then(function () { $('si-go').disabled = false; });
    });
    $('si-token-go').addEventListener('click', function () {
      var t = $('si-token').value.trim();
      if (!t) return;
      Arc.setManualToken(t).then(function () {
        $('si-token').value = '';
        toast('Token stored', 'ok');
        return afterSignIn();
      });
    });
    $('si-close').addEventListener('click', function () { closeSheets(); });

    document.addEventListener('click', function (e) {
      if (e.target.classList && e.target.classList.contains('sheet')) closeSheets();
    });
    window.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeSheets();
      if (e.key === ' ' && state.view === 'cam' && !document.querySelector('.sheet.open')) { e.preventDefault(); capture(); }
    });

    window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); deferredPrompt = e; });
    window.addEventListener('online', function () { setNet(true); });
    window.addEventListener('offline', function () { setNet(false); });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState !== 'visible') { if (state.view === 'cam') stopCamera(true); return; }
      setNet(navigator.onLine);
      refreshCounts().then(function () { if (state.online && Config.get().autoSync) sync(); });
      if (state.view === 'cam') startCamera();
    });
    window.addEventListener('pagehide', function () { stopCamera(); });
  }

  /* ────────────────────────────── boot ────────────────────────────── */

  function boot() {
    watchForProblems();
    Report.note('boot', navigator.userAgent.slice(0, 120));
    buildDial();
    wire();

    Config.load().then(function (c) {
      Sound.setEnabled(c.sound);
      $('mi-about-sub').textContent = 'build ' + buildLabel();
      return Arc.completeOAuth().catch(function (e) {
        toast('Sign-in failed: ' + errText(e), 'bad', 5000);
        return null;
      });
    }).then(function (a) {
      if (a) toast('Signed in as ' + a.username, 'ok');
      return renderAuth();
    }).then(function () {
      // the copy on the phone first: the list works with no signal at all
      return Store.get('stations').then(useStations);
    }).then(function () {
      return Promise.all([Arc.reclaimStranded(), renderDrafts(), refreshCounts()]);
    }).then(function () {
      setNet(navigator.onLine);
      state.online = navigator.onLine;
      $('chip-net').className = 'chip ' + (state.online ? 'ok' : 'bad');
      $('chip-net').querySelector('.label').textContent = state.online ? 'online' : 'offline';
      scheduleSync();
      registerSW();
      startGPS();
      if (needsGesture()) {
        listenOrientation(false);                 // a granted origin streams data with no prompt
        armCompass();
        setTimeout(function () { if (!gotOrientation) armCompass(); }, 1500);
      } else {
        startCompass();
      }
      if (state.auth && state.online) loadStations();
      else refreshMeta();
      return pruneLocalCopies();
    }).then(function () {
      Report.flushHeld();
      if (state.online && state.counts.outstanding && Config.get().autoSync) sync();
      self.__ppReady = true;
    }).catch(function (e) {
      var msg = errText(e);
      toast('Startup problem: ' + msg, 'bad', 6000);
      $('list-status').textContent = 'Something went wrong starting the app: ' + msg;
      $('list-status').className = 'hint bad-text';
      Report.send(reportContext('startup', msg, { stack: Arc.asError(e).stack }));
    });
  }

  // for the test suites and for poking at a misbehaving phone from the console
  self.PhotoPoints = { state: state, tracker: tracker, sync: sync, capture: capture };

  function safeBoot() {
    self.__ppBooted = true;                  // the watchdog in index.html checks this
    try { boot(); } catch (e) {
      $('list-status').textContent = 'The app could not start: ' + (e && e.message);
      $('list-status').className = 'hint bad-text';
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', safeBoot);
  else safeBoot();
})();
