/* Exotic Camera — configuration + settings store.
   Loaded in the page AND in the service worker (importScripts), so it must not
   touch `window` or `document`. */
(function (g) {
  'use strict';

  var BUILD = '__BUILD__';                    // replaced at deploy time with the commit sha

  var DEFAULTS = {
    // Target feature service. Layer 0 of this service is "Exotics Camera Points".
    serviceUrl: 'https://services.arcgis.com/apTfC6SUmnNfnxuF/arcgis/rest/services/Exotics_Camera_Points/FeatureServer',
    layerId: 0,
    portal: 'https://www.arcgis.com',
    appId: '',                                // OAuth 2.0 client id, if the org registered one

    maxDim: 1600,                             // long edge of the uploaded JPEG
    quality: 0.8,
    saveToDevice: true,                       // also hand each photo to the phone
    keepHours: 48,                            // how long the local JPEG is kept after upload
    sound: true,
    haptics: true,
    autoSync: true,

    // Field mapping. '' = auto-detect, '-' = never write this value.
    // Defaults match the Esri GNSS metadata schema on this layer.
    fields: {
      heading:   'esrisnsr_azimuth',          // compass reading (deg)
      lat:       'esrignss_latitude',
      lon:       'esrignss_longitude',
      altitude:  'esrignss_altitude',
      accuracy:  'esrignss_h_rms',            // horizontal accuracy (m)
      vaccuracy: 'esrignss_v_rms',
      speed:     'esrignss_speed',            // km/h
      course:    'esrignss_direction',        // direction of travel (deg)
      captured:  'esrignss_fixdatetime',
      device:    'esrignss_receiver',
      notes:     ''
    }
  };

  // Names we look for when a mapping is left blank.
  var CANDIDATES = {
    heading:   ['esrisnsr_azimuth', 'azimuth', 'heading', 'bearing', 'direction', 'camera_heading', 'cameradir', 'compass'],
    lat:       ['esrignss_latitude', 'latitude', 'lat', 'y'],
    lon:       ['esrignss_longitude', 'longitude', 'long', 'lon', 'x'],
    altitude:  ['esrignss_altitude', 'altitude', 'elevation', 'elev', 'alt', 'z'],
    accuracy:  ['esrignss_h_rms', 'accuracy', 'gps_accuracy', 'horizontal_accuracy', 'hacc'],
    vaccuracy: ['esrignss_v_rms', 'vertical_accuracy', 'vacc'],
    speed:     ['esrignss_speed', 'speed'],
    course:    ['esrignss_direction', 'course', 'track'],
    captured:  ['esrignss_fixdatetime', 'captured', 'capture_time', 'photo_date', 'datetime', 'date_time', 'timestamp'],
    device:    ['esrignss_receiver', 'device', 'source', 'platform', 'collector'],
    notes:     ['notes', 'note', 'comment', 'comments', 'description', 'remarks']
  };

  // Fields the service manages itself — never send these.
  var RESERVED = /^(objectid|globalid|fid|shape|shape_|se_anno)/i;

  var cfg = null;

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function merge(base, over) {
    var out = clone(base);
    if (!over) return out;
    Object.keys(over).forEach(function (k) {
      if (k === 'fields') {
        out.fields = out.fields || {};
        Object.keys(over.fields || {}).forEach(function (f) { out.fields[f] = over.fields[f]; });
      } else if (over[k] !== undefined && over[k] !== null) {
        out[k] = over[k];
      }
    });
    return out;
  }

  var Config = {
    BUILD: BUILD,
    DEFAULTS: DEFAULTS,
    CANDIDATES: CANDIDATES,
    RESERVED: RESERVED,

    /** Load settings from IndexedDB (works in page and worker). */
    load: function () {
      return g.Store.get('settings').then(function (saved) {
        cfg = merge(DEFAULTS, saved);
        return cfg;
      });
    },

    get: function () { return cfg || (cfg = clone(DEFAULTS)); },

    save: function (patch) {
      cfg = merge(Config.get(), patch);
      return g.Store.set('settings', cfg).then(function () { return cfg; });
    },

    reset: function () {
      cfg = clone(DEFAULTS);
      return g.Store.set('settings', cfg).then(function () { return cfg; });
    },

    /** Full REST url of the target layer. */
    layerUrl: function () {
      var c = Config.get();
      return String(c.serviceUrl).replace(/\/+$/, '') + '/' + (c.layerId | 0);
    }
  };

  g.Config = Config;
})(typeof self !== 'undefined' ? self : this);
