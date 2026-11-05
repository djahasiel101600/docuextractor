"""Blank-form authoring support.

Analyzes an empty (or sample-filled) AcroForm PDF so the UI can offer every
discoverable widget as a candidate for a new extraction profile. This module
is deliberately read-only: it never touches jobs, documents, or stored
profiles, and it reuses the same widget/row primitives as the extraction
engine so discovered label text is verbatim what the matcher will see later.
"""

import re

import fitz
from django.conf import settings
from rest_framework.exceptions import ValidationError

from .document_extraction import (
    _group_words_into_rows,
    _pdf_document_pages,
)

# Maximum centerline gap (pt) between a widget and a same-row text run before
# the run stops being considered its label. generous but bounded so distant
# column headers are not grabbed.
SAME_ROW_LABEL_GAP = 220.0
# Maximum vertical gap (pt, text-row center to widget top edge) for labels
# printed directly above a widget. Deliberately tight: long instruction
# paragraphs above a field must not outrank the widget's own row label.
ABOVE_LABEL_GAP = 30.0
# Longest label text kept as a candidate; government forms print genuinely
# long instruction-style labels and those must survive verbatim.
MAX_LABEL_CHARS = 260

# Keyword table used to suggest a field type/validation for a widget. Tokens
# are matched against the widget's field name, alternate label and nearby
# static text; earlier entries win.
_SUGGESTION_RULES = [
    (
        ("ssn", "social security", "taxpayer", "tax payer", "tin", "ein"),
        {"fieldType": "text", "name": "SSN/TIN", "minLength": 5,
         "validationRegex": r"^\d{3}-\d{2}-\d{4}$|^\d{9}$",
         "caseTransform": "uppercase"},
    ),
    (
        ("routing",),
        {"fieldType": "text", "name": "Routing Number", "minLength": 9,
         "validationRegex": r"^\d{9}$", "caseTransform": "none"},
    ),
    (
        ("account number", "account no"),
        {"fieldType": "text", "name": "Account Number", "minLength": 4,
         "caseTransform": "none"},
    ),
    (
        ("date of birth", "dob", "birthdate", "birthday"),
        {"fieldType": "date", "name": "Date of Birth"},
    ),
    (
        ("expiration", "expiry", "entered"),
        {"fieldType": "date", "name": "Expiration Date"},
    ),
    (
        ("name of individual", "beneficial owner", "applicant name",
         "candidate name", "full name", "legal name", "tax name", "name"),
        {"fieldType": "text", "name": "Name", "minLength": 3,
         "caseTransform": "titlecase"},
    ),
    (
        ("address", "street", "rural route", "suite no"),
        {"fieldType": "address", "name": "Address"},
    ),
    (("city", "town"), {"fieldType": "text", "name": "City"}),
    (("country", "nation"), {"fieldType": "text", "name": "Country"}),
    (
        ("state county", "state code", "province", "region"),
        {"fieldType": "text", "name": "State/Province"},
    ),
    (
        ("zip", "postal"),
        {"fieldType": "text", "name": "Postal Code", "minLength": 3,
         "validationRegex": r"^[A-Za-z0-9 \-]{3,12}$",
         "caseTransform": "uppercase"},
    ),
    (
        ("phone", "telephone", "mobile", "fax"),
        {"fieldType": "phone", "name": "Phone", "minLength": 7},
    ),
    (
        ("e-mail", "email"),
        {"fieldType": "email", "name": "Email", "minLength": 5,
         "validationRegex": r"^[^@\s]+@[^@\s]+\.[^@\s]+$"},
    ),
    (
        ("date", "dt"),
        {"fieldType": "date", "name": "Date"},
    ),
    (("sin", "reference number"),
     {"fieldType": "text", "name": "Reference Number", "minLength": 5}),
]

_FIELD_TYPE_TO_KIND = {
    "Text": "text",
    "ComboBox": "combo",
    "ListBox": "list",
    "PushButton": "button",
    "CheckBox": "checkbox",
    "RadioButton": "radio",
    "Signature": "signature",
}

