# ROI Extraction Reference Implementation

**The supported way to author an ROI profile is the in-app blank-form
wizard** (Profiles → From Blank Form). It draws the regions, writes
`extractionSettings.annotationSchema` directly, and dry-runs the profile
against the API before saving; see the region-of-interest section of the
root `README.md`. Nothing below is needed for that path.

The desktop annotator and `convert_schema.py` remain here as the
fallback for environments without the wizard, and as the reference for
how the shipped reader behaves.

These files are the **reference implementation** of the ROI-based
template extraction method described in the project's extraction
specification. They are:

  - NOT production code
  - NOT intended for merge into the app
  - NOT part of any build or runtime path

Their purpose is to serve as concrete evidence for:

  1. The divergence review — comparing the reference's behavior against
     the project's specification, so the project can decide which wins
     where they disagree.

  2. The ROI-vs-label accuracy benchmark — running the reference's
     extraction logic against the project's test PDFs so the ROI
     architecture decision is backed by observed accuracy, not by
     assertion.

## Files

  - `pdf_annotator.py` — annotation surface (Tkinter desktop).
    Reference for: how a human defines ROI bboxes, how coordinates are
    persisted in PDF points, how scroll/zoom alignment is preserved.

  - `extraction.py` — ROI extraction logic.
    Reference for: the tier order (widget → textbox → word-intersection
    → OCR), the ROI safety expansions, the widget overlap threshold,
    the normalization rules, and source-provenance reporting.

  - `bulk_extractor.py` — safe ZIP batch processing.
    Reference for: in-memory extraction, safety limits, per-file
    schema assignment, unassigned-file skipping.

## What is *not* the source of truth here

The project's specification is the source of truth. Where these files
and the spec disagree, the project decides which wins — do not silently
adopt the reference's behavior. List divergences and let the maintainer
choose.

## Schema shape divergence

`pdf_annotator.py` exports `field_schema.json` in its own shape:

```json
{"source_pdf": "...", "coordinate_system": "...",
 "pages": [{"page": 1,
            "fields": [{"name": "Print name of signer",
                        "bbox_pdf_pt": {"x0": 0, "y0": 0, "x1": 0, "y1": 0},
                        "bbox_normalized": {"x0": 0, "y0": 0, "x1": 0, "y1": 0}}]}]}
```

The application persists `extractionSettings.annotationSchema` in a
different shape for the same concept:

```json
{"pages": [{"pageNumber": 1,
            "fields": [{"fieldId": "print_name_of_signer",
                        "rect": [0, 0, 0, 0]}]}]}
```

**`field_schema.json` is NOT directly consumable by `process_pdf_roi`.**
The names differ (`page` vs `pageNumber`, `bbox_pdf_pt` vs `rect`), the
rect is an object rather than an ordered array, and an annotation name
is free text while `fieldId` must match a field id in the profile.
Run the export through `convert_schema.py` before using it as a profile
schema. This conversion only exists because the annotator writes its own
shape; a profile authored in the wizard already carries the application
shape above.

```
python analysis/reference/convert_schema.py field_schema.json \
    --field-map names.json --out annotation_schema.json
```

`names.json` maps annotation names to profile field ids, e.g.
`{"Print name of signer": "print_name_of_signer"}`. Unmapped names are
slugified, which is only correct when the annotation was named after
the field id. `bbox_normalized` is ignored: the application stores PDF
points only.

## Lineage

These files were built during an earlier phase of the project and are
kept here for reference only. They live under `analysis/` to make that
status unambiguous. Do not import from this directory; do not bundle
these files with the app.