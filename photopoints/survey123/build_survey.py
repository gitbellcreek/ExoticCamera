"""
Build the backup Survey123 form for Photo Points: an XLSForm for Survey123 Connect that adds a visit
(a Station_Visits row and its photos) to the existing Photo_Monitoring feature service.

Meant for photos taken with SoLocator (or any camera app that stamps the bearing) and attached after the
fact, from the phone's photo library; the camera works too. Survey123 cannot show the bearing in its own
camera view, so the form reads the bearing each photo carries and warns when a photo does not face the
direction it was put under.

Each photo question is named after its slot, and Survey123 uses the question name as the attachment
keyword, so the photos land in the same slots as Photo Points' (North_eye_level, North_groundcover, …,
Post, Other), and the popup sections that filter on North / East / … / Post / Other pick them up.

    python build_survey.py                # write Photo_Points_backup.xlsx and media/stations.csv
    python build_survey.py --no-stations  # the form only (stations.csv needs ARC_USER / ARC_PASS)
"""
import csv
import os
import sys

from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE = "https://services.arcgis.com/apTfC6SUmnNfnxuF/arcgis/rest/services/Photo_Monitoring/FeatureServer"

SLOTS = [  # question (= attachment keyword), label, target bearing (None: any)
    ("North_eye_level", "North — eye level", 0), ("North_groundcover", "North — groundcover", 0),
    ("East_eye_level", "East — eye level", 90), ("East_groundcover", "East — groundcover", 90),
    ("South_eye_level", "South — eye level", 180), ("South_groundcover", "South — groundcover", 180),
    ("West_eye_level", "West — eye level", 270), ("West_groundcover", "West — groundcover", 270),
    ("Post", "Post (locator photo)", None),
]
POST_CONDITION = [("good", "Good"), ("leaning", "Leaning / bent"), ("damaged", "Damaged"),
                  ("missing_replaced", "Missing - replaced"), ("missing_not_replaced", "Missing - not replaced")]

COLS = ["type", "name", "label", "hint", "required", "relevant", "calculation", "default", "appearance",
        "constraint", "constraint_message", "readonly", "bind::esri:fieldType", "bind::esri:parameters", "choice_filter"]


def survey_rows():
    R = []
    add = lambda **k: R.append(k)
    add(type="begin group", name="g_station", label="Station", appearance="field-list")
    add(type="select_one_from_file stations.csv", name="station", label="Station", required="yes", appearance="autocomplete",
        hint="Type to search. Opened from a station in Field Maps, this is filled in for you.", **{"bind::esri:fieldType": "null"})
    add(type="calculate", name="StationGUID", label="Station GlobalID", calculation="${station}",
        **{"bind::esri:fieldType": "esriFieldTypeGUID"})
    add(type="calculate", name="StationID", label="Station ID", calculation="pulldata('stations', 'StationID', 'name', ${station})")
    add(type="note", name="station_note", label="<b>${StationID}</b> · ${site} · unit ${unit} · schedule: ${schedule}", relevant="${station} != ''",
        **{"bind::esri:fieldType": "null"})
    for n, col in (("site", "SiteName"), ("unit", "MgmtUnit"), ("schedule", "Schedule")):
        add(type="calculate", name=n, label=col, calculation=f"pulldata('stations', '{col}', 'name', ${{station}})", **{"bind::esri:fieldType": "null"})
    add(type="end group", name="g_station")

    add(type="begin group", name="g_visit", label="Visit", appearance="field-list")
    add(type="dateTime", name="VisitDate", label="Visit date and time", required="yes", default="now()",
        hint="For photos taken earlier (SoLocator), set this to when they were taken — shown under the first photo.")
    add(type="text", name="Observer", label="Observer")
    add(type="text", name="MonitoringEvent", label="Monitoring event", hint="e.g. Fall 2026 photo monitoring")
    add(type="select_one post_condition", name="post_condition", label="Post condition", appearance="minimal",
        **{"bind::esri:fieldType": "null"})
    # the layer's codes have spaces and slashes, which choice names cannot: map the picked choice to its code
    add(type="calculate", name="PostCondition", label="Post condition (stored)",
        calculation="".join("if(${post_condition} = '%s', '%s', " % (k, v) for k, v in POST_CONDITION) + "''" + ")" * len(POST_CONDITION))
    add(type="text", name="Notes", label="Notes", appearance="multiline")
    add(type="end group", name="g_visit")

    add(type="begin group", name="g_photos", label="Photos",
        hint="Attach each photo under the direction it faces. Pick from the photo library (SoLocator) or take it here.")
    first = True
    for q, label, target in SLOTS:
        add(type="image", name=q, label=label)
        d = q + "_dir"
        if target is None and not first:
            continue
        # the bearing the photo carries (SoLocator and the iPhone camera both write it); not stored
        add(type="calculate", name=d, label=f"{label} bearing", calculation=f"pulldata('@exif', ${{{q}}}, 'GpsImgDirection')",
            **{"bind::esri:fieldType": "null"})
        if first:
            add(type="calculate", name="first_taken", label="First photo taken",
                calculation=f"pulldata('@exif', ${{{q}}}, 'DateTimeOriginal')", **{"bind::esri:fieldType": "null"})
            add(type="note", name="taken_note", label="This photo was taken ${first_taken} — use that for the visit date.",
                relevant="${first_taken} != ''", **{"bind::esri:fieldType": "null"})
            first = False
        if target is not None:
            off = f"min(abs(number(${{{d}}}) - {target}), 360 - abs(number(${{{d}}}) - {target}))"
            add(type="note", name=q + "_ok", label=f"Faces ${{{d}}}°", relevant=f"${{{d}}} != '' and {off} <= 45",
                **{"bind::esri:fieldType": "null"})
            add(type="note", name=q + "_warn",
                label=f"<span style=\"color:#b00020\"><b>This photo faces ${{{d}}}°</b>, not {['north', 'east', 'south', 'west'][target // 90]}. "
                      "Is it under the right direction?</span>",
                relevant=f"${{{d}}} != '' and {off} > 45", **{"bind::esri:fieldType": "null"})
    add(type="image", name="Other", label="Other photos", appearance="multiline",
        hint="Anything else worth keeping: extra views, the post up close, a problem.")
    add(type="end group", name="g_photos")
    return R


