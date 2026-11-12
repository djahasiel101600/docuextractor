"""Round 3: production ROI extraction vs the label pipeline, with the fixes.

Round 2 (analysis/roi_benchmark.py) scored the *reference* implementation and
therefore measured the reference's bugs: ISO date coercion, unconditional
checkbox mapping, and label bleed into the capture. This round scores the
shipped `process_pdf_roi` together with the shipped normalization, so the
numbers answer what the product will do.

Two comparisons:

  A. AcroForm corpus, both modes on the original files. Answers: is ROI at
     least as accurate as label matching where widgets exist?

  B. A subset flattened with Document.bake(), saved under analysis/flattened/
     so the result is reproducible. Widgets are gone and only the text layer
     remains. Answers: which mode can still extract, and how accurately?

Ground truth is the widget value the form tier assigned (the round-2
convention), and each ROI is that widget's own rectangle. That makes the ROI
geometry annotation-perfect, so these numbers are an upper bound on ROI
accuracy: a real annotator draws by hand.

OCR and AI are disabled so the run is offline and deterministic.

Run from the repo root:
    node scripts/python.js analysis/roi_benchmark_round3.py
"""

import json
import os
import re
import sqlite3
import sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

os.environ.setdefault("DJANGO_DEBUG", "true")
os.environ.setdefault("DJANGO_SECRET_KEY", "roi-benchmark-only")
os.environ.setdefault("DATABASE_URL", "sqlite:///:memory:")
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")
os.environ.setdefault("DOCUEXTRACT_RECOVER_JOBS", "0")

import django  # noqa: E402

django.setup()

import fitz  # noqa: E402
from django.conf import settings  # noqa: E402

from extraction.services.document_extraction import (  # noqa: E402
    _collect_form_fields,
    _normalize_checkbox,
    process_pdf,
)
from extraction.services.roi_extraction import process_pdf_roi  # noqa: E402

# Reuse round 2's corpus conventions so the two rounds stay comparable.
import roi_benchmark as base  # noqa: E402

settings.OCR_ENABLED = False

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

FLAT_DIR = ROOT / "analysis" / "flattened"
FLAT_PER_FORM = int(os.environ.get("ROI_FLAT_PER_FORM", "8"))
OUTPUT = ROOT / "analysis" / "roi_benchmark_round3_results.json"

# A profile is recognised by the field ids it declares. Round 2 keyed on one
# hardcoded id per form, which silently stopped matching when the stored W-8
# profile was rebuilt from a blank form with different ids.
FORM_SIGNATURES = {
    "w8": {
        "name_of_individual_who_is_the_beneficial_owner",
        "permanent_residence",
        "permanent_residence_address",
        "country_of_citizenship",
        "signing_confirmation",
    },
    "w9": {
        "name_of_entity_individual",
        "business_name",
        "city_state_zip_code",
    },
}


def load_profiles():
    """Map form type -> the stored profile that declares that form's ids."""
    connection = sqlite3.connect(base.DB_PATH)
    connection.row_factory = sqlite3.Row
    best = {}
    try:
        for row in connection.execute(
            "SELECT configuration FROM extraction_extractionprofile"
        ):
            config = json.loads(row["configuration"] or "{}")
            field_ids = {field.get("id", "") for field in config.get("fields", [])}
            for form_type, signature in FORM_SIGNATURES.items():
                score = len(field_ids & signature)
                if score and score > best.get(form_type, (0, None))[0]:
                    best[form_type] = (score, config)
    finally:
        connection.close()
    return {form: config for form, (_, config) in best.items()}


def _calendar_parts(value):
    numbers = re.findall(r"\d+", str(value or ""))
    if len(numbers) != 3:
        return None
    return tuple(sorted(int(number) for number in numbers))


