# Photo Points

Repeat photo monitoring for permanent photo stations, built on Exotic Camera's
foundations. Find the station, face the right way, take the set of photos, and
the visit — with every photo at full resolution — goes up to the
`Photo_Monitoring` feature service when there is signal.

Live at **https://gitbellcreek.github.io/ExoticCamera/photopoints/** (once this
folder is on the default branch). Add it to the Home Screen: the app runs full
screen, and Safari never clears an installed app's storage, which is where the
photos wait for signal.

## The data

One hosted feature service, `Photo_Monitoring`:

| Layer | What | Key fields |
| --- | --- | --- |
| `0` Photo Stations (points) | one per permanent post | `StationID`, `SiteName`, `MgmtUnit`, `PostInstalled`, `PostType`, `InstallDate`, `StationStatus` |
| `1` Station Visits (table) | one per visit, 1:M on `GlobalID → StationGUID` | `VisitDate`, `Observer`, `MonitoringEvent`, `PostCondition`, `Notes` |

Photos are attachments on the visit, keyworded by slot — the same keywords the
Field Maps form uses, so photos from either app land in the same place:

| Slot | Keyword | Target bearing |
| --- | --- | --- |
| Eye level N / E / S / W | `N` `E` `S` `W` | 0 / 90 / 180 / 270 |
| Groundcover N / E / S / W | `LOW_N` `LOW_E` `LOW_S` `LOW_W` | 0 / 90 / 180 / 270 |
| Locator (the post) | `LOCATOR` | — |
| Anything else | `MISC` | — |

Each slot takes any number of photos. `service/` holds the scripts that built
the service, copied the 74 older photo-station points (El_Rat_Generic and
Cypress Creek 2020) into 48 stations, and built the ArcGIS Experience (below);
they read credentials from `ARC_USER` / `ARC_PASS` and are kept for the record.

## In the field

1. **Stations** are listed nearest first, each with an arrow that points at it
   (it turns with the phone once the compass is up) and the distance. Tap one
   for directions, its details, and **Start visit**.
2. **The camera** shows, for the current slot, the bearing to face and how far
   off you are — *Turn 12° right ▸*, then *On target* in green within ±5°
   (Settings). Once a station has a visit from this app, the target is that
   visit's own bearing and its photo is laid faintly over the viewfinder
   (**Last visit** cycles faint / strong / off), so repeat photos line up.
   A level (horizon line and tilt) helps match the framing. After each
   shot the app moves to the next empty slot, both photos facing one way
   before turning — North, North groundcover, East, East groundcover, South,
   South groundcover, West, West groundcover, then the post — so it is one
   trip round the post, not two.
3. **Done** opens the visit details — observer, monitoring event (both
   remembered), post condition, notes, and whether a post was installed on
   this visit (which updates the station). **Save & upload** queues it.
4. **Uploads** happen in the background, one photo at a time, in 1 MB chunks.
   With no signal everything waits on the phone; nothing is lost if the app is
   closed. The ⇪ chip and **Menu → Upload queue** show what is still owed.

**Get ready for offline** (menu) refreshes the stations and brings the last
visit's photos for the nearest 25 stations onto the phone, for lining up
shots with no signal.

**Going back into a visit.** A finished visit — still waiting, or long since
uploaded — can be reopened to add photos (another angle, something by the
post) or to change its details: **Edit** on it in the station's sheet, which
lists its latest visits, or **✎** in the upload queue. The camera says
*· editing*. **Done → Save & upload changes** sends only what changed: the
new photos go to the same visit, and its details go only if they were edited.
**Discard changes** — or backing out having changed nothing — leaves the
visit as it was. A visit that is on the layer but not on this phone (taken in
Field Maps, on another phone, or cleared from this one) can be added to the
same way; its photos already there count towards the slots. While a visit is
open, nothing of it uploads until Done, and a station has one open visit at
a time.

New stations can be added where you stand (**+ New station here**); the ID is
suggested from the nearest station's prefix. Stations can be edited — post
installed, type, tag, install date, status, notes. Both go up with the next
upload, before any visit to that station.

## Looking back: the photo browser

`browse.html` starts on a **map of the stations** (the *Photo Monitoring -
Field Maps* web map). Tap a station, or pick one from the list (☰), and its
photos are dates × directions. **Flip the date and the direction stays put;
turn round the post and the date stays put** — so the same view can be
compared visit after visit. Back (‹, or the phone's) returns to the map.

- **Turn** with the ‹ › on the photo, the compass rose (N E S W, with Eye
  above Ground), ← → or N E S W on a keyboard, or by swiping the photo
  sideways. **Post** and **Misc** sit beside the rose (P and M); there the
  ‹ › and the swipe step through that slot's photos instead of turning.
- **Several photos in one slot** show ‹ *1 of 3* › at the photo's corner
  ([ ] on a keyboard).
- **Change date** with the date strip under the photo, ↑ ↓, or by swiping up
  and down. A date with no photo facing the current way is dimmed, and the
  photo says so.
- **On the photo**: which way it faces (*North*, *East groundcover*, *Post*…)
  at the top, the date and bearing at the bottom; each steps aside while the
  pointer is on it, or while a finger is down.
- **Full size** (the ⤢ at the photo's top right, or F) opens the original in
  the page: scroll or pinch to zoom, drag to look round, double-click or
  double-tap to zoom in and back out, + − ⤢ in the bar. Back closes it.
- **Compare**: *Side by side* (one above the other on a phone) or *Swipe*,
  a divider dragged across two dates in the same direction; both turn
  together. *Compare with* picks the second date.
- It opens on the latest visit that has a North photo, says where it is in the
  address (so a view can be bookmarked or shared), shows the visit's details,
  and loads the neighbouring photos ahead.

Open it from a station's sheet (**Photos**), or on its own at
`photopoints/browse.html`. It reads only, and on a phone where Photo Points is
signed in it is signed in too. The map needs a connection; without one, or if
the map library cannot load, the station list stands in for it.

**The ArcGIS Experience** *Photo Monitoring - Station Photos*
(`ce3fd77cef4e4d27b2e04f6d68c377ca`, private, built by
`service/build_experience.py`) is this browser and nothing else: one Embed
widget filling the page with `browse.html?embed=1`. An embedded page keeps its
own storage, so the first time it asks for an ArcGIS sign-in, and nothing —
not even the map — shows until then. `--update` keeps the item's title. The
script's `--layout browse` builds the earlier version (the experience's own
map, with the browser beside it handed the tapped station), and
`--layout edit` the add-visits one.

## Bearings

The compass is `../js/compass.js`, shared with Exotic Camera. The phone's
gyro gives a smooth, immediate bearing; iOS's compass reading (magnetic,
noisy, laggy) is used only to keep it pointed at north, and only from poses
where it can be cross-checked. The old approach — the compass reading swapped
into the orientation angles — jumped about whenever the phone was held
upright; `tests/compass.mjs` measures the difference on a simulated iPhone
(86° → 1° at the 95th percentile). Aimed at the ground, the bearing is the
direction of the top of the photo, which is what a groundcover shot faces.

