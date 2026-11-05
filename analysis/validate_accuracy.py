"""Rigorous validation harness for the DocuExtract extraction engine.

Runs against the real sample archive (April-20261101T231837Z-1-001.zip):
  1. Accuracy     - derived widget ground truth + integrity invariants per field
  2. Reliability  - edge-case classification (zero-text, image-heavy, opaque
                    widget names, multi-page) with crash tracking
  3. Performance  - A/B benchmark: form-field source ENABLED vs DISABLED,
                    wall time, CPU time, peak memory, per-doc averages

OCR and AI are disabled so results are deterministic and offline; the harness
measures the native-text + AcroForm pipeline, which is what changed.
"""
import json
import os
import re
import sys
import time
import tracemalloc
import zipfile
from collections import Counter, defaultdict
from contextlib import nullcontext
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))
os.environ.setdefault("DJANGO_DEBUG", "true")
os.environ.setdefault("DJANGO_SECRET_KEY", "validation-harness")
os.environ.setdefault("DATABASE_URL", "sqlite:///:memory:")
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")
import django  # noqa: E402

django.setup()

from django.conf import settings  # noqa: E402
import fitz  # noqa: E402
from extraction.services.document_extraction import process_pdf  # noqa: E402

settings.OCR_ENABLED = False

import extraction.services.document_extraction as de  # noqa: E402

ZIP_PATH = ROOT / "zip files/April-20261101T231837Z-1-001.zip"

SSN_RE = re.compile(r"^\d{3}-\d{2}-\d{4}$")
EIN_RE = re.compile(r"^\d{2}-\d{7}$")

PROFILE = {
    "fields": [
        {
            "id": "full_name",
            "name": "Full Name",
            "type": "text",
            "required": True,
            "priority": "pdf_first",
            "normalization": {"trim": True, "removeExtraSpaces": True},
            "validation": {"minLength": 2, "maxLength": 80},
            "filenameRules": {"enabled": False, "patterns": []},
            "contentRules": {
                "enabled": True,
                "labels": ["Full Name", "Name", "Your Name", "Legal Name",
                           "Name of deposit account", "First Name", "Last Name"],
                "regexPatterns": [],
            },
        },
        {
            "id": "ssn_tin",
            "name": "SSN / TIN",
            "type": "text",
            "required": False,
            "priority": "pdf_first",
            "normalization": {"trim": True},
            "validation": {"formatRegex": r"\d{3}-\d{2}-\d{4}|\d{2}-\d{7}"},
            "filenameRules": {"enabled": False, "patterns": []},
            "contentRules": {
                "enabled": True,
                "labels": ["SSN", "TIN", "Taxpayer Identification Number",
                           "Identifying Number", "Social security number",
                           "Your correct TIN"],
                "regexPatterns": [r"(\d{3}-\d{2}-\d{4})", r"(\d{2}-\d{7})"],
            },
        },
        {
            "id": "country",
            "name": "Country",
            "type": "text",
            "required": False,
            "priority": "pdf_first",
            "normalization": {"trim": True, "removeExtraSpaces": True},
            "validation": {"minLength": 2, "maxLength": 60},
            "filenameRules": {"enabled": False, "patterns": []},
            "contentRules": {
                "enabled": True,
                "labels": ["Country", "Country of citizenship", "Nation",
                           "Foreign country", "Country, state, province"],
                "regexPatterns": [],
            },
        },
        {
            "id": "citizenship",
            "name": "Citizenship",
            "type": "text",
            "required": False,
            "priority": "pdf_first",
            "normalization": {"trim": True, "removeExtraSpaces": True},
            "validation": {"minLength": 2, "maxLength": 60},
            "filenameRules": {"enabled": False, "patterns": []},
            "contentRules": {
                "enabled": True,
                "labels": ["Country of citizenship", "Citizenship"],
                "regexPatterns": [],
            },
        },
    ],
    "aiSettings": {"enabled": False},
    "extractionSettings": {"labelSimilarityThreshold": 0.82},
    "ocrSettings": {"enabledFallback": False},
}


def prose_like(text):
    if not isinstance(text, str):
        return False
    compact = re.sub(r"\s+", " ", text).strip()
    return len(compact) > 120 or len(compact.split()) >= 10


def norm(value):
    return re.sub(r"\s+", " ", value or "").strip().casefold()


def form_type(filename):
    upper = filename.upper()
    if "W8" in upper or "W-8" in upper:
        return "W8"
    if "W9" in upper or "W-9" in upper:
        return "W9"
    if "W4" in upper or "W-4" in upper:
        return "W4"
    if "EMPLOYEE" in upper or "SET UP" in upper or "SETUP" in upper:
        return "EMPLOYEE"
    return "OTHER"