def compare(category, value, truth):
    """How a capture relates to the truth: exact, equivalent, or not a hit.

    Two equivalences are reported because the ground truth is the raw widget
    string while the pipeline returns the profile's configured output:

      date      the profile may declare a dateFormat (`YYYY-MM-DD`), so a
                correctly read `04-20-2026` comes back `2026-04-20`. Compare
                the calendar components rather than the spelling.
      checkbox  the on-state is an arbitrary export name; `1`, `X` and `\x14`
                are the same answer. Use the shipped mapping on both sides.

    Format-only differences are counted separately from exact matches so the
    table cannot hide a normalization change behind a hit.
    """
    if base.same(value, truth):
        return "exact"
    if category == "date" and _calendar_parts(value) == _calendar_parts(truth):
        return "same_date"
    if category == "checkbox" and value:
        if _normalize_checkbox(str(value)) == _normalize_checkbox(str(truth)):
            return "same_boolean"
    return None


def build_annotation_schema(rects):
    """Production wire shape: pageNumber + fieldId + ordered rect array."""
    pages = defaultdict(list)
    for field_id, page_number, rect in rects:
        pages[page_number].append(
            {
                "fieldId": field_id,
                "rect": [round(float(value), 3) for value in rect],
            }
        )
    return {
        "coordinateSystem": "pdf_points_top_left",
        "pages": [
            {"pageNumber": page, "fields": fields}
            for page, fields in sorted(pages.items())
        ],
    }


def roi_profile(profile, schema):
    clone = json.loads(json.dumps(profile))
    extraction = clone.setdefault("extractionSettings", {})
    extraction["method"] = "roi"
    extraction["annotationSchema"] = schema
    clone.setdefault("aiSettings", {})["enabled"] = False
    clone.setdefault("ocrSettings", {})["enabledFallback"] = False
    return clone


def label_profile(profile):
    clone = json.loads(json.dumps(profile))
    extraction = dict(clone.get("extractionSettings") or {})
    extraction.pop("method", None)
    extraction.pop("annotationSchema", None)
    clone["extractionSettings"] = extraction
    clone.setdefault("aiSettings", {})["enabled"] = False
    clone.setdefault("ocrSettings", {})["enabledFallback"] = False
    return clone


def collect_document(path, profiles):
    """Extract with labels, derive the truth/geometry map, and the ROI result."""
    pdf_bytes = path.read_bytes()
    document = fitz.open(stream=pdf_bytes, filetype="pdf")
    try:
        page_text = " ".join(
            document.load_page(index).get_text("text")
            for index in range(min(2, document.page_count))
        )
        form_type = base.detect_form_type(page_text)
        if form_type is None or form_type not in profiles:
            return None
        profile = profiles[form_type]
        labeled = process_pdf(pdf_bytes, path.name, label_profile(profile))

        widgets = _collect_form_fields(document)
        rects, kinds, truth = [], {}, {}
        for field_id, diagnostic in labeled["diagnostics"].items():
            value = diagnostic.get("formValue")
            if not value:
                continue
            widget = base.pick_widget(widgets, value, field_id)
            if widget is None:
                continue
            truth[field_id] = value
            rects.append(
                (
                    field_id,
                    widget["pageNumber"],
                    (widget["x0"], widget["y0"], widget["x1"], widget["y1"]),
                )
            )
            kinds[field_id] = (
                widget["kind"],
                diagnostic.get("fieldName") or "",
            )
        if not rects:
            return None

        schema = build_annotation_schema(rects)
        roi = process_pdf_roi(
            pdf_bytes, path.name, roi_profile(profile, schema)
        )
    finally:
        document.close()
    return {
        "path": path,
        "form": form_type,
        "pdf_bytes": pdf_bytes,
        "profile": profile,
        "schema": schema,
        "truth": truth,
        "kinds": kinds,
        "labels": labeled["diagnostics"],
        "roi": roi["diagnostics"],
    }


def flatten(pdf_bytes, destination):
    """Bake widgets and annotations into page content; returns widget count."""
    document = fitz.open(stream=pdf_bytes, filetype="pdf")
    try:
        document.bake()
        remaining = len(_collect_form_fields(document))
        destination.parent.mkdir(parents=True, exist_ok=True)
        document.save(str(destination), garbage=4, deflate=True)
    finally:
        document.close()
    return remaining


def tally(collection, record, mode, category, value, truth):
    bucket = collection[category]
    outcome = compare(category, value, truth)
    bucket[f"{mode}_hit"] += int(bool(outcome))
    bucket[f"{mode}_exact"] += int(outcome == "exact")
    bucket[f"{mode}_empty"] += int(not value)
    record[f"{mode}"] = value
    if outcome and outcome != "exact":
        record[f"{mode}_match"] = outcome


