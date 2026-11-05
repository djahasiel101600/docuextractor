# Scratch: verify AcroForm widget values carry the real fill-in data.
import re
import zipfile
from pathlib import Path
import fitz

ZIP_PATH = Path("zip files/April-20261101T231837Z-1-001.zip")
zf = zipfile.ZipFile(ZIP_PATH)

targets = [
    "April/Fazlyn_Lagardien_W8.pdf",
    "April/Kateryna Shestak updated.W9.pdf",
    "April/Ingna Orolin_W4.pdf",
    "April/Fazlyn_Lagardien_EMPLOYEE_SETUP FORM.pdf",
    "April/Jeff Zamora_EMPLOYEE SETUP FORM(1).PDF",
    "April/Louie Andre Sarahan_W8.pdf",
]

for t in targets:
    data = zf.read(t)
    doc = fitz.open(stream=data, filetype="pdf")
    print("=" * 80)
    print(t, "| pages:", doc.page_count, "| needs_pass:", doc.needs_pass)
    filled = 0
    total = 0
    for pno, page in enumerate(doc):
        for w in page.widgets() or []:
            total += 1
            val = w.field_value
            name = w.field_name
            if val not in (None, "", False):
                filled += 1
                if filled <= 25:
                    vs = str(val)[:70]
                    print(
                        f"  p{pno+1} [{w.field_type_string}] {name!r} = {vs!r}")
    print(f"  widgets total={total} filled={filled}")
    # Does get_text see widget contents at all?
    text0 = doc[0].get_text("text")
    print("  page1 native chars:", len(re.sub(r"\s+", "", text0)))
    doc.close()
