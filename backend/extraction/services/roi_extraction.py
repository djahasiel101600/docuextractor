"""Region-of-interest extraction against an annotated form.

A profile using this method owns the geometry: every extractable field has one
box per page, drawn on the blank form by an operator, persisted in
`extractionSettings.annotationSchema`. This module never guesses where a value
lives; it reads exactly the annotated rectangle and records which tier supplied
the value:

    widget  ->  contained text  ->  intersecting words  ->  ROI-only OCR

The tier ladder, the ~1pt/2pt safety expansion and the 30% widget-overlap rule
are shared with the reference implementation. The schema handling, validation
and diagnostic shape follow this codebase (see `document_extraction.process_pdf`)
so ROI results land in the existing review UI unchanged.
"""

import math
import re
import time

import fitz
import pytesseract
from PIL import Image
from django.conf import settings
from rest_framework.exceptions import ValidationError

from .document_extraction import (
    _collect_form_fields,
    _group_words_into_rows,
    _label_similarity_threshold,
    _match_label_in_row,
    _normalize_field_config,
    _pdf_document_pages,
    _validate_value,
    normalize_value,
)

# A widget must cover at least this share of the annotated box to answer for
# it. Lower values let a neighbouring box fill a field; higher values drop
# boxes drawn slightly larger than the widget they target.
WIDGET_OVERLAP_RATIO = 0.30
# Glyph boxes are tighter than the visible ink, so a rectangle drawn exactly on
# the value clips ascenders and the last descender. The reference's expansion
# is kept verbatim: 1pt horizontally, 2pt vertically.
ROI_PADDING_X = 1.0
ROI_PADDING_Y = 2.0
# Whole-page OCR renders at 2-3x; a crop carrying a single 6-8pt form line needs
# the top of that range to resolve the glyphs.
ROI_OCR_SCALE = 3.0

# Extraction tier -> the existing diagnostic enums. `method` keeps the tier
# (which is the provenance a reviewer asks for); `source` stays inside the
# established set so every per-source badge and column keeps working.
_TIER_SOURCES = {
    "widget": "form_field",
    "textbox": "pdf_text",
    "words": "pdf_text",
    "ocr": "ocr",
}
_TIER_METHODS = {
    "widget": "roi_widget",
    "textbox": "roi_textbox",
    "words": "roi_words",
    "ocr": "roi_ocr",
}
# Confidence per tier: a filled widget is the form's own answer, contained text
# is the document's own text layer, intersecting words may be partial, and OCR
# carries its own measured confidence.
_TIER_CONFIDENCE = {"widget": 1.0, "textbox": 0.9, "words": 0.7}
_TIER_DESCRIPTIONS = {
    "widget": "AcroForm widget",
    "textbox": "text inside the annotated box",
    "words": "words overlapping the annotated box",
    "ocr": "OCR pass over the annotated box",
}


def _rect_errors(rect, context):
    if not isinstance(rect, (list, tuple)) or len(rect) != 4:
        return [f"{context}: 'rect' must be [x0, y0, x1, y1]."]
    values = []
    for item in rect:
        if isinstance(item, bool) or not isinstance(item, (int, float)):
            return [f"{context}: 'rect' coordinates must be numbers."]
        if not math.isfinite(item):
            return [f"{context}: 'rect' coordinates must be finite numbers."]
        values.append(float(item))
    x0, y0, x1, y1 = values
    if x1 <= x0 or y1 <= y0:
        return [f"{context}: 'rect' must have x1 > x0 and y1 > y0."]
    return []


def validate_roi_schema(schema):
    """Structural errors in an annotation schema; empty means usable.

    The schema is a profile's only statement of where values live, so a
    malformed one must be refused at authoring time instead of turning into a
    profile that reports every field as missing.
    """
    if schema is None:
        return ["Extraction method 'roi' requires an annotation schema."]
    if not isinstance(schema, dict):
        return ["The annotation schema must be a JSON object."]
    pages = schema.get("pages")
    if not isinstance(pages, list) or not pages:
        return ["The annotation schema must list at least one page."]
    errors = []
    for page_index, page in enumerate(pages):
        label = f"Schema page #{page_index + 1}"
        if not isinstance(page, dict):
            errors.append(f"{label}: must be an object.")
            continue
        page_number = page.get("pageNumber")
        if (
            isinstance(page_number, bool)
            or not isinstance(page_number, int)
            or page_number < 1
        ):
            errors.append(f"{label}: 'pageNumber' must be a positive integer.")
        fields = page.get("fields")
        if not isinstance(fields, list) or not fields:
            errors.append(f"{label}: defines no field boxes.")
            continue
        for field in fields:
            if not isinstance(field, dict):
                errors.append(f"{label}: each field entry must be an object.")
                continue
            field_id = field.get("fieldId")
            name = field_id if isinstance(field_id, str) and field_id else "?"
            if not isinstance(field_id, str) or not field_id.strip():
                errors.append(f"{label}: a field box has no 'fieldId'.")
            errors.extend(
                _rect_errors(field.get("rect"), f"{label}, field {name}")
            )
    return errors