def summarize(title, tallies, extra_keys=()):
    print()
    print(title)
    header = f"{'category':<12}{'n':>5}{'labels':>9}{'roi':>8}"
    for key in extra_keys:
        header += f"{key:>16}"
    print(header)
    print("-" * len(header))
    totals = Counter()
    for category in sorted(tallies):
        bucket = tallies[category]
        count = bucket["fields"] or 1
        totals.update(bucket)
        line = (
            f"{category:<12}{bucket['fields']:>5}"
            f"{bucket['labels_hit'] / count:>9.1%}"
            f"{bucket['roi_hit'] / count:>8.1%}"
        )
        for key in extra_keys:
            line += f"{bucket[key] / count:>16.1%}"
        print(line)
    count = totals["fields"] or 1
    line = (
        f"{'ALL':<12}{totals['fields']:>5}"
        f"{totals['labels_hit'] / count:>9.1%}"
        f"{totals['roi_hit'] / count:>8.1%}"
    )
    for key in extra_keys:
        line += f"{totals[key] / count:>16.1%}"
    print("-" * len(header))
    print(line)
    return totals


def main():
    profiles = load_profiles()
    print(f"profiles detected: {sorted(profiles)}")

    paths = sorted((ROOT / "storage").rglob("*.pdf"))
    if base.MAX_DOCUMENTS:
        paths = paths[: base.MAX_DOCUMENTS]

    seen, skipped, documents = set(), Counter(), []
    for path in paths:
        digest = __import__("hashlib").sha256(path.read_bytes()).hexdigest()
        if digest in seen:
            skipped["duplicate"] += 1
            continue
        seen.add(digest)
        try:
            document = collect_document(path, profiles)
        except Exception as exc:  # noqa: BLE001 - report, never abort
            skipped["pipeline error"] += 1
            print(f"  ! {path.name}: {type(exc).__name__}: {exc}")
            continue
        if document is None:
            skipped["no profile or no ground truth"] += 1
            continue
        documents.append(document)

    # --- Round 3A: original AcroForm files, both modes -------------------
    tallies_a = defaultdict(Counter)
    details_a = []
    for document in documents:
        for field_id, truth in document["truth"].items():
            kind, field_name = document["kinds"][field_id]
            category = base.categorize(field_id, field_name, kind)
            record = {
                "document": document["path"].name,
                "form": document["form"],
                "field": field_id,
                "category": category,
                "widget_kind": kind,
                "truth": truth,
            }
            tallies_a[category]["fields"] += 1
            tally(
                tallies_a, record, "labels", category,
                document["labels"][field_id].get("finalValue"), truth,
            )
            roi_diagnostic = document["roi"].get(field_id, {})
            tally(
                tallies_a, record, "roi", category,
                roi_diagnostic.get("finalValue"), truth,
            )
            record["roi_tier"] = roi_diagnostic.get("roiTier")
            details_a.append(record)

    print(f"\ndocuments used: {len(documents)}   skipped: {dict(skipped)}")
    totals_a = summarize(
        "3A. AcroForm originals (fixes applied)",
        tallies_a,
        extra_keys=("labels_exact", "roi_exact"),
    )

    worse_a = [
        item for item in details_a
        if compare(item["category"], item["labels"], item["truth"])
        and not compare(item["category"], item["roi"], item["truth"])
    ]
    print(f"\nROI worse than labels: {len(worse_a)} of {len(details_a)}")
    for item in worse_a[:15]:
        print(
            f"  {item['category']:<10} {item['field']:<32}"
            f"truth={item['truth']!r:<22} roi={item['roi']!r:<22}"
            f"tier={item['roi_tier']}"
        )

    # --- Round 3B: flattened subset --------------------------------------
    FLAT_DIR.mkdir(exist_ok=True)
    for stale in FLAT_DIR.glob("*.pdf"):
        stale.unlink()
    chosen = []
    per_form = Counter()
    for document in documents:
        form = document["form"]
        if per_form[form] >= FLAT_PER_FORM:
            continue
        per_form[form] += 1
        chosen.append(document)

    tallies_b = defaultdict(Counter)
    details_b = []
    flat_documents = []
    for document in chosen:
        destination = FLAT_DIR / (
            document["path"].stem + ".flattened.pdf"
        )
        remaining_widgets = flatten(document["pdf_bytes"], destination)
        flat_bytes = destination.read_bytes()
        profile = document["profile"]
        try:
            labeled = process_pdf(
                flat_bytes, destination.name, label_profile(profile)
            )
            roi = process_pdf_roi(
                flat_bytes,
                destination.name,
                roi_profile(profile, document["schema"]),
            )
        except Exception as exc:  # noqa: BLE001 - report, never abort
            print(f"  ! {destination.name}: {type(exc).__name__}: {exc}")
            continue

        tiers = Counter()
        for field_id, truth in document["truth"].items():
            kind, field_name = document["kinds"][field_id]
            category = base.categorize(field_id, field_name, kind)
            roi_diagnostic = roi["diagnostics"].get(field_id, {})
            tiers[roi_diagnostic.get("roiTier") or "none"] += 1
            record = {
                "document": destination.name,
                "form": document["form"],
                "field": field_id,
                "category": category,
                "widget_kind": kind,
                "truth": truth,
            }
            tallies_b[category]["fields"] += 1
            tally(
                tallies_b, record, "labels", category,
                labeled["diagnostics"][field_id].get("finalValue"), truth,
            )
            tally(
                tallies_b, record, "roi", category,
                roi_diagnostic.get("finalValue"), truth,
            )
            record["roi_tier"] = roi_diagnostic.get("roiTier")
            details_b.append(record)
        flat_documents.append(
            {
                "file": destination.relative_to(ROOT).as_posix(),
                "form": document["form"],
                "source": document["path"].name,
                "widgets_remaining_after_bake": remaining_widgets,
                "roi_tiers": dict(tiers),
            }
        )

    totals_b = summarize(
        f"3B. Flattened subset ({len(flat_documents)} documents, "
        "widgets baked away)",
        tallies_b,
        extra_keys=("labels_exact", "roi_exact", "labels_empty", "roi_empty"),
    )
    print("\nROI tier distribution on flattened forms:")
    tier_totals = Counter()
    for item in flat_documents:
        tier_totals.update(item["roi_tiers"])
    count = sum(tier_totals.values()) or 1
    for tier, hits in sorted(tier_totals.items()):
        print(f"  {tier:<10}{hits:>5}  ({hits / count:.1%})")

    winners_b = [
        item for item in details_b
        if compare(item["category"], item["roi"], item["truth"])
        and not compare(item["category"], item["labels"], item["truth"])
    ]
    losers_b = [
        item for item in details_b
        if compare(item["category"], item["labels"], item["truth"])
        and not compare(item["category"], item["roi"], item["truth"])
    ]
    print(f"\nFlattened, ROI right where labels wrong: {len(winners_b)}"
          f" of {len(details_b)}")
    for item in winners_b[:10]:
        print(
            f"  {item['category']:<10} {item['field']:<32}"
            f"truth={item['truth']!r:<22} labels={item['labels']!r}"
        )
    print(f"\nFlattened, labels right where ROI wrong: {len(losers_b)}"
          f" of {len(details_b)}")
    for item in losers_b[:10]:
        print(
            f"  {item['category']:<10} {item['field']:<32}"
            f"truth={item['truth']!r:<22} roi={item['roi']!r}"
            f" tier={item['roi_tier']}"
        )

    OUTPUT.write_text(
        json.dumps(
            {
                "documents_used": len(documents),
                "skipped": dict(skipped),
                "acroform": {
                    "fields": totals_a["fields"],
                    "categories": {
                        category: dict(bucket)
                        for category, bucket in tallies_a.items()
                    },
                    "details": details_a,
                },
                "flattened": {
                    "documents": flat_documents,
                    "fields": totals_b["fields"],
                    "categories": {
                        category: dict(bucket)
                        for category, bucket in tallies_b.items()
                    },
                    "details": details_b,
                },
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    print(f"\nDetail written to {OUTPUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
