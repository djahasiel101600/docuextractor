from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from datetime import timedelta
import hashlib
import logging
import threading
import time
import uuid

from django.conf import settings
from django.core.files.base import ContentFile
from django.db import close_old_connections, transaction
from django.db.models import Count, Q
from django.utils import timezone
import fitz
import pytesseract
from rest_framework.exceptions import ValidationError as DRFValidationError

from ..models import (
    ExtractedField,
    FieldDiagnostic,
    PDFDocument,
    ProcessingJob,
)
from .document_extraction import process_pdf

logger = logging.getLogger(__name__)


def _document_totals(job_id):
    """Per-status document counts for a job, in one query.

    Counters used to be incremented from zero for the current run, which made
    a resumed or retried job report only its latest slice of work.
    """
    rows = (
        PDFDocument.objects.filter(job_id=job_id)
        .values("processing_status")
        .annotate(total=Count("id"))
    )
    return {row["processing_status"]: row["total"] for row in rows}


def _job_should_stop(job_id):
    """True when the worker no longer owns the job or a cancel was requested.

    Read from the database on every scheduling pass, so a cancel request made
    in any process reaches the worker that is actually running the batch.
    """
    state = (
        ProcessingJob.objects.filter(pk=job_id)
        .values("cancel_requested", "status")
        .first()
    )
    if state is None:
        return True
    return bool(state["cancel_requested"]) or state["status"] != "running"


def _heartbeat_loop(job_id, stop_event):
    """Refresh the job heartbeat until the worker is done."""
    interval = max(int(settings.JOB_HEARTBEAT_INTERVAL_SECONDS), 1)
    while not stop_event.wait(interval):
        try:
            ProcessingJob.objects.filter(pk=job_id).update(
                heartbeat_at=timezone.now()
            )
        except Exception:  # noqa: BLE001 - heartbeat must never kill the job
            logger.exception(
                "Could not refresh the heartbeat for job %s.", job_id)
        finally:
            close_old_connections()


def _extract_document(job_id, document, extraction_profile, content=None):
    close_old_connections()
    try:
        # Batch jobs stream each PDF straight off storage so the whole archive
        # never has to be resident in memory; single-upload jobs still pass the
        # already-decompressed bytes in `content`.
        if content is None:
            with document.file.open("rb") as handle:
                content = handle.read()
        return process_pdf(content, document.filename, extraction_profile), None
    except Exception as exc:
        handled_errors = (
            DRFValidationError,
            ValueError,
            OSError,
            RuntimeError,
            fitz.FileDataError,
            pytesseract.TesseractError,
        )
        if isinstance(exc, handled_errors):
            logger.warning(
                "PDF extraction failed for job %s, document %s: %s",
                job_id,
                document.pk,
                exc,
            )
            detail = getattr(exc, "detail", None)
            message = (
                "; ".join(str(item) for item in detail)
                if isinstance(detail, (list, tuple))
                else str(detail or exc)
            )
        else:
            logger.exception(
                "Unexpected PDF extraction failure for job %s, document %s.",
                job_id,
                document.pk,
            )
            message = f"Unexpected extraction error: {exc}"
        return None, message
    finally:
        close_old_connections()


