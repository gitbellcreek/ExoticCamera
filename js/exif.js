/* Exotic Camera — just enough EXIF to place a photo from the camera roll.
   Reads the TIFF block that follows an "Exif\0\0" marker, which is how both
   JPEG (inside APP1) and HEIC/HEIF (inside the Exif item) carry it, so one
   path covers what phones actually hand over. */
(function (g) {
  'use strict';

  var HEAD = 512 * 1024;              // EXIF lives near the front of the file

  var TAG = {
    MAKE: 0x010f, MODEL: 0x0110, ORIENTATION: 0x0112,
    EXIF_IFD: 0x8769, GPS_IFD: 0x8825,
    DATE_ORIGINAL: 0x9003, DATE_DIGITIZED: 0x9004, OFFSET_ORIGINAL: 0x9011,
    PIXEL_X: 0xa002, PIXEL_Y: 0xa003
  };
  var GPS = {
    LAT_REF: 1, LAT: 2, LON_REF: 3, LON: 4, ALT_REF: 5, ALT: 6,
    TIME: 7, SPEED_REF: 12, SPEED: 13, IMG_DIR_REF: 16, IMG_DIR: 17, DATE: 29,
    H_ERROR: 31                        // GPSHPositioningError, metres
  };
  var SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

  function findExif(bytes) {
    // "Exif\0\0" — bounded scan, then sanity-check the TIFF header behind it
    for (var i = 0; i < bytes.length - 8; i++) {
      if (bytes[i] === 0x45 && bytes[i + 1] === 0x78 && bytes[i + 2] === 0x69 &&
          bytes[i + 3] === 0x66 && bytes[i + 4] === 0 && bytes[i + 5] === 0) {
        var t = i + 6;
        var b0 = bytes[t], b1 = bytes[t + 1];
        if ((b0 === 0x49 && b1 === 0x49) || (b0 === 0x4d && b1 === 0x4d)) return t;
      }
    }
    return -1;
  }

  function reader(view, tiff, little) {
    return {
      u16: function (o) { return view.getUint16(tiff + o, little); },
      u32: function (o) { return view.getUint32(tiff + o, little); },
      i32: function (o) { return view.getInt32(tiff + o, little); },
      u8: function (o) { return view.getUint8(tiff + o); }
    };
  }

  function readValue(r, type, count, offset) {
    var out = [];
    var i;
    for (i = 0; i < count; i++) {
      var at = offset + i * SIZE[type];
      if (type === 1 || type === 7 || type === 6) out.push(r.u8(at));
      else if (type === 2) out.push(String.fromCharCode(r.u8(at)));
      else if (type === 3) out.push(r.u16(at));
      else if (type === 4) out.push(r.u32(at));
      else if (type === 9) out.push(r.i32(at));
      else if (type === 5) {
        var den = r.u32(at + 4);
        out.push(den ? r.u32(at) / den : 0);
      } else if (type === 10) {
        var sden = r.i32(at + 4);
        out.push(sden ? r.i32(at) / sden : 0);
      } else return null;
    }
    if (type === 2) return out.join('').replace(/\0+$/, '');
    return out;
  }

  function readIFD(r, offset, into) {
    var n = r.u16(offset);
    if (n > 512) return;                                   // not a real IFD
    for (var i = 0; i < n; i++) {
      var e = offset + 2 + i * 12;
      var tag = r.u16(e), type = r.u16(e + 2), count = r.u32(e + 4);
      if (!SIZE[type]) continue;
      var bytes = SIZE[type] * count;
      var valueAt = bytes > 4 ? r.u32(e + 8) : e + 8;
      var v = readValue(r, type, count, valueAt);
      if (v !== null) into[tag] = v;
    }
  }

  function dms(parts, ref) {
    if (!parts || parts.length < 2) return null;
    var deg = parts[0] + (parts[1] || 0) / 60 + (parts[2] || 0) / 3600;
    if (ref === 'S' || ref === 'W') deg = -deg;
    return deg;
  }

  /** "2026:07:30 14:05:09" → epoch ms, read as local time like a camera means it. */
  function exifDate(s, gpsDate, gpsTime) {
    var m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s || '');
    if (m) {
      return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
    }
    var d = /^(\d{4}):(\d{2}):(\d{2})/.exec(gpsDate || '');
    if (d && gpsTime && gpsTime.length >= 3) {
      return Date.UTC(+d[1], +d[2] - 1, +d[3], gpsTime[0] | 0, gpsTime[1] | 0, gpsTime[2] | 0);
    }
    return null;
  }

  var Exif = {
    /** Resolves with what could be read; never rejects on a malformed file. */
    read: function (blob) {
      return blob.slice(0, HEAD).arrayBuffer().then(function (buf) {
        var bytes = new Uint8Array(buf);
        var tiff = findExif(bytes);
        if (tiff < 0) return { found: false };

        var view = new DataView(buf);
        var little = bytes[tiff] === 0x49;
        var r = reader(view, tiff, little);
        if (r.u16(2) !== 0x002a) return { found: false };

        var ifd0 = {}, exif = {}, gps = {};
        readIFD(r, r.u32(4), ifd0);
        if (ifd0[TAG.EXIF_IFD]) readIFD(r, ifd0[TAG.EXIF_IFD][0], exif);
        if (ifd0[TAG.GPS_IFD]) readIFD(r, ifd0[TAG.GPS_IFD][0], gps);

        var lat = dms(gps[GPS.LAT], gps[GPS.LAT_REF]);
        var lon = dms(gps[GPS.LON], gps[GPS.LON_REF]);
        var alt = gps[GPS.ALT] ? gps[GPS.ALT][0] : null;
        if (alt !== null && gps[GPS.ALT_REF] && gps[GPS.ALT_REF][0] === 1) alt = -alt;

        var heading = gps[GPS.IMG_DIR] ? gps[GPS.IMG_DIR][0] : null;
        var headingRef = gps[GPS.IMG_DIR_REF] || null;      // 'T' true, 'M' magnetic

        var speed = null;                                   // km/h in EXIF when ref is K
        if (gps[GPS.SPEED]) {
          var sv = gps[GPS.SPEED][0], sr = gps[GPS.SPEED_REF];
          if (sr === 'K') speed = sv / 3.6;                 // → m/s, as the app stores it
          else if (sr === 'M') speed = sv * 0.44704;
          else if (sr === 'N') speed = sv * 0.514444;
        }

        var make = (ifd0[TAG.MAKE] || '').trim();
        var model = (ifd0[TAG.MODEL] || '').trim();

        return {
          found: true,
          lat: typeof lat === 'number' && isFinite(lat) ? lat : null,
          lon: typeof lon === 'number' && isFinite(lon) ? lon : null,
          alt: typeof alt === 'number' && isFinite(alt) ? alt : null,
          heading: typeof heading === 'number' && isFinite(heading) ? heading : null,
          headingRef: headingRef,
          hAcc: gps[GPS.H_ERROR] ? gps[GPS.H_ERROR][0] : null,
          speed: speed,
          taken: exifDate(exif[TAG.DATE_ORIGINAL] || exif[TAG.DATE_DIGITIZED],
                          gps[GPS.DATE], gps[GPS.TIME]),
          make: make,
          model: model,
          camera: (make + ' ' + model).trim(),
          orientation: ifd0[TAG.ORIENTATION] ? ifd0[TAG.ORIENTATION][0] : 1
        };
      }).catch(function () {
        return { found: false };
      });
    }
  };

  g.Exif = Exif;
})(typeof self !== 'undefined' ? self : this);
