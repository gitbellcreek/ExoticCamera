"""
Build a Photo Monitoring hosted feature service + Field Maps web map in ArcGIS Online.

  Photo Stations  (layer 0, points)  -- one feature per permanent photo post
  Station Visits  (table 1)          -- one record per visit, related 1:M on GlobalID

Each visit gets 9 full-resolution photo attachments, captured through keyword-tagged
form slots in Field Maps:  N, E, S, W, LOW_N, LOW_E, LOW_S, LOW_W, LOCATOR.

The new web map copies the basemap, extent and (optionally) operational layers
from the source web map so it looks like the existing Hillsborough map.

Credentials come from the ARC_USER / ARC_PASS environment variables.
    python build_photo_monitoring.py --dry-run   # write JSON to ./out, create nothing
    python build_photo_monitoring.py             # create the service + web map (private)
"""
import argparse
import copy
import json
import os

import requests

SOURCE_WEBMAP_ID = "b51a040380ff410daf8110865860eee4"
SERVICE_NAME = "Photo_Monitoring"
MAP_TITLE = "Photo Monitoring - Field Maps"
WKID = 102100

# keyword -> form label. The keyword is written to each attachment's KEYWORDS field,
# so photos can be pulled out by direction later (e.g. for side-by-side comparisons).
STANDARD_PHOTOS = [
    ("N", "North"),
    ("E", "East"),
    ("S", "South"),
    ("W", "West"),
]
LOW_ANGLE_PHOTOS = [
    ("LOW_N", "Low angle - North"),
    ("LOW_E", "Low angle - East"),
    ("LOW_S", "Low angle - South"),
    ("LOW_W", "Low angle - West"),
]
LOCATOR_PHOTO = ("LOCATOR", "Locator (photo of the post)")

# Photo slots are optional and take any number of photos (e.g. several zooms per direction).
# Set MIN to 1 to require a photo, or MAX to an int to cap the count per slot.
MIN_PHOTOS_PER_SLOT = 0
MAX_PHOTOS_PER_SLOT = None


# --------------------------------------------------------------------------- domains

def coded(name, values):
    return {
        "type": "codedValue",
        "name": name,
        "codedValues": [{"name": v, "code": v} for v in values],
    }


YES_NO = coded("PM_YesNo", ["Yes", "No"])
POST_TYPE = coded("PM_PostType", ["Rebar", "T-post", "PVC", "Wood stake", "Other"])
STATION_STATUS = coded("PM_StationStatus", ["Active", "Damaged", "Missing", "Retired"])
POST_CONDITION = coded(
    "PM_PostCondition",
    ["Good", "Leaning / bent", "Damaged", "Missing - replaced", "Missing - not replaced"],
)


# ---------------------------------------------------------------------------- fields

def f(name, alias, ftype, length=None, domain=None, nullable=True):
    d = {"name": name, "alias": alias, "type": ftype, "nullable": nullable, "editable": True}
    if length:
        d["length"] = length
    if domain:
        d["domain"] = domain
    return d


OBJECTID = {"name": "OBJECTID", "alias": "OBJECTID", "type": "esriFieldTypeOID",
            "nullable": False, "editable": False}
GLOBALID = {"name": "GlobalID", "alias": "GlobalID", "type": "esriFieldTypeGlobalID",
            "length": 38, "nullable": False, "editable": False}

STATION_FIELDS = [
    OBJECTID,
    GLOBALID,
    f("StationID", "Station ID", "esriFieldTypeString", 25),
    f("SiteName", "Site / Preserve", "esriFieldTypeString", 100),
    f("MgmtUnit", "Management Unit", "esriFieldTypeString", 50),
    f("Habitat", "Habitat / Community", "esriFieldTypeString", 100),
    f("PostInstalled", "Post Installed", "esriFieldTypeString", 3, YES_NO),
    f("PostType", "Post Type", "esriFieldTypeString", 25, POST_TYPE),
    f("PostTag", "Post Tag / Marking", "esriFieldTypeString", 50),
    f("InstallDate", "Install Date", "esriFieldTypeDate", 8),
    f("StationStatus", "Station Status", "esriFieldTypeString", 25, STATION_STATUS),
    f("Notes", "Notes", "esriFieldTypeString", 1000),
]

