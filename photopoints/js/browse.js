/* Photo Points — the photo browser. A map of the stations; tap one and its
   photos are a grid of dates × directions: flip through the dates and the
   direction stays put; turn round the post and the date stays put; compare
   two dates side by side or with a swipe.

   Reads only. It lives next to the app, so on a phone where Photo Points is
   signed in it is too (same device storage). The ArcGIS experience embeds the
   whole of it (?embed=1); it signs in on its own the first time (an embedded
   page gets its own storage) and shows nothing, not even the map, before
   that. It can also be handed one station: ?station=<GlobalID or StationID>. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var DIRS = ['N', 'E', 'S', 'W'];
  var NAMES = { N: 'North', E: 'East', S: 'South', W: 'West' };
  var GUID = /^\{?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}?$/i;
  var VIEWS = ['b-viewer', 'b-map', 'b-list', 'b-signin'];
  var SDK = 'https://js.arcgis.com/5.1/';               // the ArcGIS Maps SDK, for the map; loaded once signed in

  var state = {
    token: null,
    expires: 0,
    embed: false,
    handed: false,          // embedded and handed a station: the page around us picks the stations
    view: null,             // which of VIEWS is showing
    station: null,          // Arc.normStation()
    visits: [],             // oldest first: { oid, when, attrs, photos: { slot: [att] }, files: [att], count }
    i: 0,                   // the date shown
    j: null,                // the date compared with
    dir: 'N',               // N/E/S/W, or LOCATOR / MISC
    level: 'eye',           // 'eye' | 'ground'
    mode: 'one',            // 'one' | 'side' | 'swipe'
    split: 50,              // swipe divider, % from the left
    pick: {},               // 'oid|slot' → which of several photos in a slot
    stations: null
  };

  /* ───────────────────────────── basics ───────────────────────────── */

  function esc(v) {
    return String(v === null || v === undefined ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function pad(n, w) { return String(n).padStart(w || 2, '0'); }
  function fmtDate(ms) {
    if (!ms) return 'no date';
    var d = new Date(ms);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function fmtWhen(ms) {
    if (!ms) return 'no date';
    var d = new Date(ms);
    return fmtDate(ms) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function fmtBytes(b) { return !b ? '' : b < 1048576 ? Math.round(b / 1024) + ' KB' : (b / 1048576).toFixed(1) + ' MB'; }
  function normGid(g) { return '{' + String(g || '').replace(/[{}]/g, '').toUpperCase() + '}'; }
  function isDir(d) { return DIRS.indexOf(d) >= 0; }

  function show(id) {
    VIEWS.forEach(function (x) { $(x).classList.toggle('hidden', x !== id); });
    state.view = id;
    document.body.dataset.view = id || '';
    renderBar();
  }
  function message(text, kind) {
    var m = $('b-msg');
    m.textContent = text || '';
    m.className = 'msg' + (text ? '' : ' hidden') + (kind ? ' ' + kind : '');
  }

  /** The bar: back where there is somewhere to go back to, the list on the map, the view buttons with a station. */
  function renderBar() {
    var v = state.view;
    $('b-modes').classList.toggle('hidden', v !== 'b-viewer');
    $('b-list-btn').classList.toggle('hidden', v !== 'b-map');
    $('b-back').classList.toggle('hidden', !canGoBack());
    if (v !== 'b-viewer') {
      $('b-title').textContent = 'Photo stations';
      $('b-sub').textContent = v === 'b-map' && map ? 'Tap a station to see its photos' : '';
      document.title = 'Photo stations';
    }
  }

  function canGoBack() {
    if (state.view === 'b-signin') return !state.embed;      // only out, to Photo Points
    if (history.state && history.state.from) return true;   // we came here from the map or the list
    if (!state.embed) return true;                           // the link back to Photo Points
    if (state.handed) return false;
    return state.view === 'b-viewer' || (state.view === 'b-list' && !mapBroken);
  }

  /** A visit's date, with its time when another visit is on the same day. */
  function label(v) {
    var day = fmtDate(v.when);
    var same = state.visits.filter(function (x) { return fmtDate(x.when) === day; }).length > 1;
    return same ? fmtWhen(v.when) : day;
  }

  function slotKey() {
    if (!isDir(state.dir)) return state.dir;
    return (state.level === 'ground' ? 'LOW_' : '') + state.dir;
  }
  function slotName(slot) {
    if (slot === 'LOCATOR') return 'Post';
    if (slot === 'MISC') return 'Misc';
    var low = slot.indexOf('LOW_') === 0;
    return NAMES[low ? slot.slice(4) : slot] + (low ? ' groundcover' : '');
  }

  /* ───────────────────────────── reading ──────────────────────────── */

  function post(path, params) {
    return Arc.postJson(path, Object.assign({ f: 'json', token: state.token }, params));
  }

  function loadStation(ref) {
    var where = GUID.test(ref) ? "GlobalID = '" + normGid(ref) + "'" : "StationID = '" + String(ref).replace(/'/g, "''") + "'";
    return post(Config.stationsUrl() + '/query', { where: where, outFields: '*', returnGeometry: true, outSR: 4326 }).then(function (j) {
      var f = (j.features || [])[0];
      if (!f) throw new Error('There is no station ' + ref + ' on the layer.');
      return Arc.normStation(f);
    });
  }

  /** Every visit to the station, oldest first, with its photos sorted into slots by keyword. */
  function loadVisits(st) {
    var url = Config.visitsUrl();
    return post(url + '/query', {
      where: "StationGUID = '" + st.gid + "'", outFields: '*',
      orderByFields: 'VisitDate ASC,OBJECTID ASC', resultRecordCount: 2000
    }).then(function (j) {
      var visits = (j.features || []).map(function (f) {
        var a = f.attributes || {};
        return { oid: a.OBJECTID, when: a.VisitDate || a.CreationDate || null, attrs: a, photos: {}, files: [], count: 0 };
      });
      visits.sort(function (a, b) { return (a.when || 0) - (b.when || 0) || a.oid - b.oid; });
      var byOid = {};
      visits.forEach(function (v) { byOid[v.oid] = v; });
      var chunks = [];
      for (var k = 0; k < visits.length; k += 50) chunks.push(visits.slice(k, k + 50));
      return chunks.reduce(function (chain, chunk) {
        return chain.then(function () {
          return post(url + '/queryAttachments', {
            objectIds: chunk.map(function (v) { return v.oid; }).join(','), returnMetadata: true
          }).then(function (q) {
            (q.attachmentGroups || []).forEach(function (gr) {
              var v = byOid[gr.parentObjectId];
              if (!v) return;
              (gr.attachmentInfos || []).slice().sort(function (a, b) { return a.id - b.id; }).forEach(function (a) {
                var kw = String(a.keywords || '').trim().toUpperCase();
                var rec = { id: a.id, name: a.name || '', size: a.size, type: a.contentType || '', bearing: Arc.bearingFromName(a.name) };
                if (!/^image\//i.test(rec.type) && !/\.(jpe?g|png|webp|heic)$/i.test(rec.name)) { v.files.push(rec); return; }
                var slot = Config.slot(kw) ? kw : 'MISC';         // a photo with no keyword is still worth seeing
                (v.photos[slot] = v.photos[slot] || []).push(rec);
                v.count++;
              });
            });
          });
        });
      }, Promise.resolve()).then(function () { return visits; });
    });
  }

  /* Photos are fetched with the token and shown from memory (blob: addresses),
     so the token is never in the page: not in an image address someone copies,
     not in a link, not in the browser's history. */
  function attUrl(v, att, full) {
    var w = Math.max(screen.width || 0, screen.height || 0) * (window.devicePixelRatio || 1);
    var size = w > 2200 ? 2048 : w > 1400 ? 1600 : 1280;
    return Config.visitsUrl() + '/' + v.oid + '/attachments/' + att.id + '?' +
      (full ? '' : 'w=' + size + '&') + 'token=' + encodeURIComponent(state.token);
  }

  function fetchBlob(url) {
    return fetch(url).then(function (r) {
      if (r.status === 498 || r.status === 499) throw Arc.NeedAuth('Sign in again');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      if (/json/i.test(r.headers.get('content-type') || '')) {      // ArcGIS answers a bad token with JSON
        return r.json().then(function (j) {
          var e = (j && j.error) || {};
          if (e.code === 498 || e.code === 499) throw Arc.NeedAuth('Sign in again');
          throw new Error(e.message || 'Not a photo');
        });
      }
      return r.blob();
    });
  }

  var blobs = {}, blobCount = 0;            // 'oid/id' → { p: Promise<object URL>, url, at }
  function getPhoto(v, att) {
    var key = v.oid + '/' + att.id, hit = blobs[key];
    if (hit) { hit.at = Date.now(); return hit.p; }
    var rec = { at: Date.now(), url: null };
    rec.p = fetchBlob(attUrl(v, att)).then(function (b) { rec.url = URL.createObjectURL(b); return rec.url; });
    rec.p.catch(function () { if (blobs[key] === rec) { delete blobs[key]; blobCount--; } });
    blobs[key] = rec;
    blobCount++;
    trimPhotos();
    return rec.p;
  }

  /** Keep the 40 most recently used photos in memory, never the ones on screen. */
  function trimPhotos() {
    if (blobCount <= 40) return;
    var onScreen = {};
    ['pane-a', 'pane-b'].forEach(function (id) { onScreen[$(id).querySelector('img').getAttribute('src')] = true; });
    Object.keys(blobs).sort(function (a, b) { return blobs[a].at - blobs[b].at; }).some(function (k) {
      if (blobCount <= 40) return true;
      var r = blobs[k];
      if (!r.url || onScreen[r.url]) return false;
      URL.revokeObjectURL(r.url);
      delete blobs[k];
      blobCount--;
      return false;
    });
  }

  function forgetPhotos() {
    Object.keys(blobs).forEach(function (k) { if (blobs[k].url) URL.revokeObjectURL(blobs[k].url); });
    blobs = {};
    blobCount = 0;
    shown = {};
    ['pane-a', 'pane-b'].forEach(function (id) { $(id).querySelector('img').removeAttribute('src'); });
  }

  function photosAt(i, slot) {
    var v = state.visits[i];
    return v ? v.photos[slot] || [] : [];
  }
  function pickAt(i, slot) {
    var list = photosAt(i, slot);
    if (!list.length) return null;
    var n = (state.pick[state.visits[i].oid + '|' + slot] || 0) % list.length;
    return { att: list[n], n: n, of: list.length };
  }

  /* ───────────────────────────── moving ───────────────────────────── */

  /** Clockwise for +1: N → E → S → W. From the post or misc, right is North and left is West. */
  function turn(step) {
    var k = DIRS.indexOf(state.dir);
    if (k < 0) k = step > 0 ? -1 : 0;
    state.dir = DIRS[(k + step + 4) % 4];
    render();
  }

  /** A slot with several photos on one visit: step through them, round and round. */
  function pageSlot(i, step) {
    var v = state.visits[i], n = photosAt(i, slotKey()).length;
    if (!v || n < 2) return false;
    var k = v.oid + '|' + slotKey();
    state.pick[k] = (((state.pick[k] || 0) + step) % n + n) % n;
    render();
    return true;
  }

  /** The arrows at the photo's sides: turn round the post — or at the post and in misc, the next photo there. */
  function edge(step) {
    if (isDir(state.dir)) turn(step);
    else pageSlot(state.i, step);
  }

  function face(dir) {
    state.dir = dir;
    render();
  }

  function flip(step) {
    var i = state.i + step;
    if (i < 0 || i >= state.visits.length) { nudge(step > 0 ? 'b-newer' : 'b-older'); return; }
    state.i = i;
    if (state.j === i) state.j = otherDate(i);
    render();
  }

  function setDate(i) {
    state.i = i;
    if (state.j === i) state.j = otherDate(i);
    render();
  }

  /** What to compare a date with: the nearest other visit with a photo this way, earlier first. */
  function otherDate(i) {
    if (state.visits.length < 2) return null;
    var slot = slotKey();
    for (var d = 1; d < state.visits.length; d++) {
      if (i - d >= 0 && photosAt(i - d, slot).length) return i - d;
      if (i + d < state.visits.length && photosAt(i + d, slot).length) return i + d;
    }
    return i > 0 ? i - 1 : i + 1;
  }

  /** The latest visit with a photo in this slot — a visit of extra photos only is not where to start. */
  function latestWith(slot) {
    for (var i = state.visits.length - 1; i >= 0; i--) if (photosAt(i, slot).length) return i;
    return Math.max(0, state.visits.length - 1);
  }

  function setMode(m) {
    state.mode = m;
    if (m !== 'one' && (state.j === null || state.j === state.i)) state.j = otherDate(state.i);
    render();
  }

  function nudge(id) {
    var b = $(id);
    b.classList.remove('nudge');
    void b.offsetWidth;
    b.classList.add('nudge');
  }

  /* ───────────────────────────── drawing ──────────────────────────── */

  function render() {
    if (!state.station) return;
    renderHeader();
    renderStage();
    renderDirs();
    renderDates();
    renderDetails();
    saveHash();
    preload();
  }

  function renderHeader() {
    var st = state.station, n = state.visits.length;
    $('b-title').textContent = st.id;
    $('b-sub').textContent = [st.site, n + ' visit' + (n === 1 ? '' : 's')].filter(Boolean).join(' · ');
    document.title = st.id + ' — photos';
    Array.prototype.forEach.call($('b-modes').children, function (b) {
      b.classList.toggle('on', b.dataset.mode === state.mode);
      b.disabled = b.dataset.mode !== 'one' && n < 2;
    });
  }

  var shown = {};                       // pane id → the photo ('oid/id') it was last asked to show

  function renderPane(el, i, side) {
    var slot = slotKey(), v = state.visits[i], p = v ? pickAt(i, slot) : null;
    var img = el.querySelector('img'), empty = el.querySelector('.empty'), cap = el.querySelector('figcaption'),
      tag = el.querySelector('.slotlabel'), pager = el.querySelector('.pager');
    tag.textContent = slotName(slot);
    tag.classList.toggle('hidden', !v);
    cap.classList.toggle('hidden', !v);
    pager.classList.toggle('hidden', !p || p.of < 2);
    if (p && p.of > 1) pager.querySelector('span').textContent = (p.n + 1) + ' of ' + p.of;
    if (!v) {
      img.classList.add('hidden');
      empty.classList.remove('hidden');
      empty.textContent = 'No visits yet';
      return;
    }
    cap.textContent = (side ? side + ' · ' : '') + label(v) +
      (p && p.att.bearing ? ' · ' + pad(p.att.bearing.deg, 3) + '°' + p.att.bearing.ref : '');
    if (!p) {
      img.classList.add('hidden');
      img.removeAttribute('src');
      shown[el.id] = null;
      var others = Object.keys(v.photos).length;
      empty.innerHTML = 'No ' + esc(slotName(slot).toLowerCase()) + ' photo on ' + esc(label(v)) +
        (others ? '<small>' + v.count + ' other photo' + (v.count === 1 ? '' : 's') + ' on this visit</small>' : '<small>No photos on this visit</small>');
      empty.classList.remove('hidden');
      return;
    }
    var key = v.oid + '/' + p.att.id;
    if (shown[el.id] !== key) {
      shown[el.id] = key;
      img.dataset.att = key;
      el.classList.add('loading');
      var broken = function (e) {
        if (shown[el.id] !== key) return;
        el.classList.remove('loading');
        if (e && Arc.asError(e).needAuth) return failed(e);
        img.classList.add('hidden');
        empty.innerHTML = 'This photo could not be loaded<small>' + esc(p.att.name) + '</small>';
        empty.classList.remove('hidden');
      };
      img.onload = function () { if (shown[el.id] === key) el.classList.remove('loading'); };
      img.onerror = function () { broken(null); };
      getPhoto(v, p.att).then(function (url) { if (shown[el.id] === key) img.src = url; }, broken);
    }
    img.alt = slotName(slot) + ' photo, ' + label(v) + (p.of > 1 ? ', ' + (p.n + 1) + ' of ' + p.of : '');
    img.classList.remove('hidden');
    empty.classList.add('hidden');
  }

  function renderStage() {
    var stage = $('b-stage'), two = state.mode !== 'one' && state.j !== null;
    stage.className = 'stage ' + (two ? state.mode : 'one');
    renderPane($('pane-a'), state.i, two ? 'A' : '');
    if (two) renderPane($('pane-b'), state.j, 'B');
    $('pane-b').classList.toggle('hidden', !two);
    var swipe = two && state.mode === 'swipe';
    $('b-split').classList.toggle('hidden', !swipe);
    $('b-divider').classList.toggle('hidden', !swipe);
    applySplit();
    // at the post and in misc the side arrows step through that slot's photos; with one photo there is nowhere to go
    var paging = !isDir(state.dir), many = photosAt(state.i, slotKey()).length > 1;
    [['b-turn-left', 'Turn left', 'Previous photo here', '←'], ['b-turn-right', 'Turn right', 'Next photo here', '→']].forEach(function (b) {
      var el = $(b[0]), what = paging ? b[2] : b[1];
      el.classList.toggle('hidden', paging && !many);
      el.setAttribute('aria-label', what);
      el.title = what + ' (' + b[3] + ')';
    });
  }

  /** In swipe mode A covers the left of the stage up to the divider, B shows on the right. */
  function applySplit() {
    var swipe = state.mode === 'swipe' && state.j !== null;
    $('pane-a').style.clipPath = swipe ? 'inset(0 ' + (100 - state.split) + '% 0 0)' : '';
    $('b-divider').style.left = state.split + '%';
    $('b-split').value = state.split;
  }

  function renderDirs() {
    var slot = slotKey();
    Array.prototype.forEach.call(document.querySelectorAll('[data-dir]'), function (b) {
      var d = b.dataset.dir;
      var key = isDir(d) ? (state.level === 'ground' ? 'LOW_' : '') + d : d;
      b.classList.toggle('on', key === slot);
      b.classList.toggle('none', !photosAt(state.i, key).length);
      b.setAttribute('aria-pressed', key === slot);
    });
    Array.prototype.forEach.call($('b-level').children, function (b) {
      b.classList.toggle('on', b.dataset.level === state.level && isDir(state.dir));
    });
  }

  function renderDates() {
    var slot = slotKey(), two = state.mode !== 'one';
    var chips = $('b-chips');
    chips.innerHTML = state.visits.map(function (v, i) {
      var has = photosAt(i, slot).length > 0;
      return '<button class="chip' + (i === state.i ? ' on' : '') + (two && i === state.j ? ' with' : '') + (has ? '' : ' none') +
        '" data-i="' + i + '" aria-pressed="' + (i === state.i) + '" title="' + esc(fmtWhen(v.when) + (has ? '' : ' — no ' + slotName(slot).toLowerCase() + ' photo')) + '">' +
        esc(label(v)) + '</button>';
    }).join('');
    var on = chips.querySelector('.chip.on');
    if (on) {                                            // keep the date shown in the middle of the strip
      var cr = chips.getBoundingClientRect(), br = on.getBoundingClientRect();
      chips.scrollBy({ left: (br.left + br.width / 2) - (cr.left + cr.width / 2), behavior: 'smooth' });
    }
    $('b-older').disabled = state.i <= 0;
    $('b-newer').disabled = state.i >= state.visits.length - 1;
    $('b-with-row').classList.toggle('hidden', !two || state.visits.length < 2);
    if (two) {
      $('b-with').innerHTML = state.visits.map(function (v, i) {
        return '<option value="' + i + '"' + (i === state.j ? ' selected' : '') + '>' + esc(fmtWhen(v.when)) + (i === state.i ? ' (A)' : '') + '</option>';
      }).join('');
    }
  }

  function renderDetails() {
    var v = state.visits[state.i];
    if (!v) { $('b-details').innerHTML = ''; return; }
    var a = v.attrs, slot = slotKey(), p = pickAt(state.i, slot);
    var rows = [
      ['Visit', fmtWhen(v.when)],
      ['Observer', a.Observer], ['Event', a.MonitoringEvent], ['Post', a.PostCondition], ['Notes', a.Notes],
      ['Photos', v.count + ' on this visit']
    ];
    var html = rows.filter(function (r) { return r[1]; }).map(function (r) {
      return '<dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd>';
    }).join('');
    if (p) {
      html += '<dt>This photo</dt><dd>' + esc(p.att.name) + (p.att.size ? ' · ' + esc(fmtBytes(p.att.size)) : '') +
        ' · <button class="linkish" data-full="photo">full size</button></dd>';
    }
    if (v.files.length) {
      html += '<dt>Files</dt><dd>' + v.files.map(function (f, n) {
        return '<button class="linkish" data-full="' + n + '">' + esc(f.name || 'file') + '</button>';
      }).join(', ') + '</dd>';
    }
    $('b-details').innerHTML = html;
  }

  /* Neighbouring photos load ahead, so flipping, turning and paging do not wait. */
  function preload() {
    var slot = slotKey(), want = [];
    var at = function (i, s) { var p = state.visits[i] && pickAt(i, s); if (p) want.push([state.visits[i], p.att]); };
    at(state.i - 1, slot); at(state.i + 1, slot);
    var here = photosAt(state.i, slot), cur = pickAt(state.i, slot);
    if (cur && here.length > 1) {
      want.push([state.visits[state.i], here[(cur.n + 1) % here.length]]);
      want.push([state.visits[state.i], here[(cur.n + here.length - 1) % here.length]]);
    }
    var k = DIRS.indexOf(state.dir);
    if (k >= 0) {
      var pre = state.level === 'ground' ? 'LOW_' : '';
      at(state.i, pre + DIRS[(k + 1) % 4]); at(state.i, pre + DIRS[(k + 3) % 4]);
      at(state.i, (pre ? '' : 'LOW_') + state.dir);
    }
    want.forEach(function (w) { getPhoto(w[0], w[1]).catch(function () { /* shown as it comes up */ }); });
  }

  /* ─────────────── full size, in the page: zoom with the wheel or a pinch, drag to look round ─────────────── */

  var fullUrl = null, fullGen = 0;
  var zoom = null;                      // { img, w, h: its pixels; s: scale; x, y: its top left; fit, max }

  function fullOf(i) {
    var v = state.visits[i], p = v && pickAt(i, slotKey());
    if (p) openFull(v, p.att);
  }

  function openFull(v, att) {
    var body = $('b-full-body'), gen = ++fullGen;
    $('b-full-name').textContent = att.name || 'file';
    body.innerHTML = '<p class="hint">Loading the full-size file…</p>';
    zoom = null;
    zoomButtons();
    if ($('b-full').classList.contains('hidden')) {
      $('b-full').classList.remove('hidden');
      // so the phone's back button closes the photo rather than leaving the station
      history.pushState(Object.assign({}, history.state, { full: true }), '', location.href);
    }
    return fetchBlob(attUrl(v, att, true)).then(function (b) {
      if (gen !== fullGen) return;
      if (fullUrl) URL.revokeObjectURL(fullUrl);
      fullUrl = URL.createObjectURL(b);
      body.innerHTML = '';
      var type = att.type || b.type || '';
      if (/^image\//i.test(type) || /\.(jpe?g|png|webp)$/i.test(att.name)) {
        var im = document.createElement('img');
        im.alt = att.name;
        im.draggable = false;
        im.onload = function () {
          if (gen !== fullGen) return;
          zoom = { img: im, w: im.naturalWidth || 1, h: im.naturalHeight || 1 };
          fitZoom();
        };
        im.src = fullUrl;
        body.appendChild(im);
      } else if (/pdf/i.test(type) || /\.pdf$/i.test(att.name)) {
        var fr = document.createElement('iframe');
        fr.title = att.name;
        fr.src = fullUrl;
        body.appendChild(fr);
      } else {
        var a = document.createElement('a');
        a.className = 'btn';
        a.href = fullUrl;
        a.download = att.name || 'file';
        a.textContent = 'Save ' + (att.name || 'the file');
        body.appendChild(a);
      }
    }).catch(function (e) {
      if (gen !== fullGen) return;
      e = Arc.asError(e);
      if (e.needAuth) { closeFull(); failed(e); return; }
      body.innerHTML = '<p class="hint">Could not load it: ' + esc(e.message) + '</p>';
    });
  }

  /** Close it — through the history entry it opened with, when it is still the current one. */
  function closeFull() {
    if ($('b-full').classList.contains('hidden')) return;
    if (history.state && history.state.full) history.back();     // popstate hides it
    else hideFull();
  }

  function hideFull() {
    fullGen++;
    zoom = null;
    $('b-full').classList.add('hidden');
    $('b-full-body').innerHTML = '';
    if (fullUrl) { URL.revokeObjectURL(fullUrl); fullUrl = null; }
  }

  function bodyBox() { return $('b-full-body').getBoundingClientRect(); }

  /** How small (the whole photo on screen) and how big (3 screen pixels to each of its own) it can go. */
  function measure() {
    var b = bodyBox();
    zoom.fit = Math.min(b.width / zoom.w, b.height / zoom.h) || 1;
    zoom.max = Math.max(zoom.fit * 4, 3);
  }

  function fitZoom() {
    if (!zoom) return;
    measure();
    zoom.s = zoom.fit;
    drawZoom();
  }

  /** Keep the photo on screen: centred along a side where it is smaller than the screen, edge to edge where it is bigger. */
  function drawZoom() {
    var b = bodyBox(), iw = zoom.w * zoom.s, ih = zoom.h * zoom.s;
    zoom.x = iw <= b.width ? (b.width - iw) / 2 : Math.min(0, Math.max(b.width - iw, zoom.x));
    zoom.y = ih <= b.height ? (b.height - ih) / 2 : Math.min(0, Math.max(b.height - ih, zoom.y));
    zoom.img.style.transform = 'translate(' + zoom.x + 'px, ' + zoom.y + 'px) scale(' + zoom.s + ')';
    zoomButtons();
  }

  /** Zoom by f, keeping the point at (cx, cy) in the viewer — its middle unless given — where it is. */
  function zoomBy(f, cx, cy) {
    if (!zoom) return;
    var b = bodyBox();
    if (cx === undefined) { cx = b.width / 2; cy = b.height / 2; }
    var s = Math.max(zoom.fit, Math.min(zoom.max, zoom.s * f));
    zoom.x = cx - (cx - zoom.x) * (s / zoom.s);
    zoom.y = cy - (cy - zoom.y) * (s / zoom.s);
    zoom.s = s;
    drawZoom();
  }

  function zoomButtons() {
    var on = !!zoom;
    ['b-zoom-out', 'b-zoom-fit', 'b-zoom-in'].forEach(function (id) { $(id).classList.toggle('hidden', !on); });
    if (!on) return;
    $('b-zoom-out').disabled = $('b-zoom-fit').disabled = zoom.s <= zoom.fit * 1.001;
    $('b-zoom-in').disabled = zoom.s >= zoom.max * 0.999;
  }

  function wireZoom() {
    var body = $('b-full-body'), pts = {}, moved = false, down = null, lastTap = null;
    var count = function () { return Object.keys(pts).length; };
    body.addEventListener('wheel', function (e) {
      if (!zoom) return;
      e.preventDefault();
      var b = bodyBox(), d = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? b.height : 1);
      zoomBy(Math.exp(-d * (e.ctrlKey ? 0.01 : 0.002)), e.clientX - b.left, e.clientY - b.top);   // ctrl: a trackpad pinch
    }, { passive: false });
    body.addEventListener('dragstart', function (e) { e.preventDefault(); });
    body.addEventListener('pointerdown', function (e) {
      if (!zoom || e.button > 0) return;
      body.setPointerCapture(e.pointerId);
      pts[e.pointerId] = { x: e.clientX, y: e.clientY };
      if (count() === 1) { moved = false; down = { x: e.clientX, y: e.clientY }; } else moved = true;
      zoom.img.classList.add('dragging');
    });
    body.addEventListener('pointermove', function (e) {
      var prev = pts[e.pointerId];
      if (!zoom || !prev) return;
      var cur = { x: e.clientX, y: e.clientY };
      if (down && Math.abs(cur.x - down.x) + Math.abs(cur.y - down.y) > 8) moved = true;
      var ids = Object.keys(pts);
      if (ids.length === 1) {                                          // drag to look round
        zoom.x += cur.x - prev.x;
        zoom.y += cur.y - prev.y;
        pts[e.pointerId] = cur;
        drawZoom();
      } else if (ids.length === 2) {                                   // pinch: zoom about the fingers, move with them
        var other = pts[ids[0] === String(e.pointerId) ? ids[1] : ids[0]], b = bodyBox();
        var d0 = Math.hypot(prev.x - other.x, prev.y - other.y), d1 = Math.hypot(cur.x - other.x, cur.y - other.y);
        zoom.x += (cur.x - prev.x) / 2;
        zoom.y += (cur.y - prev.y) / 2;
        pts[e.pointerId] = cur;
        if (d0 > 0) zoomBy(d1 / d0, (cur.x + other.x) / 2 - b.left, (cur.y + other.y) / 2 - b.top); else drawZoom();
      }
    });
    var lift = function (e) {
      if (!pts[e.pointerId]) return false;
      var single = count() === 1;
      delete pts[e.pointerId];
      if (!count() && zoom) zoom.img.classList.remove('dragging');
      return single;
    };
    body.addEventListener('pointerup', function (e) {
      if (!lift(e) || moved || !zoom) return;
      // a double tap or double click: in, there — or back out to the whole photo
      var now = Date.now();
      if (lastTap && now - lastTap.t < 350 && Math.abs(e.clientX - lastTap.x) < 30 && Math.abs(e.clientY - lastTap.y) < 30) {
        lastTap = null;
        var b = bodyBox();
        if (zoom.s > zoom.fit * 1.05) fitZoom(); else zoomBy(3, e.clientX - b.left, e.clientY - b.top);
      } else lastTap = { t: now, x: e.clientX, y: e.clientY };
    });
    body.addEventListener('pointercancel', lift);
    $('b-zoom-in').addEventListener('click', function () { zoomBy(1.6); });
    $('b-zoom-out').addEventListener('click', function () { zoomBy(1 / 1.6); });
    $('b-zoom-fit').addEventListener('click', fitZoom);
    window.addEventListener('resize', function () {
      if (!zoom) return;
      var atFit = zoom.s <= zoom.fit * 1.001;
      measure();
      if (atFit) zoom.s = zoom.fit;
      zoom.s = Math.max(zoom.fit, Math.min(zoom.max, zoom.s));
      drawZoom();
    });
  }

  /* ───────────────────────── where we are (in the URL) ───────────────────────── */

  function saveHash() {
    var v = state.visits[state.i], w = state.j !== null ? state.visits[state.j] : null;
    var h = 'v=' + (v ? v.oid : '') + '&d=' + state.dir + '&l=' + state.level + '&m=' + state.mode + (w ? '&w=' + w.oid : '');
    if (location.hash.slice(1) !== h) history.replaceState(history.state, '', location.pathname + location.search + '#' + h);
  }

  /** The view in the address, or a fresh start: North at eye level on the latest visit with a North photo. */
  function readHash() {
    var p = new URLSearchParams(location.hash.slice(1));
    var find = function (oid) {
      for (var i = 0; i < state.visits.length; i++) if (String(state.visits[i].oid) === oid) return i;
      return -1;
    };
    var d = p.get('d'), m = p.get('m');
    state.dir = d && (isDir(d) || d === 'LOCATOR' || d === 'MISC') ? d : 'N';
    state.level = p.get('l') === 'ground' ? 'ground' : 'eye';
    state.mode = m === 'side' || m === 'swipe' ? m : 'one';
    var i = find(p.get('v') || ''), j = find(p.get('w') || '');
    state.i = i >= 0 ? i : latestWith(slotKey());
    state.j = j >= 0 && j !== state.i ? j : state.mode !== 'one' ? otherDate(state.i) : null;
  }

  /* ───────────────────────────── stations ─────────────────────────── */

  function openStation(ref) {
    message('Loading…');
    return loadStation(ref).then(function (st) {
      state.station = st;
      return loadVisits(st);
    }).then(function (visits) {
      state.visits = visits;
      state.pick = {};
      shown = {};
      readHash();
      message(visits.length ? '' : 'No visits at ' + state.station.id + ' yet.');
      show('b-viewer');
      render();
    }).catch(failed);
  }

  function openList() {
    message('Loading stations…');
    show('b-list');
    return Arc.stations(true).then(function (rec) {
      state.stations = rec;
      message(rec.stale ? 'Offline copy of the stations' : '');
      renderList();
    }).catch(failed);
  }

  function renderList() {
    var rec = state.stations;
    if (!rec) return;
    var q = $('b-search').value.trim().toLowerCase();
    var list = rec.list.filter(function (s) {
      return !q || (s.id + ' ' + s.site + ' ' + s.mu).toLowerCase().indexOf(q) !== -1;
    }).sort(function (a, b) { return String(a.id).localeCompare(String(b.id), undefined, { numeric: true }); });
    $('b-list-status').textContent = list.length + ' station' + (list.length === 1 ? '' : 's') + (q ? ' matching' : '');
    $('b-stations').innerHTML = list.map(function (s) {
      var st = rec.stats[s.gid] || {};
      return '<button class="strow" role="listitem" data-gid="' + esc(s.gid) + '"><b>' + esc(s.id) + '</b><span>' +
        esc([s.site, st.count ? st.count + ' visit' + (st.count === 1 ? '' : 's') + ', last ' + fmtDate(st.last) : 'no visits yet'].filter(Boolean).join(' · ')) +
        '</span></button>';
    }).join('');
  }

  /** Move within the page, so the back button (ours or the phone's) comes back to `from`. */
  function go(params, from) {
    var q = new URLSearchParams(params);
    if (state.embed) q.set('embed', '1');
    history.pushState({ from: from }, '', location.pathname + '?' + q.toString());
    routed = location.search;
  }

  function pickStation(gid, from) {
    go({ station: gid }, from);
    return openStation(gid);
  }

  /* ───────────────────────────── the map ──────────────────────────── */

  var map = null;                // { view, layer, Graphic, me } once it is up
  var mapLoad = null, mapGen = 0, mapBroken = false, sdkLoad = null, IM = null;

  function timeout(p, ms, what) {
    return Promise.race([p, new Promise(function (resolve, reject) {
      setTimeout(function () { reject(new Error(what + ' took too long')); }, ms);
    })]);
  }

  /** The SDK, from its own site: a stylesheet, a module that sets up $arcgis.import, and the parts used here. */
  function sdk() {
    if (sdkLoad) return sdkLoad;
    sdkLoad = new Promise(function (resolve, reject) {
      if (!document.querySelector('link[data-sdk]')) {
        var css = document.createElement('link');
        css.rel = 'stylesheet';
        css.href = SDK + 'esri/themes/light/main.css';
        css.dataset.sdk = '1';
        document.head.appendChild(css);
      }
      var s = document.createElement('script');
      s.type = 'module';
      s.src = SDK + 'core.js';
      s.onload = function () {
        if (self.$arcgis && self.$arcgis.import) resolve(self.$arcgis);
        else reject(new Error('the map library did not start'));
      };
      s.onerror = function () { s.remove(); reject(new Error('the map library did not load')); };
      document.head.appendChild(s);
    }).then(function (arcgis) {
      // its loader never says when a part fails to arrive, so give up after a while
      return timeout(arcgis.import(['@arcgis/core/identity/IdentityManager.js', '@arcgis/core/WebMap.js',
        '@arcgis/core/views/MapView.js', '@arcgis/core/layers/FeatureLayer.js', '@arcgis/core/Graphic.js']), 60000, 'the map library');
    });
    sdkLoad.catch(function () { sdkLoad = null; });          // the next try starts again
    return sdkLoad;
  }

  /** The token, for the SDK's own requests: the portal (the web map) and the layer's server. */
  function sdkToken() {
    if (!IM) return;
    IM.destroyCredentials();
    if (!state.token) return;
    var portal = String(Config.get().portal).replace(/\/+$/, '');
    [portal + '/sharing/rest', Config.serviceUrl().replace(/(\/rest\/services)\/.*$/i, '$1')].forEach(function (server) {
      IM.registerToken({ server: server, token: state.token, expires: state.expires || Date.now() + 3600e3, ssl: true });
    });
  }

  /** The station layer in the web map — or, if the web map lost it, the layer itself. */
  function stationLayer(wm, FeatureLayer) {
    var svc = Config.serviceUrl().toLowerCase(), want = Config.get().stationsLayer | 0;
    var layer = wm.allLayers.find(function (l) {
      if (l.type !== 'feature' || !l.url) return false;
      var u = String(l.url).toLowerCase().replace(/\/+$/, ''), id = /\/(\d+)$/.exec(u);
      var n = typeof l.layerId === 'number' ? l.layerId : id ? +id[1] : 0;
      return u.replace(/\/\d+$/, '').replace(/^http:/, 'https:') === svc && n === want;
    });
    if (!layer) {
      layer = new FeatureLayer({ url: Config.stationsUrl() });
      wm.add(layer);
    }
    return layer;
  }

  function loadMap(gen) {
    return sdk().then(function (mods) {
      if (gen !== mapGen) throw new Error('signed out');
      IM = mods[0];
      sdkToken();
      var WebMap = mods[1], MapView = mods[2], FeatureLayer = mods[3], Graphic = mods[4];
      var wm = new WebMap({ portalItem: { id: Config.get().webMap } });
      return timeout(wm.load(), 45000, 'the map').then(function () {
        if (gen !== mapGen) throw new Error('signed out');
        var layer = stationLayer(wm, FeatureLayer);
        layer.outFields = ['GlobalID', 'StationID'];
        layer.popupEnabled = false;
        var view = new MapView({ container: 'b-mapdiv', map: wm, popupEnabled: false });
        return timeout(view.when(), 45000, 'the map').then(function () {
          var m = { view: view, layer: layer, Graphic: Graphic, me: null };
          wireMap(m);
          return m;
        }, function (e) { view.destroy(); throw e; });
      });
    });
  }

  function wireMap(m) {
    var view = m.view, busy = false;
    var hit = function (e) {
      return view.hitTest(e, { include: [m.layer] }).then(function (r) {
        var g = (r.results || []).filter(function (x) { return x.graphic && x.graphic.layer === m.layer; })[0];
        return g ? g.graphic : null;
      });
    };
    view.on('click', function (e) {
      hit(e).then(function (g) {
        if (!g) return;
        if (g.isAggregate) { view.goTo({ target: g.geometry, zoom: view.zoom + 2 }); return; }   // a cluster
        var gid = g.attributes && g.attributes.GlobalID;
        if (gid && state.view === 'b-map') pickStation(normGid(gid), 'map');
      });
    });
    view.on('pointer-move', function (e) {
      if (busy || e.pointerType !== 'mouse') return;
      busy = true;
      hit(e).then(function (g) { $('b-mapdiv').style.cursor = g ? 'pointer' : ''; }, function () { /* the cursor can wait */ })
        .then(function () { busy = false; });
    });
  }

  function openMap() {
    show('b-map');
    if (map) { message(''); renderBar(); return Promise.resolve(); }
    if (!mapLoad) {
      var gen = mapGen;
      message('Loading the map…');
      mapLoad = loadMap(gen).then(function (m) {
        if (gen !== mapGen) { m.view.destroy(); return; }
        map = m;
        mapBroken = false;
        if (state.view === 'b-map') { message(''); renderBar(); }
      }, function (e) {
        mapLoad = null;
        if (gen !== mapGen) return;
        e = Arc.asError(e);
        if (e.needAuth) return failed(e);
        mapBroken = true;
        if (state.view !== 'b-map') return;
        // the list does the same job
        return openList().then(function () {
          if (state.view === 'b-list') message('The map did not load (' + e.message + '), so here is the list of stations.', 'bad');
        });
      });
    }
    return mapLoad;
  }

  /** Where am I: a dot, and the map goes there. */
  function locate() {
    if (!map || !navigator.geolocation) return;
    message('Finding where you are…');
    navigator.geolocation.getCurrentPosition(function (p) {
      message('');
      if (!map) return;
      var pt = { type: 'point', longitude: p.coords.longitude, latitude: p.coords.latitude };
      if (map.me) map.view.graphics.remove(map.me);
      map.me = new map.Graphic({ geometry: pt, symbol: { type: 'simple-marker', color: [31, 99, 224], size: 14, outline: { color: [255, 255, 255], width: 2 } } });
      map.view.graphics.add(map.me);
      map.view.goTo({ target: map.me.geometry, zoom: Math.max(map.view.zoom, 17) });   // a real Point: goTo does not cast
    }, function (e) {
      message('Could not tell where you are: ' + e.message, 'bad');
    }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 30000 });
  }

  /** Signed out: the map goes, and the SDK forgets the token. */
  function dropMap() {
    mapGen++;
    mapLoad = null;
    mapBroken = false;
    if (map) { map.view.destroy(); map = null; }
    if (IM) IM.destroyCredentials();
    $('b-mapdiv').innerHTML = '';
  }

  /* ───────────────────────────── signing in ───────────────────────── */

  function failed(e) {
    e = Arc.asError(e);
    if (e.needAuth) { state.token = null; message(''); show('b-signin'); return; }
    message(e.retryable ? 'No connection to ArcGIS — ' + e.message : e.message, 'bad');
  }

  function signedIn() {
    return Arc.token().then(function (t) {
      state.token = t;
      return Arc.getAuth();
    }).then(function (a) {
      state.expires = (a && a.expires) || 0;
      sdkToken();
      return route();
    }, failed);
  }

  /** Off this device: the token goes, and so do the map and every photo held in memory. */
  function signOut() {
    hideFull();
    dropMap();
    return Arc.signOut().then(function () {
      state.token = null;
      state.expires = 0;
      state.station = null;
      state.visits = [];
      state.stations = null;
      $('b-stations').innerHTML = '';
      forgetPhotos();
      message('Signed out.');
      show('b-signin');
    });
  }

  /* ───────────────────────────── wiring ───────────────────────────── */

  var routed = null;             // the address last acted on

  function route() {
    routed = location.search;
    var q = new URLSearchParams(location.search);
    var ref = (q.get('station') || '').replace(/﻿/g, '').trim();
    // the experience can load us once with its field placeholder before the station it means
    if (/\{[A-Za-z_]+\}/.test(ref)) { show(null); message('Loading the station…'); return Promise.resolve(); }
    if (ref) return openStation(ref);
    if (q.get('view') === 'list') return openList();
    return openMap();
  }

  function goBack(e) {
    if (state.view !== 'b-signin' && history.state && history.state.from) { e.preventDefault(); history.back(); return; }
    if (!state.embed) return;                               // the link: back to Photo Points
    e.preventDefault();
    history.replaceState(null, '', location.pathname + '?embed=1');
    route();
  }

  function wire() {
    $('b-back').addEventListener('click', goBack);
    $('b-turn-left').addEventListener('click', function () { edge(-1); });
    $('b-turn-right').addEventListener('click', function () { edge(1); });
    $('b-older').addEventListener('click', function () { flip(-1); });
    $('b-newer').addEventListener('click', function () { flip(1); });
    $('b-chips').addEventListener('click', function (e) {
      var b = e.target.closest('[data-i]');
      if (b) setDate(+b.dataset.i);
    });
    $('b-with').addEventListener('change', function () { state.j = +this.value; render(); });
    Array.prototype.forEach.call(document.querySelectorAll('[data-dir]'), function (b) {
      b.addEventListener('click', function () { face(b.dataset.dir); });
    });
    Array.prototype.forEach.call($('b-level').children, function (b) {
      b.addEventListener('click', function () {
        state.level = b.dataset.level;
        if (!isDir(state.dir)) state.dir = 'N';
        render();
      });
    });
    Array.prototype.forEach.call($('b-modes').children, function (b) {
      b.addEventListener('click', function () { if (!b.disabled) setMode(b.dataset.mode); });
    });
    $('b-split').addEventListener('input', function () { state.split = +this.value; applySplit(); });
    $('b-list-btn').addEventListener('click', function () { go({ view: 'list' }, 'map'); openList(); });
    $('b-locate').addEventListener('click', locate);
    $('b-search').addEventListener('input', renderList);
    $('b-details').addEventListener('click', function (e) {
      var b = e.target.closest('[data-full]'), v = state.visits[state.i];
      if (!b || !v) return;
      if (b.dataset.full === 'photo') return fullOf(state.i);
      var att = v.files[+b.dataset.full];
      if (att) openFull(v, att);
    });
    // on each photo: full size at the top right, and ‹ 1 of 3 › for a slot with several photos
    $('b-stage').addEventListener('click', function (e) {
      var b = e.target.closest('.fullbtn, .pg-prev, .pg-next');
      if (!b) return;
      var i = b.closest('.pane').id === 'pane-b' ? state.j : state.i;
      if (i === null) return;
      if (b.classList.contains('fullbtn')) fullOf(i);
      else pageSlot(i, b.classList.contains('pg-next') ? 1 : -1);
    });
    $('b-full-close').addEventListener('click', closeFull);
    wireZoom();
    Array.prototype.forEach.call(document.querySelectorAll('.signout'), function (b) {
      b.addEventListener('click', signOut);
    });
    $('b-stations').addEventListener('click', function (e) {
      var b = e.target.closest('[data-gid]');
      if (b) pickStation(b.dataset.gid, 'list');
    });
    window.addEventListener('popstate', function () {
      if (!$('b-full').classList.contains('hidden')) { hideFull(); return; }   // back closes full size
      if (!state.token) return;
      if (location.search === routed && state.view) { renderBar(); return; }   // nothing else changed
      route();
    });

    // keys: ← → turn (at the post and in misc: the next photo), [ ] photos in a slot, ↑ ↓ date,
    // N E S W face, G ground, P post, M misc, F full size, 1 2 3 view; in full size + − 0 zoom
    document.addEventListener('keydown', function (e) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      var k = e.key, done = true;
      if (!$('b-full').classList.contains('hidden')) {
        if (k === 'Escape') closeFull();
        else if (k === '+' || k === '=') zoomBy(1.6);
        else if (k === '-' || k === '_') zoomBy(1 / 1.6);
        else if (k === '0') fitZoom();
        else done = false;
        if (done) e.preventDefault();
        return;
      }
      if (!state.station || state.view !== 'b-viewer') return;
      if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;      // the slider keeps its own arrows
      if (k === 'ArrowRight') edge(1);
      else if (k === 'ArrowLeft') edge(-1);
      else if (k === 'ArrowUp') flip(1);
      else if (k === 'ArrowDown') flip(-1);
      else if (k === ']') pageSlot(state.i, 1);
      else if (k === '[') pageSlot(state.i, -1);
      else if (/^[nesw]$/i.test(k)) face(k.toUpperCase());
      else if (k === 'g' || k === 'G') { state.level = state.level === 'ground' ? 'eye' : 'ground'; if (!isDir(state.dir)) state.dir = 'N'; render(); }
      else if (k === 'p' || k === 'P') face('LOCATOR');
      else if (k === 'm' || k === 'M') face('MISC');
      else if (k === 'f' || k === 'F') fullOf(state.i);
      else if (k === '1' || k === '2' || k === '3') setMode(['one', 'side', 'swipe'][+k - 1]);
      else done = false;
      if (done) e.preventDefault();
    });

    // the photo itself: swipe sideways to turn (or to the next photo at the post and in misc), up and
    // down to change date; in swipe view a sideways drag moves the divider instead. While a finger or
    // the mouse button is down, the words over the photo step aside.
    var stage = $('b-stage'), start = null;
    var release = function () { start = null; stage.classList.remove('pressing'); };
    stage.addEventListener('pointerdown', function (e) {
      if (e.target.closest('button')) return;
      start = { x: e.clientX, y: e.clientY, t: Date.now(), drag: state.mode === 'swipe' && state.j !== null };
      stage.setPointerCapture(e.pointerId);            // a swipe that ends off the photo still counts
      stage.classList.add('pressing');
    });
    stage.addEventListener('pointermove', function (e) {
      if (!start || !start.drag) return;
      var r = stage.getBoundingClientRect();
      if (Math.abs(e.clientY - start.y) > Math.abs(e.clientX - start.x) * 1.5) return;
      state.split = Math.max(0, Math.min(100, (e.clientX - r.left) / r.width * 100));
      applySplit();
    });
    stage.addEventListener('pointerup', function (e) {
      if (!start) return;
      var dx = e.clientX - start.x, dy = e.clientY - start.y, s = start;
      release();
      if (Date.now() - s.t > 900) return;
      if (Math.abs(dy) > 50 && Math.abs(dy) > Math.abs(dx) * 1.3) flip(dy < 0 ? 1 : -1);
      else if (!s.drag && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.3) edge(dx < 0 ? 1 : -1);
    });
    stage.addEventListener('pointercancel', release);

    // sign-in
    $('si-go').addEventListener('click', function () {
      var u = $('si-user').value.trim(), p = $('si-pass').value;
      if (!u || !p) return message('Username and password needed', 'bad');
      $('si-go').disabled = true;
      message('Signing in…');
      Arc.signInPassword(u, p).then(function () {
        $('si-pass').value = '';
        return signedIn();
      }).catch(function (e) { message(Arc.asError(e).message, 'bad'); }).then(function () { $('si-go').disabled = false; });
    });
    $('si-pass').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('si-go').click(); });
    $('si-token-go').addEventListener('click', function () {
      var t = $('si-token').value.trim();
      if (t) Arc.setManualToken(t).then(signedIn);
    });
  }

  function boot() {
    var q = new URLSearchParams(location.search);
    try { state.embed = q.get('embed') === '1' || window.top !== window.self; } catch (e) { state.embed = true; }
    state.handed = state.embed && !!q.get('station');
    document.body.classList.toggle('embedded', state.embed);
    if (history.state && history.state.full) history.replaceState(Object.assign({}, history.state, { full: false }), '', location.href);
    wire();
    renderBar();
    return Config.load().then(signedIn).catch(failed);
  }

  self.PhotoBrowser = { state: state, render: render, turn: turn, flip: flip, setMode: setMode, edge: edge,
    map: function () { return map; } };
  boot().then(function () { self.__pbReady = true; });
})();