_ALLOWED_PROFILE_TYPES = {"text", "date", "number",
                          "status", "email", "phone", "address"}
_ALLOWED_PRIORITIES = {"pdf_first",
                       "filename_first", "strict_match", "consensus"}


def _widget_keywords(widget):
    parts = [
        widget.get("fieldName") or "",
        (widget.get("fieldLabel") or "").strip(),
        *(label["text"] for label in widget.get("labels", [])[:2]),
    ]
    return " ".join(parts).casefold()


def _suggest_for_widget(widget):
    haystack = _widget_keywords(widget)
    for keywords, suggestion in _SUGGESTION_RULES:
        for keyword in keywords:
            if keyword in haystack:
                result = dict(suggestion)
                result["confidence"] = 0.85 if keyword in (
                    widget.get("fieldName") or ""
                ).casefold() or keyword in (
                    widget.get("fieldLabel") or ""
                ).casefold() else 0.6
                result["reason"] = f"matched keyword {keyword!r} in form context"
                return result
    kind = widget.get("kind")
    if kind in ("checkbox", "radio"):
        return {"fieldType": "status", "name": "", "confidence": 0.5,
                "reason": "selection widget"}
    return {"fieldType": "text", "name": "", "confidence": 0.0,
            "reason": "no keyword evidence"}


def _collect_label_candidates(rows, widget_rect, page_widgets):
    """Static text runs that plausibly label a widget: same row to its left,
    or a run printed directly above it. Words inside the widget's own rect
    (prefilled values render there) are excluded."""
    x0, y0, x1, y1 = widget_rect
    cy = (y0 + y1) / 2
    same_row = []
    above = []
    for row in rows:
        row_cy = (row["y0"] + row["y1"]) / 2
        words = [
            word
            for word in row["words"]
            if not (
                word["x0"] < x1 - 2 and word["x1"] > x0 + 2
                and word["y0"] < y1 - 2 and word["y1"] > y0 + 2
            )
        ]
        if not words:
            continue
        if abs(row_cy - cy) <= max((y1 - y0) / 2, (row["y1"] - row["y0"]) / 2) + 3:
            left_words = [
                word for word in words
                if word["x1"] <= x0 + 2 and x0 - word["x1"] <= SAME_ROW_LABEL_GAP
            ]
            if left_words:
                text = " ".join(word["text"] for word in left_words).strip()
                if 1 < len(text) <= MAX_LABEL_CHARS:
                    gap = x0 - left_words[-1]["x1"]
                    same_row.append({
                        "text": text, "placement": "same_row",
                        "distance": round(max(gap, 0.0), 1),
                    })
            continue
        if y0 - row_cy > 0 and y0 - row_cy <= ABOVE_LABEL_GAP:
            overlap = min(x1, max(word["x1"] for word in words)) - max(
                x0, min(word["x0"] for word in words)
            )
            if overlap >= 10:
                text = " ".join(word["text"] for word in words).strip()
                if 1 < len(text) <= MAX_LABEL_CHARS:
                    above.append({
                        "text": text, "placement": "above",
                        "distance": round(y0 - row_cy, 1),
                    })
    candidates = sorted(same_row, key=lambda item: item["distance"]) + sorted(
        above, key=lambda item: item["distance"]
    )
    # Same-text duplicates (fragment rows) collapse; order encodes confidence.
    unique = []
    seen = set()
    for item in candidates:
        key = item["text"].casefold()
        if key in seen:
            continue
        seen.add(key)
        unique.append(item)
    return unique[:3]


