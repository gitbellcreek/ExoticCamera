/* The lens bearing, in every pose, on both platforms. Pure maths, no browser.

   The case that matters: an iPhone on its side. iOS reports the compass as a
   heading of the top edge (Core Location's default), and tilt angles against an
   arbitrary yaw. Read alpha as the compass and the bearing is 90° out in
   landscape, and flips 180° as the camera crosses level. The fix learns the
   yaw offset in unambiguous poses, so it must come out right whichever axis
   Core Location actually uses — that policy is undocumented, so three
   plausible ones are simulated here. */
import fs from 'node:fs';
import vm from 'node:vm';
import { ROOT } from './env-lite.mjs';

const fail = (m) => { console.log('  FAIL', m); process.exitCode = 1; };
const ok = (m) => console.log('  ok  ', m);

const sandbox = { Math };
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(`${ROOT}/js/heading.js`, 'utf8'), sandbox, { filename: 'js/heading.js' });
const { Heading } = sandbox;

const RAD = Math.PI / 180;
const norm = (d) => ((d % 360) + 360) % 360;
const near = (a, b, tol = 0.5) => Math.abs(((a - b + 540) % 360) - 180) < tol;
const az = (v) => norm(Math.atan2(v[0], v[1]) / RAD);
const level = (v) => Math.hypot(v[0], v[1]);

/* A physical pose, described the easy way — by W3C angles that may run past
   the spec's ranges — becomes the rotation matrix, which is what the phone
   actually knows. */
function matrix(alpha, beta, gamma) {
  const f = Heading.frame(alpha, beta, gamma);
  // R[0..8] row-major, columns are the device axes in world coordinates
  return [f.x[0], f.y[0], f.z[0], f.x[1], f.y[1], f.z[1], f.x[2], f.y[2], f.z[2]];
}

/* WebKit's decomposition (WebCoreMotionManager.mm), including the branch that
   flips beta through 180° when the camera crosses level on a phone held sideways. */
function webkitAngles(R) {
  let z, x, y;
  if (R[8] > 0) { z = Math.atan2(-R[1], R[4]); x = Math.asin(R[7]); y = Math.atan2(-R[6], R[8]); }
  else if (R[8] < 0) {
    z = Math.atan2(R[1], -R[4]); x = -Math.asin(R[7]); x += x >= 0 ? -Math.PI : Math.PI; y = Math.atan2(R[6], -R[8]);
  } else if (R[6] > 0) { z = Math.atan2(-R[1], R[4]); x = Math.asin(R[7]); y = -Math.PI / 2; }
  else if (R[6] < 0) { z = Math.atan2(R[1], -R[4]); x = -Math.asin(R[7]); x += x >= 0 ? -Math.PI : Math.PI; y = -Math.PI / 2; }
  else { z = Math.atan2(R[3], R[0]); x = R[7] > 0 ? Math.PI / 2 : -Math.PI / 2; y = 0; }
  return { alpha: norm(z / RAD), beta: x / RAD, gamma: y / RAD };
}

/* Three things Core Location might mean by "heading" (its portrait default is
   the top edge; upright it has to use something else or the Compass app would
   not work). */
const POLICIES = {
  'top edge, lens when the top edge is vertical': (top, cam) => (level(top) < 0.2 ? az(cam) : az(top)),
  'top edge when flat, lens when the phone is steep': (top, cam, z) => (Math.abs(z[2]) < 0.7 ? az(cam) : az(top)),
  'blend of top edge and lens': (top, cam) => az([top[0] + cam[0], top[1] + cam[1]]),
};

/* What the phone hands the page for a physical pose, with the yaw of the
   motion frame `drift` degrees away from magnetic north. */
function iosEvent(pose, policy, drift) {
  const R = matrix(pose.alpha, pose.beta, pose.gamma);
  const top = [R[1], R[4], R[7]], z = [R[2], R[5], R[8]], cam = [-z[0], -z[1], -z[2]];
  const rel = webkitAngles(matrix(pose.alpha + drift, pose.beta, pose.gamma));
  return { compass: policy(top, cam, z), ...rel, truth: az(cam), pose };
}

// ── Android: absolute angles go straight through the matrix ────────────────
console.log('\n== absolute angles (Android)');
{
  const cases = [
    ['flat on a table, lens down', 45, 0, 0, null],
    ['upright facing north', 0, 90, 0, 0],
    ['upright facing west', 90, 90, 0, 270],
    ['looking down at the ground, facing east', 270, 45, 0, 90],
    ['on its side, top edge north, lens west', 0, 0, 90, 270],
    ['on its side, top edge east, facing north', 270, 0, 90, 0],
    ['on its side, top edge west, facing north', 90, 0, -90, 0],
    ['top edge east, lens a touch below level', 90, 180, -88, 0],    // the flipped decomposition of (270, 0, 92)
  ];
  for (const [name, a, b, g, want] of cases) {
    const got = Heading.cameraAzimuth(a, b, g);
    if (want === null ? got !== null : !near(got, want)) fail(`${name}: got ${got}, wanted ${want}`);
    else ok(`${name}: ${got === null ? 'no bearing' : got.toFixed(1) + '°'}`);
  }
}

