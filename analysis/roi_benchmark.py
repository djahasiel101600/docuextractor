"""Benchmark the reference ROI extractor against the label-anchored pipeline.

Corpus: the archived PDFs under storage/. Form type is detected from page-1
text, because the stored files were renamed to opaque ids; the matching profile
is taken from the database.

Ground truth: the AcroForm widget value the production form tier assigned to a
field (the convention analysis/validate_accuracy.py uses). The ROI for a field
is that widget's own rectangle -- the geometry an annotator draws around the
field on the form.

Two ROI variants are reported because they answer different questions:

  roi_all   reference extraction.py as written (widget -> textbox -> words)
  roi_text  the same ROIs with the widget tier disabled. This is what happens
            on flattened or scanned forms, where no AcroForm data exists, and
            it is the only variant that can be worse than the label pipeline.

OCR and AI are disabled so the run is deterministic and offline.

Run from the repo root:  node scripts/python.js analysis/roi_benchmark.py
"""

import importlib.util
import json
import os
import re
import sqlite3
import sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))
os.environ.setdefault("DJANGO_DEBUG", "true")
os.environ.setdefault("DJANGO_SECRET_KEY", "roi-benchmark-only")
os.environ.setdefault("DATABASE_URL", "sqlite:///:memory:")
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")
# No tables exist in the in-memory database, so the recovery thread would only
# log errors while the corpus is being scored.
os.environ.setdefault("DOCUEXTRACT_RECOVER_JOBS", "0")
import django  # noqa: E402

django.setup()

import fitz  # noqa: E402
from django.conf import settings  # noqa: E402

from extraction.services.document_extraction import (  # noqa: E402
    _collect_form_fields,
    process_pdf,
)

settings.OCR_ENABLED = False

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

DB_PATH = ROOT / "storage" / "docuextract.sqlite3"
REFERENCE_PATH = ROOT / "analysis" / "reference" / "extraction.py"
MAX_DOCUMENTS = int(os.environ.get("ROI_BENCH_LIMIT", "0"))

FORM_MARKERS = {
    "w8": ("form w-8ben", "certificate of foreign status", "w-8ben"),
    "w9": ("form w-9", "request for taxpayer identification"),
}

CATEGORIES = (
    ("ssn_tin", ("ssn", "tin", "social", "taxpayer", "identifying")),
    ("date", ("date", "dob", "birth", "expiry", "expiration", "issued")),
    ("address", ("address", "street", "city", "state", "zip", "postal",
                 "country", "province", "residence")),
    ("name", ("name", "surname", "first", "last", "middle", "full")),
    ("id_number", ("number", "account", "employee_id", "identifier",
                   "reference")),
)


def load_reference():
    """Import analysis/reference/extraction.py without making it a package."""
    spec = importlib.util.spec_from_file_location(
        "reference_extraction", REFERENCE_PATH)
    module = importlib.util.module_from_spec(spec)
    # Register before exec: @dataclass resolves annotations through
    # sys.modules[cls.__module__], which is absent for a bare module.
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def load_profiles():
    """Map form type -> profile configuration using the field ids."""
    connection = sqlite3.connect(DB_PATH)
    connection.row_factory = sqlite3.Row
    profiles = {}
    try:
        for row in connection.execute(
                "SELECT configuration FROM extraction_extractionprofile"):
            config = json.loads(row["configuration"] or "{}")
            field_ids = {field.get("id", "")
                         for field in config.get("fields", [])}
            if "name_of_individual_who_is_the_beneficial_owner" in field_ids:
                profiles.setdefault("w8", config)
            elif "name_of_entity_individual" in field_ids:
                profiles.setdefault("w9", config)
    finally:
        connection.close()
    return profiles


def detect_form_type(text):
    folded = text.casefold()
    for form_type, needles in FORM_MARKERS.items():
        if any(needle in folded for needle in needles):
            return form_type
    return None


def categorize(field_id, field_name, widget_kind):
    if widget_kind == "CheckBox":
        return "checkbox"
    haystack = f"{field_id} {field_name}".casefold()
    for category, keywords in CATEGORIES:
        if any(keyword in haystack for keyword in keywords):
            return category
    return "other"


