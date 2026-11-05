"""Baseline harness: run the real backend process_pdf against representative
sample docs and compare against widget-derived ground truth.

Run from repo root with the venv python. Bootstraps Django settings."""
import os
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))
os.environ.setdefault("DJANGO_DEBUG", "true")
os.environ.setdefault("DJANGO_SECRET_KEY", "baseline-harness-only")
os.environ.setdefault("DATABASE_URL", "sqlite:///:memory:")
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")
import django  # noqa: E402

django.setup()

from extraction.services.document_extraction import process_pdf  # noqa: E402
from extraction.services.zip_processing import discover_pdf_files  # noqa: E402
from django.conf import settings  # noqa: E402
import fitz  # noqa: E402

settings.OCR_ENABLED = False  # baseline is native-only; OCR/AI handled separately

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
            "validation": {"minLength": 2},
            "filenameRules": {"enabled": True, "patterns": [r"^(.*?)[_.]?W\d|^(.*?)_EMPLOYEE"], "captureGroup": 1, "caseInsensitive": True},
            "contentRules": {
                "enabled": True,
                "labels": ["Name", "Full Name", "Name (as shown on your income tax return)", "Your Name", "First Name", "Legal Name"],
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
            "validation": {},
            "filenameRules": {"enabled": False, "patterns": []},
            "contentRules": {"enabled": True, "labels": ["Country", "Country of citizenship", "Nation", "Foreign country"], "regexPatterns": []},
        },
        {
            "id": "ssn_tin",
            "name": "SSN / TIN",
            "type": "text",
            "required": True,
            "priority": "pdf_first",
            "normalization": {"trim": True},
            "validation": {"formatRegex": r"[\d\-X ]{5,}"},
            "filenameRules": {"enabled": False, "patterns": []},
            "contentRules": {"enabled": True, "labels": ["SSN", "TIN", "Taxpayer Identification Number", "Identifying Number", "Social security number", "ssn"], "regexPatterns": [r"(\d{3}-\d{2}-\d{4})", r"(\d{2}-\d{7})"]},
        },
    ],
    "aiSettings": {"enabled": False},
    "extractionSettings": {"labelSimilarityThreshold": 0.82},
    "ocrSettings": {"enabledFallback": False},
}


def widget_truth(path):
    doc = fitz.open(stream=ZIP_PATH.read_bytes()
                    if False else None, filetype="pdf")  # placeholder
    return {}


zf = zipfile.ZipFile(ZIP_PATH)

TARGETS = [
    "April/Louie Andre Sarahan_W8.pdf",
    "April/Kateryna Shestak updated.W9.pdf",
    "April/Jeff Zamora_EMPLOYEE SETUP FORM(1).PDF",
    "April/Ingna Orolin_W4.pdf",
    "April/Fazlyn_Lagardien_EMPLOYEE_SETUP FORM.pdf",
    # zero native text (scanned)
    "April/Chesslyn Beneke_EMPLOYEE SET UP FORM.pdf",
]

for t in TARGETS:
    content = zf.read(t)
    fname = t.split("/")[-1]
    print("=" * 78)
    print(fname)
    # ground truth from widgets
    doc = fitz.open(stream=content, filetype="pdf")
    wtruth = {}
    for page in doc:
        for w in page.widgets() or []:
            if w.field_value not in (None, "", False, "Off"):
                wtruth[w.field_name] = str(w.field_value)
    doc.close()
    native_len = 0
    doc = fitz.open(stream=content, filetype="pdf")
    native_len = sum(len(__import__("re").sub(
        r"\s+", "", p.get_text("text"))) for p in doc)
    doc.close()
    print(f"  native dense chars={native_len} | filled widgets={len(wtruth)}")
    try:
        result = process_pdf(content, fname, PROFILE)
        for fid, diag in result["diagnostics"].items():
            print(
                f"    {fid:11} status={diag['status']:11} src={diag['source']:10} "
                f"method={str(diag.get('method')):14} final={diag['finalValue']!r:24} "
                f"form={diag.get('formValue')!r} pdf={diag.get('pdfValue')!r}"
            )
    except Exception as exc:
        print(f"    PROCESS ERROR: {type(exc).__name__}: {exc}")