def roi_schema_entries(schema):
    """Map field id -> [(0-based page index, rect)] for a validated schema.

    Raises ValidationError rather than returning an empty mapping: falling back
    to "no boxes" would fill every field with nothing and read as an extraction
    bug instead of the configuration error it is.

    Schema coordinates assume `/Rotate 0`. A page with a non-zero rotation
    displays its content rotated while word geometry stays in unrotated user
    space, so boxes drawn on the displayed page will offset on such a form.
    The planned fix is to apply the page's rotation matrix here, at the point
    where schema coordinates become page coordinates.
    """
    errors = validate_roi_schema(schema)
    if errors:
        raise ValidationError(
            "The ROI annotation schema is unusable. " + " ".join(errors)
        )
    entries = {}
    for page in schema["pages"]:
        page_index = int(page["pageNumber"]) - 1
        for field in page["fields"]:
            x0, y0, x1, y1 = (float(value) for value in field["rect"])
            entries.setdefault(field["fieldId"], []).append(
                (page_index, fitz.Rect(x0, y0, x1, y1))
            )
    return entries


def _widget_for_rect(rect, widgets):
    """The widget covering at least 30% of `rect`, or None.

    Overlap is measured against the annotated area, not the widget area: a
    large form field must not answer for a small box drawn in its corner.
    """
    rect_area = max(rect.width * rect.height, 1e-6)
    best, best_area = None, 0.0
    for widget in widgets:
        widget_rect = fitz.Rect(
            widget["x0"], widget["y0"], widget["x1"], widget["y1"]
        )
        intersection = widget_rect & rect
        if intersection.is_empty:
            continue
        area = intersection.width * intersection.height
        if area / rect_area >= WIDGET_OVERLAP_RATIO and area > best_area:
            best, best_area = widget, area
    return best


def _roi_words(page, rect, *, contained):
    """Text words inside (or merely touching) `rect`, in reading order."""
    words = []
    for item in page.get_text("words", clip=rect, sort=True):
        text = item[4].strip()
        if not text:
            continue
        x0, y0, x1, y1 = (float(value) for value in item[:4])
        if contained:
            center_x, center_y = (x0 + x1) / 2, (y0 + y1) / 2
            if not (
                rect.x0 <= center_x <= rect.x1
                and rect.y0 <= center_y <= rect.y1
            ):
                continue
        words.append(
            {
                "text": text,
                "x0": x0,
                "y0": y0,
                "x1": x1,
                "y1": y1,
                "confidence": 1.0,
            }
        )
    return words


def _strip_label_runs(words, labels, minimum_similarity):
    """Drop word runs that are a printed field label.

    A box drawn around "Date (MM-DD-YYYY) 04-22-2026" captures the label as
    well as the value. Any run matching one of the profile's configured labels
    is removed before the capture is accepted, so a value is never prefixed
    with printed instructions.
    """
    if not words or not labels:
        return words
    dropped = set()
    for row in _group_words_into_rows(words):
        for label in labels:
            match = _match_label_in_row(row, label, minimum_similarity)
            if match:
                dropped.update(
                    id(word) for word in row["words"][match["start"]:match["end"]]
                )
    if not dropped:
        return words
    return [word for word in words if id(word) not in dropped]


def _capture_text(page, rect, labels, minimum_similarity):
    """Tier 2 then Tier 3 capture from `rect`; returns (text, tier)."""
    for contained, tier in ((True, "textbox"), (False, "words")):
        words = _strip_label_runs(
            _roi_words(page, rect, contained=contained),
            labels,
            minimum_similarity,
        )
        if not words:
            continue
        text = " ".join(row["text"] for row in _group_words_into_rows(words))
        text = " ".join(text.split())
        if text:
            return text, tier
    return "", None


