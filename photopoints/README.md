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
the service and copied the 74 older photo-station points (El_Rat_Generic and
Cypress Creek 2020) into 48 stations; they read credentials from `ARC_USER` /
`ARC_PASS` and are kept for the record.

## In the field

1. **Stations** are listed nearest first, each with an arrow that points at it
   (it turns with the phone once the compass is up) and the distance. Tap one
   for directions, its details, and **Start visit**.
2. **The camera** shows, for the current slot, the bearing to face and how far
   off you are — *Turn 12° right ▸*, then *On target* in green within ±5°
   (Settings). Once a station has a visit from this app, the target is that
   visit's own bearing and its photo is laid faintly over the viewfinder
   (**Last visit** cycles faint / strong / off), so repeat photos line up.
   A level (horizon line and tilt) helps match the framing. After a
   directional shot the app moves to the next empty slot.
3. **Done** opens the visit details — observer, monitoring event (both
   remembered), post condition, notes, and whether a post was installed on
   this visit (which updates the station). **Save & upload** queues it.
4. **Uploads** happen in the background, one photo at a time, in 1 MB chunks.
   With no signal everything waits on the phone; nothing is lost if the app is
   closed. The ⇪ chip and **Menu → Upload queue** show what is still owed.

**Get ready for offline** (menu) refreshes the stations and brings the last
visit's photos for the nearest 25 stations onto the phone, for lining up
shots with no signal.

New stations can be added where you stand (**+ New station here**); the ID is
suggested from the nearest station's prefix. Stations can be edited — post
installed, type, tag, install date, status, notes. Both go up with the next
upload, before any visit to that station.

## Bearings

The compass is `../js/compass.js`, shared with Exotic Camera. The phone's
gyro gives a smooth, immediate bearing; iOS's compass reading (magnetic,
noisy, laggy) is used only to keep it pointed at north, and only from poses
where it can be cross-checked. The old approach — the compass reading swapped
into the orientation angles — jumped about whenever the phone was held
upright; `tests/compass.mjs` measures the difference on a simulated iPhone
(86° → 1° at the 95th percentile). Aimed at the ground, the bearing is the
direction of the top of the photo, which is what a groundcover shot faces.

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
sw.js             app-shell cache + background drain
service/          the scripts that built the feature service and copied the old stations
```

Bump `REV` in `sw.js` whenever the file list changes.

## Tests

`tests/pp-upload.mjs` (node), `tests/pp-land.mjs` and `tests/pp-coexist.mjs`
(browser, no service), and `tests/pp-flow.mjs` (browser, live service). The
last writes only under the station called **Test**, or a station it adds, and
removes only rows carrying its own GlobalIDs; the Test station's fields are
put back as found. See `tests/README.md`.
