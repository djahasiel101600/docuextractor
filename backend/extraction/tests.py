from io import BytesIO
import copy
import json
import tempfile
from threading import Barrier, Lock
import time
import zipfile
from unittest.mock import patch

import fitz
from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import connection
from django.test import override_settings
from django.test import SimpleTestCase
from PIL import Image
from rest_framework.exceptions import ValidationError
from rest_framework.test import APITestCase

from .models import PDFDocument, ProcessingJob
from .services.document_extraction import (
    _choose_content_candidate,
    _drop_duplicate_form_widgets,
    _needs_selective_ai_review,
    _normalize_ocrspace_lines,
    _ocr_pdf,
    _ocr_pdf_ocrspace,
    process_pdf,
)
from .services.job_processing import process_job
from .services.form_layout import analyze_blank_form, validate_profile_config
from .services.ollama import (
    _request_json,
    extract_with_ollama,
    normalize_ollama_url,
)


PROFILE = {
    "id": "test-profile",
    "name": "Test Profile",
    "description": "Test extraction profile",
    "version": "1.0",
    "fields": [
        {
            "id": "full_name",
            "name": "Full Name",
            "label": "Full Name",
            "type": "text",
            "required": True,
            "filenameRules": {
                "enabled": False,
                "patterns": [],
                "captureGroup": 1,
                "caseInsensitive": True,
            },
            "contentRules": {
                "enabled": True,
                "labels": ["Full Name:"],
                "regexPatterns": [],
            },
            "priority": "pdf_first",
            "normalization": {
                "trim": True,
                "caseTransform": "none",
                "removeExtraSpaces": True,
            },
            "validation": {},
        }
    ],
    "ocrSettings": {
        "enabledFallback": False,
        "autoDetectScanned": False,
        "minTextLengthThreshold": 40,
        "language": "eng",
    },
}


def create_pdf():
    document = fitz.open()
    page = document.new_page()
    page.insert_text((72, 72), "Full Name: Jane Doe")
    content = document.tobytes()
    document.close()
    return content


def create_layout_pdf(text_items):
    document = fitz.open()
    page = document.new_page()
    for text, x, y in text_items:
        page.insert_text((x, y), text, fontsize=8)
    content = document.tobytes()
    document.close()
    return content


def create_acroform_pdf(label_items, widget_items):
    """PDF with printed label rows plus filled AcroForm text widgets.

    widget_items are (field_name, field_value, rect) tuples; the widget values
    live in annotations, so they reach extraction only through the AcroForm
    readers, exactly like a real filled government form.
    """
    document = fitz.open()
    page = document.new_page()
    for text, x, y in label_items:
        page.insert_text((x, y), text, fontsize=8)
    for name, value, rect in widget_items:
        widget = fitz.Widget()
        widget.field_name = name
        widget.field_value = value
        widget.rect = fitz.Rect(*rect)
        widget.field_type = fitz.PDF_WIDGET_TYPE_TEXT
        page.add_widget(widget)
    content = document.tobytes()
    document.close()
    return content


def create_labeled_field(field_id, label):
    return {
        "id": field_id,
        "name": field_id.replace("_", " ").title(),
        "label": label,
        "type": "text",
        "required": True,
        "filenameRules": {
            "enabled": False,
            "patterns": [],
            "captureGroup": 1,
            "caseInsensitive": True,
        },
        "contentRules": {
            "enabled": True,
            "labels": [label],
            "regexPatterns": [],
        },
        "priority": "pdf_first",
        "normalization": {
            "trim": True,
            "caseTransform": "none",
            "removeExtraSpaces": True,
        },
        "validation": {},
    }


def create_zip(entries):
    buffer = BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, content in entries:
            archive.writestr(name, content)
    return buffer.getvalue()


