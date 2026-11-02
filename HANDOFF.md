# Handoff

Where the project stands, what is deliberate, and what is still open. `README.md`
describes what the app *does*; this is the note for whoever picks it up next.

Last worked on: 26 October 2026 (Photo Points added in `photopoints/`; compass,
duplicate-upload and service-worker fixes here). Default branch
`claude/mobile-arcgis-photo-app-6sbfip`.

## State

Working and in field use. Every feature below has been exercised on a real
iPhone (iOS 18.7, Safari 26.5, installed to the Home Screen) as well as in the
test suites.

Live at **https://gitbellcreek.github.io/ExoticCamera/**.

## How it deploys

GitHub Pages serves **the branch directly**, not the artifact from
`.github/workflows/pages.yml`. Pushing to the default branch is the deploy; it
goes live in about a minute.

Two consequences worth knowing:

- The workflow's `sed` that stamps `__BUILD__` with the commit sha never runs, so
  **Menu → About** shows *"branch deploy (unstamped)"*. That is honest rather than
  broken. Switching Pages to *Source: GitHub Actions* would make the build id real.
- With no build id there is nothing to key the service worker cache on, so
  **`REV` in `sw.js` is the cache key. Bump it whenever the file list changes.**
  Forgetting leaves users on a half-populated cache, which is how you get a blank
  screen offline.

The worker serves the shell network-first with a 2.5 s timeout, so a normal launch
picks up new code without anyone doing anything. **Menu → Reinstall app** forces it:
it unregisters the worker, drops every cache and reloads. Queued photos and
settings survive that.

## Decisions you would otherwise have to rediscover

Each of these came from something breaking in the field.

**The compass never uses a lone Euler angle** (`js/compass.js`). The old code
put iOS's compass reading in place of alpha and kept beta and gamma. Held
upright — the photo pose — those angles are at gimbal lock: gamma swings
through tens of degrees with a degree of tilt, and the bearing jumped with it
(reported from the field). WebKit's source settles what the inputs are:
alpha/beta/gamma are one exact decomposition of CoreMotion's attitude in an
arbitrary-yaw frame (so alpha is relative on iOS), and `webkitCompassHeading`
is Core Location's `magneticHeading`. So the attitude is only ever rebuilt as a
whole rotation matrix, and the compass reading only learns the offset between
the gyro frame and magnetic north — slowly, only while the phone is still, and
only from poses where the top and the back of the phone agree, so Apple's
undocumented meaning of "heading" for an upright phone never matters. A jump
no hand could make (iOS restarting its gyro frame) starts it afresh. Pointing
at the ground, the bearing blends to the top-of-photo direction from 50° down.
`tests/compass.mjs` replays WebKit's angle decomposition against a simulated
phone; the old maths is in there too, for comparison.

**A point and a photo can never be filed twice.** When the answer to an upload
is lost, the upload may well have landed. Points carry a GlobalID minted on the
phone and go through `applyEdits` with `useGlobalIds` — `addFeatures` silently
replaces a client GlobalID with its own, which was checked against the live
service — so a retry is refused as a duplicate and the point is looked up
instead. A photo whose answer was lost is looked for by its (unique) name
before it is sent again. `tests/dedupe.mjs`.

**The origin is shared.** Every GitHub Pages site of the account is
`gitbellcreek.github.io`, so CacheStorage, worker registrations and IndexedDB
are shared with Photo Points and anything else published. The worker's
activate used to delete every cache that was not its own, and Reinstall
unregistered every worker and emptied every cache. Both now touch only
`exoticcam-…` and this app's own registration; the worker also leaves the
`photopoints/` folder to its own worker. `tests/pp-coexist.mjs` fails on the
old code.

**`index.html` has a doctype.** It had none, so the app ran in quirks mode.
Screenshots before and after are pixel-identical; it is there so a future CSS
change does not meet quirks-mode surprises.