def write_xlsx(path):
    wb = Workbook()
    ws = wb.active
    ws.title = "survey"
    ws.append(COLS)
    for r in survey_rows():
        ws.append([r.get(c, "") for c in COLS])
    ch = wb.create_sheet("choices")
    ch.append(["list_name", "name", "label"])
    for k, v in POST_CONDITION:
        ch.append(["post_condition", k, v])
    st = wb.create_sheet("settings")
    st.append(["form_title", "form_id", "version", "submission_url", "instance_name", "style", "default_language"])
    st.append(["Photo Points (backup)", "Station_Visits", "1", SERVICE,
               "concat(${StationID}, ' — ', format-date(${VisitDate}, '%Y-%m-%d'))", "pages", "en"])
    head, fill = Font(bold=True), PatternFill("solid", fgColor="DDEBF7")
    for sh in (ws, ch, st):
        for c in sh[1]:
            c.font, c.fill = head, fill
        for col in sh.columns:
            sh.column_dimensions[col[0].column_letter].width = min(60, max(12, max(len(str(c.value or "")) for c in col) + 2))
    wb.save(path)


def write_stations(path):
    """Every station, for picking one with no signal: name is its GlobalID as Survey123 stores a GUID."""
    import requests
    H = {"Referer": "https://www.arcgis.com"}
    t = requests.post("https://www.arcgis.com/sharing/rest/generateToken", headers=H, timeout=60, data={
        "username": os.environ["ARC_USER"], "password": os.environ["ARC_PASS"], "referer": "https://www.arcgis.com",
        "expiration": 15, "f": "json"}).json()["token"]
    j = requests.post(SERVICE + "/0/query", headers=H, timeout=60, data={
        "f": "json", "token": t, "where": "StationStatus IS NULL OR StationStatus <> 'Retired'",
        "outFields": "GlobalID,StationID,SiteName,MgmtUnit,Schedule,StationStatus", "orderByFields": "StationID"}).json()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["name", "label", "StationID", "SiteName", "MgmtUnit", "Schedule"])
        for f in j["features"]:
            a = f["attributes"]
            gid = "{" + str(a["GlobalID"]).strip("{}").upper() + "}"
            w.writerow([gid, f"{a['StationID']} — {a['SiteName'] or ''}".strip(" —"), a["StationID"], a["SiteName"] or "",
                        a["MgmtUnit"] or "", a["Schedule"] or ""])
    return len(j["features"])


if __name__ == "__main__":
    xlsx = os.path.join(HERE, "Photo_Points_backup.xlsx")
    write_xlsx(xlsx)
    print("wrote", xlsx)
    if "--no-stations" not in sys.argv:
        n = write_stations(os.path.join(HERE, "media", "stations.csv"))
        print("wrote media/stations.csv:", n, "stations")
