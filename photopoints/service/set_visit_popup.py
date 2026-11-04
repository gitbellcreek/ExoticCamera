"""
Give the Station Visits popup in the "Photo Monitoring - Field Maps" web map a
table of the visit's photos by direction (visit_popup.arcade, an Arcade
element), between the visit's fields and its photos.

Why a table of links rather than labelled photos: the Photo_Monitoring layer
is private, and a popup's media element loads its images with no token, so
they come back HTTP 400 (checked in the ArcGIS Maps SDK that Map Viewer runs
on). Only the attachments element loads them, and its keyword filter matches
substrings ("W" finds every LOW_ photo, "S" finds MISC), so it cannot sort them
by direction either. The table shows each slot's bearing and links to that
photo in the Photo Points photo browser, which labels it and maps it; the
attachments element below still shows every photo, in the order taken.

The web map is changed in place: only the Station Visits popup's elements. A
copy of the web map as it was is written to ./out first, and the script reads
the result back and checks that nothing else changed. Running it again
replaces the table with the current visit_popup.arcade.

Credentials come from the ARC_USER / ARC_PASS environment variables.
    python set_visit_popup.py --dry-run     # write the new web map JSON to ./out, change nothing
    python set_visit_popup.py               # update the web map
"""
import argparse
import copy
import json
import os
import time

import requests

WEBMAP_ID = "e785cab8a5f745e8acd63a95d8966b90"
TABLE_ID = "station_visits"                  # the Station Visits table's id in that web map
TITLE = "Photos by direction"
SHARING = "https://www.arcgis.com/sharing/rest"
HEADERS = {"Referer": "https://www.arcgis.com"}
HERE = os.path.dirname(os.path.abspath(__file__))


def token():
    r = requests.post(f"{SHARING}/generateToken", headers=HEADERS, timeout=60, data={
        "username": os.environ["ARC_USER"], "password": os.environ["ARC_PASS"],
        "referer": "https://www.arcgis.com", "expiration": 30, "f": "json"}).json()
    if "token" not in r:
        raise SystemExit(f"generateToken failed: {r.get('error', {}).get('message')}")
    return r["token"]


def call(url, tok, **params):
    params.update(f="json", token=tok)
    j = requests.post(url, data=params, headers=HEADERS, timeout=120).json()
    if isinstance(j, dict) and "error" in j:
        raise RuntimeError(json.dumps(j["error"]))
    return j


def with_table(data, arcade):
    """The web map with the visits popup as fields, the direction table, then the photos."""
    new = copy.deepcopy(data)
    table = next(t for t in new.get("tables", []) if t.get("id") == TABLE_ID)
    els = table["popupInfo"].get("popupElements", [])
    keep = [e for e in els if not (e.get("type") == "expression" and (e.get("expressionInfo") or {}).get("title") == TITLE)]
    expr = {"type": "expression", "expressionInfo": {"title": TITLE, "expression": arcade, "returnType": "dictionary"}}
    at = next((n for n, e in enumerate(keep) if e.get("type") == "attachments"), len(keep))
    if at < len(keep) and not keep[at].get("title"):
        keep[at] = dict(keep[at], title="All photos")
    table["popupInfo"]["popupElements"] = keep[:at] + [expr] + keep[at:]
    return new


def only_popup_changed(before, after):
    a, b = copy.deepcopy(before), copy.deepcopy(after)
    for d in (a, b):
        next(t for t in d.get("tables", []) if t.get("id") == TABLE_ID)["popupInfo"].pop("popupElements", None)
    return a == b


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dry-run", action="store_true", help="write the new web map JSON to ./out and change nothing")
    args = ap.parse_args()
    arcade = open(os.path.join(HERE, "visit_popup.arcade"), encoding="utf-8").read()
    tok = token()
    info = call(f"{SHARING}/content/items/{WEBMAP_ID}", tok)
    data = call(f"{SHARING}/content/items/{WEBMAP_ID}/data", tok)
    new = with_table(data, arcade)
    os.makedirs("out", exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    with open(os.path.join("out", f"webmap_{WEBMAP_ID}_{stamp}_before.json"), "w") as fh:
        json.dump({"info": info, "data": data}, fh, indent=1)
    if args.dry_run:
        path = os.path.join("out", f"webmap_{WEBMAP_ID}_{stamp}_new.json")
        with open(path, "w") as fh:
            json.dump(new, fh, indent=1)
        els = next(t for t in new["tables"] if t["id"] == TABLE_ID)["popupInfo"]["popupElements"]
        print(f"Wrote {path}; the visits popup would be:", [e.get("title") or (e.get("expressionInfo") or {}).get("title") or e["type"] for e in els])
        return
    folder = info.get("ownerFolder")
    url = f"{SHARING}/content/users/{info['owner']}" + (f"/{folder}" if folder else "") + f"/items/{WEBMAP_ID}/update"
    call(url, tok, text=json.dumps(new, separators=(",", ":")))
    after = call(f"{SHARING}/content/items/{WEBMAP_ID}/data", tok)
    if not only_popup_changed(data, after) or after != new:
        raise SystemExit("The web map does not read back as intended — compare it with the copy in ./out")
    print(f"Updated '{info['title']}': the Station Visits popup now has '{TITLE}' between its fields and its photos.")


if __name__ == "__main__":
    main()