**Photo bytes live in their own IndexedDB store (`photos`), never on the queue
row.** They used to sit on the row, so every state change rewrote the whole JPEG —
and on iOS that write *fails* for a photo that has survived an app restart. The
symptom was one photo stuck forever while newer ones uploaded past it. Keep queue
metadata small enough that a write cannot fail. `Store.photo(id)` fetches bytes
only when needed.

**Only one context drains the queue.** The page and the service worker both used
to, and two drainers lose writes — one finishes an upload while the other still
holds a stale copy of the row, and the stale copy wins. The worker now hands the
job to an open window (`sw.js` → `drain`), with a lock in the key/value store as a
backstop. If you add another drain trigger, respect that.

**The compass asks for permission on the first touch anywhere.** iOS only grants
orientation access from a user gesture, and `pointerdown` is *not* accepted for
it — asking there burns the tap for nothing. Only `touchend`/`click` arm it, a
refused call is retried on the next tap, and the app listens passively from boot
so an already-granted origin needs no prompt at all. The first shutter press waits
for the answer and the first sample rather than recording a null heading.

**The camera watchdog only trusts an ended track or a stopped frame clock.**
`track.muted` fires constantly on iOS and means very little; treating it as failure
restarted a perfectly good camera and caused a restart loop. A fresh stream also
gets a grace period before it is judged.

**EXIF is written back into every JPEG.** Canvas re-encoding strips it, which left
both the phone copies *and the ArcGIS attachments* with no position. `js/exif.js`
writes position, altitude, `GPSImgDirection` (flagged true or magnetic),
`GPSHPositioningError` and capture time before the photo is stored, so the same
bytes go to the attachment and the phone.

**The service worker answers an uncached sub-resource with 504, never with
`index.html`.** Handing the parser HTML where a script was expected kills the app
with a syntax error — a black viewfinder with no message. Only navigations fall
back to the shell.

**Every request has a deadline, and a deadline is not the same as no signal.**
`fetch` will sit on a half-open connection forever, and the queue drains one
photo at a time — so a single hung attachment upload held up every photo behind
it with nothing written back at all. The field symptom was three photos owed,
`queueerrors: 0`, and rows reading *"waiting"* for hours. JSON calls get 30 s and
an attachment 120 s (`Arc.timeouts`, which the tests shrink). A timeout is
retryable, so it does not count against the photo, but unlike *network
unreachable* it does **not** stop the drain: the connection answered, just
slowly, and the photos behind it deserve their own attempt and their own error.

**A row left in `uploading` belongs to nobody.** iOS suspends the app during a
slow upload and the drain never returns, so the row keeps the state it was given
and no attempt, error or timer is ever recorded — it just sits there looking
busy. `Arc.reclaimStranded()` runs at startup and hands those back.

**An upload that files the point and loses the photo must never be called a
success.** The point goes up first, so a failed attachment leaves a point on the
map with nothing behind it. Two things used to hide that: missing photo bytes
were treated as a legitimate "point-only record" and the row was marked sent
with a success chime, and a `fetch` that rejected while streaming a stored Blob
was always blamed on the network — which does not raise the attempt count and
caps the retry at a minute, so the row read *"waiting"* forever with no error
text. On iOS a Blob held in IndexedDB can go stale after the app is killed and
fail its request in exactly that way. Now the bytes are checked, an unreadable
photo says so, and the queue counts network retries too.

**A problem report that cannot be sent is held, not binned.** It also quotes the
error instead of guessing "offline or signed out" — that guess sent us looking
at the token when the table itself was refusing the row.

**Anything can end up in a `catch`.** IndexedDB rejects with `null` in some
failure paths; the first property access then throws a second, meaningless error.
`Arc.asError()` normalises before anything touches a property. Use it.

**Field mapping is resolved per layer from the live schema**, never hard-coded.
The two shipped layers name the same things differently. An explicit override that
the layer does not have falls back to auto-detection rather than silently dropping
the value.