**Checking north.** iOS restarts its motion sensors, from a new arbitrary
starting point, whenever the page comes back after the phone was locked or
another app was in front. The compass then learns north again from scratch: no
heading for about a second, then a provisional one, and the camera says
*Compass not checked* until it is confirmed. To confirm it, hold the phone in
portrait, tilted as if you were reading it, for a second — the phone's top and
back then point the same way, so iOS's compass reading can be checked against
the gyro. Upright or in landscape it cannot be. A photo taken before the check
keeps its bearing (usually right) and the visit warns once; *Compass checked ✓*
says when it is done. Until 4 November 2026 the restart went unnoticed after a
lock: north stayed wherever the new starting point put it, and the compass
still said ✓ — two visits on 3 November came out about 180° out and were
corrected on the layer (see `HANDOFF.md`).

Bearings are **true north** by default: the phone's magnetic bearing plus the
declination, −6.3° for Hillsborough County in 2026 (NOAA WMM-2025; it changes
by about −0.08° a year). Settings switches to magnetic. Every photo carries its
bearing three ways: in its EXIF (`GPSImgDirection`, ref `T`/`M`), in its name
(`LKD-PS01_N_20261026-144012_003T.jpg`), and in the visit's queue record.

## Photos

Saved at the camera's full resolution as the browser delivers it (a web app
cannot use the native camera's still pipeline; on recent iPhones the stream
is up to 4032×3024), JPEG quality 0.92, with position, bearing and time
written into the EXIF. They stay on the phone for 72 hours after they are
safely up; **Upload queue → ⤓** hands a visit's photos to the share sheet
(*Save N Images* on iOS).

## How it uploads, and why

- **Never twice.** The station, the visit and every photo carry a GlobalID
  minted on the phone and go through `applyEdits` with `useGlobalIds`. If the
  answer to an edit is lost on a bad connection, the edit may well have
  landed: the retry is refused as a duplicate, which is the cue to look the
  record up instead of filing it again. (`addFeatures` silently replaces a
  client GlobalID with its own — only `applyEdits` keeps it.)
- **In chunks, one photo at a time.** `uploads/register → uploadPart →
  commit`, then the attachment is added from the upload. A dropped connection
  costs one chunk, and the next attempt carries on from it — even after the
  app was closed. Field Maps sending seven full-size photos at once on two
  bars is what made all seven fail together.
- **Every request has a deadline** (30 s, 60 s for edits, 90 s per chunk), and
  a timeout is not the same as no signal: it moves on to the next photo.
- **The service forgot a half-sent upload** (it says only "Unable to upload
  item.") — the photo starts again from its first chunk.

`tests/pp-upload.mjs` runs this against a simulated service that loses
replies, drops the connection mid-photo and forgets uploads.

## Living next to Exotic Camera

Both apps are on `gitbellcreek.github.io`, so they share CacheStorage,
service-worker registrations and IndexedDB. Photo Points has its own worker
(scope `photopoints/`), caches (`photopoints-…`) and database
(`photopoints`); neither app deletes the other's caches or unregisters the
other's worker, and Exotic Camera's worker leaves `photopoints/` alone.
`../js/compass.js`, `exif.js`, `sound.js` and `report.js` are shared; problem
reports go to the same `ExoticCameraBugs` table, labelled *Photo Points*.

## Layout

```
index.html        stations, the visit camera, and the sheets
app.css           all styling
js/config.js      service, slots, settings (page + worker)
js/store.js       IndexedDB: visits, photo rows, photo bytes, station edits, ghosts (page + worker)
js/arc.js         sign-in, reading stations, the upload engine (page + worker)
js/app.js         compass and camera, the visit, the queue, all UI wiring
browse.html       the photo browser: the station map, then dates × directions (+ browse.css, js/browse.js)
sw.js             app-shell cache + background drain
service/          the scripts that built the feature service, copied the old stations, and built the experience
```

Bump `REV` in `sw.js` whenever the file list changes.

## Tests

`tests/pp-upload.mjs` (node), `tests/pp-land.mjs`, `tests/pp-coexist.mjs`,
`tests/pp-visit.mjs` and `tests/pp-browse.mjs` (browser, no service), and
`tests/pp-flow.mjs` (browser, live service). The last writes only under the station called **Test**, or a
station it adds, and removes only rows carrying its own GlobalIDs; the Test
station's fields are put back as found. See `tests/README.md`.
