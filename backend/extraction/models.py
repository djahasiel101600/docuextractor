import uuid

from django.conf import settings
from django.db import models


def create_job_id():
    return f"job-{uuid.uuid4()}"


class ExtractionProfile(models.Model):
    id = models.CharField(max_length=100, primary_key=True)
    name = models.CharField(max_length=200)
    description = models.TextField(blank=True)
    version = models.CharField(max_length=50, default="1.0")
    configuration = models.JSONField(default=dict)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["name"]

    def __str__(self):
        return self.name


class ProcessingJob(models.Model):
    STATUS_CHOICES = [
        ("idle", "Idle"),
        ("running", "Running"),
        ("completed", "Completed"),
        ("cancelled", "Cancelled"),
        ("error", "Error"),
    ]

    id = models.CharField(
        max_length=100, primary_key=True, default=create_job_id)
    name = models.CharField(max_length=255)
    zip_filename = models.CharField(max_length=255)
    zip_size_bytes = models.PositiveBigIntegerField(default=0)
    profile = models.ForeignKey(
        ExtractionProfile, on_delete=models.PROTECT, related_name="jobs"
    )
    status = models.CharField(
        max_length=20, choices=STATUS_CHOICES, default="running")
    total_discovered = models.PositiveIntegerField(default=0)
    processed_count = models.PositiveIntegerField(default=0)
    failed_count = models.PositiveIntegerField(default=0)
    skipped_count = models.PositiveIntegerField(default=0)
    review_required_count = models.PositiveIntegerField(default=0)
    conflict_count = models.PositiveIntegerField(default=0)
    missing_count = models.PositiveIntegerField(default=0)
    invalid_count = models.PositiveIntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)
    # Durable-execution controls. The heartbeat is refreshed by the worker
    # while it owns the job, so a restarted process can tell an orphaned
    # "running" job (stale/absent heartbeat) from one a live worker is still
    # processing. cancel_requested is polled between documents instead of
    # killing threads mid-extraction.
    heartbeat_at = models.DateTimeField(null=True, blank=True, db_index=True)
    cancel_requested = models.BooleanField(default=False)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self):
        return self.name


def document_upload_path(instance, filename):
    return f"jobs/{instance.job_id}/{instance.id}/{filename}"


class PDFDocument(models.Model):
    STATUS_CHOICES = [
        ("pending", "Pending"),
        ("processing", "Processing"),
        ("completed", "Completed"),
        ("failed", "Failed"),
        ("excluded", "Excluded by user"),
    ]
    EXTRACTION_CHOICES = [
        ("NATIVE_PDF_TEXT", "Native PDF text"),
        ("OCR_EXTRACTED", "OCR extracted"),
        ("AI_EXTRACTED", "Local AI extracted"),
        ("FAILED", "Failed"),
    ]
    ASSIGNMENT_CHOICES = [
        ("legacy", "Legacy job profile"),
        ("assigned", "Assigned by rule"),
        ("manual", "Manually overridden"),
        ("ambiguous", "Ambiguous profile match"),
        ("unassigned", "No profile assignment"),
        ("excluded", "Excluded from processing"),
    ]

    id = models.CharField(max_length=150, primary_key=True)
    job = models.ForeignKey(
        ProcessingJob, on_delete=models.CASCADE, related_name="documents")
    profile = models.ForeignKey(
        ExtractionProfile,
        on_delete=models.SET_NULL,
        related_name="documents",
        null=True,
        blank=True,
    )
    filename = models.CharField(max_length=255)
    relative_path = models.TextField()
    file_size_bytes = models.PositiveBigIntegerField(default=0)
    file = models.FileField(upload_to=document_upload_path)
    page_count = models.PositiveIntegerField(default=0)
    file_hash = models.CharField(max_length=64, blank=True)
    processing_duration_ms = models.PositiveBigIntegerField(
        null=True, blank=True)
    processing_metrics = models.JSONField(default=dict, blank=True)
    processing_status = models.CharField(
        max_length=20, choices=STATUS_CHOICES, default="pending"
    )
    error_details = models.TextField(blank=True)
    is_encrypted_or_corrupted = models.BooleanField(default=False)
    extraction_method_used = models.CharField(
        max_length=30, choices=EXTRACTION_CHOICES, default="NATIVE_PDF_TEXT"
    )
    assignment_status = models.CharField(
        max_length=20,
        choices=ASSIGNMENT_CHOICES,
        default="legacy",
    )
    assignment_method = models.CharField(max_length=50, blank=True)
    assignment_rule = models.CharField(max_length=255, blank=True)
    assignment_confidence = models.FloatField(default=0.0)
    assignment_reason = models.TextField(blank=True)
    raw_filename_text = models.TextField(blank=True)
    raw_extracted_pdf_text = models.TextField(blank=True)
    pdf_text_length = models.PositiveIntegerField(default=0)
    is_reviewed = models.BooleanField(default=False)
    reviewed_at = models.DateTimeField(null=True, blank=True)
    reviewed_by = models.CharField(max_length=150, blank=True)
    edit_history = models.JSONField(default=list)

    class Meta:
        ordering = ["filename"]


class ExtractedField(models.Model):
    document = models.ForeignKey(
        PDFDocument, on_delete=models.CASCADE, related_name="extracted_fields"
    )
    field_id = models.CharField(max_length=100)
    field_name = models.CharField(max_length=200)
    final_value = models.TextField(blank=True)

    class Meta:
        unique_together = [("document", "field_id")]


class FieldDiagnostic(models.Model):
    document = models.ForeignKey(
        PDFDocument, on_delete=models.CASCADE, related_name="field_diagnostics"
    )
    field_id = models.CharField(max_length=100)
    field_name = models.CharField(max_length=200)
    details = models.JSONField(default=dict)

    class Meta:
        unique_together = [("document", "field_id")]