def analyze_blank_form(pdf_bytes):
    """Discover every AcroForm widget in a PDF with its spatial labels.

    Returns a JSON-serializable layout map plus authoring warnings. Raises a
    DRF ValidationError for unusable inputs (encrypted, oversized, corrupt).
    """
    try:
        document = fitz.open(stream=pdf_bytes, filetype="pdf")
    except (fitz.FileDataError, RuntimeError) as exc:
        raise ValidationError(
            "The PDF could not be opened; it may be encrypted or corrupted."
        ) from exc
    try:
        return _analyze_open_document(document)
    except ValidationError:
        raise
    except RuntimeError as exc:
        # PyMuPDF is not thread-safe; under concurrent load a low-level call
        # can abort with a RuntimeError instead of returning data.
        raise ValidationError(
            "The PDF form could not be read (" + str(exc) + "). "
            "Retry the upload; if this persists, the file may be corrupted."
        ) from exc
    finally:
        document.close()


def _analyze_open_document(document):
    """Widget/label discovery for an opened fitz document. The caller owns
    closing; a second close() on a fitz document raises ValueError."""
    if document.is_encrypted:
        raise ValidationError(
            "Password-protected PDF files are not supported.")
    if document.page_count > settings.MAX_PDF_PAGES:
        raise ValidationError("The PDF exceeds the configured page limit.")

    page_count, pages = _pdf_document_pages(document)
    rows_by_page = {}
    for page in pages:
        rows_by_page[page["pageNumber"]] = _group_words_into_rows(
            page.get("words", [])
        )

    warnings = []
    widgets_by_key = {}
    order = []
    prefilled = 0
    for page_index, page in enumerate(document):
        for widget in page.widgets() or []:
            try:
                kind = _FIELD_TYPE_TO_KIND.get(
                    widget.field_type_string,
                    (widget.field_type_string or "unknown").lower(),
                )
                raw_value = widget.field_value
                rect = widget.rect
            except Exception:
                continue
            name = widget.field_name or ""
            key = (page_index, name)
            rect_box = [
                round(float(rect.x0), 1), round(float(rect.y0), 1),
                round(float(rect.x1), 1), round(float(rect.y1), 1),
            ]
            value = raw_value if isinstance(raw_value, str) else (
                "Yes" if raw_value in (True, 1) else None
            )
            if value and value.casefold() != "off":
                prefilled += 1
            options = []
            if kind in ("checkbox", "radio"):
                try:
                    states = widget.button_states() or {}
                    options = sorted(
                        str(item) for item in states.get("on", ())
                        if str(item).lower() != "off"
                    )
                except Exception:
                    options = []
            entry = widgets_by_key.get(key)
            if entry is None:
                entry = {
                    "id": f"p{page_index + 1}-w{len(order):03d}",
                    "fieldName": name,
                    "fieldLabel": (widget.field_label or "").strip(),
                    "kind": kind,
                    "pageNumber": page_index + 1,
                    "rect": rect_box,
                    "prefilledValue": value if value and value.casefold() != "off" else None,
                    "textMaxLength": getattr(widget, "text_maxlen", None) or None,
                    "options": options,
                    "onStates": options,
                }
                widgets_by_key[key] = entry
                order.append(entry)
            else:
                # Radio groups: one annotation per export option.
                for option in options:
                    if option not in entry["options"]:
                        entry["options"].append(option)
                        if entry["onStates"] is not None and option not in entry["onStates"]:
                            entry["onStates"].append(option)
                if entry["prefilledValue"] is None and value and value.casefold() != "off":
                    entry["prefilledValue"] = value

    for entry in order:
        page_rows = rows_by_page.get(entry["pageNumber"], [])
        entry["labels"] = _collect_label_candidates(
            page_rows, entry["rect"], []
        )
        entry["suggestion"] = _suggest_for_widget(entry)
        if not entry["labels"] and not entry["fieldLabel"]:
            warnings.append(
                f"{entry['id']} ({entry['fieldName'] or 'unnamed'} on page "
                f"{entry['pageNumber']}) has no detectable label text."
            )

    signature_count = sum(1 for entry in order if entry["kind"] == "signature")
    if not order:
        warnings.append(
            "No AcroForm fields were found. This PDF looks like a static "
            "print-and-sign document; profile generation needs fillable "
            "widgets."
        )
    if prefilled:
        warnings.append(
            f"{prefilled} widget(s) already contain values. A blank copy "
            "of the form produces the cleanest profile; prefilled values "
            "are shown as hints only."
        )
    if signature_count:
        warnings.append(
            f"{signature_count} signature widget(s) were skipped from "
            "label detection (they never carry extractable text)."
        )

    return {
        "pageCount": page_count,
        "pages": [
            {
                "pageNumber": page["pageNumber"],
                "width": round(float(page.get("width", 0)), 1),
                "height": round(float(page.get("height", 0)), 1),
            }
            for page in pages
        ],
        "widgets": order,
        "widgetCount": len(order),
        "prefilledCount": prefilled,
        "isBlank": prefilled == 0,
        "warnings": warnings,
    }


