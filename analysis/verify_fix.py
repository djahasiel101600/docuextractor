"""Validate the spatial form-field fix across the full archive using the REAL
live profile from the DB (not a synthetic one).

Ground truth for W-8/W-9 candidate_name = the person's name embedded in the
filename (profile pattern ^(.*?)_W[56789]). Reports pass/fail, prose leaks,
crashes, and the value source mix. OCR/AI disabled for determinism.
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
os.environ.setdefault("DJANGO_SECRET_KEY", "verify")
os.environ.setdefault("DATABASE_URL", "sqlite:///storage/docuextract.sqlite3")
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")
import django  # noqa: E402

django.setup()
from django.conf import settings  # noqa: E402
from extraction.models import ExtractionProfile  # noqa: E402
from extraction.services.document_extraction import process_pdf  # noqa: E402

settings.OCR_ENABLED = False

ZIP_PATH = ROOT / "zip files/April-20261101T231837Z-1-001.zip"
profile = ExtractionProfile.objects.get(
    id="profile-hr-applications").configuration
# Isolate the native-text + AcroForm pipeline: force AI/OCR off for a fast,
# deterministic validation run (they only add latency + nondeterminism).
if isinstance(profile.get("aiSettings"), dict):
    profile["aiSettings"]["enabled"] = False
profile["ocrSettings"] = {
    **profile.get("ocrSettings", {}), "enabledFallback": False}

NAME_FIELD = "candidate_name"
name_re = re.compile(r"^(.*?)_W[56789]", re.IGNORECASE)


def norm(s):
    return re.sub(r"[^a-z]+", "", (s or "").casefold())


zf = zipfile.ZipFile(ZIP_PATH)
pdfs = sorted(
    n for n in zf.namelist() if n.lower().endswith(".pdf") and not n.endswith("/")
)

stats = Counter()
fails = []
prose = []
crashes = []
for name in pdfs:
    fname = name.split("/")[-1]
    try:
        result = process_pdf(zf.read(name), fname, profile)
    except Exception as exc:  # noqa: BLE001
        crashes.append((fname, f"{type(exc).__name__}: {exc}"))
        continue
    diag = result["diagnostics"].get(NAME_FIELD)
    if not diag:
        stats["no_diag"] += 1
        continue
    final = diag.get("finalValue") or ""
    source = diag["source"]
    status = diag["status"]
    stats[f"src:{source}"] += 1
    stats[f"status:{status}"] += 1
    m = name_re.match(fname)
    truth = norm(m.group(1)) if m else ""
    got = norm(final)
    if final and (len(final.split()) >= 10 or len(final) > 120):
        prose.append((fname, final[:60], source))
    if truth:
        if got and (truth in got or got in truth or got == truth):
            stats["NAME_MATCH"] += 1
        elif not got:
            stats["NAME_MISS"] += 1
        else:
            stats["NAME_WRONG"] += 1
            fails.append((fname, final, truth, source, status))

print("=== candidate_name vs filename ground truth (real profile, 104 PDFs) ===")
print("crashes:", len(crashes))
for c in crashes:
    print("   CRASH", c)
print("prose leaks:", len(prose))
for p in prose:
    print("   PROSE", p)
print("stats:", dict(sorted(stats.items())))
print(f"\nWRONG-VALUE cases ({len(fails)}):")
for f in fails[:40]:
    print("   ", f)
