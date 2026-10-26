/* Compass — shared by Exotic Camera and Photo Points.
   Turns deviceorientation events into the bearing the camera lens is pointing,
   plus pitch and roll for a level. Pure maths and a small tracker: no window,
   no document, no listeners — each app wires up its own events and permission
   prompt and hands every event to `tracker.update()`.

   Why this exists. The old maths swapped iOS's compass reading into the W3C
   Euler angles (`alpha = 360 - webkitCompassHeading`) and kept beta and gamma.
   With the phone upright — the pose every photo is taken in — those angles are
   at gimbal lock: alpha and gamma turn about the same axis and only their sum
   means anything. Each one swings wildly with a degree of tilt, so replacing
   one of the pair left the other's swing in the result: the bearing jumped
   about as the camera tilted near upright.

   What happens instead, from WebKit's own source (WebCoreMotionManager.mm):
   - alpha/beta/gamma come from CoreMotion in an arbitrary-yaw frame, i.e. on
     iOS alpha is relative, and the three are one exact decomposition of the
     attitude. Rebuilt into a rotation matrix they are smooth through gimbal
     lock, so the matrix is the only thing ever used — never a lone angle.
   - webkitCompassHeading is Core Location's magneticHeading: absolute, but
     noisy and laggy, and its exact meaning in a tilted pose is Apple's
     business. So it is not used as a heading at all, only to learn one number:
     the offset between the gyro frame and magnetic north. That offset is
     filtered slowly and only updated from poses where every reasonable reading
     of "heading" agrees. The gyro gives a smooth, immediate bearing; the
     magnetometer keeps it honest. This is how phone navigation apps do it.
   On Android, `deviceorientationabsolute` is already referenced to north, so
   the offset is simply zero.

   Pointing at the ground. A lens aimed straight down has no horizontal
   direction, so its bearing is noise. Past ~50° below the horizon the bearing
   blends towards the direction of the top edge of the photo, which is what a
   groundcover shot is "facing", and is fully that at ~80°. */
