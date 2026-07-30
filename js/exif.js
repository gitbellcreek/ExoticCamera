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

  /* ── writing ─────────────────────────────────────────────────────
     Canvas re-encoding drops every scrap of metadata, so a photo saved back to
     the phone — or pulled off the layer as an attachment — would carry no
     position at all. These build a fresh EXIF block and splice it in. */

  function rational(x, den) {
    den = den || 1000000;
    var n = Math.round(Math.abs(x) * den);
    return [n, den];
  }

  function toDMS(deg) {
    var a = Math.abs(deg);
    var d = Math.floor(a);
    var m = Math.floor((a - d) * 60);
    var sec = (a - d - m / 60) * 3600;
    return [[d, 1], [m, 1], rational(sec, 10000)];
  }

  function ascii(s) {
    var out = [];
    for (var i = 0; i < s.length; i++) out.push(s.charCodeAt(i) & 0xff);
    out.push(0);
    return out;
  }

  var W = { BYTE: 1, ASCII: 2, SHORT: 3, LONG: 4, RATIONAL: 5 };
  var WIDTH = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8 };

  function entryCount(e) {
    if (e.type === W.ASCII) return e.value.length;
    if (e.type === W.RATIONAL) return e.value.length / 2;
    return e.value.length;
  }

  function ifdBytes(n) { return 2 + n * 12 + 4; }

  /** Serialise IFD0 + Exif IFD + GPS IFD into one little-endian TIFF block. */
  function buildTiff(ifd0, exifIfd, gpsIfd) {
    var ifd0Off = 8;
    var exifOff = ifd0Off + ifdBytes(ifd0.length + (exifIfd.length ? 1 : 0) + (gpsIfd.length ? 1 : 0));
    var gpsOff = exifOff + (exifIfd.length ? ifdBytes(exifIfd.length) : 0);
    var dataStart = gpsOff + (gpsIfd.length ? ifdBytes(gpsIfd.length) : 0);

    // pointers into the sub-IFDs live in IFD0
    var head = ifd0.slice();
    if (exifIfd.length) head.push({ tag: TAG.EXIF_IFD, type: W.LONG, value: [exifOff] });
    if (gpsIfd.length) head.push({ tag: TAG.GPS_IFD, type: W.LONG, value: [gpsOff] });
    head.sort(function (a, b) { return a.tag - b.tag; });

    var data = [];
    var total = dataStart;
    function reserve(bytes) {
      var at = total;
      total += bytes + (bytes % 2);
      return at;
    }

    var buf = new Uint8Array(65000);
    var view = new DataView(buf.buffer);
    function u16(o, v) { view.setUint16(o, v, true); }
    function u32(o, v) { view.setUint32(o, v, true); }

    buf[0] = 0x49; buf[1] = 0x49;              // 'II'
    u16(2, 42);
    u32(4, ifd0Off);

    function writeIFD(entries, offset) {
      entries.sort(function (a, b) { return a.tag - b.tag; });
      u16(offset, entries.length);
      entries.forEach(function (e, i) {
        var at = offset + 2 + i * 12;
        var count = entryCount(e);
        var bytes = WIDTH[e.type] * (e.type === W.RATIONAL ? count * 2 : count);
        if (e.type === W.RATIONAL) bytes = count * 8;
        u16(at, e.tag);
        u16(at + 2, e.type);
        u32(at + 4, count);
        if (bytes <= 4) {
          for (var b = 0; b < bytes; b++) {
            if (e.type === W.SHORT) u16(at + 8 + b * 2, e.value[b]);
            else buf[at + 8 + b] = e.value[b];
          }
          if (e.type === W.SHORT) u16(at + 8, e.value[0]);
          if (e.type === W.LONG) u32(at + 8, e.value[0]);
        } else {
          var pos = reserve(bytes);
          u32(at + 8, pos);
          data.push({ at: pos, e: e });
        }
      });
      u32(offset + 2 + entries.length * 12, 0);   // no next IFD
    }

    writeIFD(head, ifd0Off);
    if (exifIfd.length) writeIFD(exifIfd, exifOff);
    if (gpsIfd.length) writeIFD(gpsIfd, gpsOff);

    data.forEach(function (d) {
      var e = d.e, at = d.at;
      if (e.type === W.RATIONAL) {
        for (var i = 0; i < e.value.length; i += 2) {
          u32(at + i * 4, e.value[i]);
          u32(at + i * 4 + 4, e.value[i + 1]);
        }
      } else if (e.type === W.SHORT) {
        for (var j = 0; j < e.value.length; j++) u16(at + j * 2, e.value[j]);
      } else if (e.type === W.LONG) {
        for (var k = 0; k < e.value.length; k++) u32(at + k * 4, e.value[k]);
      } else {
        for (var m = 0; m < e.value.length; m++) buf[at + m] = e.value[m];
      }
    });

    return buf.subarray(0, total);
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  var Exif = {
    /**
     * Return a copy of `jpeg` carrying an EXIF block built from `meta`
     * (lat, lon, alt, heading, headingRef, hAcc, taken, device, speed).
     * Falls back to the original blob if anything is off — metadata is never
     * worth losing the photo over.
     */
    write: function (jpeg, meta) {
      return jpeg.arrayBuffer().then(function (buf) {
        var src = new Uint8Array(buf);
        if (src[0] !== 0xff || src[1] !== 0xd8) return jpeg;      // not a JPEG

        var ifd0 = [], exifIfd = [], gps = [];
        var when = meta.taken ? new Date(meta.taken) : null;

        if (meta.device) {
          ifd0.push({ tag: TAG.MAKE, type: W.ASCII, value: ascii(String(meta.device).slice(0, 60)) });
          ifd0.push({ tag: TAG.MODEL, type: W.ASCII, value: ascii(String(meta.model || meta.device).slice(0, 60)) });
        }
        ifd0.push({ tag: TAG.ORIENTATION, type: W.SHORT, value: [1] });   // already baked in
        if (when) {
          var stamp = when.getFullYear() + ':' + pad2(when.getMonth() + 1) + ':' + pad2(when.getDate()) +
            ' ' + pad2(when.getHours()) + ':' + pad2(when.getMinutes()) + ':' + pad2(when.getSeconds());
          ifd0.push({ tag: 0x0132, type: W.ASCII, value: ascii(stamp) });
          exifIfd.push({ tag: TAG.DATE_ORIGINAL, type: W.ASCII, value: ascii(stamp) });
          exifIfd.push({ tag: TAG.DATE_DIGITIZED, type: W.ASCII, value: ascii(stamp) });
        }

        if (typeof meta.lat === 'number' && typeof meta.lon === 'number') {
          gps.push({ tag: 0, type: W.BYTE, value: [2, 3, 0, 0] });          // GPSVersionID
          gps.push({ tag: GPS.LAT_REF, type: W.ASCII, value: ascii(meta.lat >= 0 ? 'N' : 'S') });
          gps.push({ tag: GPS.LAT, type: W.RATIONAL, value: [].concat.apply([], toDMS(meta.lat)) });
          gps.push({ tag: GPS.LON_REF, type: W.ASCII, value: ascii(meta.lon >= 0 ? 'E' : 'W') });
          gps.push({ tag: GPS.LON, type: W.RATIONAL, value: [].concat.apply([], toDMS(meta.lon)) });
        }
        if (typeof meta.alt === 'number' && isFinite(meta.alt)) {
          gps.push({ tag: GPS.ALT_REF, type: W.BYTE, value: [meta.alt < 0 ? 1 : 0] });
          gps.push({ tag: GPS.ALT, type: W.RATIONAL, value: rational(meta.alt, 100) });
        }
        if (typeof meta.heading === 'number' && isFinite(meta.heading)) {
          gps.push({ tag: GPS.IMG_DIR_REF, type: W.ASCII, value: ascii(meta.headingRef === 'T' ? 'T' : 'M') });
          gps.push({ tag: GPS.IMG_DIR, type: W.RATIONAL, value: rational(meta.heading, 100) });
        }
        if (typeof meta.hAcc === 'number' && isFinite(meta.hAcc)) {
          gps.push({ tag: GPS.H_ERROR, type: W.RATIONAL, value: rational(meta.hAcc, 100) });
        }
        if (typeof meta.speed === 'number' && isFinite(meta.speed)) {
          gps.push({ tag: GPS.SPEED_REF, type: W.ASCII, value: ascii('K') });
          gps.push({ tag: GPS.SPEED, type: W.RATIONAL, value: rational(meta.speed * 3.6, 100) });
        }
        if (when) {
          gps.push({ tag: GPS.DATE, type: W.ASCII, value: ascii(
            when.getUTCFullYear() + ':' + pad2(when.getUTCMonth() + 1) + ':' + pad2(when.getUTCDate())) });
          gps.push({ tag: GPS.TIME, type: W.RATIONAL, value: [
            when.getUTCHours(), 1, when.getUTCMinutes(), 1, when.getUTCSeconds(), 1] });
        }

        if (!gps.length && !exifIfd.length) return jpeg;

        var tiff = buildTiff(ifd0, exifIfd, gps);
        var payload = 6 + tiff.length;                        // "Exif\0\0" + TIFF
        if (payload + 2 > 65535) return jpeg;

        var out = new Uint8Array(src.length + 4 + payload);
        var o = 0;
        out[o++] = 0xff; out[o++] = 0xd8;                     // SOI
        out[o++] = 0xff; out[o++] = 0xe1;                     // APP1
        out[o++] = ((payload + 2) >> 8) & 0xff;
        out[o++] = (payload + 2) & 0xff;
        out[o++] = 0x45; out[o++] = 0x78; out[o++] = 0x69; out[o++] = 0x66; out[o++] = 0; out[o++] = 0;
        out.set(tiff, o); o += tiff.length;
        out.set(src.subarray(2), o);                          // the rest of the original
        return new Blob([out], { type: 'image/jpeg' });
      }).catch(function () {
        return jpeg;
      });
    },

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