VISIT_FIELDS = [
    OBJECTID,
    GLOBALID,
    f("StationGUID", "Station GUID", "esriFieldTypeGUID", 38),
    f("StationID", "Station ID", "esriFieldTypeString", 25),
    f("VisitDate", "Visit Date", "esriFieldTypeDate", 8),
    f("Observer", "Observer(s)", "esriFieldTypeString", 100),
    f("MonitoringEvent", "Monitoring Event", "esriFieldTypeString", 50),
    f("PostCondition", "Post Condition", "esriFieldTypeString", 30, POST_CONDITION),
    f("Notes", "Visit Notes", "esriFieldTypeString", 1000),
]

# Keywords + EXIF (GPS, compass heading, camera, timestamp) stored with every photo.
ATTACHMENT_PROPERTIES = [
    {"name": "name", "isEnabled": True},
    {"name": "size", "isEnabled": True},
    {"name": "contentType", "isEnabled": True},
    {"name": "keywords", "isEnabled": True},
    {"name": "exifInfo", "isEnabled": True},
]

# Relationship: Stations.GlobalID (origin) -> Visits.StationGUID (destination).
# composite=True: deleting a station deletes its visits (and their photos).
REL_NAME_FROM_STATION = "Station_Visits"
REL_NAME_FROM_VISIT = "Photo_Station"


def service_definition():
    common = {
        "currentVersion": 11.3,
        "objectIdField": "OBJECTID",
        "globalIdField": "GlobalID",
        "hasAttachments": True,
        "attachmentProperties": ATTACHMENT_PROPERTIES,
        "supportsAttachmentsByUploadId": True,
        "capabilities": "Create,Delete,Query,Update,Editing,Sync",
        "maxRecordCount": 2000,
        "supportedQueryFormats": "JSON, geoJSON, PBF",
        "hasStaticData": False,
    }
    stations = dict(common, **{
        "id": 0,
        "name": "Photo_Stations",
        "type": "Feature Layer",
        "geometryType": "esriGeometryPoint",
        "displayField": "StationID",
        "description": "Permanent photo monitoring posts (one point per post).",
        "extent": {"xmin": -9218000, "ymin": 3189000, "xmax": -9100000, "ymax": 3292000,
                   "spatialReference": {"wkid": WKID}},
        "fields": STATION_FIELDS,
        "drawingInfo": {"renderer": {
            "type": "simple",
            "symbol": {"type": "esriSMS", "style": "esriSMSDiamond", "size": 11,
                       "color": [230, 152, 0, 255],
                       "outline": {"color": [255, 255, 255, 255], "width": 1.25}},
        }},
        "templates": [{"name": "Photo Station", "drawingTool": "esriFeatureEditToolPoint",
                       "prototype": {"attributes": {"StationStatus": "Active"}}}],
        "relationships": [{
            "id": 0, "name": REL_NAME_FROM_STATION, "relatedTableId": 1,
            "cardinality": "esriRelCardinalityOneToMany", "role": "esriRelRoleOrigin",
            "keyField": "GlobalID", "composite": True,
        }],
    })
    visits = dict(common, **{
        "id": 1,
        "name": "Station_Visits",
        "type": "Table",
        "displayField": "StationID",
        "description": "One record per photo station visit; photos attached by direction keyword.",
        "fields": VISIT_FIELDS,
        "templates": [{"name": "Station Visit", "prototype": {"attributes": {}}}],
        "relationships": [{
            "id": 0, "name": REL_NAME_FROM_VISIT, "relatedTableId": 0,
            "cardinality": "esriRelCardinalityOneToMany", "role": "esriRelRoleDestination",
            "keyField": "StationGUID", "composite": True,
        }],
    })
    return {"layers": [stations], "tables": [visits]}


