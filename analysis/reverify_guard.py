"""Re-verify the whole 104-doc batch with the fixed extractor, using the
actual stored HR profile (never a synthetic config) and the original PDFs from
job-138c040c. Writes analysis/_reverify.json and prints the headline checks.
"""
from extraction.services.document_extraction import process_pdf
from extraction.models import PDFDocument, ProcessingJob
import django
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))
os.environ["DATABASE_URL"] = "sqlite:///" + (
    os.path.abspath(
        os.path.join(os.path.dirname(__file__), "..",
                     "storage", "docuextract.sqlite3")
    )
)
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")

django.setup()


NAME = "candidate_name"
ADDR = "field_1793589323133"
JOB_ID = "job-138c040c-2e1b-4dce-af6d-24c4132d5862"

job = ProcessingJob.objects.get(id=JOB_ID)
profile = job.profile.configuration
profile.setdefault("fields", [])
for f in profile["fields"]:
    f.setdefault("contentRules", {"enabled": True, "labels": []})
# The original browser run recorded 0 AI and 0 OCR invocations; pin both off so
# this sweep is a like-for-like, deterministic comparison of the field rules.
profile["aiSettings"] = {"enabled": False}
profile["ocrSettings"] = {"enabledFallback": False, "autoDetectScanned": False}

out = {}
statuses = {}
for doc in PDFDocument.objects.filter(job=job).order_by("filename"):
    with open(doc.file.path, "rb") as fh:
        pdf_bytes = fh.read()
    result = process_pdf(pdf_bytes, doc.filename, profile)
    diag = result["diagnostics"]
    out[doc.filename] = {
        field_id: {
            "status": d.get("status"),
            "source": d.get("source"),
            "final": d.get("finalValue"),
            "form": d.get("formValue"),
            "formConf": d.get("formConfidenceScore"),
            "validationPassed": d.get("validationPassed"),
            "reviewRequired": d.get("reviewRequired"),
        }
        for field_id, d in diag.items()
    }
    for field_id, d in diag.items():
        statuses.setdefault(field_id, {}).setdefault(d.get("status"), 0)
        statuses[field_id][d.get("status")] += 1

with open(os.path.join(os.path.dirname(__file__), "_reverify.json"), "w", encoding="utf-8") as fh:
    json.dump(out, fh, indent=1)

print("STATUS DISTRIBUTION:", json.dumps(statuses))
for probe in [
    "Fazlyn_Lagardien_W8.pdf",
    "Aurimas Juskevicius_W8.pdf",
    "Albina Askatova_W8.pdf",
    "Nina Mitrovic_W8.pdf",
    "Jaycee Carlo Calandria_W8.pdf",
    "Titas Vaiciunas_W8.pdf",
]:
    hits = {k: v for k, v in out.items() if k.lower().startswith(
        probe.split("_")[0][:6].lower()) or k == probe}
    for name, fields in hits.items():
        print("\n", name)
        for field_id, d in fields.items():
            print(
                f"   {field_id}: status={d['status']} source={d['source']} "
                f"final={d['final']!r} form={d['form']!r} validated={d['validationPassed']}"
            )
