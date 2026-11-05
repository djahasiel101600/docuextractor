"""Debug: for failing targets, show label matches and widget geometry so the
spatial form matcher's thresholds can be tuned with evidence."""
import os
import re
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))
os.environ.setdefault("DJANGO_DEBUG", "true")
os.environ.setdefault("DJANGO_SECRET_KEY", "debug-only")
os.environ.setdefault("DATABASE_URL", "sqlite:///:memory:")
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")
import django  # noqa: E402

django.setup()

import fitz  # noqa: E402
from extraction.services.document_extraction import (  # noqa: E402
    _build_text_index,
    _collect_form_fields,
    _pdf_document_pages,
)

ZIP_PATH = ROOT / "zip files/April-20261101T231837Z-1-001.zip"

TARGETS = {
    "April/Louie Andre Sarahan_W8.pdf": [
        "SSN", "Identifying Number", "Country", "citizenship"
    ],
    "April/Ingna Orolin_W4.pdf": ["SSN", "Identifying Number", "Employee"],
    "April/Kateryna Shestak updated.W9.pdf": ["Country", "citizenship", "TIN"],
}

zf = zipfile.ZipFile(ZIP_PATH)
for target, label_words in TARGETS.items():
    content = zf.read(target)
    doc = fitz.open(stream=content, filetype="pdf")
    page_count, pages = _pdf_document_pages(doc)
    widgets = _collect_form_fields(doc)
    doc.close()
    print("=" * 80)
    print(target)
    print(f"  pages={page_count} filled widgets={len(widgets)}")
    for w in widgets:
        print(
            f"    p{w['pageNumber']} [{w['x0']:6.1f},{w['y0']:6.1f}-"
            f"{w['x1']:6.1f},{w['y1']:6.1f}] {w['kind']:9} "
            f"name={w['name']!r:55} value={w['value']!r}"
        )
    # Find native text positions containing the target label words
    for page_index, page in enumerate(pages):
        pattern = re.compile("|".join(re.escape(t)
                             for t in label_words), re.IGNORECASE)
        for row in page["lines"]:
            if pattern.search(row):
                print(f"    LINE p{page_index+1}: {row.strip()[:100]!r}")
    # Show label matches from index for a big-label set
    labels = [w for pair in label_words for w in (pair, pair + ":")]
    idx, _ = _build_text_index(pages, list(dict.fromkeys(labels)), 0.82)
    for page_index, entry in enumerate(idx):
        for m in entry["labelMatches"]:
            print(
                f"    LBLMATCH p{page_index+1} [{m['x0']:6.1f},{m['y0']:6.1f}-"
                f"{m['x1']:6.1f},{m['y1']:6.1f}] {m['label']!r} "
                f"text={m['text'][:60]!r} sim={m['similarity']:.2f}"
            )