def fold(value):
    return re.sub(r"\s+", " ", str(value or "")).strip().casefold()


def same(left, right):
    left_folded, right_folded = fold(left), fold(right)
    return bool(left_folded) and left_folded == right_folded


def contains(captured, truth):
    truth_folded = fold(truth)
    return bool(truth_folded) and truth_folded in fold(captured)


def build_schema(rects):
    pages = defaultdict(list)
    for field_id, page_number, rect in rects:
        pages[page_number].append(
            {
                "name": field_id,
                "bbox_pdf_pt": {
                    "x0": rect[0], "y0": rect[1],
                    "x1": rect[2], "y1": rect[3],
                },
            }
        )
    return {
        "coordinate_system": "PDF points, origin top-left (PyMuPDF convention)",
        "pages": [
            {"page": page, "fields": fields}
            for page, fields in sorted(pages.items())
        ],
    }


def pick_widget(widgets, truth, field_id):
    """Return the widget holding `truth`, or None when the box is ambiguous."""
    candidates = [widget for widget in widgets if same(widget["value"], truth)]
    if len(candidates) == 1:
        return candidates[0]
    if not candidates:
        return None
    # Same value in several boxes (Yes/No, repeated dates): prefer the widget
    # whose name shares a token with the field id, otherwise refuse to guess.
    tokens = {token for token in re.split(r"[^a-z0-9]+", field_id.casefold())
              if len(token) > 2}
    scored = [
        (len(tokens & set(
            re.split(r"[^a-z0-9]+", widget["name"].casefold()))), widget)
        for widget in candidates
    ]
    scored.sort(key=lambda item: item[0], reverse=True)
    if scored[0][0] > scored[1][0]:
        return scored[0][1]
    return None