(function (g) {
  'use strict';

  var D = Math.PI / 180;

  function norm360(a) { a %= 360; return a < 0 ? a + 360 : a; }
  function wrap180(a) { a = norm360(a + 180); return a - 180; }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function smoothstep(e0, e1, x) { var t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); }

  /** Compass bearing of a horizontal vector (x east, y north). */
  function bearing(x, y) { return norm360(Math.atan2(x, y) / D); }

  /**
   * W3C device→world rotation, R = Rz(alpha)·Rx(beta)·Ry(gamma), row-major.
   * Columns are the device axes in world coordinates (x east, y north, z up —
   * or, on iOS, an arbitrary yaw).
   */
  function matrix(alpha, beta, gamma) {
    var cA = Math.cos(alpha * D), sA = Math.sin(alpha * D);
    var cB = Math.cos(beta * D), sB = Math.sin(beta * D);
    var cG = Math.cos(gamma * D), sG = Math.sin(gamma * D);
    return [
      cA * cG - sA * sB * sG, -cB * sA, cA * sG + cG * sA * sB,
      cG * sA + cA * sB * sG, cA * cB, sA * sG - cA * cG * sB,
      -cB * sG, sB, cB * cG
    ];
  }

  function col(R, i) { return [R[i], R[3 + i], R[6 + i]]; }

  /** Screen rotation in whole quarter turns, 0/90/180/270 (iOS reports -90). */
  function quarter(angle) { return norm360(Math.round((+angle || 0) / 90) * 90); }

  /**
   * The device axis that is "up" in the picture, for the current screen
   * rotation. The captured frame follows the UI, so in landscape the top of
   * the photo is a side of the phone, not its top.
   */
  function imageUp(R, angle) {
    var q = quarter(angle), v;
    if (q === 90) v = col(R, 0);                              // turned anticlockwise: right side up
    else if (q === 180) { v = col(R, 1); v = [-v[0], -v[1], -v[2]]; }
    else if (q === 270) { v = col(R, 0); v = [-v[0], -v[1], -v[2]]; }
    else v = col(R, 1);
    return v;
  }

  function imageRight(R, angle) {
    var q = quarter(angle), v;
    if (q === 90) { v = col(R, 1); v = [-v[0], -v[1], -v[2]]; }
    else if (q === 180) { v = col(R, 0); v = [-v[0], -v[1], -v[2]]; }
    else if (q === 270) v = col(R, 1);
    else v = col(R, 0);
    return v;
  }

  /**
   * Where the rear camera is looking, in the matrix's own frame.
   *   bearing  degrees clockwise from the frame's north (null if undefined)
   *   pitch    lens elevation, degrees; negative is looking down
   *   roll     tilt of the picture's horizon, degrees; 0 is level
   *   blend    0 = pure lens direction … 1 = pure top-of-photo direction
   */
  function lens(R, angle) {
    var f = col(R, 2);
    f = [-f[0], -f[1], -f[2]];                                // the lens looks out of the back
    var up = imageUp(R, angle);
    var down = -f[2];                                         // sine of the depression angle
    var steep = Math.asin(clamp(Math.abs(down), 0, 1)) / D;
    var w = smoothstep(50, 80, steep);

    var fh = Math.hypot(f[0], f[1]);
    var s = down >= 0 ? 1 : -1;                               // looking up, the top of the photo faces back
    var uh = Math.hypot(up[0], up[1]);
    var x = 0, y = 0;
    if (fh > 1e-9) { x += (1 - w) * f[0] / fh; y += (1 - w) * f[1] / fh; }
    if (uh > 1e-9) { x += w * s * up[0] / uh; y += w * s * up[1] / uh; }

    var r = imageRight(R, angle);
    return {
      bearing: Math.hypot(x, y) > 1e-6 ? bearing(x, y) : null,
      pitch: Math.asin(clamp(f[2], -1, 1)) / D,
      roll: Math.asin(clamp(r[2], -1, 1)) / D,
      blend: w
    };
  }

  /* ─────────────────────────── the tracker ─────────────────────────── */

  var STRONG = 0.8;           // an axis this horizontal gives a trustworthy heading
  var WEAK = 0.35;            // below this its horizontal direction is noise
  var TURN = 60;              // degrees per second: a real turn, not a hand wandering — the magnetometer is ignored
  var QUIET = 0.6;            // seconds after a turn before it is consulted again — Core Location catches up

  function strength(h) { return clamp((h - WEAK) / (STRONG - WEAK), 0, 1); }

  function Tracker(opts) {
    opts = opts || {};
    this.tau = opts.tau || 1.2;           // seconds for the offset to follow the magnetometer
    this.gate = opts.gate || 12;          // degrees: further than this from the offset is suspect
    this.reacquire = opts.reacquire || 0.8;  // seconds of a consistent new offset before jumping to it
    this.reset();
  }

  Tracker.prototype.reset = function () {
    this.mode = null;                     // 'fused' (iOS) | 'absolute' (Android)
    this.offset = null;                   // gyro-frame bearing minus magnetic bearing
    this.settled = false;
    this.confirm = 0;
    this.quiet = 0;
    this.single = 0.7;                    // how often upright-only readings agree with cross-checked ones
    this.cand = null;
    this.candFor = 0;
    this.lastT = null;
    this.hist = [];
    this.accuracy = null;
    this.calibratedAt = null;
  };

  /**
   * Offset candidates from this sample. Core Location's heading is the
   * bearing of the phone's top when it lies flat. What it means for an upright
   * phone Apple does not say — most likely the back, possibly noise — and the
   * tracker does not depend on it: held square (portrait, little roll) the top
   * and the back point the same way, so a reading there is cross-checked
   * whatever Core Location means. Tilted sideways they part company, and only
   * the one matching what is already known is used.
   */
  function candidates(R, H) {
    var y = col(R, 1), z = col(R, 2);
    var out = [];
    var yh = Math.hypot(y[0], y[1]), zh = Math.hypot(z[0], z[1]);
    if (yh > WEAK) out.push({ off: wrap180(bearing(y[0], y[1]) - H), w: strength(yh), axis: 'top' });
    if (zh > WEAK) out.push({ off: wrap180(bearing(-z[0], -z[1]) - H), w: strength(zh), axis: 'back' });
    return out;
  }

  function circMean(a, b) { return wrap180(a + wrap180(b - a) / 2); }

  /**
   * Feed one deviceorientation(-absolute) event. `angle` is the screen
   * rotation; `now` is in milliseconds. Returns null for data that cannot be
   * a compass (relative-only events), otherwise
   *   { heading, pitch, roll, blend, accuracy, settled, mode }
   * where heading is null until the first usable compass reading arrives.
   */
  Tracker.prototype.update = function (e, angle, now) {
    if (!e || e.alpha === null || e.alpha === undefined || e.beta === null || e.beta === undefined) return null;
    var hasMag = typeof e.webkitCompassHeading === 'number' && isFinite(e.webkitCompassHeading);
    var acc = hasMag && typeof e.webkitCompassAccuracy === 'number' ? e.webkitCompassAccuracy : null;
    var magOk = hasMag && (acc === null || acc >= 0);         // iOS flags an invalid heading with a negative accuracy

    if (hasMag) this.mode = 'fused';
    else if (e.absolute === true) this.mode = 'absolute';
    else return null;                                         // relative-only data is useless as a compass

    var R = matrix(+e.alpha, +e.beta, +(e.gamma || 0));
    var t = typeof now === 'number' ? now : Date.now();
    var dt = this.lastT === null ? 1 / 60 : clamp((t - this.lastT) / 1000, 0, 0.25);

    /* A jump no hand could make — tens of degrees between two samples a frame
       apart — is iOS restarting its gyro frame (motion updates stop and start
       when the page is hidden and shown), not the phone moving. Everything
       learned against the old frame is void: start again from this sample. */
    var prev = this.hist.length ? this.hist[this.hist.length - 1] : null;
    if (this.mode === 'fused' && prev && t - prev.t < 100) {
      var jump = rotation(prev.R, R);
      if (jump > 20 && jump / Math.max((t - prev.t) / 1000, 1 / 120) > 1500) {
        this.offset = null;
        this.settled = false;
        this.hist = [];
        this.cand = null;
        this.candFor = 0;
      }
    }
    this.lastT = t;

    var spin = this.turnRate(R, t);

    if (this.mode === 'fused') {
      this.accuracy = acc !== null && acc >= 0 ? acc : null;
      if (magOk) this.learn(R, norm360(e.webkitCompassHeading), dt, spin, acc);
    } else {
      this.offset = 0;
      this.settled = true;
      this.accuracy = null;
    }

    var l = lens(R, angle);
    return {
      heading: l.bearing === null || this.offset === null ? null : norm360(l.bearing - this.offset),
      pitch: l.pitch,
      roll: l.roll,
      blend: l.blend,
      accuracy: this.accuracy,
      settled: this.settled,
      mode: this.mode
    };
  };

  /**
   * How fast the phone is really turning, in degrees per second about any
   * axis. Measured across ~150 ms rather than between samples: a hand shakes
   * at around 10 Hz, which sample to sample looks like a fast turn but goes
   * nowhere, and must not stop the compass from learning.
   */
  Tracker.prototype.turnRate = function (R, t) {
    var h = this.hist;
    h.push({ t: t, R: R });
    while (h.length > 2 && t - h[1].t >= 150) h.shift();       // keep one sample at least 150 ms old
    var old = h[0];
    var span = (t - old.t) / 1000;
    if (span < 0.1) return 0;
    return rotation(old.R, R) / span;
  };

  /** Angle in degrees of the rotation taking attitude A to attitude B. */
  function rotation(A, B) {
    var tr = 0;
    for (var i = 0; i < 9; i++) tr += A[i] * B[i];              // trace of Aᵀ·B
    return Math.acos(clamp((tr - 1) / 2, -1, 1)) / D;
  }

  Tracker.prototype.learn = function (R, H, dt, spin, acc) {
    var cs = candidates(R, H);
    if (!cs.length) return;
    var both = cs.length === 2;
    // With the phone held square every reasonable meaning of "heading" points
    // the same way: such a reading is cross-checked, any other is a guess.
    var agree = both && Math.abs(wrap180(cs[0].off - cs[1].off)) <= 10 && Math.min(cs[0].w, cs[1].w) > 0.3;

    // first reading: take it, provisionally
    if (this.offset === null) {
      if (both && !agree) {
        // tilted sideways: the two readings disagree, so trust whichever axis
        // is closer to level — it is the one Core Location will be using
        this.offset = (cs[0].w >= cs[1].w ? cs[0] : cs[1]).off;
      } else {
        this.offset = both ? circMean(cs[0].off, cs[1].off) : cs[0].off;
      }
      this.settled = false;
      this.confirm = 0;
      this.quiet = QUIET;                                     // nothing has moved yet: learn straight away
      this.calibratedAt = this.lastT;
      return;
    }

    /* Core Location smooths its heading, so during a turn — and for a moment
       after — it trails the gyro by the turn rate times its lag: a steady,
       convincing-looking error. Ignore it while the phone is really turning
       and briefly after; the gyro carries the bearing through a turn on its
       own. A hand wandering about is not a turn, it just counts for less. */
    if (spin > TURN) { this.quiet = 0; return; }
    this.quiet = (this.quiet || 0) + dt;
    if (this.quiet < QUIET) return;
    var still = clamp(1 - spin / TURN, 0, 1);

    var self = this;
    var best = cs.reduce(function (a, c) {
      return Math.abs(wrap180(c.off - self.offset)) < Math.abs(wrap180(a.off - self.offset)) ? c : a;
    });
    var meas = agree ? circMean(cs[0].off, cs[1].off) : best.off;
    var innov = wrap180(meas - this.offset);

    /* An unchecked reading — phone upright, so only its back is level — is
       right if Core Location tracks the back of an upright phone, and noise if
       it only knows the top. Which it is shows in how often such readings land
       near what the cross-checked ones said: keep a running score, and stop
       listening to them when they mostly miss. */
    if (!agree && this.settled) {
      var a = 1 - Math.exp(-dt / 2);
      this.single += a * ((Math.abs(innov) <= 6 ? 1 : 0) - this.single);
    }
    var base = agree ? Math.max(cs[0].w, cs[1].w)
      : best.w * (both ? 0.5 : 1) * (this.settled ? 0.25 * clamp((this.single - 0.5) / 0.4, 0, 1) : 0.6);
    var gate = !this.settled ? 25 : agree ? this.gate : 6;

    if (Math.abs(innov) <= gate) {
      var w = base * still;
      if (acc !== null && acc > 15) w *= clamp(1 - (acc - 15) / 40, 0.25, 1);   // a poorly calibrated magnetometer
      var tau = this.settled ? this.tau : this.tau / 3;      // converge quickly from a first guess
      this.offset = wrap180(this.offset + w * (1 - Math.exp(-dt / tau)) * innov);
      if (agree) {
        this.calibratedAt = this.lastT;
        if (Math.abs(innov) <= 6 && ++this.confirm >= 20) this.settled = true;
      }
      this.cand = null;
      this.candFor = 0;
      return;
    }

    /* Consistently somewhere else: iOS restarts its gyro frame whenever motion
       updates restart (the app was backgrounded, say), and alpha jumps. A
       wrong first guess looks the same. Either way, follow the new value once
       it has held for a moment — a single wild reading never moves us, and
       once settled only a cross-checked reading can. */
    if (this.settled && !agree) return;
    if (this.cand !== null && Math.abs(wrap180(meas - this.cand)) < 20) {
      this.cand = wrap180(this.cand + 0.1 * wrap180(meas - this.cand));   // noisy, but going one way
      this.candFor += dt;
    } else {
      this.cand = meas;
      this.candFor = dt;
    }
    if (this.candFor >= this.reacquire) {
      this.offset = this.cand;
      this.settled = false;
      this.confirm = 0;
      this.cand = null;
      this.candFor = 0;
      this.calibratedAt = this.lastT;
    }
  };

  var Compass = {
    matrix: matrix,
    lens: lens,
    bearing: bearing,
    norm360: norm360,
    wrap180: wrap180,
    quarter: quarter,
    create: function (opts) { return new Tracker(opts); },

    /** Sixteen-point name for a bearing. */
    card: function (h) {
      return ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'][
        Math.round(norm360(h) / 22.5) % 16];
    }
  };

  g.Compass = Compass;
})(typeof self !== 'undefined' ? self : this);
