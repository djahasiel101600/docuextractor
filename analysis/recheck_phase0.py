"""Before/after re-extraction check for the Phase 0 accuracy guards.

The 104-document archive referenced by validate_accuracy.py is no longer in the
workspace, but the pipeline still has the stored PDFs and the stored (pre-change)
diagnostics of the matching completed job. This script re-runs the CURRENT
extraction code over those PDFs with the job's own profile and compares each
field's outcome with the stored diagnostics.

OCR and AI are disabled so the comparison isolates the deterministic
native-text + AcroForm pipeline, exactly like the original audit harness.

Usage (from the repository root):
    python analysis/recheck_phase0.py [job-id]

Writes analysis/out/phase0_recheck.json and prints a compact summary.
"""
import json
import os
import sys
import time
from collections import Counter
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
from extraction.services.country_data import is_country_value  # noqa: E402
from extraction.services.document_extraction import (  # noqa: E402
    _infer_value_type,
    _is_us_ssn,
    process_pdf,
)

settings.OCR_ENABLED = False
settings.OCR_SPACE_ENABLED = False

DEFAULT_JOB_ID = "job-29e2e0c0-857f-46cd-a07e-df56000d9fb1"
FOCUS_FIELDS = ("country_of_citizenship", "country",
                "country_mailing", "ssn_tin")
MAX_EXAMPLES = 25


def load_profile_configuration(job):
    config = dict(job.profile.configuration)
    # Force a fully offline, deterministic run.
    config["aiSettings"] = {**config.get("aiSettings", {}), "enabled": False}
    return config


def value_is_semantically_valid(field, value):
    """Mirror the Phase 0 value guards for the report."""
    if not value:
        return True
    value_type = _infer_value_type(field)
    if value_type == "country":
        return is_country_value(value)
    if value_type == "us_ssn":
        return _is_us_ssn(value)
    return True


def main(job_id=DEFAULT_JOB_ID):
    job = ProcessingJob.objects.select_related("profile").get(pk=job_id)
    profile_config = load_profile_configuration(job)
    field_configs = {
        field.get("id"): field
        for field in profile_config.get("fields", [])
        if isinstance(field, dict)
    }
    documents = list(job.documents.order_by("filename"))
    limit = int(os.getenv("PHASE0_LIMIT", "0"))
    if limit:
        documents = documents[:limit]
    print(f"Job {job.pk}: {len(documents)} documents, profile {job.profile.name}")

    old_diagnostics = {}
    for diagnostic in FieldDiagnostic.objects.filter(document__job=job):
        old_diagnostics.setdefault(diagnostic.document_id, {})[
            diagnostic.field_id
        ] = diagnostic.details

    transitions = Counter()
    examples = []
    old_invalid = Counter()
    new_invalid = Counter()
    old_semantic_violations = Counter()
    new_semantic_violations = Counter()
    fragment_hits = {"old": 0, "new": 0}
    durations = []
    missing_files = []
    failures = []

    for index, document in enumerate(documents, start=1):
        try:
            with document.file.open("rb") as handle:
                content = handle.read()
        except (FileNotFoundError, ValueError):
            missing_files.append(document.filename)
            continue
        started = time.perf_counter()
        try:
            result = process_pdf(content, document.filename, profile_config)
        except Exception as exc:  # noqa: BLE001
            failures.append(
                (document.filename, f"{type(exc).__name__}: {exc}"))
            continue
        durations.append(time.perf_counter() - started)

        for field_id in FOCUS_FIELDS:
            old = old_diagnostics.get(document.id, {}).get(field_id, {})
            new = result["diagnostics"].get(field_id, {})
            old_status = old.get("status") or "MISSING"
            new_status = new.get("status") or "MISSING"
            old_value = old.get("finalValue") or ""
            new_value = new.get("finalValue") or ""
            transitions[(field_id, old_status, new_status)] += 1
            if old_status == "INVALID":
                old_invalid[field_id] += 1
            if new_status == "INVALID":
                new_invalid[field_id] += 1
            field_config = field_configs.get(field_id, {"id": field_id})
            if not value_is_semantically_valid(field_config, old_value):
                old_semantic_violations[field_id] += 1
            if not value_is_semantically_valid(field_config, new_value):
                new_semantic_violations[field_id] += 1
            fragment = old_value.strip().casefold() == "address."
            if fragment:
                fragment_hits["old"] += 1
                if new_value.strip().casefold() == "address.":
                    fragment_hits["new"] += 1
            if old_value != new_value and len(examples) < MAX_EXAMPLES:
                examples.append(
                    {
                        "document": document.filename,
                        "field": field_id,
                        "oldStatus": old_status,
                        "newStatus": new_status,
                        "oldValue": old_value,
                        "newValue": new_value,
                        "newValidationError": new.get("validationError"),
                    }
                )
        if index % 10 == 0:
            print(
                f"  {index}/{len(documents)} docs "
                f"({sum(durations):.1f}s total, {durations[-1]:.2f}s last)",
                flush=True,
            )

    report = {
        "jobId": job.pk,
        "profile": job.profile.name,
        "documents": len(documents),
        "processed": len(durations),
        "missingFiles": missing_files,
        "failures": failures,
        "ocrAi": "disabled (deterministic offline run)",
        "timing": {
            "totalSeconds": round(sum(durations), 1),
            "averageSeconds": round(sum(durations) / max(len(durations), 1), 2),
            "p95Seconds": round(
                sorted(durations)[int(len(durations) * 0.95)], 2
            ) if durations else None,
        },
        "invalidCounts": {
            "before": dict(old_invalid),
            "after": dict(new_invalid),
        },
        "semanticViolations": {
            "before": dict(old_semantic_violations),
            "after": dict(new_semantic_violations),
        },
        "addressFragmentValues": fragment_hits,
        "statusTransitions": {
            f"{field}: {old_status} -> {new_status}": count
            for (field, old_status, new_status), count in sorted(
                transitions.items()
            )
        },
        "changedExamples": examples,
    }
    out_path = ROOT / "analysis" / "out" / "phase0_recheck.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(report, indent=2), encoding="utf-8")

    print("\n=== Focus-field status transitions ===")
    for label, count in report["statusTransitions"].items():
        print(f"  {label}: {count}")
    print("\n=== INVALID counts before -> after ===")
    for field_id in FOCUS_FIELDS:
        print(
            f"  {field_id}: {old_invalid[field_id]} -> {new_invalid[field_id]}"
        )
    print("\n=== Values failing the new semantic guard before -> after ===")
    for field_id in FOCUS_FIELDS:
        print(
            f"  {field_id}: {old_semantic_violations[field_id]}"
            f" -> {new_semantic_violations[field_id]}"
        )
    print(
        f"\n'address.' values: {fragment_hits['old']} -> {fragment_hits['new']}")
    print(f"Missing stored PDFs: {len(missing_files)}")
    print(f"Report written to {out_path}")
    return report


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else DEFAULT_JOB_ID)