def main():
    reference = load_reference()
    profiles = load_profiles()
    print(f"profiles detected: {sorted(profiles)}")

    paths = sorted((ROOT / "storage").rglob("*.pdf"))
    if MAX_DOCUMENTS:
        paths = paths[:MAX_DOCUMENTS]

    tallies = defaultdict(Counter)
    details = []
    tally_by_form = Counter()
    skipped = Counter()
    seen_hashes = set()

    for path in paths:
        pdf_bytes = path.read_bytes()
        digest = __import__("hashlib").sha256(pdf_bytes).hexdigest()
        if digest in seen_hashes:
            skipped["duplicate"] += 1
            continue
        seen_hashes.add(digest)

        document = fitz.open(stream=pdf_bytes, filetype="pdf")
        try:
            page_text = " ".join(
                document.load_page(index).get_text("text")
                for index in range(min(2, document.page_count))
            )
            form_type = detect_form_type(page_text)
            if form_type is None or form_type not in profiles:
                skipped["no matching profile"] += 1
                continue

            profile = json.loads(json.dumps(profiles[form_type]))
            profile.setdefault("aiSettings", {})["enabled"] = False
            profile.setdefault("ocrSettings", {})["enabledFallback"] = False

            try:
                extracted = process_pdf(pdf_bytes, path.name, profile)
            except Exception as exc:  # noqa: BLE001 - report, never abort
                skipped["pipeline error"] += 1
                print(f"  ! {path.name}: {type(exc).__name__}: {exc}")
                continue

            widgets = _collect_form_fields(document)
            rects = []
            kinds = {}
            unmappable = 0
            for field_id, diagnostic in extracted["diagnostics"].items():
                truth = diagnostic.get("formValue")
                if not truth:
                    continue
                widget = pick_widget(widgets, truth, field_id)
                if widget is None:
                    unmappable += 1
                    continue
                rects.append(
                    (field_id, widget["pageNumber"],
                     (widget["x0"], widget["y0"], widget["x1"], widget["y1"]))
                )
                kinds[field_id] = (widget["kind"], diagnostic.get("fieldName"))
            if not rects:
                skipped["no usable ground truth"] += 1
                continue

            schema = build_schema(rects)
            roi_all = reference._extract_from_open_doc(document, schema)
            collect_widgets = reference._collect_widgets
            reference._collect_widgets = lambda page: []
            try:
                roi_text = reference._extract_from_open_doc(document, schema)
            finally:
                reference._collect_widgets = collect_widgets
        finally:
            document.close()

        tally_by_form[form_type] += 1
        for field_id, _page, _rect in rects:
            diagnostic = extracted["diagnostics"][field_id]
            truth = diagnostic.get("formValue")
            kind, field_name = kinds[field_id]
            category = categorize(field_id, field_name or "", kind)
            labels_value = diagnostic.get("finalValue")
            bucket = tallies[category]
            bucket["fields"] += 1
            bucket["labels_hit"] += int(same(labels_value, truth))
            bucket["labels_empty"] += int(not labels_value)
            bucket["roi_all_hit"] += int(
                same(roi_all.get(field_id, {}).get("value"), truth))
            bucket["roi_text_hit"] += int(
                same(roi_text.get(field_id, {}).get("value"), truth))
            bucket["roi_text_contains"] += int(
                contains(roi_text.get(field_id, {}).get("value"), truth))
            bucket["roi_text_empty"] += int(
                not roi_text.get(field_id, {}).get("value"))
            details.append(
                {
                    "document": path.name,
                    "form": form_type,
                    "field": field_id,
                    "category": category,
                    "widget_kind": kind,
                    "truth": truth,
                    "labels": labels_value,
                    "roi_all": roi_all.get(field_id, {}).get("value"),
                    "roi_text": roi_text.get(field_id, {}).get("value"),
                }
            )

    print(f"documents used: {dict(tally_by_form)}   skipped: {dict(skipped)}")
    print()
    print("=" * 92)
    print(f"{'category':<12}{'n':>5}{'labels':>9}{'roi_all':>9}"
          f"{'roi_text':>10}{'roi_text_has':>14}{'roi_empty':>11}")
    print("-" * 92)
    totals = Counter()
    for category in sorted(tallies):
        bucket = tallies[category]
        count = bucket["fields"]
        totals.update(bucket)
        print(
            f"{category:<12}{count:>5}"
            f"{bucket['labels_hit'] / count:>9.1%}"
            f"{bucket['roi_all_hit'] / count:>9.1%}"
            f"{bucket['roi_text_hit'] / count:>10.1%}"
            f"{bucket['roi_text_contains'] / count:>14.1%}"
            f"{bucket['roi_text_empty'] / count:>11.1%}"
        )
    count = totals["fields"] or 1
    print("-" * 92)
    print(
        f"{'ALL':<12}{totals['fields']:>5}"
        f"{totals['labels_hit'] / count:>9.1%}"
        f"{totals['roi_all_hit'] / count:>9.1%}"
        f"{totals['roi_text_hit'] / count:>10.1%}"
        f"{totals['roi_text_contains'] / count:>14.1%}"
        f"{totals['roi_text_empty'] / count:>11.1%}"
    )
    print("=" * 92)
    print("roi_text_has = the true value appears inside the ROI capture, exact"
          " match not required")

    output = ROOT / "analysis" / "roi_benchmark_results.json"
    output.write_text(
        json.dumps(
            {
                "documents": dict(tally_by_form),
                "skipped": dict(skipped),
                "fields": totals["fields"],
                "categories": {
                    category: dict(bucket) for category, bucket in tallies.items()
                },
                "details": details,
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    print(f"Detail written to {output.relative_to(ROOT)}")

    worse = [
        item for item in details
        if same(item["labels"], item["truth"])
        and not same(item["roi_text"], item["truth"])
    ]
    better = [
        item for item in details
        if same(item["roi_text"], item["truth"])
        and not same(item["labels"], item["truth"])
    ]
    print(f"\nROI-by-text worse than labels: {len(worse)} of {len(details)}"
          " fields (first 10)")
    for item in worse[:10]:
        print(
            f"  {item['category']:<10} {item['field']:<28}"
            f"truth={item['truth']!r:<24} roi={item['roi_text']!r}"
        )

    print(f"\nROI-by-text better than labels: {len(better)} of {len(details)}"
          " fields")
    for item in better[:10]:
        print(
            f"  {item['category']:<10} {item['field']:<28}"
            f"truth={item['truth']!r:<24} labels={item['labels']!r}"
        )


if __name__ == "__main__":
    main()
