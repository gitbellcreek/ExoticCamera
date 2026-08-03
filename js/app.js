/* Exotic Camera — capture, compass, and the sync loop. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  // Reporting is a nicety; the camera is not. If report.js failed to load —
  // a partial cache, a bad deploy — carry on without it.
  if (typeof Report === 'undefined') {
    self.Report = { note: function () {}, breadcrumbs: function () { return []; },
                    send: function () { return Promise.resolve(false); } };
  }

  var state = {
    stream: null,
    facing: 'environment',
    heading: null,
    headingSource: null,
    headingAccuracy: null,
    pos: null,
    posAt: 0,
    gpsError: null,
    gpsDenied: false,
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

  function errText(e) { return Arc.asError(e).message; }

  /** CI stamps the commit sha in; a plain branch deploy leaves the placeholder. */
  function buildLabel() {
    return /^__/.test(Config.BUILD) ? 'branch deploy (unstamped)' : Config.BUILD;
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

  var compassArmed = false, compassPending = null, gotOrientation = false;
  var compassDenied = false, headingHopeless = false;
  var headingWaiters = [];

  /**
   * Resolve once the magnetometer produces a sample, or give up after `ms`.
   * Only ever worth waiting for once: if the first shot times out, this device
   * is not going to produce a heading, and the shutter should stop stalling.
   */
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

  function onOrientation(e) {
    var alpha = e.alpha;
    if (typeof e.webkitCompassHeading === 'number' && e.webkitCompassHeading >= 0) {
      alpha = 360 - e.webkitCompassHeading;           // iOS: derive absolute alpha
    } else if (!e.absolute) {
      return;                                          // relative-only data is useless as a compass
    }
    if (alpha === null) return;
    var az = cameraAzimuth(alpha, e.beta || 0, e.gamma || 0);
    if (az === null) return;
    gotOrientation = true;
    compassDenied = headingHopeless = false;
    pushHeading(az, 'sensor', e.webkitCompassAccuracy);
    while (headingWaiters.length) headingWaiters.pop()(false);
  }

  var listening = false;
  function listenOrientation(warnIfSilent) {
    if (!listening) {
      listening = true;
      window.addEventListener('deviceorientationabsolute', onOrientation, true);
      window.addEventListener('deviceorientation', onOrientation, true);
    }
    // Granted but silent usually means Motion & Orientation Access is off in Safari
    if (warnIfSilent) {
      setTimeout(function () {
        if (!gotOrientation) {
          toast('No compass data — check Settings → Safari → Motion & Orientation Access', 'warn', 7000);
        }
      }, 5000);
    }
  }

  function needsGesture() {
    var DOE = window.DeviceOrientationEvent;
    return !!DOE && typeof DOE.requestPermission === 'function';
  }

  /** Resolves true once orientation data is allowed to flow. */
  function startCompass() {
    var DOE = window.DeviceOrientationEvent;
    if (!DOE) { toast('No compass on this device', 'warn'); return Promise.resolve(false); }
    if (!needsGesture()) { listenOrientation(true); return Promise.resolve(true); }
    if (compassPending) return compassPending;
    var p;
    try {
      p = DOE.requestPermission();
    } catch (e) {
      return Promise.resolve(false);     // not a valid gesture — try again on the next one
    }
    compassPending = Promise.resolve(p).then(function (r) {
      compassPending = null;
      if (r === 'granted') { listenOrientation(true); return true; }
      compassDenied = true;
      toast('Compass blocked — tap the compass to ask again', 'warn', 5000);
      return 'denied';
    }).catch(function () {
      compassPending = null;
      return false;                      // Safari refused the call; the next gesture retries
    });
    return compassPending;
  }

  /**
   * iOS only hands out compass data after asking, and only from a user gesture.
   * Two things make that invisible to the user:
   *   1. listen passively first — if the origin was already granted, data flows
   *      with no prompt and no tap at all;
   *   2. otherwise ask on the first touch anywhere in the app.
   * Only touchend/click are used: Safari does not treat pointerdown as a valid
   * gesture for this call, and asking there burns the tap for nothing. The
   * listeners stay put until a request actually resolves, so a refused call is
   * retried on the next tap instead of being swallowed.
   */
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
      startCompass().then(function (r) {
        if (r === true || r === 'denied') unarm();   // answered; stop intercepting taps
      });
    };
    document.addEventListener('touchend', fire, true);
    document.addEventListener('click', fire, true);
  }

  /* ───────────────────────────── location ─────────────────────────── */

  function fixAge() {
    return state.posAt ? Date.now() - state.posAt : Infinity;
  }

  function ago(ms) {
    var s = Math.round(ms / 1000);
    return s < 60 ? s + 's' : Math.round(s / 60) + 'm';
  }

  /**
   * The chip reflects what we actually hold. A geolocation TIMEOUT is routine on
   * iOS and says nothing about the fix already in hand — blanking the readout to
   * "no fix" while photos were still being placed from that fix was simply a lie.
   */
  function renderGPS() {
    var chip = $('chip-gps');
    var label = chip.querySelector('.label');
    if (state.gpsDenied) {
      chip.className = 'chip bad';
      label.textContent = 'denied';
      return;
    }
    if (!state.pos) {
      chip.className = 'chip bad';
      label.textContent = state.gpsError ? 'searching' : 'no fix';
      return;
    }
    var acc = state.pos.coords.accuracy;
    var age = fixAge();
    label.textContent = (acc ? '±' + Math.round(acc) + 'm' : '--') + (age > 45000 ? ' · ' + ago(age) : '');
    chip.className = 'chip ' + (age > 180000 ? 'bad'
      : age > 45000 || acc > 30 ? 'warn'
      : acc <= 10 ? 'ok' : 'warn');
  }

  var lastGpsNote = 0;

  function startGPS() {
    if (!navigator.geolocation) { toast('No GPS on this device', 'warn'); return; }
    setInterval(renderGPS, 5000);                 // so the age keeps up
    navigator.geolocation.watchPosition(function (p) {
      state.pos = p;
      state.posAt = Date.now();
      state.gpsError = null;
      state.gpsDenied = false;
      renderGPS();
      // fall back to course over ground when the phone has no magnetometer
      if (state.headingSource !== 'sensor' && p.coords.speed > 1.5 && p.coords.heading !== null) {
        pushHeading(p.coords.heading, 'gps');
      }
    }, function (err) {
      state.gpsError = err.code;
      if (err.code === err.PERMISSION_DENIED) {
        state.gpsDenied = true;
        state.pos = null;
        toast('Location permission denied — points need it', 'bad', 4000);
      } else if (Date.now() - lastGpsNote > 60000) {
        // a timeout only means this attempt failed; the last fix still stands
        lastGpsNote = Date.now();
        Report.note('gps error', err.code === err.TIMEOUT ? 'timeout' : 'position unavailable');
      }
      renderGPS();
    }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 60000 });
  }

  /* ───────────────────────────── camera ───────────────────────────── */

  function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showNoVideo('This browser has no camera API — use the file picker.');
      return Promise.resolve();
    }
    stopCamera();

    // getUserMedia can sit unresolved indefinitely — after a cold start with the
    // radio off, notably. A viewfinder that never arrives and never explains
    // itself is just a black screen, so give it a deadline.
    var settled = false;
    var deadline = new Promise(function (res) {
      setTimeout(function () {
        if (!settled) { showNoVideo('Camera did not start. Tap to try again.'); res(); }
      }, 8000);
    });

    var open = navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: state.facing }, width: { ideal: 2560 }, height: { ideal: 1920 } }
    }).then(function (s) {
      settled = true;
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
        track.addEventListener('mute', function () {
          // routine on iOS, and noisy — record at most one every half minute
          if (Date.now() - lastMuteNote > 30000) {
            lastMuteNote = Date.now();
            Report.note('camera muted (usually harmless)');
          }
        });
        track.addEventListener('unmute', function () {
          staleTicks = 0;
          v.play().catch(function () {});
        });
      }
      return v.play().catch(function () { /* autoplay quirks — the tap already started it */ });
    }).catch(function (e) {
      settled = true;
      var name = Arc.asError(e).name || (e && e.name);
      Report.note('camera failed', name);
      showNoVideo(name === 'NotAllowedError'
        ? 'Camera permission denied. Tap to try again.'
        : 'Camera unavailable (' + name + '). Tap to try again.');
    });

    return Promise.race([open, deadline]);
  }

  /* ── keeping the preview alive ──────────────────────────────────
     iOS suspends the capture session for all sorts of reasons — an incoming
     call, another app grabbing the camera, a thermal pause — and hands back a
     stream whose tracks are still "live" while no new frames arrive. The
     preview freezes on its last frame, and the only clue is that nothing
     moves. Flipping the camera fixes it because that builds a new stream. */

  var lastFrameTime = -1, staleTicks = 0, lastRecovery = 0, cameraStartedAt = 0, lastMuteNote = 0;
  var GRACE = 6000;                  // a fresh stream needs a moment before it is judged

  function videoTrack() {
    return state.stream ? state.stream.getVideoTracks()[0] : null;
  }

  /**
   * iOS mutes a track constantly — a notification, a focus change, a brief
   * interruption — and unmutes a moment later with the camera perfectly fine.
   * Treating `muted` as failure restarts a working camera, so the only signals
   * trusted here are a track that has ended and a frame clock that has stopped.
   */
  function cameraHealthy() {
    var v = $('preview');
    if (!state.stream || !v) return false;
    var t = videoTrack();
    if (!t || t.readyState !== 'live') return false;
    return !!v.videoWidth;
  }

  function previewStalled() {
    if (!state.stream) return false;
    var t = videoTrack();
    if (!t || t.readyState === 'ended') return true;
    return staleTicks >= 2;            // ~4s with no new frame
  }

  function recoverCamera(why) {
    if (Date.now() - lastRecovery < 8000) return Promise.resolve();  // don't loop
    lastRecovery = Date.now();
    staleTicks = 0;
    lastFrameTime = -1;
    Report.note('camera recovery', why);
    toast('Camera stalled — restarting it', 'warn');
    return startCamera();
  }

  function watchCamera() {
    setInterval(function () {
      if (document.visibilityState !== 'visible' || !state.stream) return;
      if (Date.now() - cameraStartedAt < GRACE) return;   // still warming up
      var v = $('preview');
      var t = videoTrack();
      if (!t || t.readyState === 'ended') return void recoverCamera('track ended');

      if (!v.videoWidth) staleTicks++;                    // never produced a frame
      else if (v.currentTime === lastFrameTime) staleTicks++;
      else staleTicks = 0;
      lastFrameTime = v.currentTime;

      if (staleTicks === 1 && v.paused) v.play().catch(function () { /* handled below */ });
      if (staleTicks >= 3) recoverCamera('no new frames for ~6s');
    }, 2000);
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

  /** Last resort: say what went wrong instead of leaving a black rectangle. */
  function showFatal(msg) {
    try {
      showNoVideo('Something went wrong starting the app: ' + msg);
      var btn = $('start-cam');
      btn.textContent = 'Reload';
      btn.onclick = function () { location.reload(); };
    } catch (e) { /* nothing left to do */ }
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

  function devicePlatform() {
    var m = navigator.userAgent.match(/\((?:Linux; )?(?:U; )?([^;)]+)/);
    return (m ? m[1] : 'web').trim();
  }

  function deviceLabel() {
    return ('Exotic Camera / ' + devicePlatform()).slice(0, 50);
  }

  function capture() {
    if (state.busy) return Promise.resolve();
    // check the fix first — a shutter click for a photo we can't place is a lie
    if (!state.pos) {
      Sound.error();
      toast('No GPS fix yet — waiting for location', 'bad', 3500);
      return Promise.resolve();
    }
    // A stalled preview shows the last good frame, so a shot taken now would
    // quietly record a stale image at the current GPS fix.
    if (state.stream && previewStalled()) {
      Sound.error();
      toast('Preview had stalled — restarting, take it again', 'warn', 3500);
      recoverCamera('stalled at the shutter');
      return Promise.resolve();
    }

    state.busy = true;
    // The first shot often lands while the compass permission dialog is still up.
    // Wait for the answer, then briefly for the first sample, so shot one is not
    // silently headingless.
    var settle = compassPending || Promise.resolve();
    return settle
      .then(function () { return state.heading === null ? firstHeading(1500) : null; })
      .then(doCapture);
  }

  function doCapture() {
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
      toast('Capture failed: ' + errText(e), 'bad');
    });
  }

  function enqueue(img) {
    var p = state.pos && state.pos.coords;
    if (p && fixAge() > 120000) {
      toast('Location is ' + ago(fixAge()) + ' old — move outside for a fresh fix', 'warn', 4000);
    }
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
      make: 'Exotic Camera',
      model: devicePlatform(),
      // pin the destination now: switching layers later must not redirect
      // photos that were already taken
      serviceUrl: Config.get().serviceUrl,
      layerId: Config.get().layerId,
      layerName: Config.layerName(),
      state: 'pending'
    };
    applyTag(item);
    item.filename = photoName(item);
    if (item.heading === null || item.heading === undefined) {
      toast('Saved without a heading — compass not available', 'warn', 4000);
    }
    Report.note('captured', { heading: item.heading, acc: Math.round(item.hAcc || 0), layer: item.layerName });
    var stampedBlob = null;
    return Exif.write(img.blob, exifMeta(item)).then(function (stamped) {
      stampedBlob = stamped;                  // Store.add moves the bytes out of `item`
      item.blob = stamped;
      return Store.add(item);
    }).then(function () {
      if (Config.get().saveToDevice) saveCopy(stampedBlob, photoName(item));
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

  /* ── keeping a copy on the phone ──────────────────────────────── */

  /** The heading the app records is magnetic unless it came from GPS course. */
  function exifMeta(item) {
    return {
      lat: item.lat, lon: item.lon, alt: item.alt,
      heading: item.heading,
      headingRef: (item.headingSource === 'gps' || item.headingSource === 'exif') ? 'T' : 'M',
      hAcc: item.hAcc, speed: item.speed,
      taken: item.createdAt,
      device: item.make || 'Exotic Camera',
      model: item.model || item.device
    };
  }

  function photoName(item) {
    var d = new Date(item.createdAt);
    var p = function (n, w) { return String(n).padStart(w || 2, '0'); };
    return 'exoticcam_' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' +
      p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) +
      (item.heading === null || item.heading === undefined ? '' : '_hdg' + p(Math.round(item.heading), 3)) + '.jpg';
  }

  /**
   * Hand a photo to the phone. On iOS there is no way for a web app to write to
   * the camera roll directly, so we open the share sheet — "Save Image" puts it
   * in Photos. Everywhere else a plain download lands in the gallery folder.
   */
  function saveCopy(blob, name) {
    if (!blob) return Promise.resolve(false);
    var file;
    try { file = new File([blob], name, { type: 'image/jpeg' }); } catch (e) { file = null; }

    if (file && isIOS() && navigator.canShare && navigator.canShare({ files: [file] })) {
      return navigator.share({ files: [file] }).then(function () { return true; })
        .catch(function (e) {
          if (e && e.name === 'AbortError') return false;      // user closed the sheet
          return downloadBlob(blob, name);
        });
    }
    return Promise.resolve(downloadBlob(blob, name));
  }

  function downloadBlob(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 15000);
    return true;
  }

  /** Hand every retained photo over at once — iOS offers "Save N Images". */
  function saveAllToDevice() {
    return Store.all().then(function (rows) {
      var withPhoto = rows.filter(function (r) { return r.hasPhoto; }).slice(0, 30);
      if (!withPhoto.length) return toast('No photos still held on the device', 'warn');

      return Promise.all(withPhoto.map(function (r) { return Store.photo(r.id); })).then(function (blobs) {
        withPhoto = withPhoto.filter(function (r, i) { r.blob = blobs[i]; return !!blobs[i]; });
        return finishSaveAll(withPhoto);
      });
    });
  }

  function finishSaveAll(withPhoto) {
    return Promise.resolve().then(function () {
      if (!withPhoto.length) return toast('No photos still held on the device', 'warn');
      var files = [];
      for (var i = 0; i < withPhoto.length && i < 30; i++) {
        try { files.push(new File([withPhoto[i].blob], photoName(withPhoto[i]), { type: 'image/jpeg' })); }
        catch (e) { /* older browser: fall back to downloads below */ }
      }
      var more = withPhoto.length > files.length ? ' (' + files.length + ' of ' + withPhoto.length + ')' : '';

      if (files.length && navigator.canShare && navigator.canShare({ files: files })) {
        return navigator.share({ files: files }).then(function () {
          Sound.sent();
          toast('Handed ' + files.length + ' photo(s) to the phone' + more, 'ok');
        }).catch(function (e) {
          if (!e || e.name === 'AbortError') return;
          withPhoto.forEach(function (r) { downloadBlob(r.blob, photoName(r)); });
        });
      }
      withPhoto.forEach(function (r) { downloadBlob(r.blob, photoName(r)); });
      Sound.tick();
      toast('Saved ' + withPhoto.length + ' photo(s)', 'ok');
    });
  }

  /** Drop the local JPEG once it has been uploaded and had its keep time. */
  function pruneLocalCopies() {
    var keep = (Config.get().keepHours || 48) * 3600000;
    return Store.all().then(function (rows) {
      var stale = rows.filter(function (r) {
        return r.state === 'sent' && r.hasPhoto && r.sentAt && Date.now() - r.sentAt > keep;
      });
      return Promise.all(stale.map(function (r) {
        return Store.dropPhoto(r.id).then(function () { return Store.patch(r.id, { hasPhoto: false }); });
      }));
    });
  }

  function flashScreen() {
    var f = $('flash');
    f.classList.remove('go');
    void f.offsetWidth;
    f.classList.add('go');
  }

  /* ──────────────── editing a photo already in the queue ───────────
     Changing a note after the fact is normal field work. If the photo has not
     gone up yet the edit simply rides along; if it has, the change is pushed to
     the layer — and if that cannot happen now, it is queued like any other work
     owed to the server. */

  var editing = null, editFields = { feature: null, notes: null };

  function openEditor(id) {
    return Store.item(id).then(function (item) {
      if (!item) return;
      editing = item;
      $('edit-thumb').style.backgroundImage = item.thumb ? 'url(' + item.thumb + ')' : '';
      $('edit-meta').innerHTML = '<b>' + esc(new Date(item.createdAt).toLocaleString()) + '</b>' +
        '<span>' + (item.heading === null || item.heading === undefined ? 'no heading' : Math.round(item.heading) + '°') +
        ' · ' + esc(item.layerName || Config.layerName()) +
        (item.state === 'sent' ? ' · OBJECTID ' + item.objectId : ' · not uploaded yet') + '</span>';

      return Arc.layerMeta(false, Arc.targetUrl(item)).then(function (meta) {
        var map = Arc.resolveFields(meta);
        editFields.feature = tagFieldInfo(map.feature);
        editFields.notes = tagFieldInfo(map.notes);
      }).catch(function () {
        editFields.feature = { name: 'feature', alias: 'Feature', length: 255 };
        editFields.notes = { name: 'notes', alias: 'Note', length: 255 };
      }).then(function () {
        var f = editFields.feature, n = editFields.notes;
        $('edit-feature-wrap').classList.toggle('hidden', !f);
        $('edit-note-wrap').classList.toggle('hidden', !n);
        if (f) {
          $('edit-feature-name').textContent = f.alias;
          $('edit-feature').maxLength = f.length;
          $('edit-feature').value = item.feature || '';
        }
        if (n) {
          $('edit-note-name').textContent = n.alias;
          $('edit-note').maxLength = n.length;
          $('edit-note').value = item.notes || '';
        }
        $('edit-hint').textContent = !f && !n
          ? 'This layer has no Feature or Note field, so there is nothing to edit here.'
          : item.state === 'sent'
            ? 'Saving updates the point already on the layer.'
            : 'Saving updates the photo before it goes up.';
        $('edit-save').disabled = !f && !n;
        countEdit();
        openSheet('edit-panel');
      });
    });
  }

  function backToQueue() {
    return renderQueue().then(function () { openSheet('queue-panel'); });
  }

  function countEdit() {
    [['edit-feature', 'edit-feature-count', editFields.feature],
     ['edit-note', 'edit-note-count', editFields.notes]].forEach(function (t) {
      if (!t[2]) return;
      var el = $(t[0]), out = $(t[1]);
      out.textContent = el.value.length + '/' + t[2].length;
      out.classList.toggle('full', el.value.length >= t[2].length);
    });
  }

  function saveEdit() {
    if (!editing) return Promise.resolve();
    var item = editing;
    var patch = {};
    if (editFields.feature) patch.feature = $('edit-feature').value.trim();
    if (editFields.notes) patch.notes = $('edit-note').value.trim();

    var unchanged = (patch.feature === undefined || patch.feature === (item.feature || '')) &&
                    (patch.notes === undefined || patch.notes === (item.notes || ''));
    if (unchanged) { closeSheets(); return Promise.resolve(); }

    if (item.state === 'sent') patch.pendingEdit = true;
    $('edit-save').disabled = true;

    return Store.patch(item.id, patch).then(function () {
      Report.note('edited', { id: item.id.slice(0, 8), sent: item.state === 'sent' });
      $('edit-save').disabled = false;
      Sound.tick();
      return refreshCounts();
    }).then(function () {
      // the editor is only ever reached from the queue, so go back to it
      return backToQueue();
    }).then(function () {
      if (item.state !== 'sent') { toast('Saved — it will go up with the photo', 'ok'); return null; }
      if (!state.online) { toast('Saved — the layer will be updated when back online', 'warn', 4000); return null; }
      return sync(true);
    });
  }

  /* ─────────────────── the session tag ─────────────────────────────
     A feature name and/or note that rides along with every photo until it is
     changed or cleared. Which inputs appear, and how long they may be, come
     from the target layer's own schema. */

  var tag = { feature: '', note: '' };
  var tagFields = { feature: null, notes: null };
  var tagSaveTimer = null;

  function tagFieldInfo(f) {
    return f ? { name: f.name, alias: f.alias || f.name, length: f.length || 255 } : null;
  }

  function refreshTagFields() {
    return Arc.layerMeta().then(function (meta) {
      var map = Arc.resolveFields(meta);
      tagFields.feature = tagFieldInfo(map.feature);
      tagFields.notes = tagFieldInfo(map.notes);
    }).catch(function () {
      // never seen this layer's schema: offer both, at a length both layers allow
      tagFields.feature = tagFields.feature || { name: 'feature', alias: 'Feature', length: 255 };
      tagFields.notes = tagFields.notes || { name: 'notes', alias: 'Note', length: 255 };
    }).then(applyTagFields);
  }

  /** What of the current tag this layer can actually store, and what it cannot. */
  function tagStatus() {
    var kept = [], dropped = [];
    if (tag.feature) (tagFields.feature ? kept : dropped).push({ label: 'Feature', value: tag.feature });
    if (tag.note) (tagFields.notes ? kept : dropped).push({ label: 'Note', value: tag.note });
    return { kept: kept, dropped: dropped };
  }

  function applyTagFields() {
    var f = tagFields.feature, n = tagFields.notes;
    var st = tagStatus();
    $('tag-feature-wrap').classList.toggle('hidden', !f);
    $('tag-note-wrap').classList.toggle('hidden', !n);
    // hide the button on a layer with nowhere to put a tag — unless something is
    // already set, in which case say so rather than drop it silently
    $('tagger').classList.toggle('hidden', !f && !n && !st.dropped.length);

    if (f) {
      $('tag-feature-name').textContent = f.alias;
      $('tag-feature').maxLength = f.length;
      if (tag.feature.length > f.length) tag.feature = tag.feature.slice(0, f.length);
      $('tag-feature').value = tag.feature;
    }
    if (n) {
      $('tag-note-name').textContent = n.alias;
      $('tag-note').maxLength = n.length;
      if (tag.note.length > n.length) tag.note = tag.note.slice(0, n.length);
      $('tag-note').value = tag.note;
    }
    $('tag-hint').textContent = st.dropped.length
      ? Config.layerName() + ' has no ' + st.dropped.map(function (d) { return d.label; }).join(' or ') +
        ' field, so ' + (st.kept.length ? 'that part' : 'this tag') + ' will not be written there.'
      : 'Goes on every photo sent to ' + Config.layerName() + ' until cleared.';
    countTag();
    renderTag();
  }

  function countTag() {
    [['tag-feature', 'tag-feature-count', tagFields.feature],
     ['tag-note', 'tag-note-count', tagFields.notes]].forEach(function (t) {
      if (!t[2]) return;
      var el = $(t[0]), out = $(t[1]);
      out.textContent = el.value.length + '/' + t[2].length;
      out.classList.toggle('full', el.value.length >= t[2].length);
    });
  }

  /**
   * The button must show what this layer will actually record. Showing a
   * feature name on a layer with no Feature field reads as "every photo is
   * being tagged", when in truth none of them are.
   */
  function renderTag() {
    var st = tagStatus();
    var shown = st.kept.length ? st.kept[0].value : (st.dropped.length ? st.dropped[0].value : '');
    $('tagger').classList.toggle('set', !!st.kept.length);
    $('tagger').classList.toggle('stranded', !!st.dropped.length && !st.kept.length);
    $('tag-label').textContent = shown || 'Tag';
    $('tag-toggle').setAttribute('title', !shown ? 'Tag these photos'
      : st.kept.length ? 'Tagging every photo: ' + st.kept.map(function (k) { return k.value; }).join(' · ')
      : 'Not written to ' + Config.layerName() + ': ' + shown);
  }

  function saveTag() {
    clearTimeout(tagSaveTimer);
    tagSaveTimer = setTimeout(function () {
      Store.set('sessionTag', tag);
    }, 300);
  }

  function readTagInputs() {
    tag.feature = tagFields.feature ? $('tag-feature').value : tag.feature;
    tag.note = tagFields.notes ? $('tag-note').value : tag.note;
    countTag();
    renderTag();
    saveTag();
  }

  function openTag(open) {
    var el = $('tagger');
    var isOpen = open === undefined ? !el.classList.contains('open') : open;
    el.classList.toggle('open', isOpen);
    $('tag-toggle').setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    if (isOpen) {
      var first = tagFields.feature ? $('tag-feature') : $('tag-note');
      setTimeout(function () { first.focus(); }, 60);
    }
  }

  function clearTag() {
    tag = { feature: '', note: '' };
    $('tag-feature').value = '';
    $('tag-note').value = '';
    countTag();
    renderTag();
    Store.set('sessionTag', tag);
    Sound.tick();
    toast('Tag cleared', 'ok', 1600);
  }

  /** Stamp the current tag onto a photo about to be queued. */
  function applyTag(item) {
    if (tag.feature) item.feature = tag.feature;
    if (tag.note) item.notes = tag.note;
    return item;
  }

  /* ────────────────── importing photos already on the phone ────────── */

  /** Decode with the camera's own orientation applied, then re-encode to size. */
  function decodeOriented(file) {
    if (self.createImageBitmap) {
      return createImageBitmap(file, { imageOrientation: 'from-image' })
        .catch(function () { return decodeViaImg(file); });
    }
    return decodeViaImg(file);
  }

  function decodeViaImg(file) {
    return new Promise(function (res, rej) {
      var img = new Image();
      var url = URL.createObjectURL(file);
      img.onload = function () { URL.revokeObjectURL(url); res(img); };
      img.onerror = function () { URL.revokeObjectURL(url); rej(new Error('Could not read this image')); };
      img.src = url;
    });
  }

  function importOne(file) {
    return Exif.read(file).then(function (ex) {
      if (!ex.found || ex.lat === null || ex.lon === null) {
        return { skipped: 'no location' };
      }
      return decodeOriented(file).then(function (src) {
        var w = src.width || src.naturalWidth, h = src.height || src.naturalHeight;
        if (!w || !h) throw new Error('Could not read this image');
        return drawToBlob(src, w, h).then(function (img) {
          if (src.close) src.close();
          var item = {
            id: Store.uuid(),
            createdAt: ex.taken || file.lastModified || Date.now(),
            blob: img.blob,
            thumb: img.thumb,
            w: img.w, h: img.h,
            lat: ex.lat,
            lon: ex.lon,
            alt: ex.alt,
            hAcc: ex.hAcc,
            vAcc: null,
            speed: ex.speed,
            course: null,
            heading: ex.heading === null ? null : Math.round(ex.heading * 10) / 10,
            headingSource: ex.heading === null ? null : ('exif' + (ex.headingRef === 'M' ? '-mag' : '')),
            device: ('Imported · ' + (ex.camera || 'unknown camera')).slice(0, 50),
            make: ex.make || 'Exotic Camera',
            model: ex.model || (ex.camera || 'imported'),
            source: 'import',
            serviceUrl: Config.get().serviceUrl,
            layerId: Config.get().layerId,
            layerName: Config.layerName(),
            state: 'pending'
          };
          applyTag(item);
          item.filename = photoName(item);
          return Exif.write(img.blob, exifMeta(item)).then(function (stamped) {
            item.blob = stamped;
            return Store.add(item);
          }).then(function () {
            return { added: true, heading: item.heading };
          });
        });
      });
    }).catch(function (e) {
      return { skipped: errText(e) };
    });
  }

  function importFiles(files) {
    var list = Array.prototype.slice.call(files || []);
    if (!list.length) return Promise.resolve();

    var added = 0, noLoc = 0, failed = 0, withHeading = 0, done = 0;
    $('import-title').textContent = 'Adding ' + list.length + ' photo' + (list.length === 1 ? '' : 's');
    $('import-summary').textContent = '';
    $('import-bar').style.width = '0%';
    $('import-status').textContent = 'Reading…';
    openSheet('import-panel');
    Report.note('import started', list.length + ' file(s)');

    return list.reduce(function (chain, file) {
      return chain.then(function () {
        return importOne(file).then(function (r) {
          done++;
          if (r.added) { added++; if (r.heading !== null && r.heading !== undefined) withHeading++; }
          else if (r.skipped === 'no location') noLoc++;
          else failed++;
          $('import-bar').style.width = Math.round(done / list.length * 100) + '%';
          $('import-status').textContent = done + ' of ' + list.length + ' read · ' + added + ' added';
        });
      });
    }, Promise.resolve()).then(function () {
      var parts = [added + ' added' + (withHeading ? ' (' + withHeading + ' with a compass heading)' : '')];
      if (noLoc) parts.push(noLoc + ' skipped — no location stored in the photo');
      if (failed) parts.push(failed + ' could not be read');
      $('import-status').textContent = 'Done.';
      $('import-summary').innerHTML = parts.map(esc).join('<br>');
      Report.note('import finished', { added: added, noLoc: noLoc, failed: failed });
      if (added) { Sound.queued(); } else { Sound.error(); }
      return refreshCounts().then(function () {
        if (added && state.online && Config.get().autoSync) sync(true);
      });
    });
  }

  /* ─────────────────────────── sync engine ────────────────────────── */

  function sheetOpen(id) {
    var el = $(id);
    return el && !el.classList.contains('hidden');
  }

  function refreshCounts() {
    return Store.counts().then(function (c) {
      state.counts = c;
      var chip = $('chip-queue');
      chip.querySelector('.label').textContent = String(c.outstanding);
      chip.className = 'chip' + (c.error ? ' bad' : c.outstanding ? ' warn' : ' ok');
      $('mi-queue-sub').textContent = c.outstanding
        ? c.outstanding + ' waiting' + (c.error ? ', ' + c.error + ' failed' : '') +
          (c.edits ? ', ' + c.edits + ' edited' : '')
        : 'nothing pending';
      // watching the queue should mean watching it change, not tapping away and back
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
      // photos held back by a retry timer are due immediately: the wait was the
      // connection's fault, not theirs
      Arc.clearBackoff().then(function () {
        if (Config.get().autoSync) sync(true);
        Report.flushHeld();               // reports wait for a connection too
      });
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
        Report.note('upload start', item.id);
        $('chip-queue').classList.add('busy');
      } else if (type === 'sent') {
        sentAny = true;
        Sound.sent();
        buzz(10);
        pulseSent();
        refreshCounts();
      } else if (type === 'failed') {
        Report.note('upload failed', errText(err));
        if (!err.retryable && !err.needAuth) {
          toast('Upload failed: ' + errText(err), 'bad', 4000);
          Report.send(reportContext('upload', errText(err), { extra: 'item ' + item.id }));
        }
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
      var msg = errText(e);
      toast(msg, 'bad', 4000);
      Report.note('sync aborted', msg);
      Report.send(reportContext('sync', msg, { stack: Arc.asError(e).stack }));
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
    if (self.Snake) Snake.close();          // never leave the game ticking behind a sheet
    // every .sheet, not a hand-kept list — a new panel missing from that list
    // stays stuck open over the viewfinder, which has happened twice
    Array.prototype.forEach.call(document.querySelectorAll('.sheet'), function (el) {
      if (el.classList.contains('hidden')) return;
      el.classList.remove('open');
      setTimeout(function () { el.classList.add('hidden'); }, 220);
    });
  }

  function renderQueue() {
    return Store.all().then(function (rows) {
      var list = $('queue-list');
      if (!rows.length) {
        list.innerHTML = '<p class="hint">Queue is empty.</p>';
        $('q-save-hint').textContent = '';
        return;
      }
      list.innerHTML = rows.map(function (r) {
        var when = new Date(r.createdAt).toLocaleString();
        // the point goes up before the photo, so "sent" without an attachment is
        // a point on the map with nothing behind it — say so rather than imply
        // the photo made it
        var noPhoto = r.objectId && !r.attachmentId;
        var sub = r.pendingEdit ? 'edit waiting to go up'
          : r.state === 'sent' ? (noPhoto
              ? 'OBJECTID ' + r.objectId + ' · filed without a photo'
              : 'uploaded · OBJECTID ' + (r.objectId || '?'))
          : r.state === 'error' ? esc(r.lastError || 'failed')
          : r.state === 'uploading' ? 'uploading…'
          // A connection failure deliberately doesn't raise `attempts`, which used
          // to mean a row failing every minute for hours still read "waiting"
          // with no error at all. Count those too, or a stuck photo is invisible.
          : (r.attempts || r.netAttempts)
            ? 'retry ' + (r.attempts || r.netAttempts) + (r.lastError ? ' · ' + esc(r.lastError) : '')
            : 'waiting';
        if (noPhoto && r.state !== 'sent') sub = 'point filed, photo still owed · ' + sub;
        var where = r.layerName && r.layerName !== Config.layerName() ? ' → ' + esc(r.layerName) : '';
        if (r.source === 'import') where = ' · imported' + where;
        if (r.feature) where = ' · ' + esc(r.feature) + where;
        return '<div class="qrow ' + r.state + (r.pendingEdit ? ' edited' : '') + '">' +
          '<div class="qthumb" style="background-image:url(' + (r.thumb || '') + ')"></div>' +
          '<div class="qmeta"><b>' + esc(when) + '</b>' +
          '<span>' + (r.heading === null || r.heading === undefined ? 'no heading' : Math.round(r.heading) + '°') +
          ' · ' + (r.hAcc ? '±' + Math.round(r.hAcc) + 'm' : 'no acc') + where + '</span>' +
          '<span class="qsub">' + sub + '</span></div>' +
          '<button class="qedit" data-id="' + r.id + '" aria-label="Edit note">✎</button>' +
          (r.hasPhoto ? '<button class="qsave" data-id="' + r.id + '" aria-label="Save to device">⤓</button>' : '') +
          (r.state === 'sent' && r.objectId
            ? '<button class="qunsend" data-id="' + r.id + '" aria-label="Remove from the layer">⌫</button>'
            : '') +
          '<button class="qdel" data-id="' + r.id + '" aria-label="Remove from the queue">✕</button></div>';
      }).join('');
      var held = rows.filter(function (r) { return r.hasPhoto; }).length;
      $('q-save-hint').textContent = held
        ? held + ' photo(s) still held on this device (' + (Config.get().keepHours || 48) + 'h after upload).'
        : 'No local copies left — they are cleared after upload.';
      Array.prototype.forEach.call(list.querySelectorAll('.qedit'), function (b) {
        b.addEventListener('click', function () { openEditor(b.dataset.id); });
      });
      Array.prototype.forEach.call(list.querySelectorAll('.qsave'), function (b) {
        b.addEventListener('click', function () {
          Promise.all([Store.item(b.dataset.id), Store.photo(b.dataset.id)]).then(function (r) {
            if (!r[0] || !r[1]) return toast('Local copy no longer on the device', 'warn');
            return saveCopy(r[1], photoName(r[0])).then(function (done) {
              if (done) { Sound.tick(); toast('Saved', 'ok'); }
            });
          });
        });
      });

      // change your mind: take the uploaded photo back off the layer
      Array.prototype.forEach.call(list.querySelectorAll('.qunsend'), function (b) {
        b.addEventListener('click', function () {
          Store.item(b.dataset.id).then(function (r) {
            if (!r) return;
            if (!confirm('Delete this photo from ' + (r.layerName || 'the layer') +
                         ' (OBJECTID ' + r.objectId + ')? This cannot be undone.')) return;
            b.disabled = true;
            return Arc.deleteFeature(r).then(function () {
              Report.note('removed from layer', r.objectId);
              return Store.remove(r.id);
            }).then(function () {
              Sound.tick();
              toast('Removed from ' + (r.layerName || 'the layer'), 'ok');
              return renderQueue().then(refreshCounts);
            }).catch(function (e) {
              b.disabled = false;
              Sound.error();
              toast('Could not remove it: ' + errText(e), 'bad', 4500);
            });
          });
        });
      });
      Array.prototype.forEach.call(list.querySelectorAll('.qdel'), function (b) {
        b.addEventListener('click', function () {
          Store.remove(b.dataset.id).then(renderQueue).then(refreshCounts);
        });
      });
    });
  }

  /* ── layer picker ─────────────────────────────────────────────── */

  function renderLayerPicker() {
    var active = Config.activePreset();
    $('mi-layer-sub').textContent = Config.layerName();
    $('layer-list').innerHTML = Config.PRESETS.map(function (p) {
      var on = active && active.id === p.id;
      return '<button class="item' + (on ? ' on' : '') + '" data-layer="' + p.id + '">' +
        '<span class="i">▤</span><span>' + esc(p.name) +
        '<span class="layer-url">' + esc(p.serviceUrl.replace(/^https:\/\/[^/]+\/.*?\/services\//, '…/')) + '</span></span>' +
        (on ? '<span class="tick">✓</span>' : '') + '</button>';
    }).join('') + (active ? '' :
      '<div class="item on"><span class="i">✎</span><span>Custom layer' +
      '<span class="layer-url">' + esc(Config.layerUrl()) + '</span></span><span class="tick">✓</span></div>');

    Array.prototype.forEach.call($('layer-list').querySelectorAll('[data-layer]'), function (b) {
      b.addEventListener('click', function () {
        var id = b.dataset.layer;
        if (Config.activePreset() && Config.activePreset().id === id) return closeSheets();
        Config.useLayer(id).then(function () {
          Sound.tick();
          renderLayerPicker();
          closeSheets();
          toast('Photos now go to ' + Config.layerName(), 'ok');
          return Arc.layerMeta(true)
            .catch(function () { /* offline: resolved on upload */ })
            .then(refreshTagFields);
        });
      });
    });
  }

  function renderPresetButtons() {
    var active = Config.activePreset();
    $('s-presets').innerHTML = Config.PRESETS.map(function (p) {
      return '<button data-layer="' + p.id + '"' + (active && active.id === p.id ? ' class="on"' : '') + '>' +
        esc(p.name) + '</button>';
    }).join('');
    Array.prototype.forEach.call($('s-presets').children, function (b) {
      b.addEventListener('click', function () {
        var p = Config.preset(b.dataset.layer);
        $('s-url').value = p.serviceUrl;         // fill the fields; Save commits it
        $('s-layer').value = p.layerId;
        Array.prototype.forEach.call($('s-presets').children, function (o) { o.classList.remove('on'); });
        b.classList.add('on');
        Sound.tick();
      });
    });
  }

  function loadSettingsForm() {
    var c = Config.get();
    renderPresetButtons();
    $('s-url').value = c.serviceUrl;
    $('s-layer').value = c.layerId;
    $('s-appid').value = c.appId;
    $('s-portal').value = c.portal;
    $('s-maxdim').value = c.maxDim;
    $('s-quality').value = c.quality;
    $('s-quality-out').textContent = c.quality;
    $('s-savedevice').checked = c.saveToDevice;
    $('s-sound').checked = c.sound;
    $('s-haptics').checked = c.haptics;
    $('s-autosync').checked = c.autoSync;
    $('s-report').checked = c.reportProblems;
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
      saveToDevice: $('s-savedevice').checked,
      sound: $('s-sound').checked,
      haptics: $('s-haptics').checked,
      autoSync: $('s-autosync').checked,
      reportProblems: $('s-report').checked,
      fields: {}
    };
    ['heading', 'lat', 'lon', 'accuracy', 'altitude', 'captured', 'notes', 'device'].forEach(function (k) {
      var el = $('s-f-' + k);
      if (el) patch.fields[k] = el.value.trim();
    });
    return Config.save(patch).then(function (c) {
      var p = Config.activePreset();
      return Config.save({ activeLayer: p ? p.id : 'custom' });
    }).then(function (c) {
      Sound.setEnabled(c.sound);
      Sound.tick();
      renderLayerPicker();
      refreshTagFields();
      toast('Settings saved — photos go to ' + Config.layerName(), 'ok');
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

  /* ─────────────────────── problem reports ────────────────────────── */

  function sensorState() {
    return [
      'compass=' + (gotOrientation ? 'live' : listening ? 'listening' : 'off'),
      'hdg=' + (state.heading === null ? 'none' : Math.round(state.heading)),
      'gps=' + (state.pos ? '±' + Math.round(state.pos.coords.accuracy) + 'm/' + ago(fixAge()) : 'none') +
        (state.gpsDenied ? ' denied' : state.gpsError ? ' err' + state.gpsError : ''),
      'cam=' + (state.stream ? (cameraHealthy() ? 'live' : 'stalled') : 'off'),
      'camstale=' + staleTicks + (videoTrack() && videoTrack().muted ? ' muted' : ''),
      'standalone=' + (isStandalone() ? 'yes' : 'no'),
      'gesture=' + (needsGesture() ? 'required' : 'no')
    ].join(' ');
  }

  function reportContext(kind, summary, extra) {
    var p = state.pos && state.pos.coords;
    return {
      kind: kind,
      summary: summary,
      sensors: sensorState(),
      device: navigator.userAgent + ' | ' + screen.width + 'x' + screen.height +
              ' | ' + window.innerWidth + 'x' + window.innerHeight,
      queued: state.counts.outstanding,
      queueErrors: state.counts.error,
      online: state.online,
      lat: p ? p.latitude : undefined,
      lon: p ? p.longitude : undefined,
      stack: extra && extra.stack,
      extra: extra && extra.extra
    };
  }

  function watchForProblems() {
    window.addEventListener('error', function (e) {
      var msg = e.message || 'Script error';
      Report.note('window.error', msg);
      Report.send(reportContext('crash', msg, {
        stack: e.error && e.error.stack, extra: e.filename + ':' + e.lineno
      }));
    });
    window.addEventListener('unhandledrejection', function (e) {
      var r = Arc.asError(e.reason);
      Report.note('unhandled rejection', r.message);
      Report.send(reportContext('crash', r.message, { stack: r.stack }));
    });
  }

  function openBugPanel() {
    $('bug-preview').textContent = sensorState() + ' · queue ' + state.counts.outstanding +
      (state.counts.error ? ' (' + state.counts.error + ' failed)' : '') +
      ' · build ' + buildLabel();
    $('bug-note').value = '';
    openSheet('bug-panel');
  }

  function sendBugReport() {
    var note = $('bug-note').value.trim();
    $('bug-send').disabled = true;
    return Report.send(Object.assign(
      reportContext('manual', note || 'Manual report'),
      { note: note }
    )).then(function (okSent) {
      $('bug-send').disabled = false;
      closeSheets();
      if (okSent) { Sound.sent(); toast('Report sent — thank you', 'ok'); }
      else {
        // "offline or signed out" was a guess, and it was usually the wrong one.
        // Say what the table actually said, and that the report is being kept.
        Sound.error();
        toast('Report held — ' + (Report.lastFailure || 'could not send it') +
              '. It will go up on its own once that clears.', 'warn', 6000);
      }
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

  /* ── installing to the Home Screen ────────────────────────────── */

  var deferredPrompt = null;

  function isStandalone() {
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
           navigator.standalone === true;
  }

  function isIOS() {
    return /iP(hone|ad|od)/.test(navigator.platform || '') ||
           (/Mac/.test(navigator.userAgent) && 'ontouchend' in document);
  }

  function offerInstall() {
    if (deferredPrompt) {                       // Chrome/Edge can do it in one tap
      var p = deferredPrompt;
      deferredPrompt = null;
      closeSheets();
      p.prompt();
      return p.userChoice.then(function (c) {
        if (c && c.outcome === 'accepted') { Sound.sent(); toast('Installed', 'ok'); }
      }).catch(function () { /* dismissed */ });
    }
    // Safari has no install API — show it where the button lives
    $('steps-ios').classList.toggle('hidden', !isIOS());
    $('steps-other').classList.toggle('hidden', isIOS());
    var warn = $('install-queue-warn');
    warn.classList.toggle('hidden', !state.counts.outstanding);
    if (state.counts.outstanding) {
      warn.textContent = state.counts.outstanding + ' photo(s) still waiting to upload. ' +
        'Finish them here first — the installed app will not see them.';
    }
    openSheet('install-panel');
    return Promise.resolve();
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
    $('preview').addEventListener('click', function () {
      if (!cameraHealthy() || previewStalled()) { lastRecovery = 0; recoverCamera('tapped the preview'); }
    });
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
      if (state.heading === null) {
        compassDenied = headingHopeless = false;
        startCompass().then(function (r) { if (r !== true) armCompass(); });
      }
      else toast('Heading ' + Math.round(state.heading) + '° (' + (state.headingSource === 'gps' ? 'GPS course' : 'magnetometer') + ')');
    });

    $('tag-toggle').addEventListener('click', function (e) {
      e.stopPropagation();
      Sound.unlock();
      openTag();
    });
    $('tag-feature').addEventListener('input', readTagInputs);
    $('tag-note').addEventListener('input', readTagInputs);
    $('tag-feature').addEventListener('keydown', function (e) { if (e.key === 'Enter') openTag(false); });
    $('tag-clear').addEventListener('click', function (e) { e.stopPropagation(); clearTag(); openTag(false); });
    $('tag-done').addEventListener('click', function (e) { e.stopPropagation(); readTagInputs(); openTag(false); });
    $('tag-card').addEventListener('click', function (e) { e.stopPropagation(); });
    document.addEventListener('click', function () {
      if ($('tagger').classList.contains('open')) { readTagInputs(); openTag(false); }
    });

    $('menu-btn').addEventListener('click', function () {
      Sound.unlock(); Sound.tick();
      renderLayerPicker();
      renderAuth().then(function () { openSheet('menu'); });
    });
    $('last-shot').addEventListener('click', function () { renderQueue().then(function () { openSheet('queue-panel'); }); });
    $('chip-queue').addEventListener('click', function () { renderQueue().then(function () { openSheet('queue-panel'); }); });
    $('chip-net').addEventListener('click', function () { sync(true); });
    $('chip-gps').addEventListener('click', function () {
      var p = state.pos && state.pos.coords;
      toast(p ? p.latitude.toFixed(6) + ', ' + p.longitude.toFixed(6) + ' ±' + Math.round(p.accuracy) +
               'm, ' + ago(fixAge()) + ' ago'
             : state.gpsDenied ? 'Location permission denied' : 'No fix yet');
    });

    $('mi-layer').addEventListener('click', function () { renderLayerPicker(); openSheet('layer-panel'); });
    $('l-close').addEventListener('click', closeSheets);
    $('mi-queue').addEventListener('click', function () { renderQueue().then(function () { openSheet('queue-panel'); }); });
    $('mi-sync').addEventListener('click', function () { closeSheets(); sync(true); });
    $('mi-settings').addEventListener('click', function () { loadSettingsForm(); openSheet('settings-panel'); });
    $('mi-install').addEventListener('click', offerInstall);
    $('i-close').addEventListener('click', closeSheets);
    $('mi-reinstall').addEventListener('click', reinstall);
    $('mi-bug').addEventListener('click', openBugPanel);
    $('bug-close').addEventListener('click', closeSheets);
    $('bug-send').addEventListener('click', sendBugReport);
    $('mi-about').addEventListener('click', function () {
      $('about-body').innerHTML =
        'Build <b>' + esc(buildLabel()) + '</b><br>' +
        'Layer: <b>' + esc(Config.layerName()) + '</b><br><code>' + esc(Config.layerUrl()) + '</code><br>' +
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
    ['import-files', 's-import-files'].forEach(function (id) {
      $(id).addEventListener('change', function (e) {
        // FileList is live: clearing the input first would empty it under us
        var files = Array.prototype.slice.call(e.target.files);
        e.target.value = '';
        importFiles(files).then(renderQueue);
      });
    });
    $('import-close').addEventListener('click', function () {
      closeSheets();
      renderQueue();
    });
    $('edit-save').addEventListener('click', saveEdit);
    $('edit-cancel').addEventListener('click', function () { editing = null; backToQueue(); });
    $('edit-feature').addEventListener('input', countEdit);
    $('edit-note').addEventListener('input', countEdit);
    $('q-save-all').addEventListener('click', function () {
      saveAllToDevice().then(renderQueue);
    });
    $('q-clear-done').addEventListener('click', function () {
      Store.removeSent().then(renderQueue).then(refreshCounts);
    });

    $('s-save').addEventListener('click', saveSettings);
    $('s-close').addEventListener('click', closeSheets);
    $('a-close').addEventListener('click', closeSheets);
    $('a-snake').addEventListener('click', function () {
      openSheet('snake-panel');
      Snake.open();
    });
    $('snake-close').addEventListener('click', closeSheets);
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
        $('s-schema').innerHTML = '<span class="bad-text">' + esc(errText(e)) + '</span>';
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
        // the layer's schema only becomes readable once signed in, so the tag
        // card can finally take its real field names and limits
        return renderAuth().then(refreshTagFields).then(function () { return sync(); });
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
        closeSheets();
        // the layer's schema only becomes readable once signed in, so the tag
        // card can finally take its real field names and limits
        return renderAuth().then(refreshTagFields).then(function () { return sync(); });
      });
    });
    $('si-close').addEventListener('click', closeSheets);

    document.addEventListener('click', function (e) {
      if (e.target.classList.contains('sheet')) closeSheets();
    });
    window.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        if ($('tagger').classList.contains('open')) return openTag(false);
        return closeSheets();
      }
      if (sheetOpen('snake-panel')) Snake.keydown(e);
    });

    window.addEventListener('beforeinstallprompt', function (e) {
      e.preventDefault();
      deferredPrompt = e;
    });
    window.addEventListener('appinstalled', function () {
      deferredPrompt = null;
      Store.set('installHinted', true);
    });

    window.addEventListener('online', function () { setNet(true); });
    window.addEventListener('offline', function () { setNet(false); });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState !== 'visible') return;
      setNet(navigator.onLine);
      refreshCounts().then(function () {
        if (state.online && Config.get().autoSync) sync();
      });
      staleTicks = 0;
      lastFrameTime = -1;
      if (!cameraHealthy()) startCamera();
      else if ($('preview').paused) $('preview').play().catch(function () {});
    });
    window.addEventListener('pagehide', stopCamera);
  }

  /* ────────────────────────────── boot ────────────────────────────── */

  function boot() {
    watchForProblems();
    if (self.Snake) Snake.attach($('snake-canvas'));
    Report.note('boot', navigator.userAgent.slice(0, 120));
    buildDial();
    renderHeading();
    wire();

    Config.load().then(function (c) {
      Sound.setEnabled(c.sound);
      $('mi-about-sub').textContent = 'build ' + buildLabel();
      $('mi-layer-sub').textContent = Config.layerName();
      return Arc.completeOAuth().catch(function (e) {
        toast('Sign-in failed: ' + errText(e), 'bad', 5000);
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
      if (needsGesture()) {
        // a previously granted origin often streams data with no prompt at all
        listenOrientation(false);
        armCompass();
        setTimeout(function () { if (!gotOrientation) armCompass(); }, 1500);
      } else {
        startCompass();
      }
      watchCamera();
      startCamera();                        // deliberately not awaited: a slow
      return Store.all();                   // camera must not hold up the queue
    }).then(function (rows) {
      return rows;
    }).then(function (rows) {
      if (rows.length && rows[0].thumb) $('last-shot').style.backgroundImage = 'url(' + rows[0].thumb + ')';
      if (state.online && state.counts.outstanding && Config.get().autoSync) sync();
      return Store.get('sessionTag').then(function (t) {
        tag = { feature: (t && t.feature) || '', note: (t && t.note) || '' };
        return refreshTagFields();
      }).then(pruneLocalCopies).then(function () {
        Report.flushHeld();               // anything that could not go last time
      }).then(maybeHintInstall);
    }).catch(function (e) {
      var msg = errText(e);
      toast('Startup problem: ' + msg, 'bad', 5000);
      showFatal(msg);
      Report.send(reportContext('startup', msg, { stack: Arc.asError(e).stack }));
    });
  }

  /** Mention the Home Screen once — the browser bar is the first thing you notice. */
  function maybeHintInstall() {
    if (isStandalone()) {
      $('mi-install').classList.add('hidden');
      return Promise.resolve();
    }
    return Store.get('installHinted').then(function (seen) {
      if (seen) return null;
      return Store.set('installHinted', true).then(function () {
        setTimeout(function () {
          toast('Menu → Add to Home Screen to lose the browser bar', 'ok', 6000);
        }, 2500);
      });
    });
  }

  function safeBoot() {
    self.__ecBooted = true;                  // the watchdog in index.html checks this
    try {
      boot();
    } catch (e) {
      showFatal(typeof Arc !== 'undefined' && Arc.asError ? Arc.asError(e).message : String(e));
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', safeBoot);
  else safeBoot();
})();