def _ocr_rect(page, rect, language, timings=None):
    """Tier 4: OCR the annotated region only; returns (text, confidence)."""
    area = max(rect.width * rect.height, 1.0)
    scale = max(1.0, min(ROI_OCR_SCALE, math.sqrt(20_000_000 / area)))
    render_started = time.perf_counter()
    pixmap = page.get_pixmap(
        matrix=fitz.Matrix(scale, scale), clip=rect, alpha=False
    )
    image = Image.frombytes(
        "RGB", (pixmap.width, pixmap.height), pixmap.samples
    )
    if timings is not None:
        timings["pdf_rendering_ms"] += round(
            (time.perf_counter() - render_started) * 1000, 3
        )
    ocr_started = time.perf_counter()
    try:
        result = pytesseract.image_to_data(
            image, lang=language, output_type=pytesseract.Output.DICT
        )
    finally:
        image.close()
    if timings is not None:
        timings["ocr_execution_ms"] += round(
            (time.perf_counter() - ocr_started) * 1000, 3
        )
    lines = {}
    confidences = []
    for index, raw_text in enumerate(result["text"]):
        text = raw_text.strip()
        if not text:
            continue
        try:
            confidences.append(max(0.0, float(result["conf"][index]) / 100))
        except (TypeError, ValueError):
            continue
        line_key = (
            result["block_num"][index],
            result["par_num"][index],
            result["line_num"][index],
        )
        lines.setdefault(line_key, []).append(text)
    text = "\n".join(" ".join(parts) for parts in lines.values()).strip()
    confidence = sum(confidences) / len(confidences) if confidences else 0.0
    return text, confidence


def _ocr_fallback_enabled(ocr_settings):
    return bool(
        settings.OCR_ENABLED
        and isinstance(ocr_settings, dict)
        and ocr_settings.get("enabledFallback") is True
    )


def _read_roi(page, rect, widgets, labels, minimum_similarity, ocr_settings, timings):
    """Read one annotated box through the tier ladder.

    Returns (raw_text, tier, confidence). `rect` is the box; the text tiers run
    on the safety-expanded copy so ink that touches the border is still read.
    """
    widget = _widget_for_rect(rect, widgets)
    if widget is not None:
        return str(widget.get("value") or "").strip(), "widget", 1.0
    expanded = fitz.Rect(
        rect.x0 - ROI_PADDING_X,
        rect.y0 - ROI_PADDING_Y,
        rect.x1 + ROI_PADDING_X,
        rect.y1 + ROI_PADDING_Y,
    ) & page.rect
    text, tier = _capture_text(page, expanded, labels, minimum_similarity)
    if text:
        return text, tier, _TIER_CONFIDENCE[tier]
    if _ocr_fallback_enabled(ocr_settings):
        text, confidence = _ocr_rect(
            page, expanded, ocr_settings.get("language", "eng"), timings
        )
        if text:
            return text, "ocr", confidence
    return "", None, 0.0


