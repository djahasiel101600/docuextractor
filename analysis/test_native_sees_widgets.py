# Does the current native-text extraction see AcroForm field VALUES at all?
import zipfile
from pathlib import Path
import fitz

zf = zipfile.ZipFile(Path("zip files/April-20261101T231837Z-1-001.zip"))

cases = {
    "April/Louie Andre Sarahan_W8.pdf": ["Louie Andre Sarahan", "Philippines", "04/22/2026"],
    "April/Kateryna Shestak updated.W9.pdf": ["Kateryna Shestak", "SK&KUZ LLC", "Carriage"],
    "April/Jeff Zamora_EMPLOYEE SETUP FORM(1).PDF": ["Jeff", "Zamora", "Spotter.ai", "4109"],
}

for f, values in cases.items():
    doc = fitz.open(stream=zf.read(f), filetype="pdf")
    page = doc[0]
    plain = page.get_text("text")
    words = " ".join(it[4] for it in page.get_text("words", sort=True))
    print("=" * 70)
    print(f)
    for v in values:
        print(
            f"   value {v!r:30} in get_text? {v in plain!s:6}  in words? {v in words}")
    doc.close()
