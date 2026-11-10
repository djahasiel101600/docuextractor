"""Live check: the server's periodic scan resumes an orphaned job.

Creates an orphaned job straight in the dev database (status "running", stale
heartbeat, one document stuck in "processing" as if the worker died mid-file),
then waits for the running dev server to claim and finish it. The job is
deleted afterwards. Run with the backend venv.
"""

import json
import os
import sys
import time
import urllib.request

os.environ["DOCUEXTRACT_RECOVER_JOBS"] = "0"  # only the server should recover
sys.path.insert(
    0, os.path.join(os.path.dirname(
        os.path.abspath(__file__)), "..", "backend")
)
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")

from datetime import timedelta  # noqa: E402

import django  # noqa: E402
import fitz  # noqa: E402

django.setup()

from django.core.files.base import ContentFile  # noqa: E402
from django.utils import timezone  # noqa: E402

from extraction.models import (  # noqa: E402
    ExtractionProfile,
    PDFDocument,
    ProcessingJob,
)

BASE = "http://127.0.0.1:8000/api"


def make_pdf():
    document = fitz.open()
    page = document.new_page()
    page.insert_text((72, 72), "Full Name: Recovered Test")
    data = document.tobytes()
    document.close()
    return data


def fetch(path):
    with urllib.request.urlopen(f"{BASE}{path}", timeout=30) as response:
        return json.loads(response.read())


def delete(path):
    request = urllib.request.Request(f"{BASE}{path}", method="DELETE")
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.status


def main():
    profile = ExtractionProfile.objects.get(name="W8 Profile")
    suffix = int(time.time())
    job_id = f"job-recovery-live-{suffix}"
    job = ProcessingJob.objects.create(
        id=job_id,
        name="Recovery live check",
        zip_filename="recovery.zip",
        profile=profile,
        status="running",
        total_discovered=1,
        heartbeat_at=timezone.now() - timedelta(minutes=10),
    )
    document = PDFDocument(
        id=f"doc-recovery-live-{suffix}",
        job=job,
        filename="recovery.pdf",
        relative_path="recovery.pdf",
        file_size_bytes=1,
        processing_status="processing",  # interrupted mid-extraction
        assignment_status="legacy",
    )
    document.file.save(f"{document.id}.pdf",
                       ContentFile(make_pdf()), save=False)
    document.save()
    print(f"orphan created: {job_id} (stale heartbeat, doc processing)")
    try:
        deadline = time.time() + 180
        detail = None
        while time.time() < deadline:
            detail = fetch(f"/jobs/{job_id}/")
            if detail["status"] != "running":
                print(
                    f"final: {detail['status']} processed={detail['processedCount']} "
                    f"docs={[(d['filename'], d['processingStatus']) for d in detail['documents']]}"
                )
                return
            time.sleep(2)
        print(f"TIMEOUT: still {detail['status']}")
    finally:
        print(f"delete job: {delete(f'/jobs/{job_id}/')}")


if __name__ == "__main__":
    main()