def _save_document_result(
    job_id,
    document,
    extracted,
    error,
    profile_fields,
    started,
    processed_count,
    failed_count,
):
    database_started = time.perf_counter()
    if extracted is None:
        document.processing_status = "failed"
        document.extraction_method_used = "FAILED"
        document.error_details = error or "The document could not be processed."
    else:
        document.page_count = extracted["pageCount"]
        document.raw_extracted_pdf_text = extracted["rawPdfText"]
        document.pdf_text_length = extracted["pdfTextLength"]
        document.extraction_method_used = extracted["extractionMethodUsed"]
        document.processing_status = "completed"
        processing_errors = [
            error
            for error in (extracted["ocrError"], extracted.get("aiError"))
            if error
        ]
        document.error_details = "\n".join(processing_errors)

    metrics = extracted["processingMetrics"] if extracted else {}
    with transaction.atomic():
        document.save()
        if extracted is not None:
            ExtractedField.objects.bulk_create(
                [
                    ExtractedField(
                        document=document,
                        field_id=field["id"],
                        field_name=field.get("name", field["id"]),
                        final_value=extracted["finalValues"].get(
                            field["id"], ""),
                    )
                    for field in profile_fields
                ]
            )
            FieldDiagnostic.objects.bulk_create(
                [
                    FieldDiagnostic(
                        document=document,
                        field_id=field["id"],
                        field_name=field.get("name", field["id"]),
                        details=extracted["diagnostics"][field["id"]],
                    )
                    for field in profile_fields
                    if field["id"] in extracted["diagnostics"]
                ]
            )

        metrics["database_operations_ms"] = round(
            (time.perf_counter() - database_started) * 1000, 3
        )
        metrics["total_processing_ms"] = round(
            (time.perf_counter() - started) * 1000, 3
        )
        document.processing_duration_ms = metrics["total_processing_ms"]
        document.processing_metrics = metrics
        document.save(
            update_fields=["processing_duration_ms", "processing_metrics"]
        )
        ProcessingJob.objects.filter(pk=job_id).update(
            processed_count=processed_count,
            failed_count=failed_count,
        )

    logger.info(
        "Processed PDF document.",
        extra={
            "job_id": job_id,
            "document_id": document.pk,
            "processing_status": document.processing_status,
            "processing_metrics": metrics,
        },
    )


def _finalize_job(job, cancelled=False):
    documents = list(job.documents.prefetch_related("field_diagnostics"))
    # Recompute the totals from document state instead of trusting the current
    # run's counters, so a resumed or retried job reports the whole batch and
    # cannot lose earlier results.
    job.processed_count = sum(
        1 for doc in documents if doc.processing_status == "completed")
    job.failed_count = sum(
        1 for doc in documents if doc.processing_status == "failed")
    job.skipped_count = sum(
        1 for doc in documents if doc.processing_status == "excluded")
    job.review_required_count = sum(
        any(item.details.get("reviewRequired")
            for item in doc.field_diagnostics.all())
        for doc in documents
    )
    job.conflict_count = sum(
        any(item.details.get("isConflict")
            for item in doc.field_diagnostics.all())
        for doc in documents
    )
    job.missing_count = sum(
        any(item.details.get("status") ==
            "NOT_FOUND" for item in doc.field_diagnostics.all())
        for doc in documents
    )
    job.invalid_count = sum(
        any(item.details.get("status") ==
            "INVALID" for item in doc.field_diagnostics.all())
        for doc in documents
    )
    if cancelled:
        # A cooperative stop is a user decision, not a failure: documents that
        # were never reached stay pending so a retry can resume exactly them.
        job.status = "cancelled"
    elif job.processed_count or job.skipped_count:
        job.status = "completed"
    else:
        job.status = "error"
    job.save(update_fields=[
        "processed_count",
        "failed_count",
        "skipped_count",
        "review_required_count",
        "conflict_count",
        "missing_count",
        "invalid_count",
        "status",
    ])


