/* Photo Points — configuration + settings store.
   Loaded in the page AND in the service worker (importScripts), so it must not
   touch `window` or `document`. The shape of `Config` (BUILD, get, layerName,
   layerUrl) is what ../js/report.js expects, so problem reports work here too. */
(function (g) {
  'use strict';

  var BUILD = '__BUILD__';                    // replaced at deploy time with the commit sha

  var SERVICE = 'https://services.arcgis.com/apTfC6SUmnNfnxuF/arcgis/rest/services/Photo_Monitoring/FeatureServer';

  /* The photo slots of a visit. `key` is the attachment keyword the Field Maps
     form uses, so photos from either app land in the same slot. `bearing` is
     the cardinal direction to face; the target becomes the last visit's own
     bearing once there is one, so repeat photos line up with the first. */
  var SLOTS = [
    { key: 'N', word: 'North eye level', label: 'North', short: 'N', bearing: 0, group: 'eye' },
    { key: 'E', word: 'East eye level', label: 'East', short: 'E', bearing: 90, group: 'eye' },
    { key: 'S', word: 'South eye level', label: 'South', short: 'S', bearing: 180, group: 'eye' },
    { key: 'W', word: 'West eye level', label: 'West', short: 'W', bearing: 270, group: 'eye' },
    { key: 'LOW_N', word: 'North groundcover', label: 'Groundcover · North', short: 'N', bearing: 0, group: 'low' },
    { key: 'LOW_E', word: 'East groundcover', label: 'Groundcover · East', short: 'E', bearing: 90, group: 'low' },
    { key: 'LOW_S', word: 'South groundcover', label: 'Groundcover · South', short: 'S', bearing: 180, group: 'low' },
    { key: 'LOW_W', word: 'West groundcover', label: 'Groundcover · West', short: 'W', bearing: 270, group: 'low' },
    { key: 'LOCATOR', word: 'Post', label: 'Locator — the post', short: 'Post', bearing: null, group: 'other' },
    { key: 'MISC', word: 'Other', label: 'Misc', short: '+', bearing: null, group: 'other' }
  ];

  /* The keyword a photo is saved with is its slot spelled out ("North
     groundcover"), so a popup's attachment filter, which matches any part of
     the keyword, can pick out a direction ("North") or a level ("groundcover")
     cleanly. Photos saved before November 2026 carry the old shorthand (N,
     LOW_N, LOCATOR, MISC); both are read, and so are the backup Survey123
     form's question names (North_eye_level). */
  function slotOfKeyword(kw) {
    var k = String(kw || '').trim().toUpperCase();
    if (!k) return null;
    // the backup Survey123 form names its photo questions North_eye_level, …, and uses those as keywords
    var spaced = k.replace(/[_-]+/g, ' ');
    for (var i = 0; i < SLOTS.length; i++) {
      if (SLOTS[i].key === k || SLOTS[i].word.toUpperCase() === spaced) return SLOTS[i].key;
    }
    return null;
  }

  /* The order the camera moves through after each shot: both photos facing
     one way before turning, so it is one trip around the post, not two. */
  var ORDER = ['N', 'LOW_N', 'E', 'LOW_E', 'S', 'LOW_S', 'W', 'LOW_W', 'LOCATOR'];

  var DEFAULTS = {
    serviceUrl: SERVICE,
    stationsLayer: 0,
    visitsLayer: 1,
    portal: 'https://www.arcgis.com',
    appId: '',                                // OAuth 2.0 client id, if the org registered one
    webMap: 'e785cab8a5f745e8acd63a95d8966b90', // the photo browser's map of the stations
    // management unit boundaries: a new station's unit is filled in from these (MU_ID, e.g. BBS_23a)
    unitsUrl: 'https://services.arcgis.com/apTfC6SUmnNfnxuF/arcgis/rest/services/CELM_MU_202405/FeatureServer/0',

    // where problem reports go — the same table as Exotic Camera's
    bugsUrl: 'https://services.arcgis.com/apTfC6SUmnNfnxuF/arcgis/rest/services/ExoticCameraBugs/FeatureServer',
    bugsLayerId: 0,
    reportProblems: true,

    tolerance: 5,                             // degrees either side of the target that count as on target
    north: 'true',                            // 'true' or 'magnetic'
    declination: -6.3,                        // magnetic → true: Hillsborough County, WMM-2025, Oct 2026 (−0.08°/yr)
    autoAdvance: true,                        // after a shot, move to the next empty slot
    ghost: true,                              // overlay the last visit's photo for the slot

    maxDim: 0,                                // long edge of the saved JPEG; 0 = the camera's full resolution
    quality: 0.92,
    partKB: 1024,                             // upload chunk size: a dropped connection only costs one chunk
    keepHours: 72,                            // how long a photo stays on the phone after it is safely up

    sound: true,
    haptics: true,
    autoSync: true,

    // remembered between visits, so a day of visits does not mean retyping them
    observer: '',
    monitoringEvent: ''
  };

  // Fields the service manages itself — never send these.
  var RESERVED = /^(objectid|globalid|fid|shape|shape_|creationdate|creator|editdate|editor)$/i;

  var cfg = null;

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function merge(base, over) {
    var out = clone(base);
    if (!over) return out;
    Object.keys(over).forEach(function (k) {
      if (over[k] !== undefined && over[k] !== null) out[k] = over[k];
    });
    return out;
  }

  var Config = {
    BUILD: BUILD,
    SLOTS: SLOTS,
    ORDER: ORDER,
    DEFAULTS: DEFAULTS,
    RESERVED: RESERVED,

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

    serviceUrl: function () { return String(Config.get().serviceUrl).replace(/\/+$/, ''); },
    stationsUrl: function () { return Config.serviceUrl() + '/' + (Config.get().stationsLayer | 0); },
    visitsUrl: function () { return Config.serviceUrl() + '/' + (Config.get().visitsLayer | 0); },

    // what report.js labels a report with
    layerName: function () { return 'Photo Points'; },
    layerUrl: function () { return Config.visitsUrl(); },

    slotOfKeyword: slotOfKeyword,

    /** The keyword a slot's photos are saved with, and the same for a file name: North-groundcover. */
    keyword: function (key) { var s = Config.slot(key); return s ? s.word : key; },
    namePart: function (key) { var s = Config.slot(key); return s ? s.word.replace(/ /g, '-') : key; },

    slot: function (key) {
      for (var i = 0; i < SLOTS.length; i++) if (SLOTS[i].key === key) return SLOTS[i];
      return null;
    },

    /** Turn a magnetic bearing into the one the app shows and records. */
    reference: function (magnetic) {
      if (magnetic === null || magnetic === undefined) return null;
      var c = Config.get();
      if (c.north !== 'true') return ((magnetic % 360) + 360) % 360;
      return (((magnetic + (+c.declination || 0)) % 360) + 360) % 360;
    },

    /** 'T' or 'M' — what the recorded bearings are measured from. */
    ref: function () { return Config.get().north === 'true' ? 'T' : 'M'; }
  };

  g.Config = Config;
})(typeof self !== 'undefined' ? self : this);