# ---------------------------------------------------------------------- Field Maps forms

def fe(field, label, input_type, **extra):
    return dict({"type": "field", "fieldName": field, "label": label,
                 "inputType": input_type}, **extra)


TEXT = {"type": "text-box", "maxLength": 100, "minLength": 0}
AREA = {"type": "text-area", "maxLength": 1000, "minLength": 0}
COMBO = {"type": "combo-box", "showNoValueOption": True, "noValueOptionLabel": "No value"}
DATE = {"type": "datetime-picker", "includeTime": False}
DATETIME = {"type": "datetime-picker", "includeTime": True}


ALWAYS = {"name": "expr_always", "title": "Always", "expression": "true", "returnType": "boolean"}
NEVER = {"name": "expr_never", "title": "Never", "expression": "false", "returnType": "boolean"}


def photo_slot(keyword, label):
    slot = {
        "type": "attachment",
        "label": label,
        "attachmentKeyword": keyword,
        # No maxImageSize -> Field Maps uploads the original, full-resolution image.
        "inputType": {"type": "image", "inputMethod": "any"},
        "minAttachmentCount": MIN_PHOTOS_PER_SLOT,
        # Field Maps Designer default. useOriginalFilename=False without a filenameExpression
        # coincided with "attachments failed to upload" on iOS, so keep the original names.
        "useOriginalFilename": True,
    }
    if MAX_PHOTOS_PER_SLOT:
        slot["maxAttachmentCount"] = MAX_PHOTOS_PER_SLOT
    return slot


# Any file type: full-res photos, video, audio, documents (PDF, etc.)
ANY_FILE = {"type": "attachment", "inputTypes": [
    {"type": "image", "inputMethod": "any"},
    {"type": "video", "inputMethod": "any"},
    {"type": "audio"},
    {"type": "document"},
]}


def file_slot(keyword, label, association, description=None):
    slot = {
        "type": "attachment",
        "label": label,
        "attachmentKeyword": keyword,
        "inputType": dict(ANY_FILE, attachmentAssociationType=association),
        "minAttachmentCount": 0,
        "useOriginalFilename": True,
        "displayFilename": True,
        "allowUserRename": True,
    }
    if description:
        slot["description"] = description
    return slot


def station_form():
    return {
        "title": "Photo Station {StationID}",
        "supportsAttachmentElements": True,
        "expressionInfos": [
            ALWAYS,
            {"name": "expr_has_post", "title": "Post installed",
             "expression": "$feature.PostInstalled == 'Yes'", "returnType": "boolean"},
        ],
        "formElements": [
            {"type": "group", "label": "Station", "initialState": "expanded", "formElements": [
                fe("StationID", "Station ID", dict(TEXT, maxLength=25), requiredExpression="expr_always"),
                fe("SiteName", "Site / Preserve", TEXT),
                fe("MgmtUnit", "Management unit", dict(TEXT, maxLength=50)),
                fe("Habitat", "Habitat / community", TEXT),
            ]},
            {"type": "group", "label": "Post", "initialState": "expanded", "formElements": [
                fe("PostInstalled", "Post installed?", {"type": "radio-buttons", "noValueOptionLabel": "No value",
                                                        "showNoValueOption": False},
                   requiredExpression="expr_always"),
                fe("PostType", "Post type", COMBO, visibilityExpression="expr_has_post"),
                fe("PostTag", "Tag / marking", dict(TEXT, maxLength=50), visibilityExpression="expr_has_post"),
                fe("InstallDate", "Install date", DATE, visibilityExpression="expr_has_post"),
                fe("StationStatus", "Status", COMBO),
                fe("Notes", "Notes", AREA),
            ]},
            # "any" = shows every attachment on the station, whatever its keyword
            file_slot("STATION", "Station attachments", "any",
                      "Install photos, sketches, documents - anything about the station itself."),
            {"type": "relationship", "relationshipId": 0, "label": "Visits",
             "description": "Tap Add to start a new visit at this post.",
             "displayCount": 5, "displayType": "list",
             "orderByFields": [{"field": "VisitDate", "order": "desc"}]},
        ],
    }