def process_job(job_id, entries=None):
    close_old_connections()
    processed_count = 0
    failed_count = 0
    skipped_count = 0
    cancelled = False
    heartbeat_stop = threading.Event()
    try:
        job = ProcessingJob.objects.select_related("profile").get(pk=job_id)
        # A duplicate launch (or a job cancelled before the worker got here)
        # must not process anything: the compare-and-swap claim already moved
        # ownership elsewhere.
        if job.status != "running":
            return
        if job.cancel_requested:
            _finalize_job(job, cancelled=True)
            return
        # Resume from what is already on disk so progress and the final report
        # cover the whole job, not just this run.
        totals = _document_totals(job_id)
        processed_count = totals.get("completed", 0)
        failed_count = totals.get("failed", 0)
        skipped_count = totals.get("excluded", 0)
        ProcessingJob.objects.filter(pk=job_id).update(
            heartbeat_at=timezone.now(),
            processed_count=processed_count,
            failed_count=failed_count,
            skipped_count=skipped_count,
        )
        heartbeat_thread = threading.Thread(
            target=_heartbeat_loop,
            args=(job_id, heartbeat_stop),
            name=f"docuextract-heartbeat-{job_id}",
            daemon=True,
        )
        heartbeat_thread.start()

        if entries is not None:
            # Single-upload path: the PDF bytes are already decompressed in
            # memory as `entries`, so create the rows and keep the bytes for
            # this job only.
            documents = []
            contents = []
            with transaction.atomic():
                for entry in entries:
                    # Check if this document already exists for this job to preserve assignments
                    document = PDFDocument.objects.filter(
                        job=job, filename=entry.filename
                    ).first()

                    if not document:
                        document = PDFDocument(
                            id=f"doc-{uuid.uuid4()}",
                            job=job,
                            profile=None,
                            filename=entry.filename,
                            relative_path=entry.relative_path,
                            file_size_bytes=len(entry.content),
                            file_hash=hashlib.sha256(
                                entry.content).hexdigest(),
                            processing_status="pending",
                            assignment_status="legacy",
                            assignment_method="job_default",
                            assignment_rule="job_default_profile",
                            assignment_confidence=0.5,
                            raw_filename_text=entry.filename,
                        )
                        document.file.save(
                            f"{document.id}.pdf", ContentFile(entry.content), save=False
                        )

                    # Update content/status for the current processing run
                    document.processing_status = "pending"
                    document.save()

                    documents.append(document)
                    contents.append(entry.content)
                PDFDocument.objects.bulk_create(
                    [d for d in documents if d.pk is None], batch_size=100)
        else:
            # Batch path: the per-archive append endpoint already persisted each
            # PDFDocument row (bytes on storage, status pending), so we process
            # whatever is still queued. Bytes are streamed off disk per document
            # instead of holding every archive in memory.
            documents = list(
                job.documents.filter(
                    processing_status="pending").order_by("id")
            )
            contents = None

        next_document = 0
        active = {}
        worker_count = min(settings.PDF_PROCESSING_WORKERS, len(documents))
        with ThreadPoolExecutor(
            max_workers=max(worker_count, 1),
            thread_name_prefix="docuextract-pdf",
        ) as executor:
            while next_document < len(documents) or active:
                # Cooperative cancel: checked between documents from any
                # process. Already-running extractions finish and are saved;
                # the rest of the queue is left pending for a retry.
                if _job_should_stop(job_id):
                    cancelled = True
                    next_document = len(documents)
                while next_document < len(documents) and len(active) < worker_count:
                    document = documents[next_document]

                    # Documents the user excluded are skipped entirely: no
                    # extraction, no OCR/Ollama cost, and no results attributed
                    # to an unrelated profile.
                    if document.assignment_status == "excluded":
                        document.processing_status = "excluded"
                        document.error_details = ""
                        document.save(
                            update_fields=[
                                "processing_status", "error_details"]
                        )
                        skipped_count += 1
                        # Keep the live progress count accurate while the batch
                        # is still running.
                        ProcessingJob.objects.filter(pk=job_id).update(
                            skipped_count=skipped_count
                        )
                        next_document += 1
                        continue

                    # Resolve the profile: document-specific first, then the job
                    # default that the assignment rules fall back to. Ambiguous
                    # and unassigned documents must never be processed with an
                    # unrelated profile - that would silently corrupt results.
                    effective_profile = document.profile or job.profile
                    if document.profile_id is None and document.assignment_status in (
                        "ambiguous",
                        "unassigned",
                    ):
                        effective_profile = None

                    if effective_profile is None:
                        document.processing_status = "failed"
                        document.assignment_status = "unassigned"
                        document.assignment_reason = (
                            document.assignment_reason
                            or "No extraction profile could be matched to this document."
                        )
                        document.error_details = document.assignment_reason
                        document.save(
                            update_fields=[
                                "processing_status", "assignment_status", "assignment_reason", "error_details"]
                        )
                        failed_count += 1
                        next_document += 1
                        continue

                    profile_fields = effective_profile.configuration.get(
                        "fields", [])
                    extraction_profile = {
                        "fields": profile_fields,
                        "aiSettings": effective_profile.configuration.get("aiSettings", {}),
                        "extractionSettings": effective_profile.configuration.get(
                            "extractionSettings", {}
                        ),
                        "ocrSettings": effective_profile.configuration.get("ocrSettings", {}),
                    }

                    # Persist the profile actually used so the assignment stays
                    # traceable even when it came from the job default.
                    document.processing_status = "processing"
                    update_fields = ["processing_status"]
                    if document.profile_id is None:
                        document.profile = effective_profile
                        update_fields.append("profile")
                    document.save(update_fields=update_fields)
                    started = time.perf_counter()
                    content = (
                        contents[next_document] if contents is not None else None
                    )
                    future = executor.submit(
                        _extract_document,
                        job_id,
                        document,
                        extraction_profile,
                        content,
                    )
                    active[future] = (document, started, profile_fields)
                    next_document += 1

                completed, _ = wait(active, return_when=FIRST_COMPLETED)
                for future in completed:
                    document, started, profile_fields = active.pop(future)
                    extracted, error = future.result()
                    next_processed = processed_count + \
                        int(extracted is not None)
                    next_failed = failed_count + int(extracted is None)
                    _save_document_result(
                        job_id,
                        document,
                        extracted,
                        error,
                        profile_fields,
                        started,
                        next_processed,
                        next_failed,
                    )
                    processed_count = next_processed
                    failed_count = next_failed

        if not cancelled and _job_should_stop(job_id):
            cancelled = True
        _finalize_job(job, cancelled=cancelled)
    except Exception:
        logger.exception("Background processing failed for job %s.", job_id)
        try:
            totals = _document_totals(job_id)
        except Exception:  # noqa: BLE001 - keep the original error reportable
            totals = {}
        ProcessingJob.objects.filter(pk=job_id).update(
            status="error",
            processed_count=totals.get("completed", processed_count),
            failed_count=totals.get("failed", failed_count),
            skipped_count=totals.get("excluded", skipped_count),
        )
    finally:
        heartbeat_stop.set()
        close_old_connections()


