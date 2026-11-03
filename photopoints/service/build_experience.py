"""
Build the photo monitoring ArcGIS Experience.

Two layouts, both on the "Photo Monitoring - Field Maps" web map:

  browse (default)  Station photos. Tap a station on the map and the panel
                    beside it shows every visit's photos, by date and by
                    direction: the Photo Points photo browser
                    (photopoints/browse.html on the GitHub Pages site), handed
                    the selected station's GlobalID by an Embed widget.
  edit              Add visits from a phone. An Edit widget: tap a station,
                    then Visits -> Add; it uses the web map's forms, so the
                    visit form has the same keyword photo slots as Field Maps.
                    Photo Stations can have their attributes edited but cannot
                    be added, moved or deleted.

The item is private, in the same folder as the web map. The published config
goes in the item's data and the same config in config/config.json, which is
what Experience Builder opens for further editing.

Credentials come from the ARC_USER / ARC_PASS environment variables.
    python build_experience.py --dry-run [--layout edit]   # write the config to ./out, create nothing
    python build_experience.py [--layout edit]             # create the experience (private)
    python build_experience.py --update <itemid>           # replace an existing one's config and title
"""
import argparse
import io
import json
import os
import time
import urllib.parse
import uuid

import requests

WEBMAP_ID = "e785cab8a5f745e8acd63a95d8966b90"
STATION_LAYER = "photo_stations"          # the Photo Stations layer's id in that web map
PORTAL_URL = "https://hillsborough.maps.arcgis.com"
BROWSER_URL = "https://gitbellcreek.github.io/ExoticCamera/photopoints/browse.html"
EXB_VERSION = "1.21.0"
DS = "dataSource_1"
STATIONS_DS = f"{DS}-{STATION_LAYER}"
MAP, PANEL = "widget_1", "widget_2"

LAYOUTS = {
    "browse": {
        "title": "Photo Monitoring - Station Photos",
        "snippet": "Tap a photo station to flip through its visits by date and turn round its photo directions.",
        # map | photos split per screen size: the photos get the room
        "splits": {"LARGE": ("side", 36), "MEDIUM": ("stack", 38), "SMALL": ("stack", 32)},
    },
    "edit": {
        "title": "Photo Monitoring - Add Visits",
        "snippet": "Add photo station visits from a phone: tap a station, then Visits > Add.",
        # phones get the map on top so a station is one tap away, and most of the height for the form
        "splits": {"LARGE": ("side", 68), "MEDIUM": ("stack", 50), "SMALL": ("stack", 40)},
    },
}

STATION_FIELDS = [
    ("StationID", "Station ID", "STRING", "esriFieldTypeString"),
    ("SiteName", "Site", "STRING", "esriFieldTypeString"),
    ("MgmtUnit", "Management unit", "STRING", "esriFieldTypeString"),
    ("Habitat", "Habitat", "STRING", "esriFieldTypeString"),
    ("PostInstalled", "Post installed?", "STRING", "esriFieldTypeString"),
    ("PostType", "Post type", "STRING", "esriFieldTypeString"),
    ("PostTag", "Post tag", "STRING", "esriFieldTypeString"),
    ("InstallDate", "Install date", "DATE", "esriFieldTypeDate"),
    ("StationStatus", "Station status", "STRING", "esriFieldTypeString"),
    ("Notes", "Notes", "STRING", "esriFieldTypeString"),
]


# ----------------------------------------------------------------------------- config

