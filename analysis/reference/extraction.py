"""
extraction.py
-------------
Apply a field schema (produced by pdf_annotator.py) to a filled PDF and
extract the value inside each annotated bounding box.

REFERENCE IMPLEMENTATION — NOT PRODUCTION CODE.
Reference for:
  - tier order (widget → textbox → word-intersection → OCR)
  - ROI safety expansions
  - widget overlap threshold
  - normalization rules (dates, checkboxes, whitespace)
  - source-provenance reporting

Usage:
    from extraction import load_schema, extract_values
    schema = load_schema("field_schema.json")
    results = extract_values("filled_form.pdf", schema)
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, asdict
from typing import Any, Dict, List, Optional

import fitz  # PyMuPDF


# ---------------------------------------------------------------------------
# Schema loading
# ---------------------------------------------------------------------------

def load_schema(path: str) -> Dict[str, Any]:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


# ---------------------------------------------------------------------------
# Result model
# ---------------------------------------------------------------------------

@dataclass
class FieldResult:
    name: str
    page: int                       # 1-based
    bbox_pdf_pt: Dict[str, float]
    raw_text: str                   # pre-normalization
    value: str                      # normalized
    confidence: float
    source: str                     # 'widget' | 'textbox' | 'fallback'
    notes: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


# ---------------------------------------------------------------------------
# Core extraction
# ---------------------------------------------------------------------------

def extract_values(pdf_path: str, schema: Dict[str, Any]) -> Dict[str, dict]:
    doc = fitz.open(pdf_path)
    try:
        return _extract_from_open_doc(doc, schema)
    finally:
        doc.close()


def _extract_from_open_doc(
    doc: "fitz.Document", schema: Dict[str, Any]
) -> Dict[str, dict]:
    results: Dict[str, dict] = {}
    for page_entry in schema.get("pages", []):
        page_num = page_entry["page"]
        if page_num < 1 or page_num > doc.page_count:
            continue
        page = doc.load_page(page_num - 1)
        widgets = _collect_widgets(page)
        for f in page_entry["fields"]:
            bbox = f["bbox_pdf_pt"]
            rect = fitz.Rect(bbox["x0"], bbox["y0"], bbox["x1"], bbox["y1"])
            result = _extract_one(page, f["name"], page_num, rect, widgets)
            results[f["name"]] = result.to_dict()
    return results


def _collect_widgets(page: fitz.Page) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    try:
        for w in page.widgets() or []:
            out.append({
                "rect": fitz.Rect(w.rect),
                "field_name": w.field_name or "",
                "field_type": w.field_type_string or "",
                "value": w.field_value if w.field_value is not None else "",
            })
    except Exception:
        pass
    return out


def _extract_one(
    page: fitz.Page,
    name: str,
    page_num: int,
    rect: fitz.Rect,
    widgets: List[Dict[str, Any]],
) -> FieldResult:
    bbox_dict = {"x0": rect.x0, "y0": rect.y0, "x1": rect.x1, "y1": rect.y1}

    # Tier 1: AcroForm widget overlap
    widget_hit = _find_widget_for_rect(rect, widgets)
    if widget_hit is not None:
        raw = str(widget_hit["value"]).strip()
        value = _normalize_value(raw)
        conf = 1.0 if raw else 0.0
        return FieldResult(
            name=name, page=page_num, bbox_pdf_pt=bbox_dict,
            raw_text=raw, value=value, confidence=conf,
            source="widget",
            notes=f"AcroForm field '{widget_hit['field_name']}' "
            f"({widget_hit['field_type']})",
        )

    # Tier 2: textbox (glyph anchor inside ROI)
    expanded = _expand(rect, x_pad=1.0, y_pad=2.0)
    raw = (page.get_textbox(expanded) or "").strip()

    # Tier 3: word-intersection fallback
    if not raw:
        raw = _word_intersect_text(page, expanded).strip()

    value = _normalize_value(raw)
    conf = _confidence(raw)
    source = "textbox" if raw else "fallback"
    notes = "" if raw else "No text found inside region"

    return FieldResult(
        name=name, page=page_num, bbox_pdf_pt=bbox_dict,
        raw_text=raw, value=value, confidence=conf,
        source=source, notes=notes,
    )


def _find_widget_for_rect(
    rect: fitz.Rect, widgets: List[Dict[str, Any]]
) -> Optional[Dict[str, Any]]:
    """Return the widget whose rect has ≥30% overlap with `rect`, if any."""
    best, best_area = None, 0.0
    rect_area = max(rect.width * rect.height, 1e-6)
    for w in widgets:
        inter = rect & w["rect"]
        if inter.is_empty:
            continue
        area = inter.width * inter.height
        if area / rect_area >= 0.30 and area > best_area:
            best, best_area = w, area
    return best


def _word_intersect_text(page: fitz.Page, rect: fitz.Rect) -> str:
    words = page.get_text("words") or []
    hits = []
    for w in words:
        wr = fitz.Rect(w[:4])
        if wr.intersects(rect):
            hits.append((wr.y0, wr.x0, w[4]))
    hits.sort()
    return " ".join(t[2] for t in hits)


def _expand(rect: fitz.Rect, x_pad: float, y_pad: float) -> fitz.Rect:
    return fitz.Rect(
        rect.x0 - x_pad, rect.y0 - y_pad,
        rect.x1 + x_pad, rect.y1 + y_pad,
    )


def _confidence(raw: str) -> float:
    if not raw:
        return 0.0
    if len(raw) <= 1:
        return 0.6
    if len(raw) > 200:
        return 0.7
    return 0.9


# ---------------------------------------------------------------------------
# Normalization
# ---------------------------------------------------------------------------

_DATE_ISO = re.compile(r"(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})")
_DATE_SLASH = re.compile(r"(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})")


def _normalize_value(raw: str) -> str:
    if not raw:
        return ""
    s = re.sub(r"\s+", " ", raw).strip()
    s = re.sub(r"^[:\-–—\s]+|[:\-–—\s]+$", "", s).strip()

    lowered = s.lower()
    if lowered in {"x", "✓", "✔", "[x]", "yes", "true", "y"}:
        return "true"
    if lowered in {"", "[ ]", "no", "false", "n"}:
        return "false"

    m = _DATE_ISO.match(s)
    if m:
        y, mo, d = m.group(1), m.group(2).zfill(2), m.group(3).zfill(2)
        return f"{y}-{mo}-{d}"
    m = _DATE_SLASH.match(s)
    if m:
        a, b, y = int(m.group(1)), int(m.group(2)), m.group(3)
        if a > 12:                       # definitely day-first
            d, mo = a, b
        elif b > 12:                     # definitely month-first
            d, mo = b, a
        else:                            # ambiguous — default day-first
            d, mo = a, b
        return f"{y}-{mo:02d}-{d:02d}"

    return s