def _build_roi_diagnostic(field, raw, tier, page_number, confidence):
    """One FieldDiagnostic payload per field, shaped like process_pdf's."""
    value = normalize_value(raw, field.get("normalization", {}))
    passed, validation_error = _validate_value(
        value, field.get("validation", {})
    )
    if not value:
        status = "NOT_FOUND"
    elif not passed:
        status = "INVALID"
    elif tier == "ocr":
        status = "OCR_EXTRACTED"
    else:
        status = "MATCHED"
    review_required = bool(
        (field.get("required", False) and not value)
        or (value and not passed)
        or tier == "ocr"
    )
    explanation_parts = []
    if tier:
        explanation_parts.append(
            f"Read from the {_TIER_DESCRIPTIONS[tier]}."
        )
    else:
        explanation_parts.append(
            "The annotated region contained no readable value."
        )
    if value and not passed and validation_error:
        explanation_parts.append(validation_error)
    if tier == "ocr":
        explanation_parts.append(
            "OCR output is a best-effort read of the region; verify this value."
        )
    source = _TIER_SOURCES[tier] if tier else "manual"
    method = _TIER_METHODS[tier] if tier else "layout_aware"
    evidence = raw if tier else None
    return {
        "fieldId": field["id"],
        "fieldName": field.get("name", field["id"]),
        "status": status,
        "statusBeforeValidation": None,
        "filenameValue": None,
        "pdfValue": raw if tier in ("textbox", "words") else None,
        "ocrValue": raw if tier == "ocr" else None,
        "ocrSpaceValue": None,
        "formValue": raw if tier == "widget" else None,
        "aiValue": None,
        "aiEvidence": None,
        "aiSourceKind": None,
        "finalValue": value,
        "source": source,
        "method": method,
        "roiTier": tier,
        "matchedPatternOrLabel": None,
        "validationPassed": passed if value else False,
        "validationError": validation_error,
        "confidenceScore": confidence if tier else 0.0,
        "pdfConfidenceScore": (
            confidence if tier in ("textbox", "words") else None
        ),
        "ocrConfidenceScore": confidence if tier == "ocr" else None,
        "formConfidenceScore": confidence if tier == "widget" else None,
        "formMethod": "roi_widget" if tier == "widget" else None,
        "pdfEvidence": (
            evidence if tier in ("textbox", "words") else None
        ),
        "pdfPageNumber": page_number if tier in ("textbox", "words") else None,
        "ocrEvidence": evidence if tier == "ocr" else None,
        "ocrPageNumber": page_number if tier == "ocr" else None,
        "ocrSpaceEvidence": None,
        "ocrSpacePageNumber": None,
        "ocrSpaceConfidenceScore": None,
        "formEvidence": evidence if tier == "widget" else None,
        "formPageNumber": page_number if tier == "widget" else None,
        "aiPageNumber": None,
        "candidateScores": {source: confidence} if tier else {},
        "selectionReason": (
            f"The annotated box was read by the {tier} tier."
            if tier
            else "No annotated box for this field produced a value."
        ),
        "supportingEvidence": evidence,
        "pageNumber": page_number,
        "explanation": " ".join(explanation_parts),
        "isConflict": False,
        "reviewRequired": review_required,
        "isManuallyCorrected": False,
    }


