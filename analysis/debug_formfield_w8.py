"""Reproduce the spatial form-field mis-association seen in the browser test.

Loads the exact live HR profile from the DB and runs the real matcher internals
against the W-8 PDF the browser flagged (Aidar Osmonaliev_W8.pdf), printing each
widget's geometry, the label-match bbox, and the candidate each matcher returns.
"""
import os
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))
os.environ.setdefault("DJANGO_DEBUG", "true")
os.environ.setdefault("DJANGO_SECRET_KEY", "repro")
os.environ.setdefault("DATABASE_URL", "sqlite:///storage/docuextract.sqlite3")
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")
import django  # noqa: E402

django.setup()

from django.conf import settings  # noqa: E402
import fitz  # noqa: E402
from extraction.models import ExtractionProfile  # noqa: E402
from extraction.services.document_extraction import (  # noqa: E402
    _pdf_document_pages,
    _build_text_index,
    _collect_form_fields,
    _match_form_field_by_position,
    _match_form_field_by_name,
    _match_form_field_by_pattern,
    _extract_from_form_fields,
    _extract_from_text,
    _extract_from_filename,
    _choose_content_candidate,
    normalize_value,
)

settings.OCR_ENABLED = False

ZIP_PATH = ROOT / "zip files/April-20261101T231837Z-1-001.zip"
TARGET = "Aidar Osmonaliev_W8.pdf"

profile = ExtractionProfile.objects.get(
    id="profile-hr-applications").configuration
fields = profile["fields"]
all_labels = [
    lbl for f in fields for lbl in f.get("contentRules", {}).get("labels", [])
    if isinstance(lbl, str)
]

zf = zipfile.ZipFile(ZIP_PATH)
pdf_name = next(n for n in zf.namelist() if n.split("/")[-1] == TARGET)
pdf_bytes = zf.read(pdf_name)

doc = fitz.open(stream=pdf_bytes, filetype="pdf")
page_count, pages = _pdf_document_pages(doc)
native_index = _build_text_index(pages, all_labels, 0.82)
form_fields = _collect_form_fields(doc)

print(f"=== {TARGET} :: {len(form_fields)} widgets ===")
for w in form_fields:
    print(
        f"  p{w['pageNumber']} rect=({w['x0']:.0f},{w['y0']:.0f})-"
        f"({w['x1']:.0f},{w['y1']:.0f}) name={w['name']!r} value={w['value']!r}"
    )

for f in fields:
    fid = f["id"]
    labels = f.get("contentRules", {}).get("labels", [])
    print(f"\n--- field {fid!r} labels={labels} validation={f.get('validation')} "
          f"prio={f.get('priority')} ---")
    for page_entry in native_index[0]:
        for m in page_entry["labelMatches"]:
            if m["label"] in labels:
                print(
                    f"   labelMatch {m['label']!r} text={m['text'][:40]!r} "
                    f"bbox=({m['x0']:.0f},{m['y0']:.0f})-({m['x1']:.0f},{m['y1']:.0f})"
                )
    pos = _match_form_field_by_position(native_index, form_fields, f, 0.82)
    nm = _match_form_field_by_name(form_fields, f, 0.82)
    pat = _match_form_field_by_pattern(form_fields, f)
    chosen = _extract_from_form_fields(form_fields, native_index, f, 0.82)
    fname_val, _ = _extract_from_filename(TARGET, f)

    def brief(c):
        if not c:
            return None
        return f"{c[0]!r} conf={c[5]} method={c[4]}"

    print(f"   by_position = {brief(pos)}")
    print(f"   by_name     = {brief(nm)}")
    print(f"   by_pattern  = {brief(pat)}")
    print(f"   FORM CHOSEN = {brief(chosen)}")
    print(f"   filename    = {fname_val!r}")
    native = _extract_from_text(pages, f, all_labels, native_index, 0.82)
    cand, ambig, reason = _choose_content_candidate(native, None, f, chosen)
    sel_val = cand["candidate"][0] if cand else None
    sel_src = cand["source"] if cand else None
    print(f"   native(pdf) = {native[0]!r}")
    print(
        f"   -> content selection: source={sel_src} "
        f"value={sel_val!r} reason={reason!r}"
    )
