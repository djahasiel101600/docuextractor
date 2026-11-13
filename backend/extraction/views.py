import csv
from datetime import datetime
import hashlib
import re
import uuid

from django.db import IntegrityError, transaction
from django.db.models import Avg, Q
from django.db.utils import DatabaseError
from django.core.files.base import ContentFile
from django.http import FileResponse, Http404, StreamingHttpResponse
from django.utils import timezone
from django.conf import settings
from rest_framework import serializers, status
from rest_framework.exceptions import ParseError, ValidationError
from rest_framework.parsers import FormParser, JSONParser, MultiPartParser
from rest_framework.response import Response
from rest_framework.views import APIView
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiParameter, OpenApiResponse, extend_schema, inline_serializer
from django.utils.decorators import method_decorator
from django.views.decorators.csrf import csrf_exempt, ensure_csrf_cookie

from .api_serializers import (
    BulkAssignmentRequestSerializer,
    DocumentPatchRequestSerializer,
    DocumentResponseSerializer,
    DocumentAssignmentSerializer,
    DocumentAssignmentUpdateSerializer,
    JobUploadRequestSerializer,
    ProcessingJobProgressSerializer,
    ProcessingJobResponseSerializer,
    document_data,
    job_data,
)
from .models import (
    ExtractedField,
    ExtractionProfile,
    FieldDiagnostic,
    PDFDocument,
    ProcessingJob,
)
from .serializers import (
    ExtractionProfileSerializer,
    OllamaConnectionTestRequestSerializer,
)
from .services.job_processing import launch_job_processing
from .services.ollama import test_ollama_connection
from .services.form_layout import analyze_blank_form, validate_profile_config
from .services.zip_processing import discover_pdf_files
from .services.document_assignment import classify_document_assignment

# Multipart envelope overhead (boundary markers, part headers, field names) is
# a few hundred bytes. Allow 1 MiB of slack so a body exactly at the configured
# archive cap is not rejected for its headers alone.
MULTIPART_OVERHEAD_BYTES = 1024 * 1024


def _oversized_body_response(request):
    """Return a 413 response when the declared body exceeds the archive cap.

    DRF parses the multipart body lazily, so the first access to
    ``request.FILES`` streams the entire payload off the socket. A size check
    after that point has already paid for the whole transfer, which is how a
    large upload used to hold a request handler until gunicorn's master aborted
    it. Reading ``CONTENT_LENGTH`` is free and lets the client fail fast.

    Returns None when the body is acceptable or its length is unknown.
    """
    try:
        declared_bytes = int(request.META.get("CONTENT_LENGTH") or 0)
    except (TypeError, ValueError):
        return None
    if declared_bytes <= settings.MAX_UPLOAD_SIZE_BYTES + MULTIPART_OVERHEAD_BYTES:
        return None
    return Response(
        {
            "detail": (
                "The uploaded archive exceeds the configured size limit of "
                f"{settings.MAX_UPLOAD_SIZE_BYTES // (1024 * 1024)} MB."
            )
        },
        status=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
    )


def _parse_upload(request):
    """Return ``(upload, error_response)`` for the request's ``file`` field.

    A truncated or reset body (client disconnect, tunnel reset) makes DRF's
    MultiPartParser wrap the read error in ParseError. DRF would answer 400 on
    its own, but its message embeds the internal exception text; a stable
    message keeps the client contract clean and the logs quiet.
    """
    try:
        return request.FILES.get("file"), None
    except ParseError:
        return None, Response(
            {
                "detail": (
                    "The upload was interrupted before it completed. "
                    "Please retry the archive."
                )
            },
            status=status.HTTP_400_BAD_REQUEST,
        )