def process_pdf_roi(pdf_bytes, filename, profile):
    """Extract a filled PDF by reading only the annotated regions of interest.

    Returns the same contract as `process_pdf` (pageCount, rawPdfText,
    diagnostics, finalValues, extractionMethodUsed, processingMetrics) so the
    job pipeline and the review UI consume ROI results without changes.

    Values are read only from the pages the schema references; a schema that
    annotates page 1 of a nine-page form never reads a value from pages 2-9.
    `rawPdfText` still spans the whole document because the review pane shows
    it, so `firstPageOnly` deliberately does not apply here: the page scope is
    the schema's, which is narrower than any page limit and is intentional
    performance behaviour rather than a regression.

    `filename` is accepted for signature parity with `process_pdf`. Filename
    rules are not consulted, so this mode cannot raise a filename-vs-content
    conflict.
    """
    total_started = time.perf_counter()
    timings = {
        "pdf_loading_ms": 0.0,
        "native_text_extraction_ms": 0.0,
        "form_field_extraction_ms": 0.0,
        "field_extraction_ms": 0.0,
        "pdf_rendering_ms": 0.0,
        "ocr_execution_ms": 0.0,
    }
    loading_started = time.perf_counter()
    try:
        document = fitz.open(stream=pdf_bytes, filetype="pdf")
    except (fitz.FileDataError, RuntimeError) as exc:
        raise ValidationError(
            "The PDF could not be opened; it may be encrypted or corrupted."
        ) from exc
    timings["pdf_loading_ms"] = round(
        (time.perf_counter() - loading_started) * 1000, 3
    )
    ocr_error = ""
    with document:
        if document.is_encrypted:
            raise ValidationError(
                "Password-protected PDF files are not supported.")
        if document.page_count > settings.MAX_PDF_PAGES:
            raise ValidationError("The PDF exceeds the configured page limit.")

        extraction_settings = profile.get("extractionSettings", {})
        if not isinstance(extraction_settings, dict):
            extraction_settings = {}
        rois = roi_schema_entries(extraction_settings.get("annotationSchema"))
        schema_pages = sorted(
            {page_index for boxes in rois.values() for page_index, _ in boxes}
        )
        missing_pages = [
            page_index + 1
            for page_index in schema_pages
            if page_index >= document.page_count
        ]
        if missing_pages:
            raise ValidationError(
                "The ROI annotation schema references page "
                f"{missing_pages[0]}, but this PDF has {document.page_count}."
            )

        native_started = time.perf_counter()
        # Word geometry is only needed by label matching; ROI reads its own
        # boxes, so skip it and keep only the text the review pane displays.
        page_count, pages = _pdf_document_pages(
            document, include_words=False
        )
        native_text = "\n\n".join(page["rawText"] for page in pages)
        native_length = len(re.sub(r"\s+", "", native_text))
        timings["native_text_extraction_ms"] = round(
            (time.perf_counter() - native_started) * 1000, 3
        )

        fields = [
            _normalize_field_config(field)
            for field in profile.get("fields", [])
        ]
        all_labels = [
            label
            for item in fields
            for label in item.get("contentRules", {}).get("labels", [])
            if isinstance(label, str)
        ]
        label_similarity_threshold = _label_similarity_threshold(
            extraction_settings
        )
        ocr_settings = profile.get("ocrSettings", {})

        form_started = time.perf_counter()
        widgets_by_page = {}
        # TODO(roi-filename): filename-vs-content reconciliation is deferred. ROI
        # diagnostics therefore never produce a filename/PDF conflict or a
        # MISMATCH priority outcome, even for `filename_first`/`strict_match`
        # profiles. Correctness of the read is unaffected; only corroboration
        # is missing. Add reconciliation in a follow-up.
        for widget in _collect_form_fields(document, schema_pages):
            widgets_by_page.setdefault(
                widget["pageNumber"] - 1, []
            ).append(widget)
        timings["form_field_extraction_ms"] = round(
            (time.perf_counter() - form_started) * 1000, 3
        )
        timings["form_field_count"] = sum(
            len(widgets) for widgets in widgets_by_page.values()
        )

        field_started = time.perf_counter()
        diagnostics = {}
        values = {}
        used_ocr = False
        for field in fields:
            field_id = field["id"]
            boxes = rois.get(field_id, [])
            raw, tier, page_number, confidence = "", None, None, 0.0
            if not boxes:
                diagnostics[field_id] = _build_roi_diagnostic(
                    field, "", None, None, 0.0
                )
                diagnostics[field_id]["explanation"] = (
                    "No region is annotated for this field in the profile "
                    "schema."
                )
                values[field_id] = ""
                continue
            for page_index, rect in boxes:
                page = document.load_page(page_index)
                clipped = rect & page.rect
                if clipped.is_empty:
                    continue
                try:
                    candidate, candidate_tier, candidate_confidence = _read_roi(
                        page,
                        clipped,
                        widgets_by_page.get(page_index, []),
                        all_labels,
                        label_similarity_threshold,
                        ocr_settings,
                        timings,
                    )
                except pytesseract.TesseractNotFoundError:
                    ocr_error = ocr_error or (
                        "Tesseract OCR is enabled for this profile but is not "
                        "installed or configured."
                    )
                    continue
                except pytesseract.TesseractError as exc:
                    ocr_error = ocr_error or f"OCR failed: {exc}"
                    continue
                if candidate:
                    raw = candidate
                    tier = candidate_tier
                    page_number = page_index + 1
                    confidence = candidate_confidence
                    break
            diagnostic = _build_roi_diagnostic(
                field, raw, tier, page_number, confidence
            )
            if not raw and ocr_error and _ocr_fallback_enabled(ocr_settings):
                diagnostic["explanation"] = (
                    f"{diagnostic['explanation']} {ocr_error}"
                )
            diagnostics[field_id] = diagnostic
            values[field_id] = diagnostic["finalValue"]
            used_ocr = used_ocr or (tier == "ocr" and bool(raw))
        timings["field_extraction_ms"] = round(
            (time.perf_counter() - field_started) * 1000, 3
        )

    timings.update(
        {
            "page_count": page_count,
            "pages_extracted": len(pages),
            "page_scope": "roi",
            "roi_field_count": len(rois),
            "roi_pages": [page_index + 1 for page_index in schema_pages],
            "roi_ocr_field_count": sum(
                1 for item in diagnostics.values()
                if item.get("roiTier") == "ocr"
            ),
        }
    )
    timings["total_processing_ms"] = round(
        (time.perf_counter() - total_started) * 1000, 3
    )
    return {
        "pageCount": page_count,
        "rawPdfText": native_text,
        "pdfTextLength": native_length,
        "diagnostics": diagnostics,
        "finalValues": values,
        "extractionMethodUsed": (
            "OCR_EXTRACTED" if used_ocr else "NATIVE_PDF_TEXT"
        ),
        "ocrError": ocr_error,
        "ocrSpaceError": "",
        "aiError": "",
        "processingMetrics": timings,
    }
