/* The compass, against a simulated iPhone. Node only, no browser.

   The phone is modelled the way WebKit feeds Safari (WebCoreMotionManager.mm):
   CoreMotion attitude in an arbitrary-yaw frame, decomposed into W3C
   alpha/beta/gamma by WebKit's own branches, plus Core Location's magnetic
   heading with noise, lag and 1° steps. The old Exotic Camera maths
   (alpha = 360 - webkitCompassHeading, then tilt-compensate) runs alongside so
   the difference is measured, not asserted. */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ctx = {};
ctx.self = ctx;
vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'js/compass.js'), 'utf8'), ctx);
const { Compass } = ctx;

const fail = (m) => { console.log('  FAIL', m); process.exitCode = 1; };
const ok = (m) => console.log('  ok  ', m);
const D = Math.PI / 180;

/* ── a tiny 3x3 toolkit ─────────────────────────────────────────── */
const mul = (A, B) => {
  const C = new Array(9).fill(0);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++)
    for (let k = 0; k < 3; k++) C[r * 3 + c] += A[r * 3 + k] * B[k * 3 + c];
  return C;
};
const Rx = (a) => { const c = Math.cos(a * D), s = Math.sin(a * D); return [1, 0, 0, 0, c, -s, 0, s, c]; };
const Ry = (a) => { const c = Math.cos(a * D), s = Math.sin(a * D); return [c, 0, s, 0, 1, 0, -s, 0, c]; };
const Rz = (a) => { const c = Math.cos(a * D), s = Math.sin(a * D); return [c, -s, 0, s, c, 0, 0, 0, 1]; };
const col = (R, i) => [R[i], R[3 + i], R[6 + i]];
const brg = (x, y) => ((Math.atan2(x, y) / D) % 360 + 360) % 360;
const diff = (a, b) => { const d = ((a - b) % 360 + 540) % 360 - 180; return d; };

