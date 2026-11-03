/* Photo Points — the photo browser. A station's photos as dates × directions:
   flip through the dates and the direction stays put; turn round the post
   and the date stays put; compare two dates side by side or with a swipe.

   Reads only. It lives next to the app, so on a phone where Photo Points is
   signed in it is too (same device storage). Embedded in the ArcGIS
   experience it is handed the station as ?station=<GlobalID>&embed=1, and
   signs in on its own the first time (an embedded page gets its own storage). */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var DIRS = ['N', 'E', 'S', 'W'];
  var NAMES = { N: 'North', E: 'East', S: 'South', W: 'West' };
  var GUID = /^\{?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}?$/i;

  var state = {
    token: null,
    embed: false,
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

  function show(id) {
    ['b-viewer', 'b-list', 'b-signin'].forEach(function (x) { $(x).classList.toggle('hidden', x !== id); });
    $('b-modes').classList.toggle('hidden', id !== 'b-viewer');
  }
  function message(text, kind) {
    var m = $('b-msg');
    m.textContent = text || '';
    m.className = 'msg' + (text ? '' : ' hidden') + (kind ? ' ' + kind : '');
  }

  /** A visit's date, with its time when another visit is on the same day. */
  function label(v) {
    var day = fmtDate(v.when);
    var same = state.visits.filter(function (x) { return fmtDate(x.when) === day; }).length > 1;
    return same ? fmtWhen(v.when) : day;
  }

  function slotKey() {
    if (state.dir === 'LOCATOR' || state.dir === 'MISC') return state.dir;
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
    var img = el.querySelector('img'), empty = el.querySelector('.empty'), cap = el.querySelector('figcaption'), multi = el.querySelector('.multi');
    if (!v) {
      img.classList.add('hidden');
      empty.classList.remove('hidden');
      empty.textContent = 'No visits yet';
      cap.textContent = '';
      multi.classList.add('hidden');
      return;
    }
    cap.textContent = (side ? side + ' · ' : '') + label(v) + ' · ' + slotName(slot) +
      (p && p.att.bearing ? ' · ' + pad(p.att.bearing.deg, 3) + '°' + p.att.bearing.ref : '');
    if (!p) {
      img.classList.add('hidden');
      img.removeAttribute('src');
      shown[el.id] = null;
      var others = Object.keys(v.photos).length;
      empty.innerHTML = 'No ' + esc(slotName(slot).toLowerCase()) + ' photo on ' + esc(label(v)) +
        (others ? '<small>' + v.count + ' other photo' + (v.count === 1 ? '' : 's') + ' on this visit</small>' : '<small>No photos on this visit</small>');
      empty.classList.remove('hidden');
    } else {
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
      img.alt = slotName(slot) + ' photo, ' + label(v);
      img.classList.remove('hidden');
      empty.classList.add('hidden');
    }
    multi.classList.toggle('hidden', !p || p.of < 2);
    if (p && p.of > 1) multi.textContent = (p.n + 1) + ' of ' + p.of;
    multi.onclick = function (e) {
      e.stopPropagation();
      var key = v.oid + '|' + slot;
      state.pick[key] = ((state.pick[key] || 0) + 1) % p.of;
      render();
    };
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
      var key = d === 'LOCATOR' || d === 'MISC' ? d : (state.level === 'ground' ? 'LOW_' : '') + d;
      b.classList.toggle('on', key === slot);
      b.classList.toggle('none', !photosAt(state.i, key).length);
      b.setAttribute('aria-pressed', key === slot);
    });
    Array.prototype.forEach.call($('b-level').children, function (b) {
      b.classList.toggle('on', b.dataset.level === state.level && DIRS.indexOf(state.dir) >= 0);
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

  /* ── full size, in the page ─────────────────────────────────── */

  var fullUrl = null;
  function openFull(v, att) {
    var body = $('b-full-body');
    $('b-full-name').textContent = att.name || 'file';
    body.innerHTML = '<p class="hint">Loading the full-size file…</p>';
    $('b-full').classList.remove('hidden');
    return fetchBlob(attUrl(v, att, true)).then(function (b) {
      if ($('b-full').classList.contains('hidden')) return;
      fullUrl = URL.createObjectURL(b);
      body.innerHTML = '';
      var type = att.type || b.type || '';
      if (/^image\//i.test(type) || /\.(jpe?g|png|webp)$/i.test(att.name)) {
        var im = document.createElement('img');
        im.className = 'fit';
        im.alt = att.name;
        im.title = 'Tap to see it at actual size';
        im.addEventListener('click', function () { im.classList.toggle('fit'); });
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
      e = Arc.asError(e);
      if (e.needAuth) { closeFull(); failed(e); return; }
      body.innerHTML = '<p class="hint">Could not load it: ' + esc(e.message) + '</p>';
    });
  }

  function closeFull() {
    $('b-full').classList.add('hidden');
    $('b-full-body').innerHTML = '';
    if (fullUrl) { URL.revokeObjectURL(fullUrl); fullUrl = null; }
  }

  /* Neighbouring photos load ahead, so flipping and turning do not wait. */
  function preload() {
    var slot = slotKey(), want = [];
    var at = function (i, s) { var p = state.visits[i] && pickAt(i, s); if (p) want.push([state.visits[i], p.att]); };
    at(state.i - 1, slot); at(state.i + 1, slot);
    var k = DIRS.indexOf(state.dir);
    if (k >= 0) {
      var pre = state.level === 'ground' ? 'LOW_' : '';
      at(state.i, pre + DIRS[(k + 1) % 4]); at(state.i, pre + DIRS[(k + 3) % 4]);
      at(state.i, (pre ? '' : 'LOW_') + state.dir);
    }
    want.forEach(function (w) { getPhoto(w[0], w[1]).catch(function () { /* shown as it comes up */ }); });
  }

  /* ───────────────────────── where we are (in the URL) ───────────────────────── */

  function saveHash() {
    var v = state.visits[state.i], w = state.j !== null ? state.visits[state.j] : null;
    var h = 'v=' + (v ? v.oid : '') + '&d=' + state.dir + '&l=' + state.level + '&m=' + state.mode + (w ? '&w=' + w.oid : '');
    if (location.hash.slice(1) !== h) history.replaceState(null, '', location.pathname + location.search + '#' + h);
  }

  function readHash() {
    var p = new URLSearchParams(location.hash.slice(1));
    var find = function (oid) {
      for (var i = 0; i < state.visits.length; i++) if (String(state.visits[i].oid) === oid) return i;
      return -1;
    };
    var d = p.get('d');
    if (d && (DIRS.indexOf(d) >= 0 || d === 'LOCATOR' || d === 'MISC')) state.dir = d;
    if (p.get('l') === 'ground') state.level = 'ground';
    var m = p.get('m');
    if (m === 'side' || m === 'swipe') state.mode = m;
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
    $('b-list-btn').classList.add('hidden');
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

  function pickStation(gid) {
    history.pushState(null, '', location.pathname + '?station=' + encodeURIComponent(gid) + (state.embed ? '&embed=1' : ''));
    $('b-list-btn').classList.remove('hidden');
    return openStation(gid);
  }

  /* ───────────────────────────── signing in ───────────────────────── */

  function failed(e) {
    e = Arc.asError(e);
    if (e.needAuth) { message(''); show('b-signin'); return; }
    message(e.retryable ? 'No connection to ArcGIS — ' + e.message : e.message, 'bad');
  }

  function signedIn() {
    return Arc.token().then(function (t) { state.token = t; return route(); }, failed);
  }

  /** Off this device: the token goes, and so does every photo held in memory. */
  function signOut() {
    closeFull();
    return Arc.signOut().then(function () {
      state.token = null;
      state.station = null;
      state.visits = [];
      forgetPhotos();
      message('Signed out.');
      show('b-signin');
    });
  }

  /* ───────────────────────────── wiring ───────────────────────────── */

  function route() {
    var ref = (new URLSearchParams(location.search).get('station') || '').replace(/\ufeff/g, '').trim();
    // the experience can load us once with its field placeholder before the station it means
    var pending = /\{[A-Za-z_]+\}/.test(ref);
    $('b-list-btn').classList.toggle('hidden', !ref || state.embed);
    if (pending) { show(null); message('Loading the station…'); return Promise.resolve(); }
    if (ref) return openStation(ref);
    return openList();
  }

  function wire() {
    $('b-turn-left').addEventListener('click', function () { turn(-1); });
    $('b-turn-right').addEventListener('click', function () { turn(1); });
    $('b-older').addEventListener('click', function () { flip(-1); });
    $('b-newer').addEventListener('click', function () { flip(1); });
    $('b-chips').addEventListener('click', function (e) {
      var b = e.target.closest('[data-i]');
      if (b) setDate(+b.dataset.i);
    });
    $('b-with').addEventListener('change', function () { state.j = +this.value; render(); });
    Array.prototype.forEach.call(document.querySelectorAll('[data-dir]'), function (b) {
      b.addEventListener('click', function () { state.dir = b.dataset.dir; render(); });
    });
    Array.prototype.forEach.call($('b-level').children, function (b) {
      b.addEventListener('click', function () {
        state.level = b.dataset.level;
        if (DIRS.indexOf(state.dir) < 0) state.dir = 'N';
        render();
      });
    });
    Array.prototype.forEach.call($('b-modes').children, function (b) {
      b.addEventListener('click', function () { if (!b.disabled) setMode(b.dataset.mode); });
    });
    $('b-split').addEventListener('input', function () { state.split = +this.value; applySplit(); });
    $('b-list-btn').addEventListener('click', function () {
      history.pushState(null, '', location.pathname + (state.embed ? '?embed=1' : ''));
      openList();
    });
    $('b-search').addEventListener('input', renderList);
    $('b-details').addEventListener('click', function (e) {
      var b = e.target.closest('[data-full]'), v = state.visits[state.i];
      if (!b || !v) return;
      var p = pickAt(state.i, slotKey());
      var att = b.dataset.full === 'photo' ? p && p.att : v.files[+b.dataset.full];
      if (att) openFull(v, att);
    });
    $('b-full-close').addEventListener('click', closeFull);
    Array.prototype.forEach.call(document.querySelectorAll('.signout'), function (b) {
      b.addEventListener('click', signOut);
    });
    $('b-stations').addEventListener('click', function (e) {
      var b = e.target.closest('[data-gid]');
      if (b) pickStation(b.dataset.gid);
    });
    window.addEventListener('popstate', function () { if (state.token) route(); });

    // keys: ← → turn, ↑ ↓ date, G ground, P post, M misc, 1 2 3 view
    document.addEventListener('keydown', function (e) {
      if (!$('b-full').classList.contains('hidden')) { if (e.key === 'Escape') closeFull(); return; }
      if (!state.station || $('b-viewer').classList.contains('hidden')) return;
      if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;      // the slider keeps its own arrows
      var k = e.key, done = true;
      if (k === 'ArrowRight') turn(1);
      else if (k === 'ArrowLeft') turn(-1);
      else if (k === 'ArrowUp') flip(1);
      else if (k === 'ArrowDown') flip(-1);
      else if (k === 'g' || k === 'G') { state.level = state.level === 'ground' ? 'eye' : 'ground'; if (DIRS.indexOf(state.dir) < 0) state.dir = 'N'; render(); }
      else if (k === 'p' || k === 'P') { state.dir = 'LOCATOR'; render(); }
      else if (k === 'm' || k === 'M') { state.dir = 'MISC'; render(); }
      else if (k === '1' || k === '2' || k === '3') setMode(['one', 'side', 'swipe'][+k - 1]);
      else done = false;
      if (done) e.preventDefault();
    });

    // the photo itself: swipe sideways to turn, up and down to change date;
    // in swipe view a sideways drag moves the divider instead
    var stage = $('b-stage'), start = null;
    stage.addEventListener('pointerdown', function (e) {
      if (e.target.closest('button')) return;
      start = { x: e.clientX, y: e.clientY, t: Date.now(), drag: state.mode === 'swipe' && state.j !== null };
      stage.setPointerCapture(e.pointerId);            // a swipe that ends off the photo still counts
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
      start = null;
      if (Date.now() - s.t > 900) return;
      if (Math.abs(dy) > 50 && Math.abs(dy) > Math.abs(dx) * 1.3) flip(dy < 0 ? 1 : -1);
      else if (!s.drag && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.3) turn(dx < 0 ? 1 : -1);
    });
    stage.addEventListener('pointercancel', function () { start = null; });

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
    document.body.classList.toggle('embedded', state.embed);
    $('b-back').classList.toggle('hidden', state.embed);
    wire();
    return Config.load().then(signedIn).catch(failed);
  }

  self.PhotoBrowser = { state: state, render: render, turn: turn, flip: flip, setMode: setMode };
  boot().then(function () { self.__pbReady = true; });
})();
