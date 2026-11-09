# Photo Points backup form (Survey123)

A Survey123 form that adds a visit and its photos to the same Photo_Monitoring layer as Photo Points.
Use it when Photo Points can't be used. The Survey123 field app is a native app with an Outbox, so a
finished visit is kept on the phone and sent when there is signal.

Survey123 can't show the bearing in its camera, so the form is built for **photos taken with SoLocator**
(or any camera app that records the bearing) and attached afterwards from the photo library. Taking the
photos inside the form works too.

## What it does

- **Station:** pick from a list that travels with the form, so it works offline. Opened from a station in
  Field Maps, it's filled in. It saves the station's GlobalID and ID, like Photo Points does.
- **Visit:** date and time, observer, monitoring event, post condition, notes.
- **Photos:** one question per direction (`North_eye_level`, `North_groundcover`, … `West_groundcover`),
  `Post`, and `Other` (several photos).
  - Survey123 uses the question name as the photo's keyword, so the photos fall into the same directions
    in the popups, the photo browser and Photo Points.
- **Bearing check:** the form reads the bearing stored in each photo and shows it ("Faces 352°"). It warns
  in red if a photo faces more than 45° away from the direction it was put under.
- **Visit date:** it shows when the first photo was taken, so you can set the visit date to match.

## Publish it (once)

1. Copy this folder (`Photo_Points_backup.xlsx` and `media/stations.csv`) to the computer with
   **Survey123 Connect**.
2. In Connect: **New Survey → File**, choose `Photo_Points_backup.xlsx`, and name the survey.
3. Check that the survey's `media` folder holds `stations.csv`. If it doesn't, copy it in.
4. **Publish.** The settings sheet points at the existing Photo_Monitoring service (`submission_url`) and its
   Station_Visits table (`form_id`), so nothing new is created.
   - If Connect offers to create a new feature service, stop and check those two settings.
5. Share the survey with the field group. Note its **item ID** for the Field Maps link.

**Test before relying on it.** Attach one SoLocator photo and check that "Faces …°" appears under it.
- If it doesn't, the phone isn't passing the bearing tag to the form. Everything else still works; you
  just lose the bearing check.
- In the Survey123 app's settings, set the image size to **Original**. Smaller sizes re-save the photo and
  can drop its stored data.

## Open it from a station in Field Maps

Add a text element to the **Photo_Stations** popup that uses this Arcade expression as a link. It opens the
form with the station already picked:

```arcade
var gid = "{" + Upper(Replace(Replace($feature.GlobalID, "{", ""), "}", "")) + "}";
return "https://survey123.arcgis.app?itemID=SURVEY_ITEM_ID&field:station=" + UrlEncode(gid);
```

Replace `SURVEY_ITEM_ID` with the published survey's item ID.

## In the field (SoLocator)

1. At the post, take the eye-level and groundcover photos facing N, E, S and W in SoLocator, then the post.
2. Open the form (from the station in Field Maps, or pick the station).
3. Under each direction, tap the photo icon, **choose from library**, and pick that direction's photo.
   Check the "Faces …°" line under each one.
4. Set the visit date to when the photos were taken (shown under the first photo). Submit.
   With no signal, the visit waits in the Outbox.

## When stations change

The station list is a snapshot. After stations are added or renamed, rebuild it and republish:

```
ARC_USER=… ARC_PASS=… python build_survey.py   # rewrites the form and media/stations.csv
```

Then replace `stations.csv` in the survey's media folder in Connect and publish again.