@override_settings(OCR_ENABLED=False)
class ExtractionApiTests(APITestCase):
    def setUp(self):
        self.media_dir = tempfile.TemporaryDirectory()
        self.settings_override = override_settings(
            MEDIA_ROOT=self.media_dir.name)
        self.settings_override.enable()
        self.addCleanup(self.settings_override.disable)
        self.addCleanup(self.media_dir.cleanup)

    def create_profile(self):
        response = self.client.post("/api/profiles/", PROFILE, format="json")
        self.assertEqual(response.status_code, 201, response.data)
        return response.data

    def test_api_root_checks_database_connection(self):
        response = self.client.get("/api/")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["database"], "connected")

    def test_openapi_schema_is_available(self):
        response = self.client.get("/api/schema/")
        self.assertEqual(response.status_code, 200)
        self.assertIn("/api/jobs/", response.data["paths"])

    def test_profile_create_and_update_round_trip(self):
        profile = self.create_profile()
        self.assertEqual(profile["fields"][0]["id"], "full_name")
        self.assertEqual(profile["ocrSettings"]["language"], "eng")
        self.assertEqual(profile["aiSettings"]["enabled"], False)
        self.assertEqual(profile["aiSettings"]["allowCloudModels"], False)
        self.assertEqual(
            profile["aiSettings"]["baseUrl"], "http://127.0.0.1:11434"
        )
        self.assertEqual(
            profile["extractionSettings"]["labelSimilarityThreshold"], 0.82
        )

        updated = {
            **PROFILE,
            "name": "Updated Test Profile",
            "aiSettings": {
                "enabled": True,
                "baseUrl": "http://localhost:11434",
                "model": "llama3.2",
                "timeoutSeconds": 90,
                "contextSize": 8192,
                "strategy": "fallback",
            },
            "extractionSettings": {"labelSimilarityThreshold": 0.91},
        }
        response = self.client.put(
            "/api/profiles/test-profile/", updated, format="json"
        )
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data["name"], "Updated Test Profile")
        self.assertEqual(response.data["aiSettings"]["enabled"], True)
        self.assertEqual(response.data["aiSettings"]["model"], "llama3.2")
        self.assertEqual(response.data["aiSettings"]["contextSize"], 8192)
        self.assertEqual(response.data["aiSettings"]["strategy"], "fallback")
        self.assertEqual(
            response.data["extractionSettings"]["labelSimilarityThreshold"], 0.91
        )

    def test_ollama_connection_test_checks_local_service_and_model(self):
        with patch(
            "extraction.services.ollama._request_json",
            side_effect=[
                {"models": [{"name": "llama3.2:latest"}]},
                {"response": '{"connection_test":"ok"}'},
            ],
        ) as request:
            response = self.client.post(
                "/api/ai/ollama/test/",
                {
                    "baseUrl": "http://127.0.0.1:11434/",
                    "model": "llama3.2",
                },
                format="json",
            )

        self.assertEqual(response.status_code, 200, response.data)
        self.assertTrue(response.data["connected"])
        self.assertEqual(response.data["models"], ["llama3.2:latest"])
        self.assertEqual(request.call_count, 2)
        self.assertEqual(
            request.call_args_list[0].args[0],
            "http://127.0.0.1:11434/api/tags",
        )
        self.assertEqual(request.call_args_list[0].kwargs["timeout"], 120)
        self.assertEqual(
            request.call_args_list[1].args[0],
            "http://127.0.0.1:11434/api/generate",
        )
        self.assertEqual(request.call_args_list[1].kwargs["timeout"], 120)
        self.assertEqual(
            request.call_args_list[1].args[1]["model"], "llama3.2:latest"
        )
        self.assertEqual(
            request.call_args_list[1].args[1]["options"]["num_predict"], 128
        )

    def test_ollama_connection_rejects_non_local_urls(self):
        with self.assertRaisesMessage(ValidationError, "this computer"):
            normalize_ollama_url("http://example.com:11434")

    def test_ollama_connection_test_reports_missing_model(self):
        with patch(
            "extraction.services.ollama._request_json",
            return_value={"models": [{"name": "mistral:latest"}]},
        ):
            response = self.client.post(
                "/api/ai/ollama/test/",
                {
                    "baseUrl": "http://localhost:11434",
                    "model": "llama3.2",
                },
                format="json",
            )

        self.assertEqual(response.status_code, 502)
        self.assertIn("not available", response.data["detail"])

    def test_ollama_request_reports_timeout_separately_from_connection_failure(self):
        with patch("extraction.services.ollama.build_opener") as build_opener:
            build_opener.return_value.open.side_effect = TimeoutError()

            with self.assertRaisesMessage(
                RuntimeError, "Ollama did not respond within the 3-second timeout."
            ):
                _request_json("http://127.0.0.1:11434/api/generate", timeout=3)

    def test_ollama_connection_requires_cloud_model_opt_in(self):
        with patch(
            "extraction.services.ollama._request_json",
            return_value={"models": [{"name": "beam:cloud"}]},
        ) as request:
            response = self.client.post(
                "/api/ai/ollama/test/",
                {
                    "baseUrl": "http://127.0.0.1:11434",
                    "model": "beam",
                },
                format="json",
            )

        self.assertEqual(response.status_code, 502)
        self.assertIn("Cloud model use is disabled", response.data["detail"])
        request.assert_called_once_with(
            "http://127.0.0.1:11434/api/tags", timeout=120
        )

    def test_ollama_connection_tests_an_opted_in_cloud_model(self):
        with patch(
            "extraction.services.ollama._request_json",
            side_effect=[
                {"models": [{"name": "beam:cloud"}]},
                {"response": '{"connection_test":"ok"}'},
            ],
        ) as request:
            response = self.client.post(
                "/api/ai/ollama/test/",
                {
                    "baseUrl": "http://127.0.0.1:11434",
                    "model": "beam",
                    "allowCloudModels": True,
                },
                format="json",
            )

        self.assertEqual(response.status_code, 200, response.data)
        self.assertTrue(response.data["connected"])
        self.assertEqual(response.data["models"], ["beam:cloud"])
        self.assertEqual(
            request.call_args_list[1].args[1]["model"], "beam:cloud"
        )

    def test_zip_processing_persists_document_and_supports_review_and_edits(self):
        self.create_profile()
        upload = create_zip([("nested/forms/application.pdf", create_pdf())])
        with patch(
            "extraction.views.launch_job_processing",
            side_effect=process_job,
        ):
            response = self.client.post(
                "/api/jobs/",
                {
                    "profileId": "test-profile",
                    "file": SimpleUploadedFile("documents.zip", upload, "application/zip"),
                },
                format="multipart",
            )
        self.assertEqual(response.status_code, 202, response.data)
        job_response = self.client.get(f"/api/jobs/{response.data['id']}/")
        self.assertEqual(job_response.status_code, 200, job_response.data)
        job = job_response.data
        self.assertEqual(job["status"], "completed")
        self.assertEqual(job["documents"][0]["relativePath"],
                         "nested/forms/application.pdf")
        self.assertEqual(job["documents"][0]["finalValues"]
                         ["full_name"], "Jane Doe")

        document_id = job["documents"][0]["id"]
        response = self.client.patch(
            f"/api/documents/{document_id}/",
            {"fieldId": "full_name", "value": "Jane A. Doe"},
            format="json",
        )
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data["finalValues"]
                         ["full_name"], "Jane A. Doe")
        self.assertTrue(response.data["diagnostics"]
                        ["full_name"]["isManuallyCorrected"])

        response = self.client.patch(
            f"/api/documents/{document_id}/",
            {"reviewed": True},
            format="json",
        )
        self.assertEqual(response.status_code, 200, response.data)
        self.assertTrue(response.data["isReviewed"])

        response = self.client.get(f"/api/documents/{document_id}/file/")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response["Content-Type"], "application/pdf")
        response.close()

        response = self.client.get(f"/api/jobs/{job['id']}/export/")
        self.assertEqual(response.status_code, 200)
        self.assertIn(b"Jane A. Doe", b"".join(response.streaming_content))

    def test_pdf_extraction_runs_outside_database_transaction(self):
        self.create_profile()
        upload = create_zip([("application.pdf", create_pdf())])

        def process_without_holding_database_transaction(*args, **kwargs):
            self.assertEqual(len(connection.atomic_blocks), 0)
            return process_pdf(*args, **kwargs)

        with (
            patch(
                "extraction.services.job_processing.process_pdf",
                side_effect=process_without_holding_database_transaction,
            ),
            patch(
                "extraction.views.launch_job_processing",
                side_effect=process_job,
            ),
        ):
            response = self.client.post(
                "/api/jobs/",
                {
                    "profileId": "test-profile",
                    "file": SimpleUploadedFile(
                        "documents.zip", upload, "application/zip"
                    ),
                },
                format="multipart",
            )

        self.assertEqual(response.status_code, 202, response.data)
        job_response = self.client.get(f"/api/jobs/{response.data['id']}/")
        self.assertEqual(job_response.data["processedCount"], 1)

    def test_job_upload_returns_running_job_and_progress_endpoint_updates(self):
        self.create_profile()
        upload = create_zip([("application.pdf", create_pdf())])
        with patch("extraction.views.launch_job_processing") as launch:
            response = self.client.post(
                "/api/jobs/",
                {
                    "profileId": "test-profile",
                    "file": SimpleUploadedFile(
                        "documents.zip", upload, "application/zip"
                    ),
                },
                format="multipart",
            )

        self.assertEqual(response.status_code, 202, response.data)
        self.assertEqual(response.data["status"], "running")
        self.assertEqual(response.data["totalDiscovered"], 1)
        launch.assert_called_once()

        job = ProcessingJob.objects.get(pk=response.data["id"])
        PDFDocument.objects.create(
            id="doc-live-progress",
            job=job,
            filename="application.pdf",
            relative_path="application.pdf",
            file_size_bytes=1,
            file=SimpleUploadedFile(
                "application.pdf", create_pdf(), "application/pdf"),
            processing_status="processing",
        )
        progress = self.client.get(
            f"/api/jobs/{response.data['id']}/progress/")
        self.assertEqual(progress.status_code, 200, progress.data)
        self.assertEqual(progress.data["status"], "running")
        self.assertEqual(progress.data["currentProcessingFiles"], [
                         "application.pdf"])
        self.assertEqual(progress.data["processedCount"], 0)
        self.assertEqual(progress.data["failedCount"], 0)
        self.assertEqual(progress.data["remainingCount"], 1)
        self.assertIsNone(progress.data["averageSecondsPerDocument"])

    def test_documents_are_processed_with_configured_bounded_concurrency(self):
        self.create_profile()
        upload = create_zip(
            [(f"form-{index}.pdf", create_pdf()) for index in range(3)]
        )
        active_count = 0
        peak_active_count = 0
        call_count = 0
        active_lock = Lock()
        start_barrier = Barrier(2)

        def fake_process_pdf(*args, **kwargs):
            nonlocal active_count, peak_active_count, call_count
            with active_lock:
                call_count += 1
                current_call = call_count
                active_count += 1
                peak_active_count = max(peak_active_count, active_count)
            try:
                if current_call <= 2:
                    start_barrier.wait(timeout=5)
                time.sleep(0.02)
                return {
                    "pageCount": 1,
                    "rawPdfText": "Full Name: Jane Doe",
                    "pdfTextLength": 19,
                    "extractionMethodUsed": "NATIVE_PDF_TEXT",
                    "ocrError": "",
                    "finalValues": {"full_name": "Jane Doe"},
                    "diagnostics": {},
                    "processingMetrics": {"total_processing_ms": 20.0},
                }
            finally:
                with active_lock:
                    active_count -= 1

        with (
            override_settings(PDF_PROCESSING_WORKERS=2),
            patch(
                "extraction.services.job_processing.process_pdf",
                side_effect=fake_process_pdf,
            ),
            patch(
                "extraction.views.launch_job_processing",
                side_effect=process_job,
            ),
        ):
            response = self.client.post(
                "/api/jobs/",
                {
                    "profileId": "test-profile",
                    "file": SimpleUploadedFile(
                        "documents.zip", upload, "application/zip"
                    ),
                },
                format="multipart",
            )

        job = self.client.get(f"/api/jobs/{response.data['id']}/").data
        self.assertEqual(response.status_code, 202, response.data)
        self.assertEqual(job["processedCount"], 3)
        self.assertEqual(peak_active_count, 2)
        self.assertTrue(
            all(document["processingMetrics"]["database_operations_ms"] >= 0
                for document in job["documents"])
        )

    def test_archive_path_traversal_is_rejected(self):
        self.create_profile()
        upload = create_zip([("../outside.pdf", create_pdf())])
        response = self.client.post(
            "/api/jobs/",
            {
                "profileId": "test-profile",
                "file": SimpleUploadedFile("documents.zip", upload, "application/zip"),
            },
            format="multipart",
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("unsafe path", str(response.data).lower())

    def test_invalid_upload_is_rejected(self):
        self.create_profile()
        response = self.client.post(
            "/api/jobs/",
            {
                "profileId": "test-profile",
                "file": SimpleUploadedFile("invalid.zip", b"not a zip file", "application/zip"),
            },
            format="multipart",
        )
        self.assertEqual(response.status_code, 400)

    def test_api_rejects_unconfigured_browser_origins(self):
        response = self.client.get(
            "/api/profiles/", HTTP_ORIGIN="https://untrusted.example"
        )
        self.assertEqual(response.status_code, 403)

    def test_django_admin_requires_authentication(self):
        response = self.client.get("/admin/")
        self.assertEqual(response.status_code, 302)
        self.assertIn("/admin/login/", response["Location"])

    def test_corrupted_pdf_is_recorded_as_a_failed_document(self):
        self.create_profile()
        upload = create_zip([("broken.pdf", b"%PDF-not-a-valid-document")])
        with patch(
            "extraction.views.launch_job_processing",
            side_effect=process_job,
        ):
            response = self.client.post(
                "/api/jobs/",
                {
                    "profileId": "test-profile",
                    "file": SimpleUploadedFile("documents.zip", upload, "application/zip"),
                },
                format="multipart",
            )
        self.assertEqual(response.status_code, 202, response.data)
        job = self.client.get(f"/api/jobs/{response.data['id']}/").data
        self.assertEqual(job["status"], "error")
        self.assertEqual(job["documents"][0]["processingStatus"], "failed")
        self.assertIn("corrupted", job["documents"][0]["errorDetails"].lower())

    def test_ocr_fallback_uses_ocr_text_when_native_text_is_empty(self):
        document = fitz.open()
        document.new_page()
        pdf_bytes = document.tobytes()
        document.close()
        profile = copy.deepcopy(PROFILE)
        profile["ocrSettings"]["enabledFallback"] = True
        profile["ocrSettings"]["minTextLengthThreshold"] = 40
        profile["ocrSettings"]["quality"] = "high"

        with override_settings(OCR_ENABLED=True):
            with patch(
                "extraction.services.document_extraction._ocr_pdf",
                return_value=[
                    {
                        "pageNumber": 1,
                        "rawText": "Full Name: Jane Doe",
                        "lines": ["Full Name: Jane Doe"],
                        "words": [
                            {"text": "Full", "x0": 72, "y0": 60,
                                "x1": 90, "y1": 72, "confidence": 0.9},
                            {"text": "Name:", "x0": 92, "y0": 60,
                                "x1": 118, "y1": 72, "confidence": 0.9},
                            {"text": "Jane", "x0": 122, "y0": 60,
                                "x1": 147, "y1": 72, "confidence": 0.9},
                            {"text": "Doe", "x0": 150, "y0": 60,
                                "x1": 175, "y1": 72, "confidence": 0.9},
                        ],
                        "width": 612,
                        "height": 792,
                    }
                ],
            ) as run_ocr:
                extracted = process_pdf(pdf_bytes, "application.pdf", profile)

        self.assertEqual(run_ocr.call_args.kwargs["render_scale"], 3.0)
        self.assertEqual(extracted["extractionMethodUsed"], "OCR_EXTRACTED")
        self.assertEqual(extracted["finalValues"]["full_name"], "Jane Doe")

    def test_native_field_values_skip_unnecessary_ocr(self):
        profile = copy.deepcopy(PROFILE)
        document = fitz.open()
        page = document.new_page()
        page.insert_text((72, 72), "Full Name: Jane Doe")
        pdf_bytes = document.tobytes()
        document.close()

        with (
            override_settings(OCR_ENABLED=True),
            patch("extraction.services.document_extraction._ocr_pdf") as run_ocr,
        ):
            extracted = process_pdf(pdf_bytes, "application.pdf", profile)

        run_ocr.assert_not_called()
        self.assertEqual(extracted["finalValues"]["full_name"], "Jane Doe")
        self.assertEqual(extracted["extractionMethodUsed"], "NATIVE_PDF_TEXT")

    def test_missing_native_field_ocr_checks_all_pages(self):
        profile = copy.deepcopy(PROFILE)
        profile["ocrSettings"]["enabledFallback"] = True
        profile["ocrSettings"]["autoDetectScanned"] = True
        document = fitz.open()
        for page_number in range(3):
            page = document.new_page()
            page.insert_text((72, 72), f"Administrative note {page_number}")
        pdf_bytes = document.tobytes()
        document.close()
        ocr_page = {
            "pageNumber": 3,
            "rawText": "Full Name: Jane Doe",
            "lines": ["Full Name: Jane Doe"],
            "words": [
                {"text": "Full", "x0": 72, "y0": 60,
                    "x1": 90, "y1": 72, "confidence": 0.9},
                {"text": "Name:", "x0": 92, "y0": 60,
                    "x1": 118, "y1": 72, "confidence": 0.9},
                {"text": "Jane", "x0": 122, "y0": 60,
                    "x1": 147, "y1": 72, "confidence": 0.9},
                {"text": "Doe", "x0": 150, "y0": 60,
                    "x1": 175, "y1": 72, "confidence": 0.9},
            ],
            "width": 612,
            "height": 792,
        }

        with (
            override_settings(OCR_ENABLED=True),
            patch(
                "extraction.services.document_extraction._ocr_pdf",
                return_value=[ocr_page],
            ) as run_ocr,
        ):
            extracted = process_pdf(pdf_bytes, "application.pdf", profile)

        self.assertEqual(
            list(run_ocr.call_args.kwargs["page_indices"]), [0, 1, 2])
        self.assertEqual(extracted["finalValues"]["full_name"], "Jane Doe")
        self.assertEqual(extracted["diagnostics"]
                         ["full_name"]["pageNumber"], 3)

    def test_ocr_targets_sparse_pages_in_a_mixed_text_document(self):
        profile = copy.deepcopy(PROFILE)
        profile["ocrSettings"].update(
            {"enabledFallback": True, "autoDetectScanned": True}
        )
        document = fitz.open()
        document.new_page().insert_text(
            (72, 72), "Administrative text " * 8
        )
        document.new_page()
        document.new_page().insert_text(
            (72, 72), "Additional administrative text " * 8
        )
        pdf_bytes = document.tobytes()
        document.close()
        ocr_page = {
            "pageNumber": 2,
            "rawText": "Full Name: Jane Doe",
            "lines": ["Full Name: Jane Doe"],
            "words": [
                {"text": "Full", "x0": 72, "y0": 60,
                    "x1": 90, "y1": 72, "confidence": 0.95},
                {"text": "Name:", "x0": 92, "y0": 60,
                    "x1": 118, "y1": 72, "confidence": 0.95},
                {"text": "Jane", "x0": 122, "y0": 60,
                    "x1": 147, "y1": 72, "confidence": 0.95},
                {"text": "Doe", "x0": 150, "y0": 60,
                    "x1": 175, "y1": 72, "confidence": 0.95},
            ],
            "width": 612,
            "height": 792,
        }

        with (
            override_settings(OCR_ENABLED=True),
            patch(
                "extraction.services.document_extraction._ocr_pdf",
                return_value=[ocr_page],
            ) as run_ocr,
        ):
            extracted = process_pdf(pdf_bytes, "mixed.pdf", profile)

        self.assertEqual(list(run_ocr.call_args.kwargs["page_indices"]), [1])
        self.assertEqual(extracted["finalValues"]["full_name"], "Jane Doe")
        self.assertEqual(
            extracted["processingMetrics"]["ocr_page_numbers"], [2]
        )

    def test_higher_scoring_ocr_candidate_can_win_over_native_text(self):
        profile = copy.deepcopy(PROFILE)
        profile["ocrSettings"].update(
            {"enabledFallback": True, "autoDetectScanned": True}
        )
        profile["extractionSettings"] = {"labelSimilarityThreshold": 0.7}
        profile["fields"][0]["contentRules"]["labels"] = [
            "Full Name of Beneficial Owner:"
        ]
        document = fitz.open()
        page = document.new_page()
        image_buffer = BytesIO()
        Image.new("RGB", (20, 20), "white").save(image_buffer, format="PNG")
        page.insert_image(page.rect, stream=image_buffer.getvalue())
        page.insert_text((72, 72), "Full Nane of Beneficial Owner: Jame Doe")
        pdf_bytes = document.tobytes()
        document.close()
        ocr_page = {
            "pageNumber": 1,
            "rawText": "Full Name: Jane Doe",
            "lines": ["Full Name of Beneficial Owner: Jane Doe"],
            "words": [
                {"text": "Full", "x0": 72, "y0": 60,
                    "x1": 92, "y1": 72, "confidence": 0.98},
                {"text": "Name", "x0": 94, "y0": 60,
                    "x1": 124, "y1": 72, "confidence": 0.98},
                {"text": "of", "x0": 126, "y0": 60,
                    "x1": 136, "y1": 72, "confidence": 0.98},
                {"text": "Beneficial", "x0": 138, "y0": 60,
                    "x1": 190, "y1": 72, "confidence": 0.98},
                {"text": "Owner:", "x0": 192, "y0": 60,
                    "x1": 228, "y1": 72, "confidence": 0.98},
                {"text": "Jane", "x0": 232, "y0": 60,
                    "x1": 255, "y1": 72, "confidence": 0.98},
                {"text": "Doe", "x0": 258, "y0": 60,
                    "x1": 280, "y1": 72, "confidence": 0.98},
            ],
            "width": 612,
            "height": 792,
        }

        with (
            override_settings(OCR_ENABLED=True),
            patch(
                "extraction.services.document_extraction._ocr_pdf",
                return_value=[ocr_page],
            ) as run_ocr,
        ):
            extracted = process_pdf(pdf_bytes, "scan-overlay.pdf", profile)

        self.assertEqual(list(run_ocr.call_args.kwargs["page_indices"]), [0])
        self.assertEqual(extracted["finalValues"]["full_name"], "Jane Doe")
        self.assertEqual(extracted["diagnostics"]
                         ["full_name"]["source"], "ocr")
        self.assertNotEqual(
            extracted["diagnostics"]["full_name"]["pdfValue"],
            extracted["diagnostics"]["full_name"]["ocrValue"],
        )
        self.assertGreater(
            extracted["diagnostics"]["full_name"]["candidateScores"]["ocr"],
            extracted["diagnostics"]["full_name"]["candidateScores"]["pdf_text"],
        )

    def test_tesseract_ocr_output_retains_word_boxes_and_confidence(self):
        document = fitz.open()
        document.new_page()
        pdf_bytes = document.tobytes()
        document.close()
        ocr_data = {
            "text": ["Name", "Jane"],
            "conf": ["96", "87"],
            "left": [80, 180],
            "top": [60, 60],
            "width": [70, 55],
            "height": [24, 24],
            "block_num": [1, 1],
            "par_num": [1, 1],
            "line_num": [1, 1],
        }

        with patch(
            "extraction.services.document_extraction.pytesseract.image_to_data",
            return_value=ocr_data,
        ):
            pages = _ocr_pdf(pdf_bytes, "eng", 1)

        self.assertEqual(pages[0]["rawText"], "Name Jane")
        self.assertEqual(pages[0]["words"][0]["x0"], 40.0)
        self.assertEqual(pages[0]["words"][0]["y0"], 30.0)
        self.assertEqual(pages[0]["words"][0]["confidence"], 0.96)

    def test_conflicting_native_and_ocr_candidates_with_similar_scores_are_unresolved(self):
        field = copy.deepcopy(PROFILE["fields"][0])
        native = ("Jane Doe", "Full Name:",
                  "Full Name: Jane Doe", 1, "layout_aware", 0.8)
        ocr = ("John Doe", "Full Name:",
               "Full Name: John Doe", 1, "layout_aware", 0.81)

        selected, ambiguous, reason = _choose_content_candidate(
            native, ocr, field)

        self.assertIsNone(selected)
        self.assertTrue(ambiguous)
        self.assertIn("similar evidence scores", reason)

    def test_selective_ai_review_targets_only_uncertain_fields(self):
        profile = copy.deepcopy(PROFILE)
        profile["fields"].append(create_labeled_field("country", "Country:"))
        profile["aiSettings"] = {
            "enabled": True,
            "baseUrl": "http://127.0.0.1:11434",
            "model": "llama3.2",
            "timeoutSeconds": 120,
            "strategy": "selective",
        }

        with patch(
            "extraction.services.document_extraction.extract_with_ollama",
            return_value=({}, {}),
        ) as extract:
            process_pdf(create_pdf(), "application.pdf", profile)

        self.assertEqual(
            [field["id"] for field in extract.call_args.args[1]], ["country"]
        )

    def test_selective_ai_review_includes_low_score_candidates(self):
        field = copy.deepcopy(PROFILE["fields"][0])
        low_confidence_candidate = (
            "Jane Doe",
            "Full Name:",
            "Full Name: Jane Doe",
            1,
            "layout_aware",
            0.7,
        )

        self.assertTrue(
            _needs_selective_ai_review(
                field, low_confidence_candidate, None, None
            )
        )

    def test_adjacent_w8_labels_are_associated_with_values_in_their_own_columns(self):
        name_label = "Name of individual who is the beneficial owner"
        citizenship_label = "Country of citizenship"
        profile = copy.deepcopy(PROFILE)
        profile["fields"] = [
            create_labeled_field("beneficial_owner", name_label),
            create_labeled_field("citizenship", citizenship_label),
        ]
        pdf_bytes = create_layout_pdf(
            [
                (name_label, 40, 100),
                (citizenship_label, 360, 100),
                ("Jane Maria Doe", 40, 130),
                ("Philippines", 360, 130),
            ]
        )

        extracted = process_pdf(pdf_bytes, "w8ben.pdf", profile)

        self.assertEqual(
            extracted["finalValues"]["beneficial_owner"], "Jane Maria Doe"
        )
        self.assertEqual(extracted["finalValues"]
                         ["citizenship"], "Philippines")
        self.assertEqual(
            extracted["diagnostics"]["beneficial_owner"]["method"], "layout_aware"
        )
        self.assertGreater(
            extracted["diagnostics"]["beneficial_owner"]["confidenceScore"], 0.5
        )

    def test_unconfigured_adjacent_label_is_not_returned_for_target_field(self):
        name_label = "Name of individual who is the beneficial owner"
        profile = copy.deepcopy(PROFILE)
        profile["fields"] = [create_labeled_field(
            "beneficial_owner", name_label)]
        pdf_bytes = create_layout_pdf(
            [
                (name_label, 40, 100),
                ("Country of citizenship", 360, 100),
                ("Jane Doe", 40, 130),
                ("Philippines", 360, 130),
            ]
        )

        extracted = process_pdf(pdf_bytes, "w8ben.pdf", profile)

        self.assertEqual(extracted["finalValues"]
                         ["beneficial_owner"], "Jane Doe")

    def test_wrapped_label_is_matched_without_crossing_into_the_adjacent_column(self):
        name_label = "Name of individual who is the beneficial owner"
        citizenship_label = "Country of citizenship"
        profile = copy.deepcopy(PROFILE)
        profile["fields"] = [
            create_labeled_field("beneficial_owner", name_label),
            create_labeled_field("citizenship", citizenship_label),
        ]
        pdf_bytes = create_layout_pdf(
            [
                ("Name of individual who is the", 40, 100),
                (citizenship_label, 360, 100),
                ("beneficial owner", 40, 115),
                ("Jane Doe", 40, 140),
                ("Canada", 360, 140),
            ]
        )

        extracted = process_pdf(pdf_bytes, "w8ben.pdf", profile)

        self.assertEqual(extracted["finalValues"]
                         ["beneficial_owner"], "Jane Doe")
        self.assertEqual(extracted["finalValues"]["citizenship"], "Canada")

    def test_repeated_label_with_equally_plausible_values_is_left_unresolved(self):
        date_label = "Date of birth"
        profile = copy.deepcopy(PROFILE)
        profile["fields"] = [create_labeled_field("birth_date", date_label)]
        pdf_bytes = create_layout_pdf(
            [
                (date_label, 40, 100),
                ("1990-04-05", 40, 120),
                (date_label, 40, 260),
                ("2001-09-10", 40, 280),
            ]
        )

        extracted = process_pdf(pdf_bytes, "form.pdf", profile)

        self.assertEqual(extracted["finalValues"]["birth_date"], "")
        self.assertEqual(
            extracted["diagnostics"]["birth_date"]["confidenceScore"], 0.0
        )

    def test_side_by_side_values_are_cut_off_at_the_next_field_label(self):
        first_label = "First name"
        second_label = "Country"
        profile = copy.deepcopy(PROFILE)
        profile["fields"] = [
            create_labeled_field("first_name", first_label),
            create_labeled_field("country", second_label),
        ]
        pdf_bytes = create_layout_pdf(
            [
                ("First name: Ana", 40, 100),
                ("Country: Japan", 300, 100),
            ]
        )

        extracted = process_pdf(pdf_bytes, "form.pdf", profile)

        self.assertEqual(extracted["finalValues"]["first_name"], "Ana")
        self.assertEqual(extracted["finalValues"]["country"], "Japan")

    def test_multiline_address_stops_before_the_next_known_field_label(self):
        address_label = "Permanent residence address"
        country_label = "Country of residence"
        profile = copy.deepcopy(PROFILE)
        profile["fields"] = [
            create_labeled_field("address", address_label),
            create_labeled_field("residence_country", country_label),
        ]
        pdf_bytes = create_layout_pdf(
            [
                (address_label, 40, 100),
                ("123 Main Street, Unit 4", 40, 125),
                ("Springfield, CA 90001", 40, 140),
                (country_label, 360, 100),
                ("United States", 360, 125),
            ]
        )

        extracted = process_pdf(pdf_bytes, "form.pdf", profile)

        self.assertEqual(
            extracted["finalValues"]["address"],
            "123 Main Street, Unit 4 Springfield, CA 90001",
        )
        self.assertEqual(
            extracted["finalValues"]["residence_country"], "United States"
        )

    def test_blank_field_does_not_return_a_neighboring_label(self):
        name_label = "Name of individual who is the beneficial owner"
        country_label = "Country of citizenship"
        profile = copy.deepcopy(PROFILE)
        profile["fields"] = [
            create_labeled_field("beneficial_owner", name_label),
            create_labeled_field("citizenship", country_label),
        ]
        pdf_bytes = create_layout_pdf(
            [
                (name_label, 40, 100),
                (country_label, 360, 100),
                ("Philippines", 360, 130),
            ]
        )

        extracted = process_pdf(pdf_bytes, "w8ben.pdf", profile)

        self.assertEqual(extracted["finalValues"]["beneficial_owner"], "")
        self.assertEqual(extracted["finalValues"]
                         ["citizenship"], "Philippines")
        self.assertEqual(
            extracted["diagnostics"]["beneficial_owner"]["status"], "NOT_FOUND"
        )

    def test_w8ben_six_field_layout_includes_multiline_address_and_formatted_birth_date(self):
        labels = {
            "beneficial_owner": "Name of individual who is the beneficial owner",
            "citizenship": "Country of citizenship",
            "residence_address": "Permanent residence address",
            "birth_date": "Date of birth",
            "city_state": "City or town, state or province",
            "residence_country": "Country of residence",
        }
        fields = [create_labeled_field(field_id, label)
                  for field_id, label in labels.items()]
        fields[3]["type"] = "date"
        fields[3]["normalization"]["dateFormat"] = "MM-DD-YYYY"
        profile = {**copy.deepcopy(PROFILE), "fields": fields}
        pdf_bytes = create_layout_pdf(
            [
                (labels["beneficial_owner"], 40, 80),
                (labels["citizenship"], 360, 80),
                ("Maria Elena Santos", 40, 105),
                ("Philippines", 360, 105),
                (labels["residence_address"], 40, 145),
                (labels["birth_date"], 360, 145),
                ("123 Main Street, Unit 4", 40, 170),
                ("1990-04-05", 360, 170),
                ("Springfield", 40, 185),
                ("CA 90001", 40, 200),
                (labels["city_state"], 40, 250),
                (labels["residence_country"], 360, 250),
                ("Springfield, California", 40, 275),
                ("United States", 360, 275),
            ]
        )

        extracted = process_pdf(pdf_bytes, "w8ben.pdf", profile)

        self.assertEqual(
            extracted["finalValues"],
            {
                "beneficial_owner": "Maria Elena Santos",
                "citizenship": "Philippines",
                "residence_address": "123 Main Street, Unit 4 Springfield CA 90001",
                "birth_date": "04-05-1990",
                "city_state": "Springfield, California",
                "residence_country": "United States",
            },
        )

    def test_long_label_with_abbreviations_does_not_consume_the_value(self):
        address_label = (
            "Permanent residence address (street, apt. or suite no., or rural "
            "route). Do not use a P.O. box or in-care-of address."
        )
        citizenship_label = "Country of citizenship"
        profile = copy.deepcopy(PROFILE)
        profile["fields"] = [
            create_labeled_field("residence_address", address_label),
            create_labeled_field("citizenship", citizenship_label),
        ]
        document = fitz.open()
        page = document.new_page(width=1100, height=800)
        page.insert_text((40, 100), address_label, fontsize=8)
        page.insert_text((720, 100), citizenship_label, fontsize=8)
        page.insert_text((40, 125), "123 Main Street, Suite 4", fontsize=10)
        page.insert_text((720, 125), "Egypt", fontsize=10)
        pdf_bytes = document.tobytes()
        document.close()

        extracted = process_pdf(pdf_bytes, "w8ben.pdf", profile)

        self.assertEqual(
            extracted["finalValues"]["residence_address"],
            "123 Main Street, Suite 4",
        )
        self.assertEqual(extracted["finalValues"]["citizenship"], "Egypt")

    def test_short_address_alias_skips_wrapped_label_instructions_before_value(self):
        address_label = "Permanent residence address"
        city_label = "City or town, state or province"
        profile = copy.deepcopy(PROFILE)
        profile["fields"] = [
            create_labeled_field("residence_address", address_label),
            create_labeled_field("city_state", city_label),
        ]
        pdf_bytes = create_layout_pdf(
            [
                (address_label + " (street, apt. or suite no., or rural", 40, 100),
                (city_label, 330, 100),
                ("route). Do not use a P.O. box or in-care-of address.", 40, 112),
                ("135 Ma Martha St.", 40, 140),
                ("Quezon City, Metro Manila", 330, 140),
                ("Dona Carmen", 40, 155),
            ]
        )

        extracted = process_pdf(pdf_bytes, "w8ben.pdf", profile)

        self.assertEqual(
            extracted["finalValues"]["residence_address"],
            "135 Ma Martha St. Dona Carmen",
        )
        self.assertEqual(
            extracted["finalValues"]["city_state"], "Quezon City, Metro Manila"
        )

    def test_label_similarity_threshold_can_tune_ocr_tolerance(self):
        label = (
            "Permanent residence address (street, apt. or suite no., or rural "
            "route). Do not use a P.O. box or in-care-of address."
        )
        ocr_label = label.replace("Permanent", "Permanenl")
        profile = copy.deepcopy(PROFILE)
        profile["fields"] = [create_labeled_field("address", label)]
        document = fitz.open()
        page = document.new_page(width=1100, height=800)
        page.insert_text((40, 100), ocr_label, fontsize=8)
        page.insert_text((40, 125), "123 Main Street, Suite 4", fontsize=10)
        pdf_bytes = document.tobytes()
        document.close()

        tolerant = process_pdf(pdf_bytes, "w8ben.pdf", profile)
        strict_profile = copy.deepcopy(profile)
        strict_profile["extractionSettings"] = {
            "labelSimilarityThreshold": 0.99
        }
        strict = process_pdf(pdf_bytes, "w8ben.pdf", strict_profile)

        self.assertEqual(
            tolerant["finalValues"]["address"], "123 Main Street, Suite 4"
        )
        self.assertEqual(strict["finalValues"]["address"], "")

    def test_ollama_fallback_extracts_grounded_values_with_layout_context(self):
        profile = copy.deepcopy(PROFILE)
        profile["fields"][0]["contentRules"]["labels"] = ["Full Name:"]
        profile["aiSettings"] = {
            "enabled": True,
            "baseUrl": "http://127.0.0.1:11434",
            "model": "llama3.2",
            "timeoutSeconds": 120,
            "strategy": "fallback",
        }
        pdf_bytes = create_layout_pdf(
            [("Full", 40, 100), ("Name: Jane Doe", 40, 150)])

        with patch(
            "extraction.services.document_extraction.extract_with_ollama",
            return_value=(
                {
                    "full_name": {
                        "value": "Jane Doe",
                        "evidence": "Full Name: Jane Doe",
                        "pageNumber": 1,
                    }
                },
                {"ollama_request_ms": 10.0},
            ),
        ) as extract:
            result = process_pdf(pdf_bytes, "application.pdf", profile)

        self.assertEqual(result["finalValues"]["full_name"], "Jane Doe")
        self.assertEqual(
            result["diagnostics"]["full_name"]["source"], "ai"
        )
        self.assertEqual(
            result["diagnostics"]["full_name"]["method"], "ollama_llm"
        )
        self.assertTrue(result["diagnostics"]["full_name"]["reviewRequired"])
        self.assertEqual(result["extractionMethodUsed"], "AI_EXTRACTED")
        self.assertEqual(extract.call_args.args[1], profile["fields"])
        self.assertIn("Full", extract.call_args.args[2][0]["layout"][0])
        self.assertEqual(
            result["processingMetrics"]["ollama_request_ms"], 10.0
        )

    def test_ollama_fallback_does_not_accept_values_not_in_pdf_text(self):
        profile = copy.deepcopy(PROFILE)
        profile["aiSettings"] = {
            "enabled": True,
            "baseUrl": "http://127.0.0.1:11434",
            "model": "llama3.2",
            "timeoutSeconds": 120,
            "strategy": "fallback",
        }
        pdf_bytes = create_layout_pdf([("Applicant: Jane Doe", 40, 100)])

        with patch(
            "extraction.services.ollama._request_json",
            side_effect=[
                {"models": [{"name": "llama3.2:latest"}]},
                {
                    "response": json.dumps(
                        {
                            "full_name": {
                                "value": "John Smith",
                                "evidence": "Full Name: John Smith",
                                "pageNumber": 1,
                            }
                        }
                    )
                },
            ],
        ):
            result = process_pdf(pdf_bytes, "application.pdf", profile)

        self.assertEqual(result["finalValues"]["full_name"], "")
        self.assertEqual(
            result["diagnostics"]["full_name"]["status"], "NOT_FOUND"
        )

    def test_ollama_rejects_malformed_candidates_and_other_field_evidence(self):
        field = copy.deepcopy(PROFILE["fields"][0])
        pages = [
            {
                "pageNumber": 1,
                "sources": [
                    {
                        "kind": "native PDF text",
                        "text": "Full Name: Jane Doe\nCountry: Canada",
                    }
                ],
                "layout": [
                    "row 1 y=10-20: column 1 x=10-200: Full Name: Jane Doe",
                    "row 2 y=30-40: column 1 x=10-200: Country: Canada",
                ],
            }
        ]
        settings = {
            "baseUrl": "http://127.0.0.1:11434",
            "model": "llama3.2",
        }
        country_field = create_labeled_field("country", "Country:")
        with patch(
            "extraction.services.ollama._request_json",
            side_effect=[
                {"models": [{"name": "llama3.2:latest"}]},
                {"response": json.dumps({"full_name": "Canada"})},
            ],
        ):
            malformed, _ = extract_with_ollama(settings, [field], pages)
        self.assertEqual(malformed, {})

        with patch(
            "extraction.services.ollama._request_json",
            side_effect=[
                {"models": [{"name": "llama3.2:latest"}]},
                {
                    "response": json.dumps(
                        {
                            "full_name": {
                                "value": "Canada",
                                "evidence": "Full Name: Canada",
                                "pageNumber": 1,
                            }
                        }
                    )
                },
            ],
        ):
            unrelated, _ = extract_with_ollama(
                settings, [field, country_field], pages
            )
        self.assertEqual(unrelated, {})

        with patch(
            "extraction.services.ollama._request_json",
            side_effect=[
                {"models": [{"name": "llama3.2:latest"}]},
                {
                    "response": json.dumps(
                        {
                            "full_name": {
                                "value": "Full Name: Jane Doe",
                                "evidence": "Full Name: Jane Doe",
                                "pageNumber": 1,
                            }
                        }
                    )
                },
            ],
        ):
            label_in_value, _ = extract_with_ollama(settings, [field], pages)
        self.assertEqual(label_in_value, {})

        adjacent_fields_page = [
            {
                "pageNumber": 1,
                "sources": [
                    {
                        "kind": "native PDF text",
                        "text": (
                            "Full Name Country of residence "
                            "Jane Doe Philippines"
                        ),
                    }
                ],
                "layout": [
                    "row 1 y=10-20: column 1 x=10-100: Full Name || column 2 x=500-600: Country of residence",
                    "row 2 y=30-40: column 1 x=10-100: Jane Doe || column 2 x=500-600: Philippines",
                ],
            }
        ]
        with patch(
            "extraction.services.ollama._request_json",
            side_effect=[
                {"models": [{"name": "llama3.2:latest"}]},
                {
                    "response": json.dumps(
                        {
                            "full_name": {
                                "value": "Jane Doe Philippines",
                                "evidence": "Full Name Jane Doe Philippines",
                                "pageNumber": 1,
                            }
                        }
                    )
                },
            ],
        ):
            cross_column_value, _ = extract_with_ollama(
                settings, [field], adjacent_fields_page
            )
        self.assertEqual(cross_column_value, {})

    def test_ollama_uses_structured_json_and_preserves_a_grounded_candidate(self):
        field = copy.deepcopy(PROFILE["fields"][0])
        pages = [
            {
                "pageNumber": 1,
                "sources": [
                    {
                        "kind": "native PDF text",
                        "text": "Full Name: Jane Doe",
                    }
                ],
                "layout": [
                    "row 1 y=10-20: column 1 x=10-200: Full Name: Jane Doe"
                ],
            }
        ]
        response = {
            "response": json.dumps(
                {
                    "full_name": {
                        "value": "Jane Doe",
                        "evidence": "Full Name: Jane Doe",
                        "pageNumber": 1,
                    }
                }
            ),
            "load_duration": 2_000_000,
            "prompt_eval_count": 123,
            "eval_count": 20,
        }
        with patch(
            "extraction.services.ollama._request_json",
            side_effect=[
                {"models": [{"name": "llama3.2:latest"}]},
                response,
            ],
        ) as request:
            values, metrics = extract_with_ollama(
                {"baseUrl": "http://127.0.0.1:11434", "model": "llama3.2"},
                [field],
                pages,
            )

        self.assertEqual(
            values["full_name"],
            {
                "value": "Jane Doe",
                "evidence": "Full Name: Jane Doe",
                "pageNumber": 1,
                "sourceKind": "native PDF text",
            },
        )
        payload = request.call_args.args[1]
        self.assertEqual(payload["format"]["type"], "object")
        self.assertIn("x=10-200", payload["prompt"])
        self.assertIn("VERBATIM RECOGNIZED TEXT", payload["prompt"])
        self.assertEqual(payload["model"], "llama3.2:latest")
        self.assertEqual(metrics["ollama_model_load_ms"], 2.0)
        self.assertEqual(metrics["ollama_prompt_tokens"], 123)
        self.assertEqual(metrics["ollama_generated_tokens"], 20)

    def test_ollama_rebuilds_evidence_when_model_cites_layout_metadata(self):
        field = copy.deepcopy(PROFILE["fields"][0])
        pages = [
            {
                "pageNumber": 1,
                "sources": [
                    {
                        "kind": "native PDF text",
                        "text": "Full Name: Jane Doe",
                    }
                ],
                "layout": [
                    "row 1 y=10-20: column 1 x=10-200: Full Name: Jane Doe"
                ],
            }
        ]
        response = {
            "response": json.dumps(
                {
                    "full_name": {
                        "value": "Jane Doe",
                        "evidence": (
                            "native PDF text row 1 y=10-20: "
                            "column 1 x=10-200: Jane Doe"
                        ),
                        "pageNumber": 1,
                    }
                }
            )
        }
        with patch(
            "extraction.services.ollama._request_json",
            side_effect=[
                {"models": [{"name": "llama3.2:latest"}]},
                response,
            ],
        ):
            values, _ = extract_with_ollama(
                {"baseUrl": "http://127.0.0.1:11434", "model": "llama3.2"},
                [field],
                pages,
            )

        self.assertEqual(
            values["full_name"],
            {
                "value": "Jane Doe",
                "evidence": "Full Name: Jane Doe",
                "pageNumber": 1,
                "sourceKind": "native PDF text",
            },
        )

    def test_ollama_rejects_label_and_value_split_across_text_sources(self):
        field = copy.deepcopy(PROFILE["fields"][0])
        pages = [
            {
                "pageNumber": 1,
                "sources": [
                    {"kind": "native PDF text", "text": "Full Name:"},
                    {"kind": "OCR text", "text": "Jane Doe"},
                ],
                "layout": [
                    "[native PDF text] row 1 y=10-20: column 1 x=10-100: Full Name:",
                    "[OCR text] row 1 y=30-40: column 1 x=10-100: Jane Doe",
                ],
            }
        ]
        with patch(
            "extraction.services.ollama._request_json",
            side_effect=[
                {"models": [{"name": "llama3.2:latest"}]},
                {
                    "response": json.dumps(
                        {
                            "full_name": {
                                "value": "Jane Doe",
                                "evidence": "Full Name: Jane Doe",
                                "pageNumber": 1,
                            }
                        }
                    )
                },
            ],
        ):
            values, _ = extract_with_ollama(
                {"baseUrl": "http://127.0.0.1:11434", "model": "llama3.2"},
                [field],
                pages,
            )

        self.assertEqual(values, {})

    def test_ollama_extracts_with_cloud_tag_when_profile_allows_cloud_models(self):
        field = copy.deepcopy(PROFILE["fields"][0])
        pages = [
            {
                "pageNumber": 1,
                "sources": [
                    {
                        "kind": "native PDF text",
                        "text": "Full Name: Jane Doe",
                    }
                ],
                "layout": [
                    "row 1 y=10-20: column 1 x=10-200: Full Name: Jane Doe"
                ],
            }
        ]
        response = {
            "response": json.dumps(
                {
                    "full_name": {
                        "value": "Jane Doe",
                        "evidence": "Full Name: Jane Doe",
                        "pageNumber": 1,
                    }
                }
            )
        }
        with patch(
            "extraction.services.ollama._request_json",
            side_effect=[
                {"models": [{"name": "beam:cloud"}]},
                response,
            ],
        ) as request:
            values, _ = extract_with_ollama(
                {
                    "baseUrl": "http://127.0.0.1:11434",
                    "model": "beam:cloud",
                    "allowCloudModels": True,
                },
                [field],
                pages,
            )

        self.assertEqual(values["full_name"]["value"], "Jane Doe")
        self.assertEqual(
            request.call_args.args[1]["model"], "beam:cloud"
        )

    def test_ollama_does_not_send_document_data_to_cloud_without_opt_in(self):
        with patch("extraction.services.ollama._request_json") as request:
            with self.assertRaisesMessage(
                RuntimeError, "Cloud model use is disabled"
            ):
                extract_with_ollama(
                    {
                        "baseUrl": "http://127.0.0.1:11434",
                        "model": "beam:cloud",
                    },
                    [copy.deepcopy(PROFILE["fields"][0])],
                    [],
                )

        request.assert_not_called()

    def test_ollama_rejects_value_from_a_different_column_and_row(self):
        name_field = copy.deepcopy(PROFILE["fields"][0])
        country_field = create_labeled_field("country", "Country:")
        pages = [
            {
                "pageNumber": 1,
                "sources": [
                    {
                        "kind": "native PDF text",
                        "text": "Full Name Country Jane Doe Canada",
                    }
                ],
                "layout": [
                    "row 1 y=10-20: column 1 x=10-100: Full Name || column 2 x=500-600: Country",
                    "row 2 y=30-40: column 1 x=10-100: Jane Doe || column 2 x=500-600: Canada",
                ],
            }
        ]
        response = {
            "response": json.dumps(
                {
                    "full_name": {
                        "value": "Canada",
                        "evidence": "Full Name Canada",
                        "pageNumber": 1,
                    },
                    "country": {
                        "value": "Canada",
                        "evidence": "Country Canada",
                        "pageNumber": 1,
                    },
                }
            )
        }
        with patch(
            "extraction.services.ollama._request_json",
            side_effect=[
                {"models": [{"name": "llama3.2:latest"}]},
                response,
            ],
        ):
            values, _ = extract_with_ollama(
                {"baseUrl": "http://127.0.0.1:11434", "model": "llama3.2"},
                [name_field, country_field],
                pages,
            )

        self.assertNotIn("full_name", values)
        self.assertEqual(values["country"]["value"], "Canada")

    def test_ollama_fallback_does_not_replace_a_filename_match(self):
        profile = copy.deepcopy(PROFILE)
        profile["fields"][0]["filenameRules"] = {
            "enabled": True,
            "patterns": [r"^Applicant_(.*)$"],
            "captureGroup": 1,
            "caseInsensitive": True,
        }
        profile["aiSettings"] = {
            "enabled": True,
            "baseUrl": "http://127.0.0.1:11434",
            "model": "llama3.2",
            "timeoutSeconds": 120,
            "strategy": "fallback",
        }
        pdf_bytes = create_layout_pdf(
            [("No configured content label", 40, 100)])

        with patch(
            "extraction.services.document_extraction.extract_with_ollama"
        ) as extract:
            result = process_pdf(pdf_bytes, "Applicant_Jane Doe.pdf", profile)

        extract.assert_not_called()
        self.assertEqual(result["finalValues"]["full_name"], "Jane Doe")
        self.assertEqual(
            result["diagnostics"]["full_name"]["source"], "filename"
        )

    def test_month_first_birth_date_is_not_reversed_during_normalization(self):
        field = create_labeled_field("birth_date", "Date of birth")
        field["type"] = "date"
        field["normalization"]["dateFormat"] = "MM-DD-YYYY"
        profile = {**copy.deepcopy(PROFILE), "fields": [field]}
        pdf_bytes = create_layout_pdf(
            [
                ("Date of birth", 40, 100),
                ("04/05/1990", 40, 125),
            ]
        )

        extracted = process_pdf(pdf_bytes, "w8ben.pdf", profile)

        self.assertEqual(extracted["finalValues"]["birth_date"], "04-05-1990")

    def test_spatial_guard_blocks_wrong_type_widget_values(self):
        """Regression: Fazlyn_Lagardien_W8.pdf / Aurimas Juskevicius_W8.pdf.

        When the widget belonging to a label is empty, the spatial matcher must
        not fall back to a nearby filled widget of the wrong data class (a
        date-of-birth in the name field, a country in the address field)."""
        name_field = create_labeled_field(
            "candidate_name", "Full name of individual"
        )
        name_field["filenameRules"] = {
            "enabled": True,
            "patterns": [r"^(.+?)_W[56789]\.pdf$"],
            "captureGroup": 1,
            "caseInsensitive": True,
        }
        name_field["validation"] = {"minLength": 3}
        address_field = create_labeled_field(
            "permanent_address", "Permanent residence address"
        )
        address_field["type"] = "address"
        profile = {
            **copy.deepcopy(PROFILE),
            "fields": [name_field, address_field],
        }
        pdf_bytes = create_acroform_pdf(
            [
                ("Full name of individual", 40, 100),
                ("Permanent residence address", 40, 150),
            ],
            [
                ("DateOfBirth", "29-10-1977", (220, 92, 330, 108)),
                ("CountryOfTax", "Lithuania", (250, 142, 360, 158)),
            ],
        )

        result = process_pdf(pdf_bytes, "Fazlyn_Lagardien_W8.pdf", profile)

        name_diag = result["diagnostics"]["candidate_name"]
        self.assertIsNone(name_diag["formValue"])
        self.assertEqual(name_diag["finalValue"], "Fazlyn_Lagardien")
        self.assertEqual(name_diag["status"], "FILENAME_ONLY")
        addr_diag = result["diagnostics"]["permanent_address"]
        self.assertIsNone(addr_diag["formValue"])
        self.assertEqual(addr_diag["status"], "NOT_FOUND")

    def test_structural_widget_match_is_not_blocked_by_the_guard(self):
        """A widget whose own name matches the field label stays authoritative,
        even when its value carries digits (the guard is spatial-path-only)."""
        field = create_labeled_field("full_name", "Full Name")
        profile = {**copy.deepcopy(PROFILE), "fields": [field]}
        pdf_bytes = create_acroform_pdf(
            [("Unrelated heading", 40, 60)],
            [("Full Name", "Jane A. Doe", (40, 92, 200, 108))],
        )

        result = process_pdf(pdf_bytes, "employee.pdf", profile)

        diag = result["diagnostics"]["full_name"]
        self.assertEqual(diag["finalValue"], "Jane A. Doe")
        self.assertEqual(diag["source"], "form_field")
        self.assertEqual(diag["status"], "MATCHED")

    def test_one_widget_cannot_feed_two_form_fields(self):
        form_results = {
            "a": (
                "29-10-1977", "lbl a", "ev", 1, "acroform_field", 0.81,
                "1|f1_9|29-10-1977",
            ),
            "b": (
                "29-10-1977", "lbl b", "ev", 1, "acroform_field", 0.78,
                "1|f1_9|29-10-1977",
            ),
            "c": (
                "Jane Doe", "Name", "ev", 1, "acroform_name", 0.9,
                "1|Name|Jane Doe",
            ),
        }

        _drop_duplicate_form_widgets(form_results)

        self.assertIsNone(form_results["a"])
        self.assertIsNone(form_results["b"])
        self.assertIsNotNone(form_results["c"])

    def test_filename_only_match_gets_its_own_status(self):
        """Regression: 15 docs previously reported 'MATCHED @ 0% evidence' from
        the filename alone; they must carry the distinct FILENAME_ONLY status."""
        profile = copy.deepcopy(PROFILE)
        profile["fields"][0]["filenameRules"] = {
            "enabled": True,
            "patterns": [r"^Applicant_(.*)$"],
            "captureGroup": 1,
            "caseInsensitive": True,
        }
        pdf_bytes = create_layout_pdf(
            [("No configured content label", 40, 100)])

        result = process_pdf(pdf_bytes, "Applicant_Jane Doe.pdf", profile)

        diag = result["diagnostics"]["full_name"]
        self.assertEqual(diag["finalValue"], "Jane Doe")
        self.assertEqual(diag["status"], "FILENAME_ONLY")
        self.assertEqual(diag["source"], "filename")


def create_blank_form_pdf():
    """Template-style form: widgets exist but carry no values."""
    return create_acroform_pdf(
        [
            ("Name:", 40, 100),
            ("SSN:", 40, 140),
        ],
        [
            ("applicant_name", "", (70, 92, 220, 108)),
            ("ssn_field", "", (70, 132, 160, 148)),
        ],
    )


class OcrSpaceFallbackTests(SimpleTestCase):
    """Opt-in OCR.space cloud OCR fallback (parse, pipeline, priority, gating)."""

    def _blank_scan_pdf(self):
        document = fitz.open()
        document.new_page()
        pdf_bytes = document.tobytes()
        document.close()
        return pdf_bytes

    def _profile(self):
        profile = copy.deepcopy(PROFILE)
        profile["ocrSettings"].update(
            {"enabledFallback": True, "autoDetectScanned": True}
        )
        return profile

    def _ocr_space_page(self):
        return {
            "pageNumber": 1,
            "rawText": "Full Name: Jane Doe",
            "lines": ["Full Name: Jane Doe"],
            "words": [
                {"text": "Full", "x0": 72, "y0": 60,
                    "x1": 90, "y1": 72, "confidence": 0.9},
                {"text": "Name:", "x0": 92, "y0": 60,
                    "x1": 118, "y1": 72, "confidence": 0.9},
                {"text": "Jane", "x0": 122, "y0": 60,
                    "x1": 147, "y1": 72, "confidence": 0.9},
                {"text": "Doe", "x0": 150, "y0": 60,
                    "x1": 175, "y1": 72, "confidence": 0.9},
            ],
            "width": 612,
            "height": 792,
        }

    def test_normalize_ocrspace_lines_parses_words_confidence_and_boxes(self):
        payload = [
            {"words": [
                {"text": "Full", "confidence": "95",
                    "scale": [72, 60, 90, 72]},
                {"text": "Jane", "confidence": 80,
                    "scale": [122, 60, 147, 72]},
            ]}
        ]

        line_texts, words = _normalize_ocrspace_lines(payload)

        self.assertEqual(line_texts, ["Full Jane"])
        self.assertEqual(words[0]["text"], "Full")
        self.assertEqual(words[0]["confidence"], 0.95)
        self.assertEqual(words[0]["scale"], [72, 60, 90, 72])
        self.assertEqual(words[1]["confidence"], 0.8)

    def test_normalize_ocrspace_lines_is_fail_open_on_unexpected_shapes(self):
        for bad in (None, 123, {}, "plain text\nsecond line"):
            line_texts, words = _normalize_ocrspace_lines(bad)
            self.assertIsInstance(line_texts, list)
            self.assertIsInstance(words, list)
        # A plain string still yields usable lines and no word boxes.
        line_texts, words = _normalize_ocrspace_lines("Full Name: Jane Doe")
        self.assertEqual(line_texts, ["Full Name: Jane Doe"])
        self.assertEqual(words, [])

    def test_ocr_pdf_ocrspace_scales_boxes_to_pdf_points(self):
        pdf_bytes = self._blank_scan_pdf()
        payload = {
            "ocredText": [
                {"words": [
                    {"text": "Full", "confidence": "90",
                        "scale": [144, 120, 180, 144]},
                    {"text": "Name:", "confidence": "90",
                        "scale": [184, 120, 236, 144]},
                    {"text": "Jane", "confidence": "90",
                        "scale": [244, 120, 294, 144]},
                    {"text": "Doe", "confidence": "90",
                        "scale": [300, 120, 350, 144]},
                ]}
            ]
        }

        with patch(
            "extraction.services.document_extraction._ocrspace_request",
            return_value=payload,
        ) as request:
            pages = _ocr_pdf_ocrspace(
                pdf_bytes, "eng", api_key="test-key", timeout=5
            )

        request.assert_called_once()
        page = pages[0]
        self.assertEqual(page["pageNumber"], 1)
        # Default render scale is 2.0, so image pixels halve back to PDF points.
        self.assertEqual(page["words"][0]["x0"], 72.0)
        self.assertEqual(page["words"][0]["y0"], 60.0)
        self.assertEqual(page["words"][0]["confidence"], 0.9)
        self.assertIn("Full Name: Jane Doe", page["rawText"])

    def test_ocr_space_candidate_answers_field_tesseract_missed(self):
        profile = self._profile()
        pdf_bytes = self._blank_scan_pdf()

        with (
            override_settings(
                OCR_ENABLED=False,
                OCR_SPACE_ENABLED=True,
                OCR_SPACE_API_KEY="test-key",
                OCR_SPACE_PRIORITY="after_ocr",
            ),
            patch(
                "extraction.services.document_extraction._ocr_pdf_ocrspace",
                return_value=[self._ocr_space_page()],
            ) as run_ocrspace,
        ):
            extracted = process_pdf(pdf_bytes, "scan.pdf", profile)

        run_ocrspace.assert_called_once()
        self.assertEqual(extracted["finalValues"]["full_name"], "Jane Doe")
        diagnostic = extracted["diagnostics"]["full_name"]
        self.assertEqual(diagnostic["source"], "ocr_space")
        self.assertEqual(diagnostic["status"], "OCR_SPACE_EXTRACTED")
        self.assertEqual(diagnostic["ocrSpaceValue"], "Jane Doe")
        self.assertIsNotNone(diagnostic["ocrSpaceConfidenceScore"])
        self.assertGreater(diagnostic["ocrSpaceConfidenceScore"], 0.0)
        self.assertIn("ocr_space", diagnostic["candidateScores"])
        self.assertEqual(extracted["extractionMethodUsed"], "OCR_EXTRACTED")

    def test_after_ocr_priority_prefers_tesseract_over_ocr_space(self):
        field = copy.deepcopy(PROFILE["fields"][0])
        ocr = ("Jane Doe", "Full Name:",
               "Full Name: Jane Doe", 1, "layout_aware", 0.8)
        ocr_space = (
            "John Doe", "Full Name:", "Full Name: John Doe", 1,
            "layout_aware", 0.95,
        )

        # OCR.space scores higher, yet after_ocr must keep local Tesseract.
        selected, ambiguous, reason = _choose_content_candidate(
            None, ocr, field, None, ocr_space, "after_ocr"
        )
        self.assertEqual(selected["source"], "ocr")
        self.assertFalse(ambiguous)

        # With no Tesseract result, the OCR.space fallback wins.
        selected, _, _ = _choose_content_candidate(
            None, None, field, None, ocr_space, "after_ocr"
        )
        self.assertEqual(selected["source"], "ocr_space")

    def test_ocr_space_remote_failure_is_swallowed_and_job_continues(self):
        profile = self._profile()
        pdf_bytes = self._blank_scan_pdf()

        with (
            override_settings(
                OCR_ENABLED=False,
                OCR_SPACE_ENABLED=True,
                OCR_SPACE_API_KEY="test-key",
            ),
            patch(
                "extraction.services.document_extraction._ocr_pdf_ocrspace",
                side_effect=RuntimeError("OCR.space returned HTTP 503."),
            ),
            patch(
                "extraction.services.document_extraction.logger.warning",
            ) as warn,
        ):
            extracted = process_pdf(pdf_bytes, "scan.pdf", profile)

        warn.assert_called()
        self.assertEqual(extracted["ocrSpaceError"],
                         "OCR.space returned HTTP 503.")
        self.assertFalse(extracted["finalValues"]["full_name"])
        self.assertEqual(extracted["extractionMethodUsed"], "NATIVE_PDF_TEXT")

    def test_ocr_space_not_invoked_when_disabled_or_key_missing(self):
        profile = self._profile()
        pdf_bytes = self._blank_scan_pdf()

        for enabled, api_key in ((False, "test-key"), (True, "")):
            with (
                override_settings(
                    OCR_ENABLED=False,
                    OCR_SPACE_ENABLED=enabled,
                    OCR_SPACE_API_KEY=api_key,
                ),
                patch(
                    "extraction.services.document_extraction._ocr_pdf_ocrspace",
                ) as run_ocrspace,
            ):
                process_pdf(pdf_bytes, "scan.pdf", profile)

            run_ocrspace.assert_not_called()


class BlankFormAuthoringTests(APITestCase):
    """Coverage for the additive 'Create Profile from Blank Form' path."""

    def test_analyze_discovers_blank_widgets_and_labels(self):
        layout = analyze_blank_form(create_blank_form_pdf())

        self.assertEqual(layout["widgetCount"], 2)
        self.assertTrue(layout["isBlank"])
        self.assertEqual(layout["prefilledCount"], 0)
        by_name = {
            widget["fieldName"]: widget for widget in layout["widgets"]
        }
        name_widget = by_name["applicant_name"]
        self.assertEqual(name_widget["kind"], "text")
        self.assertEqual(name_widget["prefilledValue"], None)
        self.assertIn("Name:", [label["text"]
                      for label in name_widget["labels"]])
        self.assertEqual(name_widget["suggestion"]["name"], "Name")
        ssn_widget = by_name["ssn_field"]
        self.assertEqual(ssn_widget["suggestion"]["name"], "SSN/TIN")
        self.assertEqual(
            ssn_widget["suggestion"]["validationRegex"],
            r"^\d{3}-\d{2}-\d{4}$|^\d{9}$",
        )

    def test_analyze_flags_form_without_widgets(self):
        silent_pdf = create_layout_pdf([("Just static text", 40, 100)])

        layout = analyze_blank_form(silent_pdf)

        self.assertEqual(layout["widgetCount"], 0)
        self.assertTrue(
            any("No AcroForm" in item for item in layout["warnings"]))

    def test_analyze_reports_prefilled_values_as_hints(self):
        pdf_bytes = create_acroform_pdf(
            [("Name:", 40, 100)],
            [("applicant_name", "Jane Doe", (70, 92, 220, 108))],
        )

        layout = analyze_blank_form(pdf_bytes)

        self.assertFalse(layout["isBlank"])
        self.assertEqual(layout["prefilledCount"], 1)
        self.assertTrue(
            any("prefilled" in item for item in layout["warnings"])
        )
        self.assertEqual(
            layout["widgets"][0]["prefilledValue"], "Jane Doe"
        )

    def test_analyze_rejects_unusable_inputs(self):
        for payload, fragment in [
            (b"not a pdf at all", "could not be opened"),
        ]:
            with self.subTest(payload=payload[:12]):
                with self.assertRaises(ValidationError) as ctx:
                    analyze_blank_form(payload)
                self.assertIn(fragment, str(ctx.exception))

    def test_analyze_endpoint_returns_layout(self):
        response = self.client.post(
            "/api/forms/analyze/",
            {"file": SimpleUploadedFile(
                "template.pdf", create_blank_form_pdf(), "application/pdf")},
            format="multipart",
        )

        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data["widgetCount"], 2)
        self.assertTrue(response.data["isBlank"])

    def test_analyze_endpoint_rejects_missing_or_non_pdf_upload(self):
        response = self.client.post(
            "/api/forms/analyze/", {}, format="multipart")
        self.assertEqual(response.status_code, 400)

        response = self.client.post(
            "/api/forms/analyze/",
            {"file": SimpleUploadedFile("notes.txt", b"hello", "text/plain")},
            format="multipart",
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("PDF", response.data["detail"])

    def test_analyze_endpoint_is_stateless(self):
        """The add-on must not touch stored profiles or jobs."""
        from .models import ExtractionProfile, ProcessingJob

        profiles_before = ExtractionProfile.objects.count()
        jobs_before = ProcessingJob.objects.count()

        response = self.client.post(
            "/api/forms/analyze/",
            {"file": SimpleUploadedFile(
                "template.pdf", create_blank_form_pdf(), "application/pdf")},
            format="multipart",
        )

        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(ExtractionProfile.objects.count(), profiles_before)
        self.assertEqual(ProcessingJob.objects.count(), jobs_before)

    def test_validate_profile_accepts_well_formed_generated_profile(self):
        candidate = {
            **copy.deepcopy(PROFILE),
            "fields": [
                {
                    "id": "name",
                    "name": "Name",
                    "label": "Name:",
                    "type": "text",
                    "required": False,
                    "filenameRules": {
                        "enabled": False, "patterns": [], "captureGroup": 1,
                        "caseInsensitive": True,
                    },
                    "contentRules": {
                        "enabled": True, "labels": ["Name:", "applicant_name"],
                        "regexPatterns": [], "positionHint": "after_label",
                    },
                    "priority": "pdf_first",
                    "normalization": {
                        "trim": True, "caseTransform": "titlecase",
                        "removeExtraSpaces": True,
                    },
                    "validation": {"minLength": 3},
                }
            ],
        }

        response = self.client.post(
            "/api/forms/validate-profile/", candidate, format="json"
        )

        self.assertEqual(response.status_code, 200, response.data)
        self.assertTrue(response.data["valid"], response.data["errors"])
        self.assertEqual(response.data["errors"], [])

    def test_validate_profile_reports_structural_problems(self):
        candidate = {
            "id": "profile-bad",
            "name": "Bad",
            "fields": [
                {
                    "id": "dup",
                    "type": "currency",
                    "priority": "ai_first",
                    "contentRules": {"enabled": True, "labels": []},
                    "filenameRules": {
                        "enabled": True,
                        "patterns": ["^(+"],
                    },
                    "validation": {"minLength": 10, "maxLength": 4},
                },
                {"id": "dup", "type": "text", "priority": "pdf_first"},
            ],
        }

        errors = validate_profile_config(candidate)

        joined = "\n".join(errors)
        self.assertIn("unknown type", joined)
        self.assertIn("unknown priority", joined)
        self.assertIn("duplicate field id", joined)
        self.assertIn("content rules need labels", joined)
        self.assertIn("filename regex", joined)
        self.assertIn("maxLength is below minLength", joined)

    def test_generated_profile_saves_through_regular_endpoint(self):
        """End-to-end add-on check: analyze -> save via existing POST."""
        layout = analyze_blank_form(create_blank_form_pdf())
        name_widget = next(
            widget for widget in layout["widgets"]
            if widget["fieldName"] == "applicant_name"
        )
        generated = {
            "id": "profile-blank-form-test",
            "name": "Generated Template Profile",
            "description": "built from blank form",
            "version": "1.0.0",
            "fields": [
                {
                    "id": "applicant_name",
                    "name": "Name",
                    "label": name_widget["labels"][0]["text"],
                    "type": "text",
                    "required": False,
                    "filenameRules": {
                        "enabled": False, "patterns": [], "captureGroup": 1,
                        "caseInsensitive": True,
                    },
                    "contentRules": {
                        "enabled": True,
                        "labels": [
                            label["text"] for label in name_widget["labels"]
                        ] + [name_widget["fieldName"]],
                        "regexPatterns": [],
                        "positionHint": "after_label",
                    },
                    "priority": "pdf_first",
                    "normalization": {
                        "trim": True, "caseTransform": "titlecase",
                        "removeExtraSpaces": True,
                    },
                    "validation": {"minLength": 3},
                }
            ],
            "aiSettings": {
                "enabled": False,
                "baseUrl": "http://127.0.0.1:11434",
                "model": "",
                "timeoutSeconds": 120,
                "contextSize": 16384,
                "strategy": "review",
                "allowCloudModels": False,
            },
            "extractionSettings": {"labelSimilarityThreshold": 0.82},
            "ocrSettings": {
                "enabledFallback": True,
                "autoDetectScanned": True,
                "minTextLengthThreshold": 50,
                "language": "eng",
                "quality": "standard",
            },
        }

        response = self.client.post(
            "/api/profiles/", generated, format="json"
        )

        self.assertEqual(response.status_code, 201, response.data)
        saved = response.data["fields"][0]
        self.assertIn("Name:", saved["contentRules"]["labels"])
        self.assertIn("applicant_name", saved["contentRules"]["labels"])
