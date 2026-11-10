from rest_framework import serializers

from django.conf import settings
from django.db.models import Avg
from django.utils import timezone

from .models import PDFDocument, ProcessingJob


class DocumentResponseSerializer(serializers.Serializer):
    id = serializers.CharField()
    jobId = serializers.CharField()
    filename = serializers.CharField()
    relativePath = serializers.CharField()
    fileSizeBytes = serializers.IntegerField()
    pageCount = serializers.IntegerField()
    fileHash = serializers.CharField(allow_blank=True)
    processingDurationMs = serializers.IntegerField(allow_null=True)
    processingMetrics = serializers.DictField(child=serializers.JSONField())
    processingStatus = serializers.CharField()
    errorDetails = serializers.CharField(allow_null=True, allow_blank=True)
    isEncryptedOrCorrupted = serializers.BooleanField()
    extractionMethodUsed = serializers.CharField()
    rawFilenameText = serializers.CharField(allow_blank=True)
    rawExtractedPdfText = serializers.CharField(allow_blank=True)
    pdfTextLength = serializers.IntegerField()
    diagnostics = serializers.DictField(child=serializers.JSONField())
    finalValues = serializers.DictField(
        child=serializers.CharField(allow_blank=True))
    isReviewed = serializers.BooleanField()
    reviewedAt = serializers.CharField(allow_null=True)
    reviewedBy = serializers.CharField(allow_null=True)
    editHistory = serializers.ListField(child=serializers.JSONField())
    fileUrl = serializers.CharField()
    # Assignment fields
    profileId = serializers.CharField(allow_null=True)
    assignmentStatus = serializers.CharField()
    assignmentMethod = serializers.CharField(allow_blank=True)
    assignmentRule = serializers.CharField(allow_blank=True)
    assignmentConfidence = serializers.FloatField()
    assignmentReason = serializers.CharField(allow_blank=True)


class DocumentAssignmentSerializer(serializers.Serializer):
    id = serializers.CharField()
    filename = serializers.CharField()
    profileId = serializers.CharField(allow_null=True)
    profileName = serializers.CharField(allow_null=True)
    assignmentStatus = serializers.CharField()
    assignmentConfidence = serializers.FloatField()
    assignmentReason = serializers.CharField()


class DocumentAssignmentUpdateSerializer(serializers.Serializer):
    """Body for the manual assignment-override branch of PATCH /documents/{id}/.

    - `profileId`: a profile primary key, or null to exclude the document.
    - `assignmentStatus`: optional status override applied after the profile
      change (or independently).

    At least one field is required; an empty body is rejected so callers
    cannot accidentally no-op a PATCH.
    """

    profileId = serializers.CharField(
        required=False,
        allow_null=True,
        allow_blank=False,
    )
    assignmentStatus = serializers.ChoiceField(
        required=False,
        choices=["assigned", "ambiguous", "excluded", "unassigned"],
    )

    def validate(self, attrs):
        if "profileId" not in attrs and "assignmentStatus" not in attrs:
            raise serializers.ValidationError(
                "Provide at least one of 'profileId' or 'assignmentStatus'."
            )
        return attrs


class ProcessingJobResponseSerializer(serializers.Serializer):
    id = serializers.CharField()
    name = serializers.CharField()
    createdAt = serializers.CharField()
    zipFilename = serializers.CharField()
    zipSizeBytes = serializers.IntegerField()
    profileId = serializers.CharField()
    profileName = serializers.CharField()
    totalDiscovered = serializers.IntegerField()
    processedCount = serializers.IntegerField()
    failedCount = serializers.IntegerField()
    skippedCount = serializers.IntegerField()
    reviewRequiredCount = serializers.IntegerField()
    conflictCount = serializers.IntegerField()
    missingCount = serializers.IntegerField()
    invalidCount = serializers.IntegerField()
    status = serializers.CharField()
    currentProcessingFile = serializers.CharField(allow_blank=True)
    currentProcessingFiles = serializers.ListField(
        child=serializers.CharField())
    documents = DocumentResponseSerializer(many=True)