def placement(widget_id, splits, size, part):
    """Fixed-layout box for the map or the panel beside it."""
    kind, share = splits[size]
    pct, rest = f"{share:.1f}", f"{100 - share:.1f}"
    if kind == "side":
        bbox = ({"left": "0.0%", "right": f"{rest}%", "top": "0.0%", "bottom": "0.0%",
                 "width": f"{pct}%", "height": "100.0%"} if part == "map" else
                {"left": f"{pct}%", "right": "0.0%", "top": "0.0%", "bottom": "0.0%",
                 "width": f"{rest}%", "height": "100.0%"})
        auto = {"left": part != "map", "right": part == "map", "top": True, "bottom": False}
    else:
        bbox = ({"left": "0.0%", "right": "0.0%", "top": "0.0%", "bottom": f"{rest}%",
                 "width": "100.0%", "height": f"{pct}%"} if part == "map" else
                {"left": "0.0%", "right": "0.0%", "top": f"{pct}%", "bottom": "0.0%",
                 "width": "100.0%", "height": f"{rest}%"})
        auto = {"left": True, "right": False, "top": part != "map", "bottom": part == "map"}
    setting = {"autoProps": auto, "hCenter": False, "vCenter": False}
    if part == "map":
        setting.update(heightMode="fixed", aspectRatio=1)
    return {"type": "WIDGET", "widgetId": widget_id, "bbox": bbox, "setting": setting}


def layouts(splits):
    out, page, map_fixed = {}, {}, {}
    for i, size in enumerate(("LARGE", "MEDIUM", "SMALL")):
        page_id, inner_id = f"layout_{2 * i}", f"layout_{2 * i + 1}"
        out[page_id] = {"type": "FIXED",
                        "content": {"0": placement(MAP, splits, size, "map"), "1": placement(PANEL, splits, size, "panel")},
                        "order": ["0", "1"]}
        out[inner_id] = {"type": "FIXED", "label": "Map FixedLayout", "content": {}, "order": []}
        page[size], map_fixed[size] = page_id, inner_id
    return out, page, map_fixed


def station_layer_config():
    show = [{"jimuName": n, "name": n, "type": t, "esriType": e, "alias": a} for n, a, t, e in STATION_FIELDS]
    return {
        "id": STATIONS_DS,
        "name": "Photo Stations",
        "useDataSource": {"dataSourceId": STATIONS_DS, "mainDataSourceId": STATIONS_DS, "rootDataSourceId": DS},
        "addRecords": False,
        "deleteRecords": False,
        "updateRecords": True,          # needed to open a station's form and its Visits
        "updateAttributes": True,
        "updateGeometries": False,      # posts don't move
        "showFields": show,
        "groupedFields": [dict(s, editAuthority=True, subDescription="", editable=True) for s in show],
        "layerHonorMode": "WEBMAP",     # use the web map's form, with its photo slots
    }


def edit_widget():
    return {
        "uri": "widgets/common/edit/",
        "version": EXB_VERSION,
        "label": "Visits",
        "id": PANEL,
        "useMapWidgetIds": [MAP],
        "config": {
            "layersConfig": [],
            "editMode": "GEOMETRY",
            "selfSnapping": False,
            "featureSnapping": False,
            "gridSnapping": False,
            "defaultSelfEnabled": False,
            "defaultFeatureEnabled": False,
            "defaultSnapLayers": [],
            "snapSettingMode": "FLEXIBLE",
            "tooltip": False,
            "defaultTooltipEnabled": False,
            "templateFilter": False,
            "liveDataEditing": False,
            "initialReshapeMode": False,
            "relatedRecords": True,
            "copyPaste": False,
            "splitButton": False,
            "description": "",
            "noDataMessage": "",
            "mapViewsConfig": {
                f"{MAP}-{DS}": {
                    "customizeLayers": True,
                    "customJimuLayerViewIds": [f"{MAP}-{DS}-{STATION_LAYER}"],
                    "layersConfig": [station_layer_config()],
                }
            },
        },
    }


def field_in_url(ds_id, field):
    """An attribute of the selected record, written into an Embed widget's URL the way the builder does."""
    expr = {"name": "{%s}" % field, "parts": [{"type": "FIELD", "exp": "{%s}" % field, "dataSourceId": ds_id,
                                               "jimuFieldName": field, "isFromRepeatedDataSourceContext": False}]}
    enc = urllib.parse.quote(json.dumps(expr, separators=(",", ":")), safe="")
    uid = str(uuid.uuid4()).replace("-", "_")
    return (f'<exp data-uniqueid="{uid}" data-dsid="{ds_id}" data-expression="{enc}">'
            f'﻿<span contenteditable="false">﻿{{{field}}}﻿</span>﻿</exp>')


