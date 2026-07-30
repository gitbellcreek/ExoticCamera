# Exotic Camera

A small offline-first web camera for field work. Take a photo, and the app files it
as a point in the **Exotics Camera Points** ArcGIS feature layer with the compass
heading the camera was facing, the GPS fix, and the JPEG attached.

No build step, no framework, no dependencies — about 60 KB of static files served
from GitHub Pages, so it opens fast on a phone and keeps working with no signal.

## What it does

- **Live viewfinder** with a surveyor-style compass card at the top. The heading is
  tilt-compensated, so it reads the direction the *lens* points while you hold the
  phone upright — not the direction the top of the phone points. Falls back to GPS
  course over ground on devices with no magnetometer.
- **Works offline.** Photos go into IndexedDB on the device and upload themselves
  when the connection comes back — including via Background Sync while the app is
  closed, on browsers that support it.
- **Resumable uploads.** Each photo is a point (`addFeatures`) plus an attachment
  (`addAttachment`). If the connection drops between the two, the retry picks up at
  the attachment instead of creating a duplicate point.
- **Quiet audio + visual feedback.** A shutter click on capture, a soft two-note
  lift when a photo lands on the server, a gentle descending pair when the
  connection drops, and a three-note chime when the queue finally drains. All
  synthesised in about 4 KB of WebAudio — there are no sound files to download.
- **Reinstall button** in the menu: unregisters the service worker, drops every
  cache, and reloads from GitHub Pages. Queued photos and settings survive it.

## Data written

Layer: `…/Exotics_Camera_Points/FeatureServer/0` (Esri GNSS metadata schema,
attachments enabled).

| Captured | Field |
| --- | --- |
| Compass heading of the lens (°) | `esrisnsr_azimuth` |
| Latitude / longitude | `esrignss_latitude`, `esrignss_longitude` |
| Altitude | `esrignss_altitude` |
| Horizontal / vertical accuracy (m) | `esrignss_h_rms`, `esrignss_v_rms` |
| Speed (km/h) and course | `esrignss_speed`, `esrignss_direction` |
| Capture time | `esrignss_fixdatetime` |
| Device label | `esrignss_receiver` |
| Position source | `esrignss_positionsourcetype` = 2 |
| The photo | attachment |

The mapping is editable under **Settings → Field mapping**. Leave a row blank to
auto-detect it from the layer schema, or enter `-` to never write it. **Read layer
schema** shows what the app resolved against the live layer. Point a different
service URL at the app and it re-detects — nothing here is hard-wired.

Geometry is sent as WGS84 (`wkid: 4326`); the service reprojects to Web Mercator.

## Signing in

The service rejects anonymous requests (`499 Token Required`), so each user signs
in with their own ArcGIS account. **No credentials are stored in this repository or
baked into the app** — only the resulting token lives on the device.

1. **OAuth 2.0 (preferred).** Register an application item in ArcGIS Online, add
   the app's Pages URL as a redirect URI (Settings shows the exact string to
   paste), then put the app id into **Settings → OAuth app id**. The app uses the
   authorization-code flow with PKCE and refreshes the token silently, so a field
   user signs in once.
2. **Username & password.** Under Sign in, sends the credentials straight to
   `sharing/rest/generateToken` for a 14-day token. The password is never stored.
3. **Paste a token.** For testing.

If a token expires while photos are queued, nothing is lost — the queue holds and
the app asks for a sign-in.

## Hosting

Push to `main` and the included workflow publishes the repo root to GitHub Pages
(enable **Settings → Pages → Source: GitHub Actions** once). The workflow stamps
the commit sha into `sw.js` and `js/config.js`, which is what makes each deploy
invalidate the old cache and show up in **Menu → About**.

The camera and the compass need a secure context; `https://<user>.github.io/…`
qualifies. For local work use `python3 -m http.server` on `localhost`, which also
counts as secure — but note that `__BUILD__` stays unstamped outside CI.

## Layout

```
index.html      markup for the viewfinder, compass and sheets
app.css         all styling
js/config.js    defaults, field mapping, settings persistence
js/store.js     IndexedDB — the photo queue and key/value store
js/arcgis.js    auth, layer metadata, addFeatures + addAttachment, retry/backoff
js/sound.js     synthesised UI sounds
js/app.js       camera, compass maths, sync loop, UI wiring
sw.js           app-shell cache + background sync
```

`config.js`, `store.js` and `arcgis.js` are loaded by both the page and the
service worker, so they must never touch `window` or `document`.
