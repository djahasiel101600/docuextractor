"""Inspect multi-page documents: per-page text and where fields matched.

Read-only. Run with the backend environment (needs PyMuPDF + Django).
"""

import os
import sys

os.environ["DOCUEXTRACT_RECOVER_JOBS"] = "0"
sys.path.insert(
    0, os.path.join(os.path.dirname(
        os.path.abspath(__file__)), "..", "backend")
)
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")

import django  # noqa: E402
import fitz  # noqa: E402

django.setup()

from extraction.models import PDFDocument  # noqa: E402


def main():
    documents = PDFDocument.objects.filter(page_count__gt=1).select_related(
        "profile"
    )
    for document in documents:
        profile_name = document.profile.name if document.profile else None
        print(
            f"=== {document.filename} | profile={profile_name} | "
            f"pages={document.page_count} | status={document.processing_status}"
        )
        with document.file.open("rb") as handle:
            pdf = fitz.open(stream=handle.read(), filetype="pdf")
        try:
            for index, page in enumerate(pdf):
                text = page.get_text("text")
                preview = " / ".join(
                    line.strip() for line in text.splitlines() if line.strip()
                )[:120]
                print(f"  page {index + 1}: {len(text)} chars | {preview}")
        finally:
            pdf.close()

        diagnostics = list(document.field_diagnostics.all())
        statuses = {}
        for diagnostic in diagnostics:
            status = diagnostic.details.get("status")
            statuses[status] = statuses.get(status, 0) + 1
        print(f"  statuses: {statuses}")
        for diagnostic in diagnostics:
            details = diagnostic.details
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
                f"   {diagnostic.field_id[:36]:36} "
                f"{details.get('status', ''):15} pages={pages} | "
                f"{value} | {label}"
            )
        print()


if __name__ == "__main__":
    main()