class ProcessingJobProgressSerializer(serializers.Serializer):
    id = serializers.CharField()
    status = serializers.CharField()
    totalDiscovered = serializers.IntegerField()
    processedCount = serializers.IntegerField()
    failedCount = serializers.IntegerField()
    skippedCount = serializers.IntegerField()
    currentProcessingFile = serializers.CharField(allow_blank=True)
    currentProcessingFiles = serializers.ListField(
        child=serializers.CharField())
    remainingCount = serializers.IntegerField()
    elapsedSeconds = serializers.FloatField()
    averageSecondsPerDocument = serializers.FloatField(allow_null=True)
    estimatedRemainingSeconds = serializers.FloatField(allow_null=True)
    workerCount = serializers.IntegerField()


class JobUploadRequestSerializer(serializers.Serializer):
    file = serializers.FileField()
    profileId = serializers.CharField()


class DocumentPatchRequestSerializer(serializers.Serializer):
    fieldId = serializers.CharField(required=False)
    value = serializers.CharField(required=False, allow_blank=True)
    reviewed = serializers.BooleanField(required=False)


def document_data(document):
    diagnostics = {
        item.field_id: item.details
        for item in document.field_diagnostics.all()
    }
    values = {
        item.field_id: item.final_value
        for item in document.extracted_fields.all()
    }
    return {
        "id": document.id,
        "jobId": document.job_id,
        "filename": document.filename,
        "relativePath": document.relative_path,
        "fileSizeBytes": document.file_size_bytes,
        "pageCount": document.page_count,
        "fileHash": document.file_hash,
        "processingDurationMs": document.processing_duration_ms,
        "processingMetrics": document.processing_metrics,
        "processingStatus": document.processing_status,
        "errorDetails": document.error_details or None,
        "isEncryptedOrCorrupted": document.is_encrypted_or_corrupted,
        "extractionMethodUsed": document.extraction_method_used,
        "rawFilenameText": document.raw_filename_text,
        "rawExtractedPdfText": document.raw_extracted_pdf_text,
        "pdfTextLength": document.pdf_text_length,
        "diagnostics": diagnostics,
        "finalValues": values,
        "isReviewed": document.is_reviewed,
        "reviewedAt": document.reviewed_at.isoformat() if document.reviewed_at else None,
        "reviewedBy": document.reviewed_by or None,
        "editHistory": document.edit_history,
        "fileUrl": f"documents/{document.id}/file/",
        # Per-document assignment. A batch can mix profiles, so the client must
        # be able to resolve the profile this document was processed with
        # instead of assuming the job-level default.
        "profileId": document.profile_id,
        "profileName": document.profile.name if document.profile_id else None,
        "assignmentStatus": document.assignment_status,
        "assignmentMethod": document.assignment_method,
        "assignmentRule": document.assignment_rule,
        "assignmentConfidence": document.assignment_confidence,
        "assignmentReason": document.assignment_reason,
    }


def job_data(job):
    document_records = list(
        job.documents.select_related("profile").prefetch_related(
            "extracted_fields", "field_diagnostics"
        )
    )
    documents = [document_data(document) for document in document_records]
    current_processing_files = [
        document.filename
        for document in document_records
        if document.processing_status == "processing"
    ]
    current_processing_file = next(
        iter(current_processing_files),
        "",
    )
    return {
        "id": job.id,
        "name": job.name,
        "createdAt": job.created_at.isoformat(),
        "zipFilename": job.zip_filename,
        "zipSizeBytes": job.zip_size_bytes,
        "profileId": job.profile_id,
        "profileName": job.profile.name,
        "totalDiscovered": job.total_discovered,
        "processedCount": job.processed_count,
        "failedCount": job.failed_count,
        "skippedCount": job.skipped_count,
        "reviewRequiredCount": job.review_required_count,
        "conflictCount": job.conflict_count,
        "missingCount": job.missing_count,
        "invalidCount": job.invalid_count,
        "status": job.status,
        "currentProcessingFile": current_processing_file,
        "currentProcessingFiles": current_processing_files,
        "documents": documents,
    }