def visit_form():
    station_id_expr = (
        "var p = First(FeatureSetByRelationshipName($feature, '" + REL_NAME_FROM_VISIT +
        "', ['StationID'], false));\n"
        "return IIf(IsEmpty(p), $feature.StationID, p.StationID);"
    )
    return {
        "title": "Visit - {StationID}",
        "supportsAttachmentElements": True,
        "expressionInfos": [
            NEVER,
            {"name": "expr_station_id", "title": "Station ID from parent",
             "expression": station_id_expr, "returnType": "string"},
        ],
        "formElements": [
            {"type": "group", "label": "Visit", "initialState": "expanded", "formElements": [
                fe("StationID", "Station ID", dict(TEXT, maxLength=25),
                   valueExpression="expr_station_id", editableExpression="expr_never"),
                fe("VisitDate", "Visit date / time", DATETIME),
                fe("Observer", "Observer(s)", TEXT),
                fe("MonitoringEvent", "Monitoring event", dict(TEXT, maxLength=50),
                   hint="e.g. 2026 Fall, Post-burn"),
                fe("PostCondition", "Post condition", COMBO),
            ]},
            {"type": "group", "label": "Photo points (stand at post, eye level)",
             "initialState": "expanded",
             "formElements": [photo_slot(k, l) for k, l in STANDARD_PHOTOS]},
            {"type": "group", "label": "Groundcover (low angle)", "initialState": "expanded",
             "formElements": [photo_slot(k, l) for k, l in LOW_ANGLE_PHOTOS]},
            {"type": "group", "label": "Locator", "initialState": "expanded",
             "formElements": [photo_slot(*LOCATOR_PHOTO)]},
            {"type": "group", "label": "Other", "initialState": "collapsed", "formElements": [
                # "exactOrNone" also picks up files added without a keyword (e.g. from Map Viewer)
                file_slot("MISC", "Misc attachments", "exactOrNone",
                          "Extra photos, video, audio or documents for this visit."),
                fe("Notes", "Visit notes", AREA),
            ]},
        ],
    }


def popup(title, field_names, show_attachments, related_table_id=None):
    elements = [{"type": "fields"}]
    if related_table_id is not None:
        elements.append({"type": "relationship", "relationshipId": 0,
                         "displayCount": 5, "displayType": "list",
                         "orderByFields": [{"field": "VisitDate", "order": "desc"}]})
    if show_attachments:
        elements.append({"type": "attachments", "displayType": "preview"})
    field_infos = [{"fieldName": n, "label": n, "visible": True} for n in field_names]
    return {"title": title, "popupElements": elements, "fieldInfos": field_infos,
            "showAttachments": show_attachments}


# --------------------------------------------------------------------------- web map

