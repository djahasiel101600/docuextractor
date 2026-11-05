"""Aggregate accuracy run across the whole sample archive.

Runs the real backend process_pdf (native + AcroForm sources; OCR/AI off so the
result is deterministic and offline) over every PDF and tallies per-field status
plus how often the authoritative form_field source wins. Also flags any prose
leaks or crashes.
"""
import os
import re
import sys
import zipfile
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))
os.environ.setdefault("DJANGO_DEBUG", "true")
os.environ.setdefault("DJANGO_SECRET_KEY", "aggregate-harness")
os.environ.setdefault("DATABASE_URL", "sqlite:///:memory:")
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")
import django  # noqa: E402

django.setup()

from django.conf import settings  # noqa: E402
from extraction.services.document_extraction import process_pdf  # noqa: E402

settings.OCR_ENABLED = False

ZIP_PATH = ROOT / "zip files/April-20261101T231837Z-1-001.zip"

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
                "labels": ["Name", "Full Name", "Your Name", "First Name",
                           "Last Name", "Legal Name", "Name of Deposit Account"],
                "regexPatterns": [],
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
            "id": "ssn_tin",
            "name": "SSN / TIN",
            "type": "text",
            "required": False,
            "priority": "pdf_first",
            "normalization": {"trim": True},
            "validation": {"formatRegex": r"(\d{3}-\d{2}-\d{4}|\d{2}-\d{7})"},
            "filenameRules": {"enabled": False, "patterns": []},
            "contentRules": {
                "enabled": True,
                "labels": ["SSN", "TIN", "Taxpayer Identification Number",
                           "Identifying Number", "Social security number"],
                "regexPatterns": [r"(\d{3}-\d{2}-\d{4})", r"(\d{2}-\d{7})"],
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


zf = zipfile.ZipFile(ZIP_PATH)
pdf_names = [
    n for n in zf.namelist() if n.lower().endswith(".pdf") and not n.endswith("/")
]

status_counts = {f["id"]: Counter() for f in PROFILE["fields"]}
source_counts = {f["id"]: Counter() for f in PROFILE["fields"]}
prose_leaks = []
crashes = []
processed = 0

for name in pdf_names:
    content = zf.read(name)
    fname = name.split("/")[-1]
    try:
        result = process_pdf(content, fname, PROFILE)
    except Exception as exc:  # noqa: BLE001
        crashes.append((fname, f"{type(exc).__name__}: {exc}"))
        continue
    processed += 1
    for fid, diag in result["diagnostics"].items():
        status_counts[fid][diag["status"]] += 1
        source_counts[fid][diag["source"]] += 1
        final = diag.get("finalValue")
        if prose_like(final):
            prose_leaks.append((fname, fid, final))

print(
    f"PDFs in archive: {len(pdf_names)} | processed OK: {processed} | crashes: {len(crashes)}")
if crashes:
    print("\nCRASHES:")
    for fname, err in crashes[:20]:
        print(f"  {fname}: {err}")

for fid in status_counts:
    total = sum(status_counts[fid].values())
    print("\n" + "=" * 60)
    print(f"FIELD: {fid}  (n={total})")
    print("  status:", dict(status_counts[fid].most_common()))
    print("  source:", dict(source_counts[fid].most_common()))

print("\n" + "=" * 60)
print(f"PROSE LEAKS into final values: {len(prose_leaks)}")
for fname, fid, val in prose_leaks[:20]:
    print(f"  {fname} [{fid}]: {val[:80]!r}")
