/* Exotic Camera — tiny synthesised UI sounds.
   No audio files: everything is a few oscillators, so the app stays small and
   the sounds load instantly. Soft sine "marimba" plucks with a little delay
   sparkle — quiet by design; the shutter is the loudest thing here. */
(function (g) {
  'use strict';

  var ctx = null, master = null, delay = null, enabled = true;

  function build() {
    if (ctx) return ctx;
    var AC = g.AudioContext || g.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();

    master = ctx.createGain();
    master.gain.value = 0.5;

    var soften = ctx.createBiquadFilter();      // trims the fizz off the top
    soften.type = 'lowpass';
    soften.frequency.value = 7200;

    delay = ctx.createDelay(0.5);               // a hint of air, not a reverb
    delay.delayTime.value = 0.085;
    var fb = ctx.createGain();
    fb.gain.value = 0.16;
    var wet = ctx.createGain();
    wet.gain.value = 0.22;

    master.connect(soften);
    soften.connect(ctx.destination);
    soften.connect(delay);
    delay.connect(fb);
    fb.connect(delay);
    delay.connect(wet);
    wet.connect(ctx.destination);
    return ctx;
  }

  /** One soft pluck: sine body + quiet octave shimmer, exponential decay. */
  function pluck(freq, when, dur, gain, type) {
    var t = ctx.currentTime + when;
    var o = ctx.createOscillator();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(freq, t);

    var g1 = ctx.createGain();
    g1.gain.setValueAtTime(0.0001, t);
    g1.gain.exponentialRampToValueAtTime(gain, t + 0.012);       // soft, non-clicky attack
    g1.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    var o2 = ctx.createOscillator();
    o2.type = 'sine';
    o2.frequency.setValueAtTime(freq * 2.01, t);
    var g2 = ctx.createGain();
    g2.gain.setValueAtTime(0.0001, t);
    g2.gain.exponentialRampToValueAtTime(gain * 0.22, t + 0.008);
    g2.gain.exponentialRampToValueAtTime(0.0001, t + dur * 0.55);

    o.connect(g1); g1.connect(master);
    o2.connect(g2); g2.connect(master);
    o.start(t); o.stop(t + dur + 0.05);
    o2.start(t); o2.stop(t + dur + 0.05);
  }

  /** Filtered noise burst — the mechanical half of the shutter. */
  function noise(when, dur, gain, freq, q) {
    var t = ctx.currentTime + when;
    var n = Math.max(1, Math.floor(ctx.sampleRate * dur));
    var buf = ctx.createBuffer(1, n, ctx.sampleRate);
    var d = buf.getChannelData(0);
    for (var i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
    var src = ctx.createBufferSource();
    src.buffer = buf;
    var bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = freq;
    bp.Q.value = q || 1.2;
    var gn = ctx.createGain();
    gn.gain.setValueAtTime(gain, t);
    gn.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(bp); bp.connect(gn); gn.connect(master);
    src.start(t); src.stop(t + dur + 0.02);
  }

  function ready() {
    if (!enabled) return false;
    if (!build()) return false;
    if (ctx.state === 'suspended') ctx.resume();
    return true;
  }

  var Sound = {
    setEnabled: function (v) { enabled = !!v; },
    /** Must be called from a user gesture on iOS before anything will sound. */
    unlock: function () { if (build() && ctx.state === 'suspended') ctx.resume(); },

    shutter: function () {
      if (!ready()) return;
      noise(0, 0.035, 0.16, 2400, 0.9);          // mirror up
      noise(0.055, 0.05, 0.11, 1500, 0.8);       // curtain down
      pluck(2100, 0.002, 0.05, 0.05, 'triangle');
    },

    // photo accepted into the queue — a single soft tick
    queued: function () {
      if (!ready()) return;
      pluck(1174.7, 0, 0.16, 0.045);             // D6
    },

    // upload confirmed — the happy little two-note lift
    sent: function () {
      if (!ready()) return;
      pluck(1318.5, 0, 0.22, 0.06);              // E6
      pluck(1975.5, 0.075, 0.34, 0.055);         // B6
    },

    // everything drained
    allClear: function () {
      if (!ready()) return;
      pluck(1046.5, 0, 0.2, 0.05);               // C6
      pluck(1318.5, 0.07, 0.2, 0.05);            // E6
      pluck(1567.9, 0.14, 0.4, 0.05);            // G6
    },

    // connection lost — gentle descending pair, never alarming
    offline: function () {
      if (!ready()) return;
      pluck(784, 0, 0.2, 0.05);                  // G5
      pluck(587.3, 0.09, 0.3, 0.045);            // D5
    },

    online: function () {
      if (!ready()) return;
      pluck(587.3, 0, 0.16, 0.04);
      pluck(880, 0.07, 0.26, 0.045);             // A5
    },

    // retrying / soft warning
    retry: function () {
      if (!ready()) return;
      pluck(987.8, 0, 0.14, 0.035);              // B5
      pluck(880, 0.08, 0.2, 0.03);
    },

    error: function () {
      if (!ready()) return;
      pluck(523.3, 0, 0.18, 0.05, 'triangle');
      pluck(415.3, 0.1, 0.34, 0.045, 'triangle');
    },

    tick: function () {
      if (!ready()) return;
      pluck(1568, 0, 0.07, 0.025);
    }
  };

  g.Sound = Sound;
})(self);
