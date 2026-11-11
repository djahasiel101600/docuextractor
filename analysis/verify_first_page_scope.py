"""Re-run extraction on a stored multi-page PDF with its live profile.

Read-only: prints final values, diagnostics page numbers, and page-scope
metrics so firstPageOnly can be verified against real archived documents.
Run with the backend environment (needs PyMuPDF + Django).
"""

import os
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

os.environ["DOCUEXTRACT_RECOVER_JOBS"] = "0"
sys.path.insert(
    0, os.path.join(os.path.dirname(
        os.path.abspath(__file__)), "..", "backend")
)
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")

import django  # noqa: E402

django.setup()

from extraction.models import PDFDocument  # noqa: E402
from extraction.services.document_extraction import process_pdf  # noqa: E402


def main():
    filename = (
        sys.argv[1] if len(sys.argv) > 1 else "Kateryna Shestak updated.W9.pdf"
    )
    document = (
        PDFDocument.objects.filter(
            filename=filename, profile__isnull=False, page_count__gt=1
        )
        .select_related("profile")
        .latest("id")
    )
    profile = {
        "fields": document.profile.configuration.get("fields", []),
        "aiSettings": document.profile.configuration.get("aiSettings", {}),
        "extractionSettings": document.profile.configuration.get(
            "extractionSettings", {}
        ),
        "ocrSettings": document.profile.configuration.get("ocrSettings", {}),
    }
    print(
        f"=== {document.filename} | profile={document.profile.name} | "
        f"settings={profile['extractionSettings']}"
    )
    with document.file.open("rb") as handle:
        pdf_bytes = handle.read()

    extracted = process_pdf(pdf_bytes, document.filename, profile)
    metrics = extracted["processingMetrics"]
    print(
        f"  pageCount={extracted['pageCount']} "
        f"scope={metrics.get('page_scope')} "
        f"pages_extracted={metrics.get('pages_extracted')} "
        f"text_length={extracted['pdfTextLength']}"
    )
    statuses = {}
    for details in extracted["diagnostics"].values():
        statuses[details["status"]] = statuses.get(details["status"], 0) + 1
    print(f"  statuses: {statuses}")
    for field_id, details in extracted["diagnostics"].items():
        pages = {
            key: details.get(key)
            for key in (
                "pdfPageNumber",
                "ocrPageNumber",
                "ocrSpacePageNumber",
                "formPageNumber",
            )
            if details.get(key) is not None
        }
        value = (details.get("finalValue") or "").replace("\n", " ")[:55]
        label = (details.get("matchedPatternOrLabel") or "")[:42]
        print(
            f"   {field_id[:36]:36} {details['status']:15} "
            f"pages={pages} | {value} | {label}"
        )


if __name__ == "__main__":
    main()
