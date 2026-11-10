"""Inspect the one ssn_tin MISMATCH -> MATCHED document from the Phase 0 recheck.

Re-runs only the documents whose stored ssn_tin diagnostic was MISMATCH so the
new value can be compared against the old conflicted one without re-processing
the whole 104-document corpus.
"""
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))
os.environ.setdefault("DJANGO_DEBUG", "true")
os.environ.setdefault("DJANGO_SECRET_KEY", "phase0-recheck")
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")

import django  # noqa: E402

django.setup()

from django.conf import settings  # noqa: E402

from extraction.models import FieldDiagnostic, ProcessingJob  # noqa: E402
from extraction.services.document_extraction import process_pdf  # noqa: E402

settings.OCR_ENABLED = False
settings.OCR_SPACE_ENABLED = False

JOB_ID = "job-29e2e0c0-857f-46cd-a07e-df56000d9fb1"


def main():
    job = ProcessingJob.objects.select_related("profile").get(pk=JOB_ID)
    profile_config = dict(job.profile.configuration)
    profile_config["aiSettings"] = {
        **profile_config.get("aiSettings", {}),
        "enabled": False,
    }

    candidates = []
    for diagnostic in FieldDiagnostic.objects.filter(
        document__job=job, field_id="ssn_tin"
    ).select_related("document"):
        if (diagnostic.details or {}).get("status") == "MISMATCH":
            candidates.append((diagnostic.document, diagnostic.details))
    print(f"{len(candidates)} stored ssn_tin MISMATCH diagnostics")

    for document, old in candidates:
        with document.file.open("rb") as handle:
            content = handle.read()
        result = process_pdf(content, document.filename, profile_config)
        new = result["diagnostics"].get("ssn_tin", {})
        print(f"\n{document.filename}")
        print(
            f"  old: status={old.get('status')} value={old.get('finalValue')!r}")
        print(
            f"       pdfValue={old.get('pdfValue')!r} aiValue={old.get('aiValue')!r}")
        print(f"       validationError={old.get('validationError')!r}")
        print(
            f"  new: status={new.get('status')} value={new.get('finalValue')!r}")
        print(
            f"       pdfValue={new.get('pdfValue')!r} aiValue={new.get('aiValue')!r}")
        print(f"       validationError={new.get('validationError')!r}")
        for candidate in new.get("candidates") or []:
            print(
                "  candidate:"
                f" method={candidate.get('method')}"
                f" value={candidate.get('value')!r}"
                f" confidence={candidate.get('confidence')}"
            )


if __name__ == "__main__":
    main()
