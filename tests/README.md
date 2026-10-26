# Tests

Fifteen suites, plain Node scripts — no framework. Each prints `ok`/`FAIL` lines
and exits non-zero on failure. They are the record of every bug found in the
field, so a failure here almost always means a real regression rather than a
flaky check.

```bash
npx http-server . -p 8848 -s --cors -c-1 &     # serve the app
ARCGIS_USER=… ARCGIS_PASSWORD=… node tests/token.mjs
node tests/run.mjs                              # all of them
node tests/run.mjs ui camera                    # or a few
```

`token.mjs` writes `tests/.token` (git-ignored) and stores nothing else — the
password is used once, for the token request. The token is bound to the referer
of the origin the app is served from, so **it must match `APP_URL`**; ArcGIS
rejects it otherwise, which looks confusingly like `Invalid token`.

| Variable | Default |
| --- | --- |
| `APP_URL` | `http://127.0.0.1:8848/` |
| `ARCGIS_TOKEN` | read from `tests/.token` |
| `CHROME_PATH` | `/opt/pw-browsers/chromium-1194/chrome-linux/chrome` |
| `PLAYWRIGHT_MODULE` | `playwright` (set it to an absolute path for a global install) |

## The rule that matters

**A suite may only delete features it created itself.** Both shipped layers hold
real survey data — ELAPP All had 1,569 features when this was written. The suites
snapshot the layer's OBJECTIDs before they start, delete only the difference,
refuse to delete more rows than a run could plausibly have made, and abort rather
than guess if the snapshot query returns anything unexpected.

This is not theoretical. Early in development a `where=1=1` cleanup destroyed two
real photos, with no undo — neither service has sync or archiving enabled. If you
add a suite, copy the guard from `ui.mjs`, and never write a bare `deleteFeatures`.

Write tests point at a scratch layer; `layers.mjs` reads both shipped layers and
writes to neither.

`pp-flow` writes to the live `Photo_Monitoring` service: only under the
station called **Test** (kept for this) or a station the run adds itself. It
snapshots both layers first, deletes only rows that carry this run's own
GlobalIDs and did not exist before, refuses to delete more than a run could
have made, and puts the Test station's fields back as it found them. Do not
delete the Test station; the suite refuses to run without it.

`pp-land` and `pp-coexist` serve the app from `APP_URL` and need nothing else;
`pp-flow` needs the token like the others.

## What each covers

| Suite | Browser | What it protects |
| --- | :-: | --- |
| `layers` | | Field mapping resolves correctly on both layers; Central stays the default; a queued photo keeps its own destination |
| `e2e` | | Upload, attachment, resumable retry, invalid token, backoff curves, the airplane-mode photo that would not clear |
| `resilience` | | A storage failure returning `null`/a string/a number must not become a second crash; problem reports round-trip; a refused report is held with its reason and goes up later; a photo whose bytes are gone is an error, not a silent success; a hung upload times out instead of blocking the queue; a row stranded mid-upload is reclaimed |
| `edit-server` | | Editing a point already on the layer, in place, with no duplicate; a rejected edit is kept; over-long text is trimmed |
| `ui` | ✓ | The main flow: capture, offline queueing, reconnect, live queue updates, layer picker, remove-from-layer |
| `ios` | ✓ | The compass permission dance: asks on first touch, retries a refused call, works with no prompt when already granted |
| `land` | ✓ | Nothing off-screen or overlapping in portrait or landscape, including a short landscape viewport |
| `camera` | ✓ | A frozen preview recovers on its own; a healthy camera is left alone; the shutter refuses a stalled preview |
| `import` | ✓ | EXIF read from real fixtures: hemispheres, below-sea-level altitude, magnetic vs true heading, photos with no location |
| `roundtrip` | ✓ | A photo saved out of the queue can be imported straight back with its position and heading intact |
| `migrate` | ✓ | The v1 → v2 database upgrade moves photo bytes out of queue rows without losing any |
| `coldoffline` | ✓ | Airplane mode plus a cold service worker; a missing file must never be answered with HTML |
| `tag` | ✓ | The session tag follows the layer's schema and never claims to apply where it cannot |
| `edit-ui` | ✓ | The per-row editor, including the offline "edit waiting to go up" state |
| `snake` | ✓ | Mostly that it stays in its lane: camera still live, shutter still works, keys stop reaching it |
| `compass` | | The bearing on a simulated iPhone (WebKit's own angle decomposition, a noisy lagging compass): steady upright, in landscape, aimed at the ground, through turns and gyro-frame resets — with the old maths alongside for comparison |
| `dedupe` | | A lost answer never files a point or a photo twice: the real upload path against a simulated service that drops replies |
| `pp-upload` | | Photo Points' upload engine against a simulated service: chunk resume after a dropped connection, lost replies, an upload the service forgot, a station that must go up before its visit |
| `pp-land` | ✓ | Photo Points on the smallest and largest iPhones, both ways up: all ten slots in view, nothing overlapping |
| `pp-coexist` | ✓ | Exotic Camera and Photo Points on one origin: neither deletes the other's caches or worker; Photo Points opens offline from its own cache |
| `pp-flow` | ✓ | Photo Points end to end against the live `Photo_Monitoring` service — see below |

`fixtures/` holds six small JPEGs built with `piexif` — synthetic, no real data.
`mkicons.py` regenerates the app icons from `icons/icon.svg`.

## Things that will waste your time

- **`waitForFunction` does not await a Promise.** It takes the Promise itself as
  truthy and returns at once, so `waitForFunction(() => Store.all().then(…))`
  waits for nothing. Use `waitForAsync(page, fn)` from `browser.mjs`, which
  polls `page.evaluate` (every 400 ms — rAF-rate polling of the queue can also
  starve the IndexedDB write you are waiting for).
- **The browser may have no route to the internet while node does.** That is what
  `relayArcGIS` in `browser.mjs` is for. It also gives you `setOffline(true)` for
  simulating a lost connection, which is more precise than `context.setOffline`.
- **Service worker caching.** A suite that changes app files may still be served
  the previous version from a warm cache. Each suite uses a fresh context, but if
  you reuse one, bump `REV` in `sw.js` or clear caches first.
- **The app syncs immediately after some actions.** If you are asserting an
  intermediate state such as "edit waiting", put the app offline first, or the
  state will be gone before you look.
