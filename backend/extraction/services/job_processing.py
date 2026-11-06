from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
import hashlib
import logging
import threading
import time
import uuid

from django.conf import settings
from django.core.files.base import ContentFile
from django.db import close_old_connections, transaction
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


def _finalize_job(job, processed_count, failed_count):
    documents = list(job.documents.prefetch_related("field_diagnostics"))
    job.processed_count = processed_count
    job.failed_count = failed_count
    job.status = "completed" if processed_count else "error"
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
    job.save()


def process_job(job_id, entries=None):
    close_old_connections()
    processed_count = 0
    failed_count = 0
    try:
        job = ProcessingJob.objects.select_related("profile").get(pk=job_id)
        profile_fields = job.profile.configuration.get("fields", [])
        extraction_profile = {
            "fields": profile_fields,
            "aiSettings": job.profile.configuration.get("aiSettings", {}),
            "extractionSettings": job.profile.configuration.get(
                "extractionSettings", {}
            ),
            "ocrSettings": job.profile.configuration.get("ocrSettings", {}),
        }

        if entries is not None:
            # Single-upload path: the PDF bytes are already decompressed in
            # memory as `entries`, so create the rows and keep the bytes for
            # this job only.
            documents = []
            contents = []
            with transaction.atomic():
                for entry in entries:
                    document = PDFDocument(
                        id=f"doc-{uuid.uuid4()}",
                        job=job,
                        filename=entry.filename,
                        relative_path=entry.relative_path,
                        file_size_bytes=len(entry.content),
                        file_hash=hashlib.sha256(entry.content).hexdigest(),
                        processing_status="pending",
                        raw_filename_text=entry.filename,
                    )
                    document.file.save(
                        f"{document.id}.pdf", ContentFile(entry.content), save=False
                    )
                    documents.append(document)
                    contents.append(entry.content)
                PDFDocument.objects.bulk_create(documents, batch_size=100)
        else:
            # Batch path: the per-archive append endpoint already persisted each
            # PDFDocument row (bytes on storage, status pending), so we process
            # whatever is still queued. Bytes are streamed off disk per document
            # instead of holding every archive in memory.
            documents = list(
                job.documents.filter(processing_status="pending").order_by("id")
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
                while next_document < len(documents) and len(active) < worker_count:
                    document = documents[next_document]
                    document.processing_status = "processing"
                    document.save(update_fields=["processing_status"])
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
                    active[future] = (document, started)
                    next_document += 1

                completed, _ = wait(active, return_when=FIRST_COMPLETED)
                for future in completed:
                    document, started = active.pop(future)
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

        _finalize_job(job, processed_count, failed_count)
    except Exception:
        logger.exception("Background processing failed for job %s.", job_id)
        ProcessingJob.objects.filter(pk=job_id).update(
            status="error",
            processed_count=processed_count,
            failed_count=failed_count,
        )
    finally:
        close_old_connections()


def launch_job_processing(job_id, entries=None):
    worker = threading.Thread(
        target=process_job,
        args=(job_id, entries),
        name=f"docuextract-{job_id}",
        daemon=True,
    )
    worker.start()
