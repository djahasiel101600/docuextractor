"""End-to-end check of durable execution against the live dev server.

Creates a throwaway batch job (8 tiny PDFs), starts it, cancels mid-run,
retries the remainder and deletes the job in a finally block. Existing jobs
are never touched.
"""

import io
import json
import time
import urllib.error
import urllib.request
import uuid
import zipfile

import fitz

BASE = "http://127.0.0.1:8000/api"
TIMEOUT = 30


def _read(response):
    return json.loads(response.read().decode("utf-8"))


def get_json(path):
    with urllib.request.urlopen(f"{BASE}{path}", timeout=TIMEOUT) as response:
        return _read(response)


def post_json(path, payload=None):
    data = json.dumps(payload or {}).encode("utf-8")
    request = urllib.request.Request(
        f"{BASE}{path}",
        data=data,
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
            return response.status, _read(response)
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read().decode("utf-8") or "{}")


def post_archive(path, filename, content):
    boundary = uuid.uuid4().hex
    body = b"".join(
        [
            f"--{boundary}\r\n".encode(),
            (
                'Content-Disposition: form-data; name="file"; '
                f'filename="{filename}"\r\n'
            ).encode(),
            b"Content-Type: application/zip\r\n\r\n",
            content,
            f"\r\n--{boundary}--\r\n".encode(),
        ]
    )
    request = urllib.request.Request(
        f"{BASE}{path}",
        data=body,
        method="POST",
        headers={
            "Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    with urllib.request.urlopen(request, timeout=120) as response:
        return response.status, _read(response)


def delete(path):
    request = urllib.request.Request(f"{BASE}{path}", method="DELETE")
    with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
        return response.status


def pdf_bytes(index):
    document = fitz.open()
    page = document.new_page()
    page.insert_text((72, 72), f"Full Name: Durable Test {index}")
    data = document.tobytes()
    document.close()
    return data


def zip_bytes(count):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for index in range(count):
            archive.writestr(f"durable_{index:02d}.pdf", pdf_bytes(index))
    return buffer.getvalue()


def document_statuses(job):
    counts = {}
    for document in job["documents"]:
        counts[document["processingStatus"]] = (
            counts.get(document["processingStatus"], 0) + 1
        )
    return counts


def wait_until(path, predicate, seconds=240):
    deadline = time.time() + seconds
    job = None
    while time.time() < deadline:
        job = get_json(path)
        if predicate(job):
            return job
        time.sleep(0.25)
    raise TimeoutError(f"Timed out waiting for {path}: {job}")


def main():
    profiles = get_json("/profiles/")
    profile = next(
        (item for item in profiles if item["name"]
         == "W8 Profile"), profiles[0]
    )
    status, created = post_json("/jobs/batch/", {"profileId": profile["id"]})
    assert status == 202, created
    job_id = created["id"]
    print(f"created {job_id} with profile {profile['name']}")
    try:
        status, appended = post_archive(
            f"/jobs/{job_id}/archives/", "durable-check.zip", zip_bytes(8)
        )
        assert status == 200, appended
        print(f"appended docs: {appended['added']}")

        status, started = post_json(f"/jobs/{job_id}/start/")
        assert status == 202, started
        print(f"started: {started['status']}")

        # Cancel as soon as the first document has a result.
        wait_until(
            f"/jobs/{job_id}/progress/",
            lambda progress: progress["status"] != "running"
            or progress["processedCount"] + progress["failedCount"] >= 1,
            seconds=120,
        )
        status, cancel = post_json(f"/jobs/{job_id}/cancel/")
        print(f"cancel request: {status} {cancel}")

        if status == 202:
            job = wait_until(
                f"/jobs/{job_id}/",
                lambda detail: detail["status"] != "running",
            )
            print(
                f"after cancel: {job['status']} "
                f"processed={job['processedCount']} "
                f"failed={job['failedCount']} docs={document_statuses(job)}"
            )

            status, retry = post_json(f"/jobs/{job_id}/retry/")
            print(f"retry request: {status} {retry}")
            if status == 202:
                job = wait_until(
                    f"/jobs/{job_id}/",
                    lambda detail: detail["status"] != "running",
                )
                print(
                    f"after retry: {job['status']} "
                    f"processed={job['processedCount']} "
                    f"failed={job['failedCount']} docs={document_statuses(job)}"
                )
    finally:
        print(f"delete job: {delete(f'/jobs/{job_id}/')}")


if __name__ == "__main__":
    main()
