from django.contrib import admin

from .models import ExtractedField, ExtractionProfile, FieldDiagnostic, PDFDocument, ProcessingJob


class PDFDocumentInline(admin.TabularInline):
    model = PDFDocument
    extra = 0
    readonly_fields = ("filename", "relative_path", "processing_status", "file_hash")


@admin.register(ProcessingJob)
class ProcessingJobAdmin(admin.ModelAdmin):
    list_display = ("zip_filename", "profile", "status", "created_at")
    list_filter = ("status", "created_at")
    inlines = [PDFDocumentInline]
    readonly_fields = ("created_at",)


@admin.register(ExtractionProfile)
class ExtractionProfileAdmin(admin.ModelAdmin):
    list_display = ("name", "version", "updated_at")


admin.site.register(ExtractedField)
admin.site.register(FieldDiagnostic)
