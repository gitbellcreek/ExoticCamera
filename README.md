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
- **The compass starts itself.** iOS only hands out orientation data after a
  permission prompt raised from a user gesture, so the app asks on the *first touch
  anywhere* — no one has to know to tap the dial. If the first touch is the shutter,
  the capture waits for the answer and the first sample, so photo one still carries a
  heading. A photo saved without one says so.
- **Portrait and landscape.** Turned sideways the shutter moves to a right-hand rail
  under your thumb, and the status chips go inline, so a short landscape viewport is
  not wasted.
- **Keeps a copy on the phone.** Each shot is also handed to the device — the share
  sheet on iOS (tap *Save Image* for Photos; a web app cannot write to the camera roll
  by itself), a plain download elsewhere. Local copies stay in the queue for 48 hours
  after upload so you can still save them from the queue view.
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
- **Add to Home Screen** in the menu, with the steps for whichever browser is
  running. Installed, it loses the browser address bar — the only way to go truly
  full screen in Safari. Note that iOS gives the installed app its own storage, so
  drain the queue in Safari before switching.

## Which layer photos go to

Two targets ship with the app, switchable from **Menu → Layer** (and from
Settings, where a custom service URL can be entered instead):

| Name | Service |
| --- | --- |
| **Central** (default) | `…/Iphone_Images/FeatureServer/0` |
| **Exotics** | `…/Exotics_Camera_Points/FeatureServer/0` |

They have different schemas, so the field mapping is resolved per layer from the
live definition rather than hard-coded. On Central the heading lands in
`direction`, the time in `datetaken`, and the attachment name in `filename`; on
Exotics the full Esri GNSS set is used. Anything a layer has no home for is
simply not sent.

Each photo records its destination the moment it is taken, so switching layers
never redirects shots that are already queued — the queue view marks any photo
bound for somewhere other than the current layer.

## Data written

On the Exotics layer (Esri GNSS metadata schema, attachments enabled):

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

## Problem reports

**Menu → Report a problem** writes a row to
`…/ExoticCameraBugs/FeatureServer/0` with the build, the target layer, the queue
state, sensor and permission status, device and viewport, the last GPS fix, and
the last forty things the app did. Crashes, failed uploads and startup errors
report themselves the same way; **Settings → Report problems automatically**
turns that off, while the menu item always sends. No photos are ever included.

The table's fields were created for this purpose: `reported`, `kind`, `summary`,
`note`, `details` (JSON breadcrumbs + stack), `appbuild`, `layername`,
`username`, `device`, `sensors`, `queued`, `queueerrors`, `online`, `applat`,
`applon`. A report that cannot be sent is dropped silently — a failing bug
report must never become a second bug.

## Working on it

There are no unit tests; the checks that matter run against a browser and the live
service, driven by Playwright from `node`. If you write your own, note the rule the
existing ones follow: **a test may only delete features it created itself.** They
snapshot the layer's OBJECTIDs at start, delete only the difference, refuse to
delete more rows than the run could plausibly have made, and abort outright if
the snapshot query returns anything unexpected rather than assuming an empty
layer. A `where=1=1` delete here destroys real field data — with no undo, since
neither service has sync or archiving enabled.

Write tests point at Exotics; Central holds real photos and is only ever read.

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

**One manual step, once:** open **Settings → Pages** and set *Build and
deployment → Source* to **GitHub Actions**. The workflow asks for this
automatically (`enablement: true`), but GitHub does not let a workflow token
create the Pages site on a user-owned repo — it fails with *"Create Pages site
failed: Resource not accessible by integration"* until the switch is flipped by
hand. After that, re-run the latest **Deploy to GitHub Pages** run (or push
anything) and it publishes.

The workflow then publishes the repo root on every push to the default
branch. It stamps
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
js/report.js    problem reports → the ExoticCameraBugs table
js/sound.js     synthesised UI sounds
js/app.js       camera, compass maths, sync loop, UI wiring
sw.js           app-shell cache + background sync
```

`config.js`, `store.js`, `arcgis.js` and `report.js` are loaded by both the page
and the service worker, so they must never touch `window` or `document`.

The service worker serves the shell **network-first with a 2.5 s timeout**,
falling back to cache. That keeps field users current without depending on the
build stamp: GitHub Pages can be configured to publish the branch directly, in
which case the workflow that rewrites `__BUILD__` never runs and every deploy
would otherwise share one cache key. About shows *branch deploy (unstamped)*
when that is what happened.
