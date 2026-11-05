# Scratch analysis script: inspect sample archive PDF structure for extraction tuning.
import json
import re
import sys
import zipfile
from pathlib import Path
from collections import Counter

import fitz

ZIP_PATH = Path("zip files/April-20261101T231837Z-1-001.zip")
OUT = Path("analysis/out")
OUT.mkdir(parents=True, exist_ok=True)

zf = zipfile.ZipFile(ZIP_PATH)
names = [n for n in zf.namelist() if n.lower().endswith(".pdf")]

suffix_counter = Counter()
summary_rows = []
for n in names:
    m = re.search(r"_([^_]+)\.pdf$", n, re.IGNORECASE)
    suffix_counter[(m.group(1) if m else "?").upper()] += 1

print("Filename suffix counts:", dict(suffix_counter))
print("Total PDFs:", len(names))

# Pick a representative sample per suffix type
by_suffix = {}
for n in names:
    m = re.search(r"_([^_]+)\.pdf$", n, re.IGNORECASE)
    key = (m.group(1) if m else "?").upper()
    by_suffix.setdefault(key, []).append(n)

samples = [v[0] for v in by_suffix.values()]

for n in names:
    data = zf.read(n)
    try:
        doc = fitz.open(stream=data, filetype="pdf")
    except Exception as exc:
        summary_rows.append({"file": n, "error": str(exc)})
        continue
    pages = []
    for i, page in enumerate(doc):
        text = page.get_text("text")
        dense = len(re.sub(r"\s+", "", text))
        imgs = page.get_images(full=True)
        page_area = max(page.rect.width * page.rect.height, 1)
        img_area = sum(
            r.width * r.height for im in imgs for r in page.get_image_rects(im[0])
        )
        pages.append(
            {
                "p": i + 1,
                "chars": dense,
                "imgcov": round(min(img_area / page_area, 1.0), 2),
                "nimgs": len(imgs),
                "annotations": len(list(page.annots() or [])),
                "widgets": len(list(page.widgets() or [])),
            }
        )
    summary_rows.append(
        {
            "file": n,
            "pages": len(pages),
            "encrypted": doc.is_encrypted,
            "meta_total_chars": sum(p["chars"] for p in pages),
            "min_page_chars": min((p["chars"] for p in pages), default=0),
            "max_imgcov": max((p["imgcov"] for p in pages), default=0),
            "has_form_widgets": any(p["widgets"] for p in pages),
            "pages_detail": pages,
        }
    )
    doc.close()

(OUT / "pdf_summary.json").write_text(json.dumps(summary_rows, indent=1), encoding="utf-8")

# Global text stats
errs = [r for r in summary_rows if "error" in r]
rows = [r for r in summary_rows if "error" not in r]
print(f"Parse errors: {len(errs)}")
zero_text = [r for r in rows if r["meta_total_chars"] == 0]
sparse = [r for r in rows if r["meta_total_chars"] < 100]
scanned = [r for r in rows if r["max_imgcov"] >= 0.2]
forms = [r for r in rows if r["has_form_widgets"]]
print(f"Zero-native-text PDFs: {len(zero_text)}")
print(f"Sparse-text (<100 chars) PDFs: {len(sparse)}")
print(f"Image-heavy (>=20% coverage) PDFs: {len(scanned)}")
print(f"PDFs with form widgets: {len(forms)}")
print("Page counts:", Counter(r["pages"] for r in rows))

# Dump first-page text of representative samples
for s in samples[:12]:
    data = zf.read(s)
    doc = fitz.open(stream=data, filetype="pdf")
    text = doc[0].get_text("text")
    doc.close()
    (OUT / ("sample_" + re.sub(r"\W+", "_", Path(s).stem)[:40] + ".txt")).write_text(
        text, encoding="utf-8"
    )
    print(f"Sample dumped: {s} ({len(text)} chars page 1)")