def validate_profile_config(data):
    """Structural validation for a candidate profile (frontend shape).

    Returns a list of human-readable errors; empty means the profile is
    well-formed. Purely additive: it is NOT wired into the existing
    POST /api/profiles/ flow so current save behavior is unchanged.
    """
    errors = []
    if not isinstance(data, dict):
        return ["Profile payload must be a JSON object."]
    fields = data.get("fields")
    if not isinstance(fields, list) or not fields:
        errors.append("Profile must define at least one field.")
        return errors
    seen_ids = set()
    for index, field in enumerate(fields):
        if not isinstance(field, dict):
            errors.append(f"Field #{index + 1} must be an object.")
            continue
        field_id = field.get("id")
        label = field_id or f"field #{index + 1}"
        if not isinstance(field_id, str) or not field_id.strip():
            errors.append(f"Field #{index + 1}: missing id.")
        elif field_id in seen_ids:
            errors.append(f"Field {label}: duplicate field id.")
        else:
            seen_ids.add(field_id)
        if field.get("type") not in _ALLOWED_PROFILE_TYPES:
            errors.append(
                f"Field {label}: unknown type {field.get('type')!r}.")
        if field.get("priority") not in _ALLOWED_PRIORITIES:
            errors.append(
                f"Field {label}: unknown priority {field.get('priority')!r}."
            )
        content_rules = field.get("contentRules") or {}
        if content_rules.get("enabled"):
            labels = content_rules.get("labels")
            if not isinstance(labels, list) or not [
                item for item in labels if isinstance(item, str) and item.strip()
            ]:
                errors.append(f"Field {label}: content rules need labels.")
            for pattern in content_rules.get("regexPatterns") or []:
                _check_regex(pattern, f"Field {label}: content regex", errors)
        filename_rules = field.get("filenameRules") or {}
        if filename_rules.get("enabled"):
            patterns = filename_rules.get("patterns")
            if not isinstance(patterns, list) or not patterns:
                errors.append(f"Field {label}: filename rules need patterns.")
            for pattern in patterns or []:
                _check_regex(pattern, f"Field {label}: filename regex", errors)
        validation = field.get("validation") or {}
        _check_regex(
            validation.get("formatRegex"),
            f"Field {label}: validation regex",
            errors,
        )
        min_length = validation.get("minLength")
        max_length = validation.get("maxLength")
        if min_length is not None and (
            not isinstance(min_length, int) or min_length < 0
        ):
            errors.append(f"Field {label}: minLength must be >= 0.")
        if max_length is not None and (
            not isinstance(max_length, int) or max_length <= 0
        ):
            errors.append(f"Field {label}: maxLength must be > 0.")
        if (
            isinstance(min_length, int)
            and isinstance(max_length, int)
            and max_length < min_length
        ):
            errors.append(f"Field {label}: maxLength is below minLength.")
    return errors


def _check_regex(pattern, context, errors):
    if not isinstance(pattern, str) or not pattern:
        return
    try:
        re.compile(pattern)
    except re.error as exc:
        errors.append(f"{context} {pattern!r} is invalid ({exc.msg}).")
