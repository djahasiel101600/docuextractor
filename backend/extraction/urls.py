from django.urls import path

from .views import (
    APIRootView,
    BlankFormAnalyzeView,
    DocumentDetailView,
    DocumentFileView,
    JobDetailView,
    JobExportView,
    JobListCreateView,
    JobProgressView,
    OllamaConnectionTestView,
    ProfileConfigValidateView,
    ProfileDetailView,
    ProfileListCreateView,
)

urlpatterns = [
    path("", APIRootView.as_view(), name="api-root"),
    path("profiles/", ProfileListCreateView.as_view(), name="profile-list"),
    path("profiles/<str:profile_id>/",
         ProfileDetailView.as_view(), name="profile-detail"),
    path("forms/analyze/", BlankFormAnalyzeView.as_view(),
         name="blank-form-analyze"),
    path("forms/validate-profile/", ProfileConfigValidateView.as_view(),
         name="profile-validate-config"),
    path("ai/ollama/test/", OllamaConnectionTestView.as_view(),
         name="ollama-connection-test"),
    path("jobs/", JobListCreateView.as_view(), name="job-list"),
    path("jobs/<str:job_id>/progress/",
         JobProgressView.as_view(), name="job-progress"),
    path("jobs/<str:job_id>/", JobDetailView.as_view(), name="job-detail"),
    path("jobs/<str:job_id>/export/", JobExportView.as_view(), name="job-export"),
    path("documents/<str:document_id>/",
         DocumentDetailView.as_view(), name="document-detail"),
    path("documents/<str:document_id>/file/",
         DocumentFileView.as_view(), name="document-file"),
]