// ── iOS: the compass names the top edge, the angles name nothing ───────────
const PORTRAIT = [
  { alpha: 0, beta: 80, gamma: 0 }, { alpha: 0, beta: 89, gamma: 0 }, { alpha: 0, beta: 91, gamma: 0 },
  { alpha: 0, beta: 45, gamma: 0 }, { alpha: 0, beta: 60, gamma: 8 },
];
const SIDEWAYS = [
  ['top edge left, lens a touch up', { alpha: 0, beta: 0, gamma: 88 }],
  ['top edge left, lens a touch down', { alpha: 0, beta: 0, gamma: 92 }],
  ['top edge right, lens a touch up', { alpha: 0, beta: 0, gamma: -88 }],
  ['top edge right, lens a touch down', { alpha: 0, beta: 0, gamma: -92 }],
  ['top edge left, tilted 30° down', { alpha: 0, beta: 0, gamma: 120 }],
  ['leaning back past vertical, portrait', { alpha: 0, beta: 110, gamma: 0 }],
];
const FACINGS = [0, 37, 90, 200, 271, 359];

for (const [policyName, policy] of Object.entries(POLICIES)) {
  console.log(`\n== iOS, Core Location reports the ${policyName}`);
  const drift = 137.5;
  let worst = 0, n = 0, broken = null;
  for (const facing of FACINGS) {
    // warm up as a person would: a few portrait shots, then turn the phone
    let offset = null;
    for (const p of PORTRAIT) {
      const e = iosEvent({ ...p, alpha: p.alpha + facing }, policy, drift);
      const r = Heading.iosCamera(e.compass, e.alpha, e.beta, e.gamma, offset);
      offset = r.offset;
      const err = Math.abs(((r.heading - e.truth + 540) % 360) - 180);
      if (err > worst) worst = err;
      n++;
      if (err > 5 && !broken) broken = `portrait beta ${p.beta} gamma ${p.gamma} facing ${facing}: got ${r.heading.toFixed(1)}, truth ${e.truth.toFixed(1)}`;
    }
    for (const [name, p] of SIDEWAYS) {
      const e = iosEvent({ ...p, alpha: p.alpha + facing }, policy, drift);
      const r = Heading.iosCamera(e.compass, e.alpha, e.beta, e.gamma, offset);
      offset = r.offset;
      const err = Math.abs(((r.heading - e.truth + 540) % 360) - 180);
      if (err > worst) worst = err;
      n++;
      if (err > 5 && !broken) broken = `${name}, facing ${facing}: got ${r.heading.toFixed(1)}, truth ${e.truth.toFixed(1)} (webkit says α${e.alpha.toFixed(0)} β${e.beta.toFixed(0)} γ${e.gamma.toFixed(0)}, compass ${e.compass.toFixed(0)})`;
    }
  }
  if (broken) fail(broken);
  else ok(`${n} poses, worst error ${worst.toFixed(2)}° (rolled portrait is ambiguous by a degree or two) — sideways, leaning back, either roll, either side of level`);
}

// ── the old reading, for the record: alpha := 360 − compass ─────────────────
console.log('\n== what went wrong before');
{
  const policy = POLICIES['top edge, lens when the top edge is vertical'];
  const up = iosEvent({ alpha: 0, beta: 0, gamma: 88 }, policy, 0);
  const down = iosEvent({ alpha: 0, beta: 0, gamma: 92 }, policy, 0);
  const oldWay = (e) => Heading.cameraAzimuth(360 - e.compass, e.beta, e.gamma);
  const a = oldWay(up), b = oldWay(down);
  if (near(a, b, 2)) fail(`expected the old reading to flip across level, got ${a.toFixed(0)} and ${b.toFixed(0)}`);
  else ok(`the old reading gave ${a.toFixed(0)}° with the lens a touch up and ${b.toFixed(0)}° a touch down, for a lens pointing ${up.truth.toFixed(0)}°`);
  const A = Heading.iosCamera(up.compass, up.alpha, up.beta, up.gamma, 0).heading;
  const B = Heading.iosCamera(down.compass, down.alpha, down.beta, down.gamma, 0).heading;
  if (!near(A, up.truth) || !near(B, down.truth)) fail(`new reading not steady across level: ${A.toFixed(1)} / ${B.toFixed(1)}`);
  else ok(`the new one gives ${A.toFixed(1)}° and ${B.toFixed(1)}°`);
}

// ── before anything is learned ──────────────────────────────────────────────
console.log('\n== first sample, phone already on its side');
{
  const policy = POLICIES['top edge, lens when the top edge is vertical'];
  for (const [name, p] of SIDEWAYS.slice(0, 4)) {
    const e = iosEvent({ ...p, alpha: 200 }, policy, 51);
    const r = Heading.iosCamera(e.compass, e.alpha, e.beta, e.gamma, null);
    if (r.calibrated) fail(`${name}: claimed to calibrate from an ambiguous pose`);
    if (!near(r.heading, e.truth)) fail(`${name}: uncalibrated fallback got ${r.heading.toFixed(1)}, truth ${e.truth.toFixed(1)}`);
    else ok(`${name}: falls back to the documented top-edge reading, ${r.heading.toFixed(1)}°`);
  }
  // and a portrait sample is enough to learn from
  const e = iosEvent({ alpha: 200, beta: 70, gamma: 0 }, policy, 51);
  const r = Heading.iosCamera(e.compass, e.alpha, e.beta, e.gamma, null);
  if (!r.calibrated || !near(r.offset, 51)) fail(`portrait sample did not calibrate: ${JSON.stringify(r)}`);
  else ok(`one portrait sample learns the frame offset (${r.offset.toFixed(1)}°)`);
}

// ── straight down, no bearing ───────────────────────────────────────────────
{
  const r = Heading.iosCamera(90, 0, 0, 0, null);
  if (r.heading !== null) fail('lens straight down should have no bearing');
  else ok('lens straight down: no bearing, nothing learned');
}

console.log(process.exitCode ? '\nFAILED' : '\nheading maths pass');