## Known limitations

- **No web app can write to the iOS camera roll.** The share sheet is the only
  route into Photos, which is why *Save all* batches the day's photos into one
  sheet instead of interrupting every shot. Not fixable without a native wrapper.
- **HEIC has not been tested on a real device.** The EXIF reader locates the block
  the same way for JPEG and HEIC, and Safari usually transcodes to JPEG on upload,
  but if someone reports imports being skipped, start there.
- **Editing only works while the photo is still in the queue.** Once *Clear sent*
  removes the row there is no OBJECTID to update, and it becomes an ArcGIS job.
- **Local copies are kept 48 hours** (`keepHours`), then the bytes are pruned and
  only the thumbnail and metadata remain.
- **Background Sync is Chromium-only.** On iOS the queue drains when the app is
  opened, which is why the reconnect path matters so much.

## Security — decisions for you, not for me

Covered in more detail in the session this came from; the short version:

1. **Register an OAuth app id** (Settings shows the redirect URI to paste) and
   drop the username/password path. As it stands a password typed into the app
   passes through JavaScript served from Pages, so anyone who can push to this
   repository could harvest credentials from every field user. OAuth removes that
   entirely — the password is only ever typed on arcgis.com.
2. **Repo write access is production access.** Pages serves the default branch to
   field phones with no review step. Restrict who can push; consider branch
   protection.
3. **Tokens last 14 days** (`expiration: 20160` in `js/arcgis.js`) and sit in
   IndexedDB. Shorten it if a lost phone is a concern.
4. **The bug table holds staff locations.** Reports include username, device and
   the reporter's coordinates. Intended, but worth knowing; it is switchable off
   per user in Settings.

No credentials are in this repository, and the app ships none.

## Where to look

```
index.html      markup for the viewfinder, compass, tag bubble and sheets
app.css         all styling
js/config.js    layer presets, field mapping, settings
js/store.js     IndexedDB: queue metadata, photo bytes, key/value, locks
js/arcgis.js    auth, layer schema, add/update/delete, retry and backoff
js/exif.js      reads and writes the EXIF block
js/report.js    problem reports → the ExoticCameraBugs table
js/app.js       camera, compass, sync loop, tag, editor, all UI wiring
js/snake.js     the Snake behind About
js/sound.js     synthesised UI sounds
sw.js           app-shell cache and background drain
tests/          fifteen suites — see tests/README.md
```

`config.js`, `store.js`, `arcgis.js` and `report.js` are loaded by both the page
and the service worker, so they must never touch `window` or `document`.

## Field support

Problems report themselves. To read them:

```
…/ExoticCameraBugs/FeatureServer/0/query?where=1%3D1&outFields=*&orderByFields=OBJECTID DESC
```

`details` holds the last forty things the app did before the report, plus any
stack. `sensors` records compass, GPS age, camera state and whether the app was
installed. That breadcrumb trail is what identified the stuck-upload bug; ask for
a report from **Menu → Report a problem** at the moment something looks wrong
rather than afterwards.

## Photo Points

`photopoints/` is a second app on the same Pages site, for repeat photo
monitoring against the `Photo_Monitoring` service (stations + a visits table,
photos as keyworded attachments). Its README covers what it does and why its
uploads are chunked and GlobalID-guarded; its four suites are in
`tests/README.md`. It shares `js/compass.js`, `js/exif.js`, `js/sound.js` and
`js/report.js` — a change to any of those is a change to both apps.

## If you pick this up

Nothing is half-finished — the tree is clean and every suite passes. Reasonable
next steps, roughly in order of value:

1. Register the OAuth app id and remove the password sign-in path.
2. Decide whether Pages should serve the Actions artifact instead of the branch,
   which would make build ids real and let you tell exactly what a phone is running.
3. Watch the bug table for a week of real use; it is the cheapest source of truth.
4. If imports ever get skipped on a modern iPhone, test HEIC on a real device.