def browser_widget():
    """The photo browser, reloaded with the station each time one is selected on the map."""
    selection = f"{STATIONS_DS}-selection"
    hint = "Tap a photo station on the map to see its photos: every visit, by date and by direction."
    return {
        "uri": "widgets/common/embed/",
        "version": EXB_VERSION,
        "label": "Station photos",
        "id": PANEL,
        "useDataSourcesEnabled": True,
        "useDataSources": [{"dataSourceId": selection, "mainDataSourceId": STATIONS_DS, "rootDataSourceId": DS,
                            "dataViewId": "selection", "fields": ["GlobalID"]}],
        "config": {
            "embedType": "url",
            "expression": f"<p>{BROWSER_URL}?embed=1&amp;station={field_in_url(selection, 'GlobalID')}</p>",
            "honorThemeFont": False,
            "enableLabel": True,
            "label": hint,
            "enableBlankMessage": True,
            "blankMessage": hint,
            "autoRefresh": False,
        },
    }


def experience_config(webmap_title, layout):
    lay, page_layout, map_layout = layouts(LAYOUTS[layout]["splits"])
    now = int(time.time() * 1000)
    return {
        "pages": {"page_0": {"id": "page_0", "mode": "FIT_WINDOW", "type": "NORMAL", "layout": page_layout,
                             "isDefault": True, "isVisible": True, "label": "Page"}},
        "layouts": lay,
        "exbVersion": EXB_VERSION,
        "mainSizeMode": "LARGE",
        "theme": "themes/default/",
        "forBuilderAttributes": {"lockLayout": False},
        "template": "blankfullscreen",
        "widgets": {
            MAP: {
                "uri": "widgets/arcgis/arcgis-map/",
                "version": EXB_VERSION,
                "label": "Map",
                "id": MAP,
                "config": {
                    "toolConfig": {
                        "canZoom": True, "canHome": True, "canSearch": False, "canLocate": True,
                        "canCompass": False, "canMeasure": False, "canScaleBar": True, "canSelect": False,
                        "canSelectState": False, "canLayers": True, "canBaseMap": False, "canNavigation": False,
                        "canFullScreen": False, "canOverviewMap": False, "canExtentNavigate": False,
                    },
                    "isUseCustomMapState": False,
                    "initialMapDataSourceID": DS,
                    "layoutIndex": 1,
                    "clientQueryDataSourceIds": [],
                    "disablePopUp": layout == "browse",     # the photo panel says which station it is
                    "showPopupUponSelection": False,
                    "popupDockPosition": "",
                    "scaleRange": None,
                    "customLODs": None,
                },
                "layouts": {"MapFixedLayout": map_layout},
                "useDataSources": [{"dataSourceId": DS, "mainDataSourceId": DS}],
            },
            PANEL: browser_widget() if layout == "browse" else edit_widget(),
        },
        "widgetsManifest": {},
        "views": {},
        "sections": {},
        "dialogs": {},
        "messageConfigs": {},
        "attributes": {"portalUrl": PORTAL_URL},
        "dataSources": {DS: {"id": DS, "type": "WEB_MAP", "itemId": WEBMAP_ID, "portalUrl": PORTAL_URL,
                             "sourceLabel": webmap_title}},
        "pageStructure": [{"page_0": []}],
        "mainLocale": "en-us",
        "timestamp": now,
        "publishTimestamp": now,
    }


def type_keywords():
    return ["EXB Experience", "JavaScript", "Ready To Use", "status: Published", "template:blankfullscreen",
            f"version:{EXB_VERSION}", "Web Application", "Web Experience", "Web Mapping Application",
            "Web Page", "Web Site", f"modified: {int(time.time() * 1000)}"]


# ------------------------------------------------------------------------- ArcGIS Online
# Plain REST (requests only). Token from ARC_USER / ARC_PASS env vars.