def recover_stale_jobs():
    """Resume jobs orphaned by a crash or restart.

    A "running" job whose heartbeat is missing or older than
    settings.JOB_STALE_SECONDS has no live worker. Claim it with a conditional
    update (several processes may scan at once; only one update can win), reset
    documents interrupted mid-extraction, and relaunch. Returns the resumed
    job ids.
    """
    cutoff = timezone.now() - timedelta(seconds=settings.JOB_STALE_SECONDS)
    stale_filter = Q(heartbeat_at__isnull=True) | Q(heartbeat_at__lt=cutoff)
    stale_ids = list(
        ProcessingJob.objects.filter(status="running")
        .filter(stale_filter)
        .values_list("pk", flat=True)
    )
    resumed = []
    for job_id in stale_ids:
        claimed = (
            ProcessingJob.objects.filter(pk=job_id, status="running")
            .filter(stale_filter)
            .update(heartbeat_at=timezone.now())
        )
        if not claimed:
            continue
        PDFDocument.objects.filter(
            job_id=job_id, processing_status="processing"
        ).update(processing_status="pending")
        logger.warning("Resuming orphaned job %s after restart.", job_id)
        launch_job_processing(job_id)
        resumed.append(job_id)
    return resumed


def launch_job_processing(job_id, entries=None):
    worker = threading.Thread(
        target=process_job,
        args=(job_id, entries),
        name=f"docuextract-{job_id}",
        daemon=True,
    )
    worker.start()
