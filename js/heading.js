/* Exotic Camera — which way the lens points, from what the phone reports.

   Two kinds of phone hand over orientation data:

   Android gives `deviceorientationabsolute`: alpha, beta, gamma referenced to
   magnetic north, so the camera axis can be run through the W3C rotation
   matrix and read off directly, in any pose.

   iOS gives alpha/beta/gamma referenced to an *arbitrary* yaw (whatever the
   motion frame started at), plus `webkitCompassHeading`, which is Core
   Location's heading of the **top edge** of the phone — except when the top
   edge points at the sky, where Core Location quietly uses the lens instead so
   the compass keeps working upright. Exactly how it blends the two is not
   documented. Treating the compass as if it were alpha is right in portrait,
   and wrong once the phone is on its side: the top edge then points sideways,
   and the W3C angles also flip through a 180° discontinuity as the camera
   crosses level, so the bearing could come out 90° or 180° off.

   The answer here does not depend on what Core Location does: in poses where
   the top edge and the lens lean the same way the compass can only mean one
   thing, so the yaw offset between the arbitrary frame and magnetic north is
   learned there and applied everywhere — the attitude is exact in every pose,
   only its reference was missing. */
(function (g) {
  'use strict';

  var RAD = Math.PI / 180;

  /** Wrap to [0, 360). */
  function norm(d) { return ((d % 360) + 360) % 360; }
  /** Wrap to [-180, 180): the short way round from a to b. */
  function diff(a, b) { return ((b - a + 540) % 360) - 180; }

  /** World vectors (x east, y north, z up) of the device axes, W3C convention. */
  function frame(alpha, beta, gamma) {
    var a = alpha * RAD, b = beta * RAD, c = gamma * RAD;
    var cA = Math.cos(a), sA = Math.sin(a);
    var cB = Math.cos(b), sB = Math.sin(b);
    var cG = Math.cos(c), sG = Math.sin(c);
    return {
      // columns of Rz(alpha)·Rx(beta)·Ry(gamma)
      x: [cA * cG - sA * sB * sG, cG * sA + cA * sB * sG, -cB * sG],
      y: [-cB * sA, cA * cB, sB],
      z: [cG * sA * sB + cA * sG, sA * sG - cA * cG * sB, cB * cG]
    };
  }

  function azimuth(v) { return norm(Math.atan2(v[0], v[1]) / RAD); }
  function level(v) { return Math.hypot(v[0], v[1]); }        // horizontal share, 0..1

  /** Azimuth of the rear camera (device −Z) from absolute angles, or null when it points straight up/down. */
  function cameraAzimuth(alpha, beta, gamma) {
    var z = frame(alpha, beta, gamma).z;
    var cam = [-z[0], -z[1]];
    if (Math.abs(cam[0]) < 1e-7 && Math.abs(cam[1]) < 1e-7) return null;
    return azimuth(cam);
  }

  /**
   * iOS: camera bearing from the compass plus arbitrary-frame attitude.
   *
   * `offset` is the yaw between the arbitrary frame and magnetic north learned
   * from earlier samples (null at first). Returns the bearing, the offset to
   * keep for next time, and whether this sample refreshed it. `heading` is null
   * when the camera points straight up or down.
   */
  function iosCamera(compass, alpha, beta, gamma, offset) {
    var f = frame(alpha, beta, gamma);
    var cam = [-f.z[0], -f.z[1], -f.z[2]], top = f.y;
    var camH = level(cam), topH = level(top);
    if (camH < 1e-7) return { heading: null, offset: offset, calibrated: false };
    var camAz = azimuth(cam), topAz = azimuth(top);    // both in the arbitrary frame

    // What the compass must be pointing along in this pose, if anything.
    var ref = null;
    if (topH < 0.1 && camH > 0.3) ref = camAz;                    // upright: only the lens has a bearing
    else if (camH < 0.1 && topH > 0.3 && f.z[2] > 0) ref = topAz;  // flat, screen up: only the top edge does
    else if (camH > 0.1 && topH > 0.1 && Math.abs(diff(topAz, camAz)) < 10) {
      ref = norm(topAz + diff(topAz, camAz) / 2);                 // flat to upright, lens level or down: same way
    }
    var calibrated = ref !== null;
    if (calibrated) {
      var seen = norm(compass - ref);
      offset = offset === null || offset === undefined ? seen : norm(offset + diff(offset, seen) / 2);
    }

    var heading;
    if (offset === null || offset === undefined) {
      // Nothing learned yet: take the compass as the top edge, as documented.
      heading = topH > 0.1 ? norm(compass + diff(topAz, camAz)) : norm(compass);
    } else {
      heading = norm(camAz + offset);
    }
    return { heading: heading, offset: offset, calibrated: calibrated };
  }

  g.Heading = { frame: frame, cameraAzimuth: cameraAzimuth, iosCamera: iosCamera, norm: norm, diff: diff };
})(self);