SHARING = "https://www.arcgis.com/sharing/rest"
HEADERS = {"Referer": "https://www.arcgis.com"}
_token = None


def token():
    global _token
    if _token is None:
        r = requests.post(f"{SHARING}/generateToken", data={
            "username": os.environ["ARC_USER"], "password": os.environ["ARC_PASS"],
            "referer": "https://www.arcgis.com", "expiration": 120, "f": "json"}).json()
        if "token" not in r:
            raise SystemExit(f"generateToken failed: {r.get('error', {}).get('message')}")
        _token = r["token"]
    return _token


def _check(r):
    j = r.json()
    if isinstance(j, dict) and "error" in j:
        raise RuntimeError(json.dumps(j["error"]))
    return j


def get(endpoint, **params):
    params.update(f="json", token=token())
    return _check(requests.get(endpoint, params=params, headers=HEADERS))


def post(endpoint, files=None, **params):
    params.update(f="json", token=token())
    return _check(requests.post(endpoint, data=params, files=files, headers=HEADERS))


def put_draft(item_url, config):
    """config/config.json is the copy Experience Builder opens for editing."""
    blob = io.BytesIO(json.dumps(config).encode())
    args = dict(resourcesPrefix="config", fileName="config.json")
    try:
        post(f"{item_url}/updateResources", files={"file": ("config.json", blob, "application/json")}, **args)
    except RuntimeError:
        blob.seek(0)
        post(f"{item_url}/addResources", files={"file": ("config.json", blob, "application/json")}, **args)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--layout", choices=sorted(LAYOUTS), default="browse")
    ap.add_argument("--title", help="item title (default: the layout's)")
    ap.add_argument("--update", metavar="ITEM_ID", help="replace the config and title of an existing experience")
    ap.add_argument("--dry-run", action="store_true", help="write the config to ./out and exit")
    args = ap.parse_args()
    title = args.title or LAYOUTS[args.layout]["title"]
    snippet = LAYOUTS[args.layout]["snippet"]

    if args.dry_run:
        os.makedirs("out", exist_ok=True)
        path = os.path.join("out", f"experience_{args.layout}.json")
        with open(path, "w") as fh:
            json.dump(experience_config("Photo Monitoring - Field Maps", args.layout), fh, indent=2)
        print(f"Wrote {path}")
        return

    user = os.environ["ARC_USER"]
    webmap = get(f"{SHARING}/content/items/{WEBMAP_ID}")
    config = experience_config(webmap["title"], args.layout)

    if args.update:
        item_id = args.update
        item = get(f"{SHARING}/content/items/{item_id}")
        if item.get("type") != "Web Experience":
            raise SystemExit(f"{item_id} is a {item.get('type')}, not a Web Experience")
        folder = item.get("ownerFolder")
        item_url = f"{SHARING}/content/users/{user}" + (f"/{folder}" if folder else "") + f"/items/{item_id}"
        post(f"{item_url}/update", text=json.dumps(config), typeKeywords=",".join(type_keywords()),
             title=title, snippet=snippet, url=f"https://experience.arcgis.com/experience/{item_id}")
    else:
        folder = webmap.get("ownerFolder")
        user_url = f"{SHARING}/content/users/{user}" + (f"/{folder}" if folder else "")
        res = post(f"{user_url}/addItem", type="Web Experience", title=title,
                   typeKeywords=",".join(type_keywords()), text=json.dumps(config),
                   tags="photo monitoring, photo points, visits", snippet=snippet)
        item_id = res["id"]
        item_url = f"{SHARING}/content/users/{user}" + (f"/{folder}" if folder else "") + f"/items/{item_id}"
        post(f"{item_url}/update", url=f"https://experience.arcgis.com/experience/{item_id}")
    put_draft(item_url, config)

    print(f"Experience item {item_id} (private): {title}")
    print(f"  open:  https://experience.arcgis.com/experience/{item_id}")
    print(f"  edit:  {PORTAL_URL}/apps/experiencebuilder/?id={item_id}")


if __name__ == "__main__":
    main()
