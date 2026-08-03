/* Exotic Camera — configuration + settings store.
   Loaded in the page AND in the service worker (importScripts), so it must not
   touch `window` or `document`. */
(function (g) {
  'use strict';

  var BUILD = '__BUILD__';                    // replaced at deploy time with the commit sha

  // The layers a user can switch between in the field.
  var PRESETS = [
    {
      id: 'central',
      name: 'Central',
      serviceUrl: 'https://services.arcgis.com/apTfC6SUmnNfnxuF/arcgis/rest/services/Iphone_Images/FeatureServer',
      layerId: 0
    },
    {
      id: 'elapp',
      name: 'ELAPP All',
      serviceUrl: 'https://services.arcgis.com/apTfC6SUmnNfnxuF/arcgis/rest/services/El_Rat_Generic/FeatureServer',
      layerId: 0
    }
  ];

  var DEFAULTS = {
    // where problem reports go
    bugsUrl: 'https://services.arcgis.com/apTfC6SUmnNfnxuF/arcgis/rest/services/ExoticCameraBugs/FeatureServer',
    bugsLayerId: 0,
    reportProblems: true,                     // send crashes and upload failures automatically

    activeLayer: 'central',
    serviceUrl: PRESETS[0].serviceUrl,
    layerId: PRESETS[0].layerId,
    portal: 'https://www.arcgis.com',
    appId: '',                                // OAuth 2.0 client id, if the org registered one

    maxDim: 1600,                             // long edge of the uploaded JPEG
    quality: 0.8,
    saveToDevice: false,                      // per-shot share sheet: off, it interrupts shooting
    keepHours: 48,                            // how long the local JPEG is kept after upload
    sound: true,
    haptics: true,
    autoSync: true,

    // Field mapping. '' = auto-detect from the layer, '-' = never write it.
    // Blank by default so each layer resolves against its own schema — Central and
    // Exotics name the same things differently.
    fields: {
      heading: '', lat: '', lon: '', altitude: '', accuracy: '', vaccuracy: '',
      speed: '', course: '', captured: '', device: '', notes: '', filename: '', feature: ''
    }
  };

  // Names we look for when a mapping is left blank.
  var CANDIDATES = {
    heading:   ['esrisnsr_azimuth', 'azimuth', 'heading', 'bearing', 'direction', 'camera_heading', 'cameradir', 'compass'],
    filename:  ['filename', 'file_name', 'photo', 'photoname', 'image', 'imagename'],
    feature:   ['feature', 'feature_type', 'featuretype', 'featurename', 'species', 'habitat', 'category', 'type'],
    lat:       ['esrignss_latitude', 'latitude', 'lat', 'y'],
    lon:       ['esrignss_longitude', 'longitude', 'long', 'lon', 'x'],
    altitude:  ['esrignss_altitude', 'altitude', 'elevation', 'elev', 'alt', 'z'],
    accuracy:  ['esrignss_h_rms', 'accuracy', 'gps_accuracy', 'horizontal_accuracy', 'hacc'],
    vaccuracy: ['esrignss_v_rms', 'vertical_accuracy', 'vacc'],
    speed:     ['esrignss_speed', 'speed'],
    course:    ['esrignss_direction', 'course', 'track', 'course_over_ground'],
    captured:  ['esrignss_fixdatetime', 'datetaken', 'captured', 'capture_time', 'photo_date', 'datetime', 'date_time', 'timestamp'],
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
    PRESETS: PRESETS,
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
      return Config.urlOf(c.serviceUrl, c.layerId);
    },

    urlOf: function (serviceUrl, layerId) {
      return String(serviceUrl).replace(/\/+$/, '') + '/' + (layerId | 0);
    },

    preset: function (id) {
      for (var i = 0; i < PRESETS.length; i++) if (PRESETS[i].id === id) return PRESETS[i];
      return null;
    },

    /** Which preset the current settings point at, or null for a custom layer. */
    activePreset: function () {
      var c = Config.get();
      for (var i = 0; i < PRESETS.length; i++) {
        if (PRESETS[i].serviceUrl === c.serviceUrl && PRESETS[i].layerId === (c.layerId | 0)) return PRESETS[i];
      }
      return null;
    },

    layerName: function () {
      var p = Config.activePreset();
      return p ? p.name : 'Custom layer';
    },

    /** Point the app at one of the presets. */
    useLayer: function (id) {
      var p = Config.preset(id);
      if (!p) return Promise.reject(new Error('Unknown layer ' + id));
      return Config.save({ activeLayer: p.id, serviceUrl: p.serviceUrl, layerId: p.layerId });
    }
  };

  g.Config = Config;
})(typeof self !== 'undefined' ? self : this);