@method_decorator(ensure_csrf_cookie, name="dispatch")
class APIRootView(APIView):
    @extend_schema(
        operation_id="api_health",
        responses={
            200: inline_serializer(
                name="ApiHealth",
                fields={
                    "status": serializers.CharField(),
                    "database": serializers.CharField(),
                    "docs": serializers.CharField(),
                    "schema": serializers.CharField(),
                },
            ),
            503: OpenApiResponse(description="The database is unavailable."),
        },
    )
    def get(self, request):
        try:
            with transaction.atomic():
                ExtractionProfile.objects.count()
        except DatabaseError:
            return Response(
                {"status": "unavailable", "database": "unavailable"},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        return Response(
            {
                "status": "ok",
                "database": "connected",
                "docs": "/api/docs/",
                "schema": "/api/schema/",
            }
        )


class ProfileListCreateView(APIView):
    parser_classes = [JSONParser]

    @extend_schema(
        operation_id="profiles_list",
        responses=ExtractionProfileSerializer(many=True),
    )
    def get(self, request):
        profiles = ExtractionProfile.objects.all()
        return Response(ExtractionProfileSerializer(profiles, many=True).data)

    @extend_schema(
        operation_id="profiles_create",
        request=ExtractionProfileSerializer,
        responses={
            201: ExtractionProfileSerializer,
            409: OpenApiResponse(description="A profile with this ID already exists."),
        },
    )
    def post(self, request):
        serializer = ExtractionProfileSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        try:
            profile = serializer.save()
        except IntegrityError:
            return Response(
                {"id": ["A profile with this ID already exists."]},
                status=status.HTTP_409_CONFLICT,
            )
        return Response(
            ExtractionProfileSerializer(
                profile).data, status=status.HTTP_201_CREATED
        )


class ProfileDetailView(APIView):
    parser_classes = [JSONParser]

    def get_object(self, profile_id):
        try:
            return ExtractionProfile.objects.get(pk=profile_id)
        except ExtractionProfile.DoesNotExist as exc:
            raise Http404("Extraction profile not found.") from exc

    @extend_schema(operation_id="profiles_retrieve", responses=ExtractionProfileSerializer)
    def get(self, request, profile_id):
        return Response(ExtractionProfileSerializer(self.get_object(profile_id)).data)

    @extend_schema(operation_id="profiles_replace", request=ExtractionProfileSerializer, responses=ExtractionProfileSerializer)
    def put(self, request, profile_id):
        profile = self.get_object(profile_id)
        serializer = ExtractionProfileSerializer(profile, data=request.data)
        serializer.is_valid(raise_exception=True)
        return Response(ExtractionProfileSerializer(serializer.save()).data)

    @extend_schema(operation_id="profiles_update", request=ExtractionProfileSerializer, responses=ExtractionProfileSerializer)
    def patch(self, request, profile_id):
        profile = self.get_object(profile_id)
        serializer = ExtractionProfileSerializer(
            profile, data=request.data, partial=True
        )
        serializer.is_valid(raise_exception=True)
        return Response(ExtractionProfileSerializer(serializer.save()).data)

    @extend_schema(
        operation_id="profiles_delete",
        responses={
            204: OpenApiResponse(description="Profile deleted."),
            409: OpenApiResponse(description="Profile is referenced by processing jobs."),
        },
    )
    def delete(self, request, profile_id):
        profile = self.get_object(profile_id)
        if profile.jobs.exists():
            return Response(
                {"detail": "Profiles used by processing jobs cannot be deleted."},
                status=status.HTTP_409_CONFLICT,
            )
        profile.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


class BlankFormAnalyzeView(APIView):
    """Stateless helper for the 'Create Profile from Blank Form' wizard.

    Analyzes an uploaded PDF and returns its widget layout; nothing is
    persisted and no existing workflow touches this endpoint."""

    parser_classes = [MultiPartParser, FormParser]

    @extend_schema(
        operation_id="forms_analyze",
        request=inline_serializer(
            name="BlankFormAnalyzeRequest",
            fields={"file": serializers.FileField()},
        ),
        responses={200: OpenApiTypes.OBJECT, 400: OpenApiTypes.OBJECT},
    )
    def post(self, request):
        upload = request.FILES.get("file")
        if upload is None:
            return Response(
                {"detail": "Upload a PDF form in the 'file' field."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if not upload.name.lower().endswith(".pdf"):
            return Response(
                {"detail": "The blank form must be a PDF file."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if upload.size > settings.MAX_UPLOAD_SIZE_BYTES:
            return Response(
                {"detail": "The uploaded PDF exceeds the configured size limit."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        try:
            layout = analyze_blank_form(upload.read())
        except ValidationError as exc:
            return Response(
                {"detail": "; ".join(str(message)
                                     for message in exc.messages)},
                status=status.HTTP_400_BAD_REQUEST,
            )
        return Response(layout)


class ProfileConfigValidateView(APIView):
    """Dry-run structural validation for a candidate profile.

    Lets the wizard surface well-formedness errors before the profile ever
    reaches the existing save endpoint. Purely additive: the regular
    POST /api/profiles/ behavior is unchanged."""

    parser_classes = [JSONParser]

    @extend_schema(
        operation_id="profiles_validate_config",
        request=OpenApiTypes.OBJECT,
        responses={200: OpenApiTypes.OBJECT},
    )
    def post(self, request):
        errors = validate_profile_config(request.data)
        return Response({"valid": not errors, "errors": errors})


class OllamaConnectionTestView(APIView):
    parser_classes = [JSONParser]

    @extend_schema(
        operation_id="ollama_connection_test",
        request=OllamaConnectionTestRequestSerializer,
        responses={
            200: inline_serializer(
                name="OllamaConnectionTestResponse",
                fields={
                    "connected": serializers.BooleanField(),
                    "models": serializers.ListField(child=serializers.CharField()),
                },
            ),
            502: OpenApiResponse(description="Ollama is unreachable or the model is missing."),
        },
    )
    def post(self, request):
        serializer = OllamaConnectionTestRequestSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        try:
            models = test_ollama_connection(
                serializer.validated_data["baseUrl"],
                serializer.validated_data["model"],
                timeout=serializer.validated_data["timeoutSeconds"],
                allow_cloud_models=serializer.validated_data["allowCloudModels"],
            )
        except RuntimeError as exc:
            return Response(
                {"connected": False, "detail": str(exc)},
                status=status.HTTP_502_BAD_GATEWAY,
            )
        return Response({"connected": True, "models": models})


class JobListCreateView(APIView):
    parser_classes = [MultiPartParser, FormParser]

    @extend_schema(
        operation_id="jobs_list",
        responses=ProcessingJobResponseSerializer(many=True),
    )
    def get(self, request):
        jobs = ProcessingJob.objects.select_related("profile").prefetch_related(
            "documents__extracted_fields", "documents__field_diagnostics"
        )
        return Response([job_data(job) for job in jobs])

    @extend_schema(
        operation_id="jobs_create",
        request=JobUploadRequestSerializer,
        responses={202: ProcessingJobResponseSerializer},
    )
    def post(self, request):
        # Reject before the body is streamed: see _oversized_body_response.
        oversized = _oversized_body_response(request)
        if oversized is not None:
            return oversized
        upload, parse_error = _parse_upload(request)
        if parse_error is not None:
            return parse_error
        profile_id = request.data.get("profileId")
        if upload is None:
            return Response({"file": ["This field is required."]}, status=400)
        try:
            profile = ExtractionProfile.objects.get(pk=profile_id)
        except ExtractionProfile.DoesNotExist:
            return Response({"profileId": ["Choose a valid profile."]}, status=400)

        entries = discover_pdf_files(upload)
        if len(entries) > settings.MAX_JOB_DOCUMENTS:
            return Response(
                {
                    "detail": (
                        "This job would exceed the configured limit of "
                        f"{settings.MAX_JOB_DOCUMENTS} documents."
                    )
                },
                status=status.HTTP_400_BAD_REQUEST,
            )
        job_id = f"job-{uuid.uuid4()}"
        job = ProcessingJob.objects.create(
            id=job_id,
            name=upload.name,
            zip_filename=upload.name,
            zip_size_bytes=upload.size,
            profile=profile,
            total_discovered=len(entries),
        )
        launch_job_processing(job.pk, entries)
        return Response(job_data(job), status=status.HTTP_202_ACCEPTED)


@method_decorator(csrf_exempt, name="dispatch")
class JobBatchCreateView(APIView):
    """Create an empty job that archives are appended into before it starts.

    Batch uploads let a user split a large archive into several smaller ZIPs so
    each HTTP body stays under the reverse-proxy limit, while everything still
    aggregates into ONE processing job. The job is created in the 'idle'
    (assembling) state and is NOT launched until the start endpoint is called.
    """

    parser_classes = [MultiPartParser, FormParser, JSONParser]

    @extend_schema(
        operation_id="jobs_batch_create",
        request=inline_serializer(
            name="JobBatchCreateRequest",
            fields={"profileId": serializers.CharField()},
        ),
        responses={202: ProcessingJobResponseSerializer},
    )
    def post(self, request):
        profile_id = request.data.get("profileId")
        if not profile_id:
            return Response({"profileId": ["This field is required."]}, status=400)
        try:
            profile = ExtractionProfile.objects.get(pk=profile_id)
        except ExtractionProfile.DoesNotExist:
            return Response({"profileId": ["Choose a valid profile."]}, status=400)
        job = ProcessingJob.objects.create(
            id=f"job-{uuid.uuid4()}",
            name="Batch upload",
            zip_filename="batch",
            profile=profile,
            status="idle",
            total_discovered=0,
        )
        return Response(job_data(job), status=status.HTTP_202_ACCEPTED)


@method_decorator(csrf_exempt, name="dispatch")
class JobArchiveAppendView(APIView):
    """Add one ZIP archive to an assembling job, aggregating its PDFs.

    All discovery safeguards (compressed/uncompressed size caps, per-file size,
    compression-ratio zip-bomb guard, path-traversal, PDF magic-byte checks) run
    here for THIS archive only. A rejected archive returns 400 and leaves the job
    and previously appended archives untouched, so one bad file never aborts the
    batch or corrupts the job.
    """

    parser_classes = [MultiPartParser, FormParser]

    @extend_schema(
        operation_id="jobs_append_archive",
        request=JobUploadRequestSerializer,
        responses={
            200: inline_serializer(
                name="JobArchiveAppendResponse",
                fields={
                    "jobId": serializers.CharField(),
                    "archive": serializers.CharField(),
                    "added": serializers.IntegerField(),
                    "totalDiscovered": serializers.IntegerField(),
                },
            ),
            400: OpenApiResponse(description="This archive was rejected."),
            409: OpenApiResponse(description="The job is no longer accepting archives."),
        },
    )
    def post(self, request, job_id):
        # Reject before the body is streamed: see _oversized_body_response.
        oversized = _oversized_body_response(request)
        if oversized is not None:
            return oversized
        upload, parse_error = _parse_upload(request)
        if parse_error is not None:
            return parse_error
        if upload is None:
            return Response({"file": ["This field is required."]}, status=400)
        try:
            job = ProcessingJob.objects.get(pk=job_id)
        except ProcessingJob.DoesNotExist as exc:
            raise Http404("Processing job not found.") from exc
        if job.status != "idle":
            return Response(
                {"detail": "This job is no longer accepting archives."},
                status=status.HTTP_409_CONFLICT,
            )
        try:
            entries = discover_pdf_files(upload)
        except ValidationError as exc:
            detail = exc.detail
            message = "; ".join(str(item) for item in detail) if isinstance(
                detail, list
            ) else str(detail)
            return Response({"detail": message}, status=status.HTTP_400_BAD_REQUEST)

        # Lock the job row for the whole append so two archives uploaded in
        # parallel cannot both count the same existing total (and lose one
        # archive's PDFs) or race past MAX_JOB_DOCUMENTS. The status is
        # re-checked inside the lock because a start request may have won the
        # race while discovery was parsing this archive.
        with transaction.atomic():
            job = (
                ProcessingJob.objects.select_for_update()
                .filter(pk=job_id)
                .first()
            )
            if job is None:
                raise Http404("Processing job not found.")
            if job.status != "idle":
                return Response(
                    {"detail": "This job is no longer accepting archives."},
                    status=status.HTTP_409_CONFLICT,
                )
            existing_count = job.documents.count()
            if existing_count + len(entries) > settings.MAX_JOB_DOCUMENTS:
                return Response(
                    {
                        "detail": (
                            "This job would exceed the configured limit of "
                            f"{settings.MAX_JOB_DOCUMENTS} documents."
                        )
                    },
                    status=status.HTTP_400_BAD_REQUEST,
                )
            documents = []
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
            PDFDocument.objects.bulk_create(documents, batch_size=100)
            job.total_discovered += len(documents)
            job.zip_size_bytes += upload.size
            if upload.name and upload.name not in job.zip_filename:
                parts = [
                    part
                    for part in job.zip_filename.split(", ")
                    if part and part != "batch"
                ]
                parts.append(upload.name)
                job.zip_filename = ", ".join(parts)
                job.name = job.zip_filename
            job.save(
                update_fields=[
                    "total_discovered",
                    "zip_size_bytes",
                    "zip_filename",
                    "name",
                ]
            )
        return Response(
            {
                "jobId": job.pk,
                "archive": upload.name,
                "added": len(documents),
                "totalDiscovered": job.total_discovered,
            },
            status=status.HTTP_200_OK,
        )


@method_decorator(csrf_exempt, name="dispatch")
class JobAssignmentView(APIView):
    """Analyze all pending documents in a job and assign profiles based on rules."""
    parser_classes = [JSONParser]

    @extend_schema(
        operation_id="jobs_assign_profiles",
        request=None,
        responses={
            200: inline_serializer(
                name="JobAssignProfilesResponse",
                fields={
                    "detail": serializers.CharField(),
                    "analyzed": serializers.IntegerField(),
                    "preservedManual": serializers.IntegerField(),
                },
            )
        },
    )
    def post(self, request, job_id):
        try:
            job = ProcessingJob.objects.get(pk=job_id)
        except ProcessingJob.DoesNotExist as exc:
            raise Http404("Processing job not found.") from exc

        profiles = list(ExtractionProfile.objects.all())
        profile_map = {profile.id: profile for profile in profiles}
        pending_documents = job.documents.filter(processing_status="pending")
        # Manual overrides and manual exclusions are user decisions, so a
        # re-analysis must never overwrite them.
        documents = list(pending_documents.exclude(assignment_method="manual"))
        preserved_manual = pending_documents.filter(
            assignment_method="manual"
        ).count()

        with transaction.atomic():
            for doc in documents:
                assignment = classify_document_assignment(
                    doc, profiles, fallback_profile=job.profile)
                doc.profile = profile_map.get(assignment["profile_id"])
                doc.assignment_status = assignment["status"]
                doc.assignment_method = assignment["method"]
                doc.assignment_rule = assignment["rule"]
                doc.assignment_confidence = assignment["confidence"]
                doc.assignment_reason = assignment["reason"]
                doc.save(
                    update_fields=[
                        "profile",
                        "assignment_status",
                        "assignment_method",
                        "assignment_rule",
                        "assignment_confidence",
                        "assignment_reason",
                    ]
                )

        return Response(
            {
                "detail": "Profiles assigned based on rules.",
                "analyzed": len(documents),
                "preservedManual": preserved_manual,
            },
            status=status.HTTP_200_OK,
        )


class JobAssignmentDetailView(APIView):
    """Retrieve the current profile assignments for a job's documents."""

    @extend_schema(
        operation_id="jobs_assignments_list",
        responses=DocumentAssignmentSerializer(many=True),
    )
    def get(self, request, job_id):
        try:
            job = ProcessingJob.objects.get(pk=job_id)
        except ProcessingJob.DoesNotExist as exc:
            raise Http404("Processing job not found.") from exc

        documents = job.documents.select_related("profile").all()
        results = []
        for doc in documents:
            results.append({
                "id": doc.id,
                "filename": doc.filename,
                "profileId": doc.profile_id,
                "profileName": doc.profile.name if doc.profile else None,
                "assignmentStatus": doc.assignment_status,
                "assignmentMethod": doc.assignment_method,
                "assignmentConfidence": doc.assignment_confidence,
                "assignmentReason": doc.assignment_reason,
                "processingStatus": doc.processing_status,
            })
        return Response(results, status=status.HTTP_200_OK)


def _matches_bulk_filter(filename, filter_type, filter_value):
    """Case-insensitive filename match for bulk assignment filters."""
    name = (filename or "").lower()
    value = (filter_value or "").strip().lower()
    if filter_type == "exact_match":
        return name == value
    # `filename_pattern` treats `*` as the only wildcard; every other regex
    # character in the user's pattern is literal.
    pattern = re.escape(value).replace(r"\*", ".*")
    return re.fullmatch(pattern, name) is not None


@method_decorator(csrf_exempt, name="dispatch")
class JobBulkAssignmentView(APIView):
    """Assign (or clear) one profile across many pending documents at once.

    Bulk actions only apply to documents that are still `pending` and that the
    user has not manually decided on, so a bulk sweep can never overwrite a
    hand-picked profile or exclusion.
    """

    parser_classes = [JSONParser]

    @extend_schema(
        operation_id="jobs_bulk_assign_profiles",
        request=BulkAssignmentRequestSerializer,
        responses={
            200: inline_serializer(
                name="JobBulkAssignResponse",
                fields={
                    "matched": serializers.IntegerField(),
                    "updated": serializers.IntegerField(),
                    "skipped_already_assigned": serializers.IntegerField(),
                },
            ),
            400: OpenApiResponse(description="Unknown profile or filter."),
            409: OpenApiResponse(
                description="The job has already started processing."
            ),
        },
    )
    def post(self, request, job_id):
        try:
            job = ProcessingJob.objects.get(pk=job_id)
        except ProcessingJob.DoesNotExist as exc:
            raise Http404("Processing job not found.") from exc
        # Assignments only make sense before the pipeline runs; changing them
        # mid-flight would make the produced results untraceable.
        if job.status != "idle":
            return Response(
                {
                    "detail": (
                        "This job has already started; assignments can no "
                        "longer change."
                    )
                },
                status=status.HTTP_409_CONFLICT,
            )

        serializer = BulkAssignmentRequestSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        profile_id = serializer.validated_data["profileId"]
        filter_type = serializer.validated_data["filter"]["type"]
        filter_value = serializer.validated_data["filter"]["value"].strip()

        target_profile = None
        if profile_id is not None:
            try:
                target_profile = ExtractionProfile.objects.get(pk=profile_id)
            except ExtractionProfile.DoesNotExist:
                return Response(
                    {"profileId": ["Choose a valid profile."]},
                    status=status.HTTP_400_BAD_REQUEST,
                )

        pending_documents = list(
            job.documents.filter(processing_status="pending").order_by("id")
        )
        matched = [
            document
            for document in pending_documents
            if _matches_bulk_filter(
                document.filename, filter_type, filter_value
            )
        ]

        updated = 0
        preserved_manual = 0
        with transaction.atomic():
            for document in matched:
                # A manual decision always wins over a bulk action.
                if document.assignment_method == "manual":
                    preserved_manual += 1
                    continue
                if target_profile is None:
                    document.profile = None
                    document.assignment_status = "unassigned"
                    document.assignment_confidence = 0.0
                    document.assignment_reason = (
                        f"bulk-cleared via {filter_type}: {filter_value}"
                    )
                else:
                    document.profile = target_profile
                    document.assignment_status = "assigned"
                    document.assignment_confidence = 1.0
                    document.assignment_reason = (
                        f"bulk-assigned via {filter_type}: {filter_value}"
                    )
                document.assignment_method = "bulk"
                document.assignment_rule = filter_type
                document.save(
                    update_fields=[
                        "profile",
                        "assignment_status",
                        "assignment_method",
                        "assignment_rule",
                        "assignment_confidence",
                        "assignment_reason",
                    ]
                )
                updated += 1

        return Response(
            {
                "matched": len(matched),
                "updated": updated,
                "skipped_already_assigned": preserved_manual,
            },
            status=status.HTTP_200_OK,
        )


class JobStartView(APIView):
    """Launch processing for an assembled batch job.

    A job that aggregated no valid PDFs is deleted rather than left behind as an
    empty orphan, so a fully failed batch never lingers in the history.
    """

    parser_classes = [JSONParser, FormParser]

    @extend_schema(
        operation_id="jobs_start",
        request=OpenApiTypes.OBJECT,
        responses={202: ProcessingJobResponseSerializer},
    )
    def post(self, request, job_id):
        with transaction.atomic():
            try:
                job = ProcessingJob.objects.select_for_update().get(pk=job_id)
            except ProcessingJob.DoesNotExist as exc:
                raise Http404("Processing job not found.") from exc
            if job.status != "idle":
                return Response(
                    {"detail": "This job has already been started."},
                    status=status.HTTP_409_CONFLICT,
                )
            if not job.documents.filter(processing_status="pending").exists():
                job.delete()
                return Response(
                    {"detail": "No archives containing valid PDFs were uploaded."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            # Compare-and-swap: authoritative on every backend (row locks are a
            # no-op on SQLite), so two concurrent start requests can never both
            # launch the same job.
            claimed = ProcessingJob.objects.filter(
                pk=job_id, status="idle"
            ).update(status="running")
            if not claimed:
                return Response(
                    {"detail": "This job has already been started."},
                    status=status.HTTP_409_CONFLICT,
                )
            job.status = "running"
        # Launch only after the transaction commits so the worker threads can
        # read the running status and the appended documents.
        launch_job_processing(job.pk)
        return Response(job_data(job), status=status.HTTP_202_ACCEPTED)


class JobCancelView(APIView):
    @extend_schema(
        operation_id="jobs_cancel",
        request=None,
        responses={202: OpenApiTypes.OBJECT},
    )
    def post(self, request, job_id):
        if not ProcessingJob.objects.filter(pk=job_id).exists():
            raise Http404("Processing job not found.")
        # Cooperative stop: the worker polls this flag between documents, so
        # an extraction that is already running finishes and is saved first.
        requested = ProcessingJob.objects.filter(
            pk=job_id, status="running"
        ).update(cancel_requested=True)
        if not requested:
            return Response(
                {"detail": "Only a running job can be cancelled."},
                status=status.HTTP_409_CONFLICT,
            )
        return Response(
            {"id": job_id, "status": "running", "cancelRequested": True},
            status=status.HTTP_202_ACCEPTED,
        )


class JobRetryView(APIView):
    RETRYABLE_STATUSES = ("completed", "error", "cancelled")

    @extend_schema(
        operation_id="jobs_retry",
        request=None,
        responses={202: OpenApiTypes.OBJECT},
    )
    def post(self, request, job_id):
        with transaction.atomic():
            try:
                job = ProcessingJob.objects.select_for_update().get(pk=job_id)
            except ProcessingJob.DoesNotExist as exc:
                raise Http404("Processing job not found.") from exc
            if job.status not in self.RETRYABLE_STATUSES:
                return Response(
                    {"detail": "Only a finished, failed or cancelled job can "
                               "be retried."},
                    status=status.HTTP_409_CONFLICT,
                )
            # Retry re-queues exactly the documents that did not produce a
            # result: failures, anything a cancel left pending, and documents
            # skipped for lack of a profile that has since been assigned one.
            # Documents the user excluded stay excluded.
            retryable = job.documents.exclude(assignment_status="excluded").filter(
                Q(processing_status__in=["failed", "pending"])
                | Q(processing_status="skipped_unassigned", profile__isnull=False)
            )
            if not retryable.exists():
                return Response(
                    {"detail": "There are no failed, pending or reassigned "
                               "documents to retry."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            retryable.update(processing_status="pending", error_details="")
            claimed = ProcessingJob.objects.filter(
                pk=job_id, status__in=self.RETRYABLE_STATUSES
            ).update(
                status="running",
                cancel_requested=False,
                heartbeat_at=timezone.now(),
            )
            if not claimed:
                return Response(
                    {"detail": "This job is already running."},
                    status=status.HTTP_409_CONFLICT,
                )
            job.status = "running"
        # Launch after commit so the worker sees the re-queued documents.
        launch_job_processing(job.pk)
        return Response(
            {"id": job.id, "status": "running"},
            status=status.HTTP_202_ACCEPTED,
        )


class JobDetailView(APIView):
    parser_classes = [JSONParser]

    @extend_schema(operation_id="jobs_retrieve", responses=ProcessingJobResponseSerializer)
    def get(self, request, job_id):
        try:
            job = ProcessingJob.objects.select_related("profile").prefetch_related(
                "documents__extracted_fields", "documents__field_diagnostics"
            ).get(pk=job_id)
        except ProcessingJob.DoesNotExist as exc:
            raise Http404("Processing job not found.") from exc
        return Response(job_data(job))

    @extend_schema(
        operation_id="jobs_delete",
        responses={204: OpenApiResponse(
            description="Job and its stored PDFs deleted.")},
    )
    def delete(self, request, job_id):
        try:
            job = ProcessingJob.objects.get(pk=job_id)
        except ProcessingJob.DoesNotExist as exc:
            raise Http404("Processing job not found.") from exc
        for document in job.documents.all():
            if document.file:
                document.file.delete(save=False)
        job.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


class JobProgressView(APIView):
    @extend_schema(
        operation_id="jobs_progress",
        responses=ProcessingJobProgressSerializer,
    )
    def get(self, request, job_id):
        try:
            job = ProcessingJob.objects.get(pk=job_id)
        except ProcessingJob.DoesNotExist as exc:
            raise Http404("Processing job not found.") from exc
        current_files = list(
            job.documents.filter(processing_status="processing")
            .values_list("filename", flat=True)
        )
        average_duration_ms = job.documents.filter(
            processing_status__in=["completed", "failed"],
            processing_duration_ms__isnull=False,
        ).aggregate(average=Avg("processing_duration_ms"))["average"]
        remaining_count = max(
            job.total_discovered
            - job.processed_count
            - job.failed_count
            - job.skipped_count,
            0,
        )
        average_seconds = (
            average_duration_ms / 1000 if average_duration_ms is not None else None
        )
        elapsed_seconds = max(
            (timezone.now() - job.created_at).total_seconds(),
            0.0,
        )
        return Response(
            {
                "id": job.id,
                "status": job.status,
                "totalDiscovered": job.total_discovered,
                "processedCount": job.processed_count,
                "failedCount": job.failed_count,
                "skippedCount": job.skipped_count,
                "currentProcessingFile": current_files[0] if current_files else "",
                "currentProcessingFiles": current_files,
                "remainingCount": remaining_count,
                "elapsedSeconds": elapsed_seconds,
                "averageSecondsPerDocument": average_seconds,
                "estimatedRemainingSeconds": (
                    average_seconds * remaining_count / settings.PDF_PROCESSING_WORKERS
                    if average_seconds is not None
                    else None
                ),
                "workerCount": settings.PDF_PROCESSING_WORKERS,
                "cancelRequested": job.cancel_requested,
            }
        )


class DocumentFileView(APIView):
    @extend_schema(
        operation_id="documents_download",
        responses={
            200: OpenApiResponse(
                response=OpenApiTypes.BINARY,
                description="The PDF file.",
            )
        },
    )
    def get(self, request, document_id):
        try:
            document = PDFDocument.objects.get(pk=document_id)
        except PDFDocument.DoesNotExist as exc:
            raise Http404("PDF document not found.") from exc
        if not document.file:
            raise Http404("PDF file is unavailable.")
        return FileResponse(
            document.file.open("rb"),
            content_type="application/pdf",
            filename=document.filename,
        )


class DocumentDetailView(APIView):
    parser_classes = [JSONParser]

    @extend_schema(
        operation_id="documents_update",
        request=DocumentPatchRequestSerializer,
        responses=DocumentResponseSerializer,
    )
    def patch(self, request, document_id):
        try:
            document = PDFDocument.objects.get(pk=document_id)
        except PDFDocument.DoesNotExist as exc:
            raise Http404("PDF document not found.") from exc

        # ------------------------------------------------------------------
        # Shape 1: review toggle.
        #   { "reviewed": true | false }
        # ------------------------------------------------------------------
        if "reviewed" in request.data:
            reviewed = request.data["reviewed"]
            if not isinstance(reviewed, bool):
                return Response({"reviewed": ["Must be a boolean."]}, status=400)
            document.is_reviewed = reviewed
            document.reviewed_at = timezone.now() if reviewed else None
            document.save(update_fields=["is_reviewed", "reviewed_at"])
            return Response(document_data(document))

        # ------------------------------------------------------------------
        # Shape 2: manual assignment override.
        #   { "profileId": "<id>" | null, "assignmentStatus"?: "<status>" }
        #
        # Must be checked BEFORE the field-edit branch below, otherwise a body
        # like { "profileId": null } falls through and returns a confusing
        # "fieldId is required" error.
        # ------------------------------------------------------------------
        if "profileId" in request.data or "assignmentStatus" in request.data:
            serializer = DocumentAssignmentUpdateSerializer(data=request.data)
            serializer.is_valid(raise_exception=True)
            validated = serializer.validated_data

            update_fields = []
            requeued_for_assignment = False

            if "profileId" in validated:
                profile_id = validated["profileId"]
                if profile_id is None:
                    document.profile = None
                    document.assignment_status = "excluded"
                    document.assignment_method = "manual"
                    document.assignment_rule = "manual_exclude"
                    document.assignment_confidence = 0.0
                    document.assignment_reason = "Manually excluded by user."
                else:
                    try:
                        profile = ExtractionProfile.objects.get(pk=profile_id)
                    except ExtractionProfile.DoesNotExist:
                        return Response(
                            {"profileId": ["Choose a valid profile."]},
                            status=status.HTTP_400_BAD_REQUEST,
                        )
                    document.profile = profile
                    document.assignment_status = "assigned"
                    document.assignment_method = "manual"
                    document.assignment_rule = "manual_override"
                    document.assignment_confidence = 1.0
                    document.assignment_reason = "Manually assigned by user."
                    if document.processing_status == "skipped_unassigned":
                        # The document was only waiting for a profile; queue it
                        # so the next retry actually extracts it.
                        document.processing_status = "pending"
                        document.error_details = ""
                        requeued_for_assignment = True
                update_fields.extend([
                    "profile",
                    "assignment_status",
                    "assignment_method",
                    "assignment_rule",
                    "assignment_confidence",
                    "assignment_reason",
                ])
                if requeued_for_assignment:
                    update_fields.extend(
                        ["processing_status", "error_details"])

            if "assignmentStatus" in validated:
                document.assignment_status = validated["assignmentStatus"]
                if "assignment_status" not in update_fields:
                    update_fields.append("assignment_status")
                # A standalone status change is still a manual decision and
                # must survive later bulk sweeps.
                if "profileId" not in validated:
                    document.assignment_method = "manual"
                    document.assignment_rule = "manual_status"
                    document.assignment_confidence = 0.0
                    document.assignment_reason = (
                        f"Manually set to {document.assignment_status} by user."
                    )
                    update_fields.extend([
                        "assignment_method",
                        "assignment_rule",
                        "assignment_confidence",
                        "assignment_reason",
                    ])

            if update_fields:
                document.save(update_fields=update_fields)

            return Response(document_data(document))

        # ------------------------------------------------------------------
        # Shape 3: single field value edit.
        #   { "fieldId": "<id>", "value": "<new value>" }
        # ------------------------------------------------------------------
        field_id = request.data.get("fieldId")
        if not isinstance(field_id, str) or not field_id:
            return Response({"fieldId": ["This field is required."]}, status=400)
        value = request.data.get("value")
        if not isinstance(value, str):
            return Response({"value": ["Must be a string."]}, status=400)
        try:
            extracted_field = document.extracted_fields.get(field_id=field_id)
            diagnostic = document.field_diagnostics.get(field_id=field_id)
        except (ExtractedField.DoesNotExist, FieldDiagnostic.DoesNotExist) as exc:
            return Response({"fieldId": ["Unknown field for this document."]}, status=404)
        previous_value = extracted_field.final_value
        extracted_field.final_value = value
        extracted_field.save(update_fields=["final_value"])
        details = diagnostic.details
        details.update(
            {
                "finalValue": value,
                "manualValue": value,
                "source": "manual",
                "method": "manual_override",
                "status": "MANUALLY_CORRECTED",
                "isManuallyCorrected": True,
                "reviewRequired": False,
                "explanation": f'Value manually adjusted from "{previous_value}" to "{value}".',
            }
        )
        diagnostic.details = details
        diagnostic.save(update_fields=["details"])
        document.edit_history.append(
            {
                "fieldId": field_id,
                "previousValue": previous_value,
                "newValue": value,
                "timestamp": datetime.now().astimezone().isoformat(),
            }
        )
        document.save(update_fields=["edit_history"])
        return Response(document_data(document))


def _collect_export_fields(job):
    """Union of field definitions across every profile used by the job.

    A batch can mix profiles, so exporting only the job's default fields would
    silently drop the columns produced by the other profiles.
    """
    ordered_profiles = [job.profile]
    seen_profile_ids = {job.profile_id}
    used_profile_ids = (
        job.documents.exclude(profile__isnull=True)
        .values_list("profile_id", flat=True)
        .distinct()
    )
    for profile_id in used_profile_ids:
        if profile_id in seen_profile_ids:
            continue
        seen_profile_ids.add(profile_id)
        profile = ExtractionProfile.objects.filter(pk=profile_id).first()
        if profile is not None:
            ordered_profiles.append(profile)

    fields = []
    seen_field_ids = set()
    for profile in ordered_profiles:
        for field in profile.configuration.get("fields", []):
            field_id = field.get("id")
            if not field_id or field_id in seen_field_ids:
                continue
            seen_field_ids.add(field_id)
            fields.append(field)
    return fields


class JobExportView(APIView):
    @extend_schema(
        operation_id="jobs_export",
        parameters=[
            OpenApiParameter(
                name="type",
                type=str,
                location=OpenApiParameter.QUERY,
                enum=["primary", "diagnostics"],
                description="Choose the reconciled data or diagnostic trace report.",
            ),
            OpenApiParameter(
                name="delimiter",
                type=str,
                location=OpenApiParameter.QUERY,
                enum=["comma", "semicolon", "tab"],
            ),
            OpenApiParameter(
                name="includeBom",
                type=bool,
                location=OpenApiParameter.QUERY,
            ),
            OpenApiParameter(
                name="useCorrectedValues",
                type=bool,
                location=OpenApiParameter.QUERY,
            ),
            OpenApiParameter(
                name="onlyReviewed",
                type=bool,
                location=OpenApiParameter.QUERY,
            ),
            OpenApiParameter(
                name="includeInvalid",
                type=bool,
                location=OpenApiParameter.QUERY,
                description=(
                    "Include values that failed validation. Off by default so a "
                    "primary CSV never ships INVALID values as if they were data."
                ),
            ),
            OpenApiParameter(
                name="fields",
                type=str,
                location=OpenApiParameter.QUERY,
                description="Comma-separated extraction field IDs.",
            ),
        ],
        responses={200: OpenApiResponse(
            response=OpenApiTypes.BINARY, description="CSV report.")},
    )
    def get(self, request, job_id):
        try:
            job = ProcessingJob.objects.select_related("profile").prefetch_related(
                "documents__extracted_fields", "documents__field_diagnostics"
            ).get(pk=job_id)
        except ProcessingJob.DoesNotExist as exc:
            raise Http404("Processing job not found.") from exc
        profile_fields = _collect_export_fields(job)
        diagnostics_only = request.query_params.get("type") == "diagnostics"
        selected_ids = request.query_params.get("fields")
        selected_ids = set(selected_ids.split(",")) if selected_ids else None
        only_reviewed = request.query_params.get(
            "onlyReviewed", "false").lower() == "true"
        include_invalid = request.query_params.get(
            "includeInvalid", "false").lower() == "true"
        include_bom = request.query_params.get(
            "includeBom", "true").lower() == "true"
        use_corrected = request.query_params.get(
            "useCorrectedValues", "true").lower() == "true"
        delimiter_option = request.query_params.get("delimiter", "comma")
        delimiter = {"comma": ",", "semicolon": ";",
                     "tab": "\t"}.get(delimiter_option)
        if delimiter is None:
            return Response({"delimiter": ["Choose comma, semicolon, or tab."]}, status=400)
        if only_reviewed:
            job_documents = job.documents.select_related(
                "profile").filter(is_reviewed=True)
        else:
            job_documents = job.documents.select_related("profile").all()
        if selected_ids is not None:
            profile_fields = [
                field for field in profile_fields if field.get("id") in selected_ids
            ]

        class Echo:
            def write(self, value):
                return value

        writer = csv.writer(Echo())
        if diagnostics_only:
            rows = [
                writer.writerow([
                    "Document Filename", "Relative Path", "Extraction Profile",
                    "Field ID", "Field Name",
                    "Match Status", "Final Value", "Filename Extracted Value",
                    "PDF Extracted Value", "Form Field Extracted Value", "OCR Extracted Value", "Extraction Source",
                    "Extraction Method", "Matched Pattern or Label", "Validation Passed",
                    "Validation Error", "Confidence Score", "Page Number",
                    "Manual Review Required", "Is Manually Corrected",
                    "Diagnostic Explanation", "Supporting Text Evidence",
                ])
            ]
            for document in job_documents.prefetch_related("field_diagnostics"):
                for diagnostic in document.field_diagnostics.all():
                    details = diagnostic.details
                    if selected_ids is not None and diagnostic.field_id not in selected_ids:
                        continue
                    rows.append(writer.writerow([
                        document.filename,
                        document.relative_path,
                        document.profile.name if document.profile_id else job.profile.name,
                        diagnostic.field_id,
                        details.get("fieldName", diagnostic.field_name),
                        details.get("status", ""),
                        details.get("finalValue", ""),
                        details.get("filenameValue", ""),
                        details.get("pdfValue", ""),
                        details.get("formValue", ""),
                        details.get("ocrValue", ""),
                        details.get("source", ""),
                        details.get("method", ""),
                        details.get("matchedPatternOrLabel", ""),
                        "PASSED" if details.get(
                            "validationPassed") else "FAILED",
                        details.get("validationError", ""),
                        details.get("confidenceScore", ""),
                        details.get("pageNumber", ""),
                        "YES" if details.get("reviewRequired") else "NO",
                        "YES" if details.get("isManuallyCorrected") else "NO",
                        details.get("explanation", ""),
                        details.get("supportingEvidence", ""),
                    ]))
            filename = f"{job.id}-diagnostics.csv"
        else:
            rows = [writer.writerow([
                "Document Filename",
                "Relative Directory Path",
                "Extraction Profile",
                "Processing Status",
                "Extraction Method Used",
                "Review Status",
                "Flagged Values",
                *[field.get("name", field["id"]) for field in profile_fields],
            ])]
            for document in job_documents.prefetch_related(
                "extracted_fields", "field_diagnostics"
            ):
                values = {
                    item.field_id: item.final_value
                    for item in document.extracted_fields.all()
                }
                diagnostics = {
                    item.field_id: item.details
                    for item in document.field_diagnostics.all()
                }
                # INVALID values are diagnostic, not data: a primary export must
                # not present "address." as a citizenship or an address line as
                # an SSN. They are blanked by default and summarized in the
                # Flagged Values column; includeInvalid=true opts back in.
                invalid_ids = {
                    field_id
                    for field_id, details in diagnostics.items()
                    if details.get("status") == "INVALID"
                }
                flagged = [
                    "{name}: {reason}".format(
                        name=field.get("name", field["id"]),
                        reason=diagnostics[field["id"]].get(
                            "validationError") or "INVALID",
                    )
                    for field in profile_fields
                    if field["id"] in invalid_ids
                ]
                rows.append(writer.writerow([
                    document.filename,
                    document.relative_path,
                    document.profile.name if document.profile_id else job.profile.name,
                    document.processing_status,
                    document.extraction_method_used,
                    "Reviewed" if document.is_reviewed else "Pending Review",
                    " | ".join(flagged),
                    *[
                        ""
                        if not include_invalid and field["id"] in invalid_ids
                        else (
                            (
                                diagnostics.get(
                                    field["id"], {}).get("pdfValue")
                                or diagnostics.get(field["id"], {}).get("filenameValue")
                                or diagnostics.get(field["id"], {}).get("ocrValue")
                                or ""
                            )
                            if not use_corrected
                            and diagnostics.get(field["id"], {}).get("isManuallyCorrected")
                            else values.get(field["id"], "")
                        )
                        for field in profile_fields
                    ],
                ]))
            filename = f"{job.id}-extraction.csv"

        content = ("\ufeff" if include_bom else "") + "".join(rows)
        response = StreamingHttpResponse(
            iter([content]), content_type="text/csv; charset=utf-8"
        )
        response["Content-Disposition"] = f'attachment; filename="{filename}"'
        return response