def build_webmap(source, service_url, copy_source_layers):
    station_fields = [x["name"] for x in STATION_FIELDS[2:]]
    visit_fields = [x["name"] for x in VISIT_FIELDS[3:]]
    stations_layer = {
        "id": "photo_stations",
        "title": "Photo Stations",
        "url": f"{service_url}/0",
        "layerType": "ArcGISFeatureLayer",
        "visibility": True,
        "opacity": 1,
        "popupInfo": popup("Station {StationID}", station_fields, False, related_table_id=1),
        "formInfo": station_form(),
    }
    visits_table = {
        "id": "station_visits",
        "title": "Station Visits",
        "url": f"{service_url}/1",
        "popupInfo": popup("Visit {StationID} - {VisitDate}", visit_fields, True),
        "formInfo": visit_form(),
    }

    source = source or {}
    op_layers = copy.deepcopy(source.get("operationalLayers", [])) if copy_source_layers else []
    for lyr in op_layers:
        # keep the older photo station layers for reference, but don't clash with the new layer
        if lyr.get("title") == "Photo Stations":
            lyr["title"] = "Photo Stations (existing)"
    op_layers.append(stations_layer)  # last = drawn on top

    wm = {
        "operationalLayers": op_layers,
        "tables": [visits_table],
        "baseMap": source.get("baseMap") or {
            "title": "Imagery Hybrid",
            "baseMapLayers": [{
                "id": "World_Imagery", "title": "World Imagery", "layerType": "ArcGISTiledMapServiceLayer",
                "url": "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer",
                "visibility": True, "opacity": 1}],
        },
        "spatialReference": source.get("spatialReference") or {"wkid": WKID, "latestWkid": 3857},
        "version": "2.31",
        "authoringApp": "ArcGIS API for Python",
        "authoringAppVersion": "photo-monitoring-builder",
    }
    for key in ("initialState", "mapRangeInfo", "applicationProperties", "bookmarks"):
        if key in source:
            wm[key] = source[key]
    if "initialState" not in wm:
        # Hillsborough County, FL
        wm["initialState"] = {"viewpoint": {"targetGeometry": {
            "xmin": -9218000, "ymin": 3189000, "xmax": -9100000, "ymax": 3292000,
            "spatialReference": {"wkid": WKID}}}}
    return wm


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


def get(url, **params):
    params.update(f="json", token=token())
    return _check(requests.get(url, params=params, headers=HEADERS))


def post(url, **params):
    params.update(f="json", token=token())
    return _check(requests.post(url, data=params, headers=HEADERS))


def create_params(name, extent):
    return {
        "name": name,
        "serviceDescription": "Permanent photo station monitoring (stations + visits).",
        "hasStaticData": False,
        "maxRecordCount": 2000,
        "supportedQueryFormats": "JSON",
        "capabilities": "Create,Delete,Query,Update,Editing,Sync",
        "spatialReference": {"wkid": WKID, "latestWkid": 3857},
        "initialExtent": extent,
        "allowGeometryUpdates": True,
        "units": "esriMeters",
        "xssPreventionInfo": {"xssPreventionEnabled": True, "xssPreventionRule": "InputOnly",
                              "xssInputRule": "rejectInvalid"},
    }