// deterministic noise, so a failure reproduces
let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const gauss = () => { let u = 0, v = 0; while (!u) u = rnd(); v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

/**
 * True device attitude (device → east/north/up). The person faces `yaw`
 * (degrees clockwise from north), the lens is raised `pitch` (negative is
 * looking down), the picture is rolled `roll`, and `quarter` is how far the
 * phone is turned anticlockwise (90 = landscape, top of the phone to the left).
 */
function attitude(yaw, pitch, roll, quarter = 0) {
  const R0 = [1, 0, 0, 0, 0, -1, 0, 1, 0];          // upright portrait, lens north, screen south
  return mul(mul(mul(Rz(-yaw), R0), Rx(pitch)), Rz(roll + quarter));
}

/** WebKit's decomposition of an attitude matrix into W3C angles, branch for branch. */
function webkitAngles(R) {
  let z, x, y;
  if (R[8] > 0) {
    z = Math.atan2(-R[1], R[4]); x = Math.asin(R[7]); y = Math.atan2(-R[6], R[8]);
  } else if (R[8] < 0) {
    z = Math.atan2(R[1], -R[4]); x = -Math.asin(R[7]); x += (x >= 0) ? -Math.PI : Math.PI; y = Math.atan2(R[6], -R[8]);
  } else if (R[6] > 0) {
    z = Math.atan2(-R[1], R[4]); x = Math.asin(R[7]); y = -Math.PI / 2;
  } else if (R[6] < 0) {
    z = Math.atan2(R[1], -R[4]); x = -Math.asin(R[7]); x += (x >= 0) ? -Math.PI : Math.PI; y = -Math.PI / 2;
  } else {
    z = Math.atan2(R[3], R[0]); x = R[7] > 0 ? Math.PI / 2 : -Math.PI / 2; y = 0;
  }
  return { alpha: (z > 0 ? z : 2 * Math.PI + z) / D, beta: x / D, gamma: y / D };
}

/* How Core Location might define "heading" once the phone is tilted. Apple
   does not document it, so the tracker is tested against several. */
const CL = {
  // the top of the phone while that is within 45° of level, then the back
  topThenBack: (R) => {
    const y = col(R, 1), z = col(R, 2);
    return Math.hypot(y[0], y[1]) >= Math.SQRT1_2 ? brg(y[0], y[1]) : brg(-z[0], -z[1]);
  },
  // strictly the top of the phone — meaningless when it points at the sky
  topOnly: (R) => { const y = col(R, 1); return brg(y[0], y[1]); },
  // whichever of top/back is nearer level
  nearerLevel: (R) => {
    const y = col(R, 1), z = col(R, 2);
    return Math.hypot(y[0], y[1]) >= Math.hypot(z[0], z[1]) ? brg(y[0], y[1]) : brg(-z[0], -z[1]);
  },
};

/** The maths Exotic Camera shipped with: alpha from the compass, then tilt-compensate. */
function oldHeading(e) {
  const alpha = 360 - e.webkitCompassHeading;
  const a = alpha * D, b = e.beta * D, g = e.gamma * D;
  const vx = -(Math.cos(a) * Math.sin(g) + Math.cos(g) * Math.sin(a) * Math.sin(b));
  const vy = -(Math.sin(a) * Math.sin(g) - Math.cos(a) * Math.cos(g) * Math.sin(b));
  if (Math.abs(vx) < 1e-7 && Math.abs(vy) < 1e-7) return null;
  return brg(vx, vy);
}

/**
 * Run a script of poses through the simulated phone. Each segment holds a
 * pose (with hand tremor) for `secs`, optionally sweeping yaw. Returns per
 * sample truth and both trackers' answers.
 */
function simulate(segments, opts = {}) {
  const model = CL[opts.cl || 'topThenBack'];
  const tracker = Compass.create();
  let frameYaw = opts.frameYaw ?? 137;              // where iOS's arbitrary gyro frame happens to point
  let t = 0, clHeading = null;
  const out = [];
  // A held phone wanders slowly (a degree or two over half a second) and
  // shakes a little at ~9 Hz; the attitude CoreMotion reports is otherwise
  // smooth. Independent noise on every sample would look like a fast turn.
  const wander = { p: 0, r: 0, y: 0 };
  const keep = Math.exp(-(1 / 60) / 0.5), fresh = Math.sqrt(1 - keep * keep);
  const shake = (amp, ph) => amp * Math.sin(2 * Math.PI * 9 * t / 1000 + ph);
  // People move between poses, they do not teleport: each segment eases in
  // from the last pose over 0.4 s (raising the phone, turning to landscape).
  let prev = null;
  const BLEND = 24;
  for (const seg of segments) {
    if (seg.frameJump) frameYaw += seg.frameJump;   // motion updates restarted
    const n = Math.round(seg.secs * 60);
    const twist = (seg.roll || 0) + (seg.quarter || 0);
    for (let i = 0; i < n; i++, t += 1000 / 60) {
      for (const k of ['p', 'r', 'y']) wander[k] = keep * wander[k] + fresh * gauss();
      let yaw = seg.yaw + (seg.turn || 0) * (i / 60);
      let basePitch = seg.pitch, baseTwist = twist, q = seg.quarter || 0;
      if (prev && i < BLEND) {
        const f = (1 - Math.cos(Math.PI * (i + 1) / BLEND)) / 2;
        yaw = prev.yaw + diff(yaw, prev.yaw) * f;
        basePitch = prev.pitch + (seg.pitch - prev.pitch) * f;
        baseTwist = prev.twist + (twist - prev.twist) * f;
        if (f < 0.5) q = prev.quarter;            // the screen rotates halfway round
      }
      const tremor = seg.tremor ?? 1.2;
      const pitch = basePitch + tremor * wander.p + shake(0.25, 0) + 0.03 * gauss();
      const roll = baseTwist - (seg.quarter || 0) + tremor * wander.r + shake(0.2, 1.3) + 0.03 * gauss();
      const truth = attitude(yaw + 0.5 * wander.y + shake(0.15, 2.1), pitch, roll, seg.quarter || 0);
      const rel = mul(Rz(frameYaw), truth);         // the gyro frame's idea of north is arbitrary
      const ang = webkitAngles(rel);

      // Core Location: lagging, noisy, whole degrees
      const target = model(truth);
      clHeading = clHeading === null ? target : clHeading + diff(target, clHeading) * (1 - Math.exp(-(1000 / 60) / 300));
      const H = Math.round((((clHeading + 2 * gauss()) % 360) + 360) % 360);

      const e = { alpha: ang.alpha, beta: ang.beta, gamma: ang.gamma, absolute: false,
                  webkitCompassHeading: H, webkitCompassAccuracy: 10 };
      if (opts.android) {
        const abs = webkitAngles(truth);
        Object.assign(e, abs, { absolute: true });
        delete e.webkitCompassHeading; delete e.webkitCompassAccuracy;
      }
      const angle = q === 90 ? 90 : q === 270 ? -90 : 0;
      const r = tracker.update(e, angle, t);

      // What the photo is actually facing, from the true attitude: the tracker
      // is judged on fusion alone. The geometry has its own checks below.
      const want = Compass.lens(truth, angle).bearing;
      out.push({ t, seg: seg.name, want, got: r && r.heading, old: opts.android ? null : oldHeading(e),
                 pitch: r && r.pitch, roll: r && r.roll, truePitch: pitch, trueRoll: roll, settled: r && r.settled });
    }
    prev = { yaw: seg.yaw + (seg.turn || 0) * (n / 60), pitch: seg.pitch, twist, quarter: seg.quarter || 0 };
  }
  return out;
}

function stats(rows, key) {
  const errs = rows.map(r => r[key] === null || r[key] === undefined ? 180 : Math.abs(diff(r[key], r.want)));
  errs.sort((a, b) => a - b);
  const rms = Math.sqrt(errs.reduce((s, e) => s + e * e, 0) / errs.length);
  return { rms, p95: errs[Math.floor(errs.length * 0.95)], max: errs[errs.length - 1] };
}
const fmt = (s) => `rms ${s.rms.toFixed(1)}° · p95 ${s.p95.toFixed(1)}° · max ${s.max.toFixed(1)}°`;
const seg = (rows, name, skip = 0) => rows.filter(r => r.seg === name).slice(skip);

const READ = { pitch: -55, tremor: 1.5 };          // looking at the screen
const UPRIGHT = { pitch: 0, tremor: 1.2 };         // taking a picture

/* ── 0. geometry: what "the bearing of a photo" means ─────────────── */
console.log('\n== geometry');
{
  const L = (yaw, pitch, roll, quarter = 0, angle = 0) => Compass.lens(attitude(yaw, pitch, roll, quarter), angle);
  const near = (a, b, tol = 0.01) => a !== null && Math.abs(diff(a, b)) <= tol;
  const cases = [
    ['level, portrait', L(30, 0, 0), 30, 0, 0],
    ['level, rolled 10°', L(30, 0, 10), 30, 0, 10],
    ['looking down 40°', L(30, -40, 0), 30, -40, 0],
    ['straight down: top of the picture', L(30, -90, 0), 30, -90, null],
    ['straight down, landscape', L(30, -90, 0, 90, 90), 30, -90, null],
    ['straight down, landscape the other way', L(30, -90, 0, 270, -90), 30, -90, null],
    ['looking up 70°', L(30, 70, 0), 30, 70, null],
    ['landscape, level, rolled -5°', L(200, 0, -5, 90, 90), 200, 0, -5],
  ];
  for (const [name, r, b, p, ro] of cases) {
    const good = near(r.bearing, b) && Math.abs(r.pitch - p) < 0.01 && (ro === null || Math.abs(r.roll - ro) < 0.01);
    if (!good) fail(`${name}: got bearing ${r.bearing && r.bearing.toFixed(2)} pitch ${r.pitch.toFixed(2)} roll ${r.roll.toFixed(2)}`);
    else ok(name);
  }
}

/* ── 1. upright, the pose every photo is taken in ─────────────────── */
console.log('\n== upright, small hand tremor (the reported bug)');
for (const cl of ['topThenBack', 'nearerLevel', 'topOnly']) {
  const rows = simulate([
    { name: 'read', yaw: 47, ...READ, secs: 3 },
    { name: 'shoot', yaw: 47, ...UPRIGHT, secs: 10 },
  ], { cl });
  const n = stats(seg(rows, 'shoot', 30), 'got');
  const o = stats(seg(rows, 'shoot', 30), 'old');
  console.log(`   ${cl.padEnd(12)} new: ${fmt(n)}\n   ${''.padEnd(12)} old: ${fmt(o)}`);
  if (n.p95 > 3 || n.max > 6) fail(`${cl}: upright bearing still wanders (${fmt(n)})`);
  else ok(`${cl}: upright bearing holds within ${n.max.toFixed(1)}°`);
  if (cl === 'topThenBack' && o.max < 20) fail('the old maths was expected to show the jump — is the simulation faithful?');
}

/* ── 2. startup straight into the shooting pose ──────────────────── */
console.log('\n== app opened with the phone already up');
{
  const rows = simulate([{ name: 'shoot', yaw: 300, ...UPRIGHT, secs: 6 }], { cl: 'topThenBack' });
  const s = stats(seg(rows, 'shoot', 30), 'got');
  console.log('   ' + fmt(s));
  if (s.p95 > 3) fail('needs a flat pose before it works'); else ok('right from the first second upright');
}
{
  // a Core Location that only knows the top of the phone is garbage upright;
  // the tracker must notice once the phone is lowered, and say it is unsettled meanwhile
  const rows = simulate([
    { name: 'shoot', yaw: 120, ...UPRIGHT, secs: 3 },
    { name: 'read', yaw: 120, ...READ, secs: 3 },
    { name: 'shoot2', yaw: 120, ...UPRIGHT, secs: 4 },
  ], { cl: 'topOnly' });
  const s = stats(seg(rows, 'shoot2', 30), 'got');
  console.log('   top-only Core Location, after one look at the screen: ' + fmt(s));
  if (s.p95 > 3) fail('did not recover from a meaningless first reading'); else ok('recovers once the phone has been lowered');
}

/* ── 3. landscape ─────────────────────────────────────────────────── */
console.log('\n== landscape, both ways round');
for (const q of [90, 270]) {
  const rows = simulate([
    { name: 'read', yaw: 200, ...READ, secs: 3 },
    { name: 'shoot', yaw: 310, ...UPRIGHT, quarter: q, secs: 8 },
  ]);
  const s = stats(seg(rows, 'shoot', 60), 'got');
  const pr = seg(rows, 'shoot', 60);
  const pe = Math.max(...pr.map(r => Math.abs(r.pitch - r.truePitch)));
  const re = Math.max(...pr.map(r => Math.abs(r.roll - r.trueRoll)));
  console.log(`   turned ${q}: ${fmt(s)} · pitch err ≤ ${pe.toFixed(2)}° · roll err ≤ ${re.toFixed(2)}°`);
  if (s.p95 > 3) fail(`landscape ${q} heading off`); else ok(`landscape ${q}° heading holds`);
  if (pe > 0.5 || re > 0.5) fail(`landscape ${q} level readout wrong`); else ok(`landscape ${q}° level readout matches`);
}

/* ── 4. pointing at the ground ────────────────────────────────────── */
console.log('\n== groundcover: lens straight down and steeply down');
for (const p of [-90, -80, -65, -40]) {
  const rows = simulate([
    { name: 'read', yaw: 30, ...READ, secs: 3 },
    { name: 'ground', yaw: 30, pitch: p, tremor: 1.5, secs: 6 },
  ]);
  const s = stats(seg(rows, 'ground', 30), 'got');
  const o = stats(seg(rows, 'ground', 30), 'old');
  console.log(`   pitch ${String(p).padStart(3)}: new ${fmt(s)}\n              old ${fmt(o)}`);
  if (s.p95 > 4) fail(`pitch ${p}: bearing unstable`); else ok(`pitch ${p}: facing direction holds`);
}

/* ── 5. turning ───────────────────────────────────────────────────── */
console.log('\n== turning on the spot, then stopping');
{
  const rows = simulate([
    { name: 'read', yaw: 0, ...READ, secs: 3 },
    { name: 'turn', yaw: 0, turn: 60, ...UPRIGHT, secs: 4 },
    { name: 'hold', yaw: 240, ...UPRIGHT, secs: 4 },
  ]);
  const turn = stats(seg(rows, 'turn'), 'got');
  const hold = stats(seg(rows, 'hold', 60), 'got');
  console.log('   while turning 60°/s: ' + fmt(turn) + '\n   a second after stopping: ' + fmt(hold));
  if (turn.p95 > 4) fail('lags or overshoots while turning'); else ok('follows a turn without lag');
  if (hold.p95 > 3) fail('does not settle after the turn'); else ok('settles after the turn');
}

/* ── 6. iOS restarts its gyro frame ───────────────────────────────── */
console.log('\n== the gyro frame jumps (app backgrounded and back)');
{
  const rows = simulate([
    { name: 'read', yaw: 90, ...READ, secs: 3 },
    { name: 'jump', yaw: 90, ...READ, secs: 3, frameJump: 100 },
    { name: 'after', yaw: 90, ...UPRIGHT, secs: 3 },
  ]);
  const settle = seg(rows, 'jump').findIndex((r, i, a) => a.slice(i, i + 30).every(x => Math.abs(diff(x.got, x.want)) < 4));
  const after = stats(seg(rows, 'after'), 'got');
  console.log(`   back on track ${(settle / 60).toFixed(2)}s after the jump · then ${fmt(after)}`);
  if (settle < 0 || settle > 90) fail('did not re-acquire within 1.5s'); else ok('re-acquires after a frame reset');
  if (after.p95 > 3) fail('wrong after the jump'); else ok('correct after the jump');
}

/* ── 7. a single wild reading never moves it ──────────────────────── */
console.log('\n== one wild compass reading');
{
  const tracker = Compass.create();
  const truth = attitude(10, -55, 0);
  const a = webkitAngles(truth);
  let t = 0;
  for (let i = 0; i < 120; i++, t += 16.7) tracker.update({ ...a, webkitCompassHeading: 10, webkitCompassAccuracy: 10 }, 0, t);
  for (let i = 0; i < 5; i++, t += 16.7) tracker.update({ ...a, webkitCompassHeading: 190, webkitCompassAccuracy: 10 }, 0, t);
  const r = tracker.update({ ...a, webkitCompassHeading: 10, webkitCompassAccuracy: 10 }, 0, t);
  if (Math.abs(diff(r.heading, 10)) > 1) fail(`a burst of bad readings moved it to ${r.heading.toFixed(1)}`);
  else ok('a burst of bad readings is ignored');
  if (!r.settled) fail('never reported itself settled'); else ok('reports settled once confirmed');
}

/* ── 8. Android: already absolute ─────────────────────────────────── */
console.log('\n== Android absolute events');
{
  const rows = simulate([{ name: 'shoot', yaw: 222, ...UPRIGHT, secs: 3 }], { android: true });
  const s = stats(seg(rows, 'shoot'), 'got');
  console.log('   ' + fmt(s));
  if (s.max > 1.5) fail('absolute events should need no fusion'); else ok('exact from the first event');
  const t = Compass.create();
  if (t.update({ alpha: 10, beta: 80, gamma: 0, absolute: false }, 0, 0) !== null) fail('relative-only data must be refused');
  else ok('relative-only events are refused');
  const e = { alpha: 270, beta: 90, gamma: 0, absolute: true };      // what tests/ui.mjs sends: lens east
  const r = Compass.create().update(e, 0, 0);
  if (Math.abs(diff(r.heading, 90)) > 0.5) fail(`lens-east reads ${r.heading}`); else ok('lens-east reads 090');
}

/* ── 9. invalid compass flagged by iOS ────────────────────────────── */
{
  const t = Compass.create();
  const a = webkitAngles(attitude(50, -50, 0));
  const r = t.update({ ...a, webkitCompassHeading: 0, webkitCompassAccuracy: -1 }, 0, 0);
  if (r.heading !== null) fail('used a heading iOS marked invalid'); else ok('an invalid (accuracy -1) heading is not used');
}

console.log(process.exitCode ? '\nFAILED' : '\nall compass checks passed');
