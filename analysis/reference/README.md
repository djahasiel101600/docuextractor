# ROI Extraction Reference Implementation

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

## Lineage

These files were built during an earlier phase of the project and are
kept here for reference only. They live under `analysis/` to make that
status unambiguous. Do not import from this directory; do not bundle
these files with the app.