EDITOR_TRACKING = {
    "editorTrackingInfo": {"enableEditorTracking": True,
                           "enableOwnershipAccessControl": False,
                           "allowOthersToQuery": True,
                           "allowOthersToUpdate": True,
                           "allowOthersToDelete": True,
                           "allowAnonymousToUpdate": False,
                           "allowAnonymousToDelete": False},
}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--service-name", default=SERVICE_NAME)
    ap.add_argument("--map-title", default=MAP_TITLE)
    ap.add_argument("--source-webmap", default=SOURCE_WEBMAP_ID)
    ap.add_argument("--no-source-layers", action="store_true",
                    help="copy only basemap + extent from the source map, not its layers")
    ap.add_argument("--folder", default="source",
                    help="folder id for the new items; 'source' = same folder as the source map, '' = root")
    ap.add_argument("--dry-run", action="store_true",
                    help="write service + web map JSON to ./out and exit")
    args = ap.parse_args()

    svc_def = service_definition()

    # 1. source web map (basemap / extent / layers) -- read only
    src_url = f"{SHARING}/content/items/{args.source_webmap}"
    if args.dry_run and not os.environ.get("ARC_USER"):
        src_item, source = {}, {}
    else:
        src_item, source = get(src_url), get(f"{src_url}/data")
        print(f"Source web map: {src_item['title']} ({len(source.get('operationalLayers', []))} layers)")

    if args.dry_run:
        os.makedirs("out", exist_ok=True)
        wm = build_webmap(source, "https://services.arcgis.com/<org>/arcgis/rest/services/"
                                  f"{args.service_name}/FeatureServer", not args.no_source_layers)
        for name, obj in (("service_definition.json", svc_def), ("webmap.json", wm)):
            with open(os.path.join("out", name), "w") as fh:
                json.dump(obj, fh, indent=2)
        print("Wrote out/service_definition.json and out/webmap.json")
        return

    user = os.environ["ARC_USER"]
    portal = get(f"{SHARING}/portals/self")
    folder = src_item.get("ownerFolder") if args.folder == "source" else args.folder
    user_url = f"{SHARING}/content/users/{user}" + (f"/{folder}" if folder else "")

    # 2. empty hosted feature service
    avail = get(f"{SHARING}/portals/{portal['id']}/isServiceNameAvailable",
                name=args.service_name, type="Feature Service")
    if not avail.get("available"):
        raise SystemExit(f"Service name '{args.service_name}' is taken; pass --service-name")
    extent = (source.get("initialState") or {}).get("viewpoint", {}).get("targetGeometry") \
        or svc_def["layers"][0]["extent"]
    svc_def["layers"][0]["extent"] = extent
    res = post(f"{user_url}/createService", outputType="featureService",
               createParameters=json.dumps(create_params(args.service_name, extent)))
    svc_item_id, service_url = res["itemId"], res["serviceurl"]
    print(f"Created service item {svc_item_id}")
    admin_url = service_url.replace("/rest/services/", "/rest/admin/services/")

    # 3. layers, table, relationship, attachments
    # Hosted addToDefinition rejects relationships inline, so add them per layer afterwards.
    rels = {lyr["id"]: lyr.pop("relationships") for lyr in svc_def["layers"] + svc_def["tables"]}
    res = post(f"{admin_url}/addToDefinition", addToDefinition=json.dumps(svc_def))
    if not res.get("success"):
        raise RuntimeError(f"addToDefinition failed: {res}")
    for lyr_id, rel in rels.items():
        post(f"{admin_url}/{lyr_id}/addToDefinition", addToDefinition=json.dumps({"relationships": rel}))

    # 4. editor tracking (adds CreationDate / Creator / EditDate / Editor) + sync for offline
    post(f"{admin_url}/updateDefinition", updateDefinition=json.dumps(dict(
        EDITOR_TRACKING, syncEnabled=True,
        syncCapabilities={"supportsRegisteringExistingData": True,
                          "supportsSyncDirectionControl": True,
                          "supportsPerLayerSync": True,
                          "supportsPerReplicaSync": False,
                          "supportsRollbackOnFailure": False,
                          "supportsAsync": True,
                          "supportsAttachmentsSyncDirection": True})))

    post(f"{SHARING}/content/users/{user}/items/{svc_item_id}/update",
         title=args.service_name.replace("_", " "),
         tags="photo monitoring, photo points, field maps",
         snippet="Photo stations (points) and station visits (related table) "
                 "with full-resolution directional photos.")

    print(f"Feature service: {service_url}")
    for lyr_id in (0, 1):
        props = get(f"{service_url}/{lyr_id}")
        print(f"  {lyr_id}: {props['name']}  attachments={props.get('hasAttachments')}  "
              f"relationships={[r['name'] for r in props.get('relationships', [])]}  "
              f"fields={len(props['fields'])}")

    # 5. Field Maps web map
    wm = build_webmap(source, service_url, not args.no_source_layers)
    ext = src_item.get("extent") or [[-82.82, 27.57], [-82.05, 28.18]]
    res = post(f"{user_url}/addItem", type="Web Map", title=args.map_title,
               tags="photo monitoring, field maps",
               snippet=f"Field Maps photo monitoring map, based on '{src_item.get('title', '')}'.",
               typeKeywords="ArcGIS Online,Collector,Data Editing,Explorer Web Map,Map,"
                            "Mobile,Offline,Online Map,Web Map",
               extent=",".join(str(v) for v in ext[0] + ext[1]),
               text=json.dumps(wm))
    map_id = res["id"]
    org = f"https://{portal['urlKey']}.{portal['customBaseUrl']}"
    print(f"Web map: {org}/apps/mapviewer/index.html?webmap={map_id}")
    print(f"Field Maps Designer: {org}/apps/fieldmaps/maps/{map_id}")


if __name__ == "__main__":
    main()