class DocInfo:
    def __init__(self, name, content):
        self.name = name
        self.fname = name.split("/")[-1]
        self.form = form_type(self.fname)
        self.content = content
        doc = fitz.open(stream=content, filetype="pdf")
        self.pages = doc.page_count
        self.native_dense = sum(
            len(re.sub(r"\s+", "", p.get_text("text"))) for p in doc
        )
        self.image_pages = 0
        for page in doc:
            area = max(page.rect.width * page.rect.height, 1)
            covered = sum(
                r.width * r.height
                for img in page.get_images(full=True)
                for r in page.get_image_rects(img[0])
            )
            if covered / area >= 0.2:
                self.image_pages += 1
        self.widgets = []
        for page_index, page in enumerate(doc):
            for w in page.widgets() or []:
                try:
                    if w.field_value in (None, "", False, "Off", True, 1):
                        # keep string values; checkbox export values handled below
                        pass
                    raw = w.field_value
                    if isinstance(raw, str) and raw.strip() and raw != "Off":
                        self.widgets.append({
                            "name": w.field_name or "",
                            "value": raw.strip(),
                            "page": page_index + 1,
                        })
                except Exception:
                    continue
        doc.close()
        self.values = [w["value"] for w in self.widgets]
        self.opaque = all(
            re.search(r"\[\d*\]|^f\d|^topmost", w["name"]) for w in self.widgets
        ) if self.widgets else False

    @property
    def is_scanned(self):
        return self.native_dense < 100


def derive_truth(info):
    """Derive best-effort ground truth from widget structure per form family."""
    truth = {}
    vals = info.values
    by_norm = {norm(v): v for v in vals}
    ssns = [v for v in vals if SSN_RE.match(v)]
    eins = [v for v in vals if EIN_RE.match(v)]

    name_widgets = [
        w for w in info.widgets
        if re.search(r"(?i)(first|last|legal|full.?|\byour|\bname\b)", w["name"])
        and not re.search(r"(?i)(account|bank|depos|employer|claimant|prepared)", w["name"])
    ]
    if name_widgets:
        first = next((w["value"] for w in name_widgets if re.search(
            r"(?i)first", w["name"])), None)
        last = next((w["value"] for w in name_widgets if re.search(
            r"(?i)last", w["name"])), None)
        if first and last:
            truth["full_name"] = f"{first} {last}"
        else:
            truth["full_name"] = (first or last or name_widgets[0]["value"])
    elif info.form == "W8" and vals:
        truth["full_name"] = vals[0]  # IRS W-8 line 1 is first text widget
    elif info.form in ("W9", "W4") and vals:
        truth["full_name"] = vals[0]

    if ssns:
        truth["ssn_tin"] = ssns[0]
    elif eins:
        truth["ssn_tin"] = eins[0]
    else:
        descriptive_ssn = [
            w["value"] for w in info.widgets
            if re.search(r"(?i)\bssn\b|social security|taxpayer id|\btin\b", w["name"])
        ]
        if descriptive_ssn:
            truth["ssn_tin"] = descriptive_ssn[0]

    country_like = [
        v for v in vals
        if re.fullmatch(r"(?i)[a-z][a-z .]{2,40}", v)
        and norm(v) not in ("n/a", "none")
        and not re.search(r"(?i)street|route|apt|p\.?o\.? box", v)
    ]
    known_countries = {"philippines", "united states", "china", "india", "japan",
                       "canada", "mexico", "united kingdom", "australia", "germany",
                       "france", "spain", "italy", "brazil", "korea", "vietnam",
                       "thailand", "malaysia", "indonesia", "saudi arabia", "russia",
                       "ukraine", "poland", "egypt", "nigeria", "kenya", "croatia"}
    country_hits = [v for v in country_like if norm(v) in known_countries]
    if country_hits:
        truth["country"] = country_hits[0]
        truth["citizenship"] = country_hits[0]
    return truth


def classify_result(info, field_id, diag, truth):
    """Return PASS / FAIL / FN / TP / NO_TRUTH classification."""
    final = diag.get("finalValue") or ""
    status = diag["status"]
    source = diag["source"]
    if field_id in truth:
        expected = norm(truth[field_id])
        got = norm(final)
        if not got:
            return "FN"  # false negative: truth exists, nothing extracted
        if got == expected or expected in got or got in expected:
            return "TP"
        return "FP"  # false positive: extracted wrong value confidently
    # No derived truth: check integrity invariants instead
    if source == "form_field":
        widget = diag.get("formValue")
        return "INTEGRITY_OK" if norm(widget) == norm(final) else "INTEGRITY_FAIL"
    if final and prose_like(final):
        return "PROSE_LEAK"
    if status == "NOT_FOUND":
        return "ABSENT"  # nothing derivable; many forms genuinely lack the field
    if status == "INVALID":
        return "FLAGGED"  # value kept but rejected by validation -> review queue
    return "UNVERIFIED"


