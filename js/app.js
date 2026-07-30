/* Exotic Camera — capture, compass, and the sync loop. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var state = {
    stream: null,
    facing: 'environment',
    heading: null,
    headingSource: null,
    headingAccuracy: null,
    pos: null,
    online: navigator.onLine,
    flushing: false,
    busy: false,
    counts: { outstanding: 0, error: 0, sent: 0, total: 0 },
    auth: null,
    timer: null
  };

  /* ───────────────────────────── toasts ───────────────────────────── */

  function toast(msg, kind, ms) {
    // a burst of captures shouldn't stack the same line three times
    var live = $('toasts').lastElementChild;
    if (live && live.dataset.msg === msg) {
      clearTimeout(+live.dataset.t);
      live.dataset.t = setTimeout(function () {
        live.classList.remove('in');
        setTimeout(function () { live.remove(); }, 300);
      }, ms || 2600);
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

  /** Server-supplied text (error messages, field names) lands in innerHTML. */
  function esc(v) {
    return String(v === null || v === undefined ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function buzz(pattern) {
    if (!Config.get().haptics || !navigator.vibrate) return;
    try { navigator.vibrate(pattern); } catch (e) { /* not fatal */ }
  }

  /* ───────────────────────────── compass ──────────────────────────── */

  function buildDial() {
    var g = $('dial'), parts = [];
    for (var d = 0; d < 360; d += 5) {
      var major = d % 30 === 0, mid = d % 15 === 0;
      var len = major ? 14 : mid ? 9 : 5;
      var col = major ? '#e6edf7' : '#61708c';
      parts.push('<line x1="100" y1="11" x2="100" y2="' + (11 + len) + '" ' +
        'stroke="' + col + '" stroke-width="' + (major ? 2.4 : 1.2) + '" ' +
        'transform="rotate(' + d + ' 100 100)"/>');
    }
    // the needle — red half points north, so the card reads like a real compass
    parts.push('<path d="M100 32 l8 68 -16 0 z" fill="#ff6b6b"/>');
    parts.push('<path d="M100 168 l8 -68 -16 0 z" fill="#7f8ea8"/>');
    // hub: hides where the needle crosses the middle and gives the readout a bed
    parts.push('<circle cx="100" cy="100" r="46" fill="#111826" ' +
               'stroke="#3d4a63" stroke-width="2"/>');
    g.innerHTML = parts.join('');

    // The card turns, but the letters stay upright — a rotating "N" is authentic
    // and unreadable at a glance, which is the wrong trade for field work.
    $('labels').innerHTML = CARDS.map(function (c) {
      return '<g class="lbl"><text x="100" y="41" text-anchor="middle" font-size="' + c[3] +
        '" font-weight="700" fill="' + c[2] + '">' + c[1] + '</text></g>';
    }).join('');
    placeLabels(0);
  }

  var CARDS = [[0, 'N', '#ff6b6b', 20], [90, 'E', '#e6edf7', 17], [180, 'S', '#e6edf7', 17], [270, 'W', '#e6edf7', 17]];

  function placeLabels(h) {
    var els = $('labels').children;
    for (var i = 0; i < els.length; i++) {
      var a = CARDS[i][0] - h;                       // where the letter sits on the rotated card
      els[i].setAttribute('transform', 'rotate(' + a + ' 100 100)');
      els[i].firstChild.setAttribute('transform', 'rotate(' + (-a) + ' 100 35)');   // …and upright
    }
  }

  var CARD = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

  function renderHeading() {
    var h = state.heading;
    var dial = $('dial');
    if (h === null || h === undefined) {
      $('heading-deg').textContent = '---';
      $('heading-card').textContent = '';
      $('compass').classList.add('stale');
      return;
    }
    $('compass').classList.remove('stale');
    // rotate the card so the heading sits under the fixed index mark at the top
    dial.style.transform = 'rotate(' + (-h) + 'deg)';
    placeLabels(h);
    $('heading-deg').textContent = String(Math.round(h)).padStart(3, '0');
    $('heading-card').textContent = CARD[Math.round(h / 22.5) % 16];
    $('compass').classList.toggle('unreliable', state.headingAccuracy !== null && state.headingAccuracy > 25);
  }

  /** Azimuth of the rear camera axis, tilt compensated (device −Z into world). */
  function cameraAzimuth(alpha, beta, gamma) {
    var r = Math.PI / 180;
    var a = alpha * r, b = beta * r, g = gamma * r;
    var cA = Math.cos(a), sA = Math.sin(a);
    var cB = Math.cos(b), sB = Math.sin(b);
    var cG = Math.cos(g), sG = Math.sin(g);
    // third column of the W3C rotation matrix, negated → world vector of device −Z
    var vx = -(cA * sG + cG * sA * sB);
    var vy = -(sA * sG - cA * cG * sB);
    if (Math.abs(vx) < 1e-7 && Math.abs(vy) < 1e-7) return null;   // camera pointing at the sky/ground
    var deg = Math.atan2(vx, vy) / r;
    return (deg + 360) % 360;
  }

  var smooth = null;
  function pushHeading(h, source, acc) {
    if (h === null || h === undefined || isNaN(h)) return;
    if (smooth === null) smooth = h;
    else {
      var diff = ((h - smooth + 540) % 360) - 180;    // shortest way round the circle
      smooth = (smooth + diff * 0.25 + 360) % 360;
    }
    state.heading = smooth;
    state.headingSource = source;
    state.headingAccuracy = acc === undefined ? null : acc;
    renderHeading();
  }

  function onOrientation(e) {
    var alpha = e.alpha;
    if (typeof e.webkitCompassHeading === 'number' && e.webkitCompassHeading >= 0) {
      alpha = 360 - e.webkitCompassHeading;           // iOS: derive absolute alpha
    } else if (!e.absolute) {
      return;                                          // relative-only data is useless as a compass
    }
    if (alpha === null) return;
    var az = cameraAzimuth(alpha, e.beta || 0, e.gamma || 0);
    if (az !== null) pushHeading(az, 'sensor', e.webkitCompassAccuracy);
  }

  function startCompass() {
    var DOE = window.DeviceOrientationEvent;
    if (!DOE) { toast('No compass on this device', 'warn'); return Promise.resolve(); }
    var go = function () {
      window.addEventListener('deviceorientationabsolute', onOrientation, true);
      window.addEventListener('deviceorientation', onOrientation, true);
    };
    if (typeof DOE.requestPermission === 'function') {
      return DOE.requestPermission().then(function (r) {
        if (r === 'granted') go();
        else toast('Compass permission denied', 'warn');
      }).catch(function () { /* not fatal — GPS course is the fallback */ });
    }
    go();
    return Promise.resolve();
  }

  /* ───────────────────────────── location ─────────────────────────── */

  function startGPS() {
    if (!navigator.geolocation) { toast('No GPS on this device', 'warn'); return; }
    navigator.geolocation.watchPosition(function (p) {
      state.pos = p;
      var acc = p.coords.accuracy;
      $('chip-gps').querySelector('.label').textContent = acc ? '±' + Math.round(acc) + 'm' : '--';
      $('chip-gps').className = 'chip ' + (acc <= 10 ? 'ok' : acc <= 30 ? 'warn' : 'bad');
      // fall back to course over ground when the phone has no magnetometer
      if (state.headingSource !== 'sensor' && p.coords.speed > 1.5 && p.coords.heading !== null) {
        pushHeading(p.coords.heading, 'gps');
      }
    }, function (err) {
      $('chip-gps').className = 'chip bad';
      $('chip-gps').querySelector('.label').textContent = 'no fix';
      if (err.code === err.PERMISSION_DENIED) toast('Location permission denied — points need it', 'bad', 4000);
    }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
  }

  /* ───────────────────────────── camera ───────────────────────────── */

  function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return showNoVideo('This browser has no camera API — use the file picker.');
    }
    stopCamera();
    return navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: state.facing }, width: { ideal: 2560 }, height: { ideal: 1920 } }
    }).then(function (s) {
      state.stream = s;
      var v = $('preview');
      v.srcObject = s;
      $('novideo').classList.add('hidden');
      return v.play().catch(function () { /* autoplay quirks — the tap already started it */ });
    }).catch(function (e) {
      showNoVideo(e && e.name === 'NotAllowedError'
        ? 'Camera permission denied.'
        : 'Camera unavailable (' + (e && e.name) + ').');
    });
  }

  function stopCamera() {
    if (state.stream) {
      state.stream.getTracks().forEach(function (t) { t.stop(); });
      state.stream = null;
    }
  }

  function showNoVideo(msg) {
    $('novideo-msg').textContent = msg;
    $('novideo').classList.remove('hidden');
  }

  function drawToBlob(source, sw, sh) {
    var c = Config.get();
    var scale = Math.min(1, c.maxDim / Math.max(sw, sh));
    var w = Math.round(sw * scale), h = Math.round(sh * scale);
    var cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    cv.getContext('2d').drawImage(source, 0, 0, w, h);

    var tc = document.createElement('canvas');
    var ts = Math.min(1, 160 / Math.max(w, h));
    tc.width = Math.round(w * ts); tc.height = Math.round(h * ts);
    tc.getContext('2d').drawImage(cv, 0, 0, tc.width, tc.height);
    var thumb = tc.toDataURL('image/jpeg', 0.6);

    return new Promise(function (res) {
      cv.toBlob(function (b) { res({ blob: b, w: w, h: h, thumb: thumb }); }, 'image/jpeg', c.quality);
    });
  }

  function deviceLabel() {
    var ua = navigator.userAgent;
    var m = ua.match(/\((?:Linux; )?(?:U; )?([^;)]+)/);
    return ('Exotic Camera / ' + (m ? m[1] : 'web')).slice(0, 50);
  }

  function capture() {
    if (state.busy) return Promise.resolve();
    // check the fix first — a shutter click for a photo we can't place is a lie
    if (!state.pos) {
      Sound.error();
      toast('No GPS fix yet — waiting for location', 'bad', 3500);
      return Promise.resolve();
    }
    state.busy = true;
    Sound.shutter();
    buzz(12);
    flashScreen();

    var v = $('preview');
    var ready = state.stream && v.videoWidth;
    if (!ready) { state.busy = false; toast('Camera not running', 'warn'); return Promise.resolve(); }

    return drawToBlob(v, v.videoWidth, v.videoHeight).then(function (img) {
      return enqueue(img);
    }).then(function () {
      state.busy = false;
    }).catch(function (e) {
      state.busy = false;
      Sound.error();
      toast('Capture failed: ' + e.message, 'bad');
    });
  }

  function enqueue(img) {
    var p = state.pos && state.pos.coords;
    if (!p) {
      Sound.error();
      toast('No GPS fix yet — photo not saved', 'bad', 4000);
      return Promise.resolve();
    }
    var item = {
      id: Store.uuid(),
      createdAt: Date.now(),
      blob: img.blob,
      thumb: img.thumb,
      w: img.w, h: img.h,
      lat: p.latitude,
      lon: p.longitude,
      alt: p.altitude,
      hAcc: p.accuracy,
      vAcc: p.altitudeAccuracy,
      speed: p.speed,
      course: p.heading,
      heading: state.heading === null ? null : Math.round(state.heading * 10) / 10,
      headingSource: state.headingSource,
      device: deviceLabel(),
      state: 'pending'
    };
    return Store.add(item).then(function () {
      $('last-shot').style.backgroundImage = 'url(' + img.thumb + ')';
      $('last-shot').classList.add('pop');
      setTimeout(function () { $('last-shot').classList.remove('pop'); }, 400);
      Sound.queued();
      return refreshCounts();
    }).then(function () {
      if (state.online && Config.get().autoSync) sync();
      else toast('Saved offline — will upload when back online', 'warn');
    });
  }

  function flashScreen() {
    var f = $('flash');
    f.classList.remove('go');
    void f.offsetWidth;
    f.classList.add('go');
  }

  /* ─────────────────────────── sync engine ────────────────────────── */

  function refreshCounts() {
    return Store.counts().then(function (c) {
      state.counts = c;
      var chip = $('chip-queue');
      chip.querySelector('.label').textContent = String(c.outstanding);
      chip.className = 'chip' + (c.error ? ' bad' : c.outstanding ? ' warn' : ' ok');
      $('mi-queue-sub').textContent = c.outstanding
        ? c.outstanding + ' waiting' + (c.error ? ', ' + c.error + ' failed' : '')
        : 'nothing pending';
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
      if (Config.get().autoSync) sync();
    } else {
      Sound.offline();
      buzz([8, 60, 8]);
      toast('Connection lost — photos are queued', 'warn', 3200);
    }
  }

  function sync(force) {
    if (state.flushing) return Promise.resolve();
    if (!state.counts.outstanding && !force) return Promise.resolve();
    state.flushing = true;
    document.body.classList.add('syncing');

    var sentAny = false;
    return Arc.flush(function (type, item, err) {
      if (type === 'start') {
        $('chip-queue').classList.add('busy');
      } else if (type === 'sent') {
        sentAny = true;
        Sound.sent();
        buzz(10);
        pulseSent();
        refreshCounts();
      } else if (type === 'failed') {
        if (!err.retryable && !err.needAuth) toast('Upload failed: ' + err.message, 'bad', 4000);
        refreshCounts();
      }
    }, { force: force }).then(function (sum) {
      state.flushing = false;
      document.body.classList.remove('syncing');
      $('chip-queue').classList.remove('busy');
      return refreshCounts().then(function (c) {
        if (sum.needAuth) {
          Sound.error();
          toast('Sign in to ArcGIS to upload', 'bad', 5000);
        } else if (sum.offline) {
          Sound.retry();
          toast('Server unreachable — will retry', 'warn');
        } else if (sentAny && !c.outstanding) {
          Sound.allClear();
          toast('All photos uploaded', 'ok');
        }
        return sum;
      });
    }).catch(function (e) {
      state.flushing = false;
      document.body.classList.remove('syncing');
      $('chip-queue').classList.remove('busy');
      toast(e.message, 'bad', 4000);
    });
  }

  function pulseSent() {
    var chip = $('chip-queue');
    chip.classList.remove('sent-pulse');
    void chip.offsetWidth;
    chip.classList.add('sent-pulse');
  }

  function scheduleSync() {
    clearInterval(state.timer);
    state.timer = setInterval(function () {
      if (state.online && state.counts.outstanding && Config.get().autoSync) sync();
    }, 30000);
    // let the browser retry in the background too, where it's supported
    if ('serviceWorker' in navigator && 'SyncManager' in window) {
      navigator.serviceWorker.ready.then(function (reg) {
        return reg.sync.register('flush-queue');
      }).catch(function () { /* background sync is a bonus, not a requirement */ });
    }
  }

  /* ───────────────────────────── panels ───────────────────────────── */

  function openSheet(id) {
    closeSheets();
    $(id).classList.remove('hidden');
    requestAnimationFrame(function () { $(id).classList.add('open'); });
  }

  function closeSheets() {
    ['menu', 'queue-panel', 'settings-panel', 'about-panel', 'signin-panel'].forEach(function (id) {
      var el = $(id);
      if (!el || el.classList.contains('hidden')) return;
      el.classList.remove('open');
      setTimeout(function () { el.classList.add('hidden'); }, 220);
    });
  }

  function renderQueue() {
    return Store.all().then(function (rows) {
      var list = $('queue-list');
      if (!rows.length) { list.innerHTML = '<p class="hint">Queue is empty.</p>'; return; }
      list.innerHTML = rows.map(function (r) {
        var when = new Date(r.createdAt).toLocaleString();
        var sub = r.state === 'sent' ? 'uploaded · OBJECTID ' + (r.objectId || '?')
          : r.state === 'error' ? esc(r.lastError || 'failed')
          : r.state === 'uploading' ? 'uploading…'
          : r.attempts ? 'retry ' + r.attempts + (r.lastError ? ' · ' + esc(r.lastError) : '') : 'waiting';
        return '<div class="qrow ' + r.state + '">' +
          '<div class="qthumb" style="background-image:url(' + (r.thumb || '') + ')"></div>' +
          '<div class="qmeta"><b>' + esc(when) + '</b>' +
          '<span>' + (r.heading === null || r.heading === undefined ? 'no heading' : Math.round(r.heading) + '°') +
          ' · ' + (r.hAcc ? '±' + Math.round(r.hAcc) + 'm' : 'no acc') + '</span>' +
          '<span class="qsub">' + sub + '</span></div>' +
          '<button class="qdel" data-id="' + r.id + '" aria-label="Delete">✕</button></div>';
      }).join('');
      Array.prototype.forEach.call(list.querySelectorAll('.qdel'), function (b) {
        b.addEventListener('click', function () {
          Store.remove(b.dataset.id).then(renderQueue).then(refreshCounts);
        });
      });
    });
  }

  function loadSettingsForm() {
    var c = Config.get();
    $('s-url').value = c.serviceUrl;
    $('s-layer').value = c.layerId;
    $('s-appid').value = c.appId;
    $('s-portal').value = c.portal;
    $('s-maxdim').value = c.maxDim;
    $('s-quality').value = c.quality;
    $('s-quality-out').textContent = c.quality;
    $('s-sound').checked = c.sound;
    $('s-haptics').checked = c.haptics;
    $('s-autosync').checked = c.autoSync;
    ['heading', 'lat', 'lon', 'accuracy', 'altitude', 'captured', 'notes', 'device'].forEach(function (k) {
      var el = $('s-f-' + k);
      if (el) el.value = c.fields[k] || '';
    });
    $('s-redirect').textContent = Arc.redirectUri();
  }

  function saveSettings() {
    var patch = {
      serviceUrl: $('s-url').value.trim(),
      layerId: parseInt($('s-layer').value, 10) || 0,
      appId: $('s-appid').value.trim(),
      portal: $('s-portal').value.trim() || 'https://www.arcgis.com',
      maxDim: parseInt($('s-maxdim').value, 10) || 1600,
      quality: parseFloat($('s-quality').value) || 0.8,
      sound: $('s-sound').checked,
      haptics: $('s-haptics').checked,
      autoSync: $('s-autosync').checked,
      fields: {}
    };
    ['heading', 'lat', 'lon', 'accuracy', 'altitude', 'captured', 'notes', 'device'].forEach(function (k) {
      var el = $('s-f-' + k);
      if (el) patch.fields[k] = el.value.trim();
    });
    return Config.save(patch).then(function (c) {
      Sound.setEnabled(c.sound);
      Sound.tick();
      toast('Settings saved', 'ok');
      closeSheets();
    });
  }

  function renderAuth() {
    return Arc.getAuth().then(function (a) {
      state.auth = a;
      var live = a && a.expires > Date.now();
      $('acct-name').textContent = a ? (a.username || 'signed in') : 'Not signed in';
      $('acct-sub').textContent = a
        ? (live ? 'token valid until ' + new Date(a.expires).toLocaleString() : 'session expired')
        : 'ArcGIS Online';
      $('auth-btn').textContent = a ? 'Sign out' : 'Sign in';
    });
  }

  /* ───────────────────────── service worker ───────────────────────── */

  function registerSW() {
    if (!('serviceWorker' in navigator)) return Promise.resolve();
    return navigator.serviceWorker.register('sw.js').then(function (reg) {
      reg.addEventListener('updatefound', function () {
        var w = reg.installing;
        if (!w) return;
        w.addEventListener('statechange', function () {
          if (w.state === 'installed' && navigator.serviceWorker.controller) {
            toast('Update ready — reopen or hit Reinstall', 'ok', 4000);
          }
        });
      });
      navigator.serviceWorker.addEventListener('message', function (e) {
        if (e.data && e.data.type === 'flush') { refreshCounts().then(function () { sync(); }); }
      });
      return reg;
    }).catch(function () { /* app still works, just without offline caching */ });
  }

  function reinstall() {
    if (state.counts.outstanding &&
        !confirm(state.counts.outstanding + ' photo(s) still queued. They stay on the device through a reinstall. Continue?')) {
      return;
    }
    toast('Reinstalling from GitHub Pages…', 'ok', 4000);
    var jobs = [];
    if ('serviceWorker' in navigator) {
      jobs.push(navigator.serviceWorker.getRegistrations().then(function (rs) {
        return Promise.all(rs.map(function (r) { return r.unregister(); }));
      }));
    }
    if (window.caches) {
      jobs.push(caches.keys().then(function (keys) {
        return Promise.all(keys.map(function (k) { return caches.delete(k); }));
      }));
    }
    Promise.all(jobs).catch(function () { /* clear what we can, then reload regardless */ })
      .then(function () {
        location.replace(Arc.redirectUri() + '?fresh=' + Date.now());
      });
  }

  /* ────────────────────────────── wiring ──────────────────────────── */

  function wire() {
    $('shutter').addEventListener('click', function () { Sound.unlock(); capture(); });
    $('flip-cam').addEventListener('click', function () {
      state.facing = state.facing === 'environment' ? 'user' : 'environment';
      Sound.tick();
      startCamera();
    });
    $('start-cam').addEventListener('click', function () {
      Sound.unlock();
      startCompass();
      startCamera();
    });
    $('file-fallback').addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      if (!f) return;
      var img = new Image();
      img.onload = function () {
        drawToBlob(img, img.naturalWidth, img.naturalHeight).then(enqueue);
        URL.revokeObjectURL(img.src);
      };
      img.src = URL.createObjectURL(f);
      e.target.value = '';
    });

    // iOS only hands out compass data after a gesture — tapping the dial asks
    $('compass').addEventListener('click', function () {
      Sound.unlock();
      if (state.heading === null) startCompass();
      else toast('Heading ' + Math.round(state.heading) + '° (' + (state.headingSource === 'gps' ? 'GPS course' : 'magnetometer') + ')');
    });

    $('menu-btn').addEventListener('click', function () {
      Sound.unlock(); Sound.tick();
      renderAuth().then(function () { openSheet('menu'); });
    });
    $('last-shot').addEventListener('click', function () { renderQueue().then(function () { openSheet('queue-panel'); }); });
    $('chip-queue').addEventListener('click', function () { renderQueue().then(function () { openSheet('queue-panel'); }); });
    $('chip-net').addEventListener('click', function () { sync(true); });
    $('chip-gps').addEventListener('click', function () {
      var p = state.pos && state.pos.coords;
      toast(p ? p.latitude.toFixed(6) + ', ' + p.longitude.toFixed(6) + ' ±' + Math.round(p.accuracy) + 'm' : 'No fix yet');
    });

    $('mi-queue').addEventListener('click', function () { renderQueue().then(function () { openSheet('queue-panel'); }); });
    $('mi-sync').addEventListener('click', function () { closeSheets(); sync(true); });
    $('mi-settings').addEventListener('click', function () { loadSettingsForm(); openSheet('settings-panel'); });
    $('mi-reinstall').addEventListener('click', reinstall);
    $('mi-about').addEventListener('click', function () {
      $('about-body').innerHTML =
        'Build <b>' + esc(Config.BUILD) + '</b><br>Layer: <code>' + esc(Config.layerUrl()) + '</code><br>' +
        'Photos are queued on the device and uploaded as points with an attached JPEG.<br>' +
        'Heading comes from the magnetometer (tilt compensated), falling back to GPS course.';
      openSheet('about-panel');
    });

    $('q-retry').addEventListener('click', function () {
      Store.all().then(function (rows) {
        return Promise.all(rows.filter(function (r) { return r.state !== 'sent'; }).map(function (r) {
          return Store.patch(r.id, { state: 'pending', nextAttemptAt: 0, attempts: 0, lastError: null });
        }));
      }).then(refreshCounts).then(function () { closeSheets(); return sync(true); }).then(renderQueue);
    });
    $('q-clear-done').addEventListener('click', function () {
      Store.removeSent().then(renderQueue).then(refreshCounts);
    });

    $('s-save').addEventListener('click', saveSettings);
    $('s-close').addEventListener('click', closeSheets);
    $('a-close').addEventListener('click', closeSheets);
    $('s-quality').addEventListener('input', function () { $('s-quality-out').textContent = this.value; });
    $('s-probe').addEventListener('click', function () {
      $('s-schema').textContent = 'Reading…';
      Config.save({
        serviceUrl: $('s-url').value.trim(),
        layerId: parseInt($('s-layer').value, 10) || 0
      }).then(function () {
        return Arc.layerMeta(true);
      }).then(function (meta) {
        var map = Arc.resolveFields(meta);
        $('s-schema').innerHTML = '<b>' + esc(meta.name) + '</b> — attachments ' +
          (meta.hasAttachments ? 'on' : '<span class="bad-text">off</span>') + '<br>' +
          Object.keys(map).map(function (k) { return k + ' → <code>' + esc(map[k].name) + '</code>'; }).join('<br>');
      }).catch(function (e) {
        $('s-schema').innerHTML = '<span class="bad-text">' + esc(e.message) + '</span>';
      });
    });

    // sign-in
    $('auth-btn').addEventListener('click', function () {
      if (state.auth) {
        Arc.signOut().then(renderAuth).then(function () { toast('Signed out'); });
      } else {
        openSheet('signin-panel');
      }
    });
    $('si-oauth').addEventListener('click', function () {
      Arc.beginOAuth().catch(function (e) { toast(e.message, 'bad', 4000); });
    });
    $('si-go').addEventListener('click', function () {
      var u = $('si-user').value.trim(), p = $('si-pass').value;
      if (!u || !p) return toast('Username and password needed', 'warn');
      $('si-go').disabled = true;
      Arc.signInPassword(u, p).then(function () {
        $('si-pass').value = '';
        Sound.sent();
        toast('Signed in', 'ok');
        closeSheets();
        return renderAuth().then(function () { return sync(); });
      }).catch(function (e) {
        Sound.error();
        toast(e.message, 'bad', 4000);
      }).then(function () { $('si-go').disabled = false; });
    });
    $('si-token-go').addEventListener('click', function () {
      var t = $('si-token').value.trim();
      if (!t) return;
      Arc.setManualToken(t).then(function () {
        $('si-token').value = '';
        toast('Token stored', 'ok');
        closeSheets();
        return renderAuth().then(function () { return sync(); });
      });
    });
    $('si-close').addEventListener('click', closeSheets);

    document.addEventListener('click', function (e) {
      if (e.target.classList.contains('sheet')) closeSheets();
    });
    window.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeSheets(); });

    window.addEventListener('online', function () { setNet(true); });
    window.addEventListener('offline', function () { setNet(false); });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState !== 'visible') return;
      setNet(navigator.onLine);
      refreshCounts().then(function () {
        if (state.online && Config.get().autoSync) sync();
      });
      if (!state.stream) startCamera();
    });
    window.addEventListener('pagehide', stopCamera);
  }

  /* ────────────────────────────── boot ────────────────────────────── */

  function boot() {
    buildDial();
    renderHeading();
    wire();

    Config.load().then(function (c) {
      Sound.setEnabled(c.sound);
      $('mi-about-sub').textContent = 'build ' + Config.BUILD;
      return Arc.completeOAuth().catch(function (e) {
        toast('Sign-in failed: ' + e.message, 'bad', 5000);
        return null;
      });
    }).then(function (a) {
      if (a) { toast('Signed in as ' + a.username, 'ok'); }
      return renderAuth();
    }).then(refreshCounts).then(function () {
      setNet(navigator.onLine);
      $('chip-net').className = 'chip ' + (navigator.onLine ? 'ok' : 'bad');
      $('chip-net').querySelector('.label').textContent = navigator.onLine ? 'online' : 'offline';
      state.online = navigator.onLine;
      scheduleSync();
      registerSW();
      startGPS();
      // iOS needs a gesture for the compass; on Android this just works
      if (!window.DeviceOrientationEvent || typeof window.DeviceOrientationEvent.requestPermission !== 'function') {
        startCompass();
      }
      return startCamera();
    }).then(function () {
      return Store.all();
    }).then(function (rows) {
      if (rows.length && rows[0].thumb) $('last-shot').style.backgroundImage = 'url(' + rows[0].thumb + ')';
      if (state.online && state.counts.outstanding && Config.get().autoSync) sync();
    }).catch(function (e) {
      toast('Startup problem: ' + e.message, 'bad', 5000);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
