"""
Copy legacy photo stations into Photo_Monitoring/Photo_Stations (layer 0).
Source layers are only read, never edited.

  El_Rat_Generic/0               -- rows matching the web map's "Additional Photo Stations" filter
  Cypress_Creek_Photostations_2020/0

Older points were often dropped one per photo, so points within DUP_METERS of each other
are merged into one station (placed at the oldest point).

Every copied station gets PostInstalled = 'No'. StationID = <MU SITE_CODE>-PS<nn>,
numbered by original creation date within each site. The original label / notes /
source OBJECTID go into Notes so nothing is lost.

    python migrate_legacy_stations.py            # preview to out/legacy_stations_preview.csv
    python migrate_legacy_stations.py --apply    # add the features
"""
import argparse
import csv
import json
import math
import os
import re
from collections import defaultdict
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from build_photo_monitoring import get, post

SVC = "https://services.arcgis.com/apTfC6SUmnNfnxuF/arcgis/rest/services/"
TARGET = SVC + "Photo_Monitoring/FeatureServer/0"
SITES = SVC + "CELM_AllSites_20241112/FeatureServer/0"
MUS = SVC + "CELM_MU_202405/FeatureServer/0"
GENERIC = SVC + "El_Rat_Generic/FeatureServer/0"
CYPRESS = SVC + "Cypress_Creek_Photostations_2020/FeatureServer/0"
GENERIC_WHERE = ("Feature LIKE 'photo station%' OR Feature LIKE 'ps%' OR Feature LIKE 'ENC Photo station%' "
                 "OR Feature LIKE '%Photo Monitoring%' OR Feature LIKE 'BCBA PHOTO MONITOR%'")
NY = ZoneInfo("America/New_York")
DUP_METERS = 8  # points closer than this (ground metres) are the same station (phone GPS error)


def local_date(ms):
    return datetime.fromtimestamp(ms / 1000, timezone.utc).astimezone(NY).strftime("%Y-%m-%d")


def ground_m(a, b):
    """Web Mercator distance scaled to ground metres at a's latitude."""
    lat = 2 * math.atan(math.exp(a["geom"]["y"] / 6378137)) - math.pi / 2
    return math.dist((a["geom"]["x"], a["geom"]["y"]), (b["geom"]["x"], b["geom"]["y"])) * math.cos(lat)


def cluster(rows):
    groups = []
    for r in sorted(rows, key=lambda x: x["created"]):
        for g in groups:
            if any(ground_m(r, o) < DUP_METERS for o in g):
                g.append(r)
                break
        else:
            groups.append([r])
    stations = []
    for g in groups:
        first = g[0]
        if len(g) == 1:
            notes = first["notes"]
        else:
            srcs = defaultdict(list)
            for x in g:
                layer, oid = x["source"].split(":")
                srcs[layer].append(oid)
            labels = sorted({x["label"] for x in g if x["label"]})
            notes = (f"{'; '.join(labels)}. Merged from {len(g)} legacy points "
                     + "; ".join(f"{k} {', '.join(v)}" for k, v in srcs.items())
                     + f" ({local_date(g[0]['created'])} to {local_date(g[-1]['created'])}).")
        stations.append(dict(first, notes=notes, merged=len(g),
                             label=" | ".join(sorted({x["label"] for x in g})),
                             source=" ".join(x["source"] for x in g)))
    return stations


def at_point(url, geom, fields):
    r = post(url + "/query", geometry=json.dumps(dict(geom, spatialReference={"wkid": 102100})),
             geometryType="esriGeometryPoint", spatialRel="esriSpatialRelIntersects",
             inSR=102100, outFields=fields, returnGeometry="false")
    return r["features"][0]["attributes"] if r["features"] else {}


def legacy_rows():
    rows = []
    g = post(GENERIC + "/query", where=GENERIC_WHERE, outFields="OBJECTID,Feature,Notes,CreationDate",
             returnGeometry="true", outSR=102100, orderByFields="OBJECTID")
    for f in g["features"]:
        a = f["attributes"]
        note = "; ".join(x.strip() for x in (a["Feature"], a["Notes"]) if x and x.strip())
        rows.append({"geom": f["geometry"], "created": a["CreationDate"], "label": (a["Feature"] or "").strip(),
                     "notes": f"{note}. Copied from El_Rat_Generic/0 OBJECTID {a['OBJECTID']} "
                              f"(created {local_date(a['CreationDate'])}).",
                     "source": f"El_Rat_Generic/0:{a['OBJECTID']}"})
    c = post(CYPRESS + "/query", where="1=1", outFields="FID,Station,Notes,Date",
             returnGeometry="true", outSR=102100)
    for f in c["features"]:
        a = f["attributes"]
        rows.append({"geom": f["geometry"], "created": a["Date"], "label": a["Station"].strip(),
                     "notes": f"{a['Station'].strip()}; {a['Notes'].strip()}. Copied from "
                              f"Cypress_Creek_Photostations_2020/0 FID {a['FID']} "
                              f"(collected {local_date(a['Date'])}).",
                     "source": f"Cypress_Creek_Photostations_2020/0:{a['FID']}"})
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()


    points = legacy_rows()
    rows = cluster(points)
    for r in rows:
        mu = at_point(MUS, r["geom"], "SITE_NAME,SITE_CODE,MU_ID,UNIT")
        site = at_point(SITES, r["geom"], "SITE_NAME")
        r["site"] = site.get("SITE_NAME") or mu.get("SITE_NAME")
        r["code"] = mu.get("SITE_CODE") or "UNK"
        r["mu"] = mu.get("MU_ID")

    by_code = defaultdict(list)
    for r in rows:
        by_code[r["code"]].append(r)
    for code, grp in by_code.items():
        for n, r in enumerate(sorted(grp, key=lambda x: x["created"]), 1):
            r["StationID"] = f"{code}-PS{n:02d}"

    rows.sort(key=lambda r: r["StationID"])
    os.makedirs("out", exist_ok=True)
    with open("out/legacy_stations_preview.csv", "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["StationID", "SiteName", "MgmtUnit", "OriginalLabels", "PointsMerged", "Sources", "Notes"])
        for r in rows:
            w.writerow([r["StationID"], r["site"], r["mu"], r["label"], r["merged"], r["source"], r["notes"]])
    print(f"{len(points)} legacy points -> {len(rows)} stations -> out/legacy_stations_preview.csv")

    if not args.apply:
        return
    ids = ",".join(f"'{r['StationID']}'" for r in rows)
    dup = post(TARGET + "/query", where=f"StationID IN ({ids})", returnCountOnly="true")["count"]
    if dup:
        raise SystemExit(f"{dup} of these StationIDs already exist in the target; refusing to copy twice.")
    adds = [{"geometry": dict(r["geom"], spatialReference={"wkid": 102100}),
             "attributes": {"StationID": r["StationID"], "SiteName": r["site"], "MgmtUnit": r["mu"],
                            "PostInstalled": "No", "StationStatus": "Active", "Notes": r["notes"][:1000]}}
            for r in rows]
    res = post(TARGET + "/applyEdits", adds=json.dumps(adds), rollbackOnFailure="true")
    bad = [x for x in res["addResults"] if not x["success"]]
    print(f"added {len(res['addResults']) - len(bad)}, failed {len(bad)}", bad[:3])


if __name__ == "__main__":
    main()