def main():
    zf = zipfile.ZipFile(ZIP_PATH)
    pdf_names = sorted(
        n for n in zf.namelist()
        if n.lower().endswith(".pdf") and not n.endswith("/")
    )
    infos = [DocInfo(n, zf.read(n)) for n in pdf_names]

    # ---------- 3. Performance A/B benchmark ----------
    def run_batch(label, disable_form=False):
        results = {}
        walls, cpus = [], []
        collector = (
            patch.object(de, "_collect_form_fields", return_value=[])
            if disable_form
            else nullcontext()
        )
        with collector:
            for index, info in enumerate(infos, start=1):
                t0 = time.perf_counter()
                cpu0 = time.process_time()
                result = process_pdf(info.content, info.fname, PROFILE)
                cpu1 = time.process_time()
                walls.append(time.perf_counter() - t0)
                cpus.append(cpu1 - cpu0)
                results[info.name] = result
                if index % 20 == 0:
                    print(
                        f"  [{label.split(' ')[0]}] {index}/{len(infos)} "
                        f"docs ({time.perf_counter() - t0:.2f}s last)",
                        flush=True,
                    )
        return {
            "label": label,
            "results": results,
            "total_wall_s": sum(walls),
            "avg_wall_s": sum(walls) / len(walls),
            "p50_wall_s": sorted(walls)[len(walls) // 2],
            "p95_wall_s": sorted(walls)[int(len(walls) * 0.95)],
            "total_cpu_s": sum(cpus),
            "peak_mem_mb": 0.0,
            "walls": walls,
        }

    tracemalloc.start()
    baseline = run_batch("form-field DISABLED (pre-change)", disable_form=True)
    with_form = run_batch("form-field ENABLED (current)")
    current, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    for batch in (baseline, with_form):
        batch["peak_mem_mb"] = round(peak / 1024 / 1024, 1)

    # ---------- 1 & 2. Accuracy + reliability ----------
    class_counts = Counter()
    for info in infos:
        if info.is_scanned:
            class_counts["zero/sparse native text (<100 dense chars)"] += 1
        if info.image_pages:
            class_counts[f"image-heavy ({info.image_pages} pg)"] += 1
        if info.widgets:
            class_counts["has AcroForm widgets"] += 1
            if info.opaque:
                class_counts["opaque widget names only (IRS-style)"] += 1
        if info.pages > 1:
            class_counts["multi-page"] += 1
        class_counts[f"form family: {info.form}"] += 1

    accuracy = defaultdict(Counter)
    incidents = {"FP": [], "FN": [], "PROSE_LEAK": [], "INTEGRITY_FAIL": []}
    crashes = []
    source_by_field = defaultdict(Counter)
    status_by_field = defaultdict(Counter)
    for info in infos:
        truth = derive_truth(info)
        try:
            diag_map = with_form["results"][info.name]["diagnostics"]
        except Exception as exc:  # noqa: BLE001
            crashes.append((info.fname, f"{type(exc).__name__}: {exc}"))
            continue
        for fid, diag in diag_map.items():
            cls = classify_result(info, fid, diag, truth)
            accuracy[fid][cls] += 1
            source_by_field[fid][diag["source"]] += 1
            status_by_field[fid][diag["status"]] += 1
            if cls in incidents:
                incidents[cls].append((info.fname, fid, diag.get("finalValue"),
                                       truth.get(fid), diag["source"]))

    # Form-method breakdown
    method_counter = Counter()
    for info in infos:
        for diag in with_form["results"][info.name]["diagnostics"].values():
            if diag["source"] == "form_field":
                method_counter[diag.get("formMethod")] += 1

    report = {
        "archive": ZIP_PATH.name,
        "pdf_count": len(infos),
        "cpu_count": os.cpu_count(),
        "ocr_ai": "disabled (deterministic offline run)",
        "edge_cases": dict(class_counts),
        "fields": {},
        "incidents": {k: v for k, v in incidents.items()},
        "crashes": crashes,
        "form_methods": dict(method_counter),
        "timing": {},
    }
    for fid in ("full_name", "ssn_tin", "country", "citizenship"):
        total = sum(accuracy[fid].values())
        graded = accuracy[fid]["TP"] + \
            accuracy[fid]["FP"] + accuracy[fid]["FN"]
        report["fields"][fid] = {
            "counts": dict(accuracy[fid]),
            "verified_pass_rate": (
                f"{100 * accuracy[fid]['TP'] / graded:.1f}%" if graded else "n/a"
            ),
            "statuses": dict(status_by_field[fid]),
            "sources": dict(source_by_field[fid]),
        }
    for batch in (baseline, with_form):
        report["timing"][batch["label"]] = {
            "total_wall_s": round(batch["total_wall_s"], 2),
            "avg_wall_s": round(batch["avg_wall_s"], 3),
            "p50_wall_s": round(batch["p50_wall_s"], 3),
            "p95_wall_s": round(batch["p95_wall_s"], 3),
            "total_cpu_s": round(batch["total_cpu_s"], 2),
            "peak_python_heap_mb": batch["peak_mem_mb"],
        }
    delta = (
        with_form["total_wall_s"] - baseline["total_wall_s"],
        baseline["total_wall_s"],
    )
    report["timing"]["form_field_overhead"] = (
        f"+{delta[0]:.2f}s over archive "
        f"(+{100 * delta[0] / max(delta[1], 0.001):.1f}%), "
        f"+{delta[0] / len(infos) * 1000:.1f} ms/doc avg"
    )

    print(json.dumps(report, indent=2, default=str))


if __name__ == "__main__":
    main()
