"""
bulk_extractor.py
-----------------
Multi-schema, safe ZIP batch processing.

REFERENCE IMPLEMENTATION — NOT PRODUCTION CODE.
Reference for:
  - in-memory ZIP processing (no disk writes for archive members)
  - safety limits (entry count, size, ratio, traversal, symlinks)
  - per-file explicit schema assignment
  - unassigned-file skipping
  - per-file error isolation
  - structured batch report

Never writes to disk. All PDFs are opened from in-memory bytes.

Two entry points:
    scan_zip(zip_path)                  -> list of discovered PDF entries
    process_zip_with_assignments(       -> per-PDF extraction using explicit
        zip_path, assignments, ...)        schema assignments
"""

from __future__ import annotations

import os
import posixpath
import zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict, dataclass, field
from typing import Any, Callable, Dict, List, Optional, Tuple

import fitz  # PyMuPDF


# ---------------------------------------------------------------------------
# Limits
# ---------------------------------------------------------------------------

MAX_ENTRIES = 10_000
MAX_UNCOMPRESSED_BYTES = 2 * 1024 * 1024 * 1024   # 2 GB
MAX_COMPRESSION_RATIO = 100
MAX_SINGLE_FILE_BYTES = 200 * 1024 * 1024        # 200 MB


# ---------------------------------------------------------------------------
# Result models
# ---------------------------------------------------------------------------

@dataclass
class PdfEntry:
    archive: str
    archive_path: str
    relative_path: str
    size_bytes: int
    schema_name: Optional[str] = None


@dataclass
class FileResult:
    archive: str
    relative_path: str
    size_bytes: int
    schema_name: Optional[str]
    status: str                       # 'ok' | 'error' | 'skipped_unassigned'
    # | 'skipped_too_large'
    error: Optional[str] = None
    fields: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class ArchiveSummary:
    archive: str
    status: str                       # 'ok' | 'error'
    error: Optional[str] = None
    entry_count: int = 0
    pdf_count: int = 0
    skipped_in_scan: int = 0
    processed: int = 0
    unassigned: int = 0

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class BulkReport:
    archives: List[ArchiveSummary] = field(default_factory=list)
    files: List[FileResult] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "archives": [a.to_dict() for a in self.archives],
            "files": [f.to_dict() for f in self.files],
        }


# ---------------------------------------------------------------------------
# ZIP safety helpers
# ---------------------------------------------------------------------------

class ArchiveRejected(Exception):
    pass


def _is_safe_entry(name: str) -> Tuple[bool, str]:
    if not name:
        return False, "empty name"
    if "\x00" in name:
        return False, "null byte in name"
    if name.startswith(("/", "\\")) or (len(name) > 1 and name[1] == ":"):
        return False, "absolute path"
    norm = posixpath.normpath(name.replace("\\", "/"))
    if norm.startswith("../") or norm == ".." or "/.." in norm:
        return False, "path traversal"
    if any(ord(c) < 32 for c in name):
        return False, "control character"
    return True, ""


def _is_pdf_entry(info: zipfile.ZipInfo) -> bool:
    lower = info.filename.lower()
    return lower.endswith(".pdf") and not info.is_dir()


def _is_symlink(info: zipfile.ZipInfo) -> bool:
    mode = (info.external_attr >> 16) & 0xF000
    return mode == 0xA000


def _walk_safe_pdfs(zf: zipfile.ZipFile) -> Tuple[List[zipfile.ZipInfo], int, int]:
    infos = zf.infolist()
    if len(infos) > MAX_ENTRIES:
        raise ArchiveRejected(
            f"Too many entries ({len(infos)} > {MAX_ENTRIES})")

    pdf_infos: List[zipfile.ZipInfo] = []
    skipped = 0
    total_uncompressed = 0

    for info in infos:
        if info.is_dir():
            continue
        if _is_symlink(info):
            skipped += 1
            continue
        ok, _ = _is_safe_entry(info.filename)
        if not ok:
            skipped += 1
            continue

        total_uncompressed += info.file_size
        if total_uncompressed > MAX_UNCOMPRESSED_BYTES:
            raise ArchiveRejected(
                f"Archive exceeds total uncompressed size "
                f"({total_uncompressed} > {MAX_UNCOMPRESSED_BYTES})")

        if info.compress_size > 0:
            ratio = info.file_size / info.compress_size
            if ratio > MAX_COMPRESSION_RATIO and info.file_size > 1_000_000:
                raise ArchiveRejected(
                    f"Compression ratio {ratio:.0f}x exceeds limit for "
                    f"{info.filename}")

        if not _is_pdf_entry(info):
            continue

        if info.file_size > MAX_SINGLE_FILE_BYTES:
            skipped += 1
            continue

        pdf_infos.append(info)

    return pdf_infos, skipped, len(infos)


# ---------------------------------------------------------------------------
# Scan (no extraction)
# ---------------------------------------------------------------------------

def scan_zip(zip_path: str) -> Tuple[List[PdfEntry], ArchiveSummary]:
    archive_name = os.path.basename(zip_path)
    summary = ArchiveSummary(archive=archive_name, status="ok")
    entries: List[PdfEntry] = []

    try:
        zf = zipfile.ZipFile(zip_path, "r")
    except (zipfile.BadZipFile, OSError) as e:
        summary.status = "error"
        summary.error = f"Unable to open archive: {e}"
        return entries, summary

    with zf:
        try:
            pdf_infos, skipped, total = _walk_safe_pdfs(zf)
        except ArchiveRejected as e:
            summary.status = "error"
            summary.error = str(e)
            return entries, summary

        summary.entry_count = total
        summary.pdf_count = len(pdf_infos)
        summary.skipped_in_scan = skipped

        for info in pdf_infos:
            rel = posixpath.normpath(info.filename.replace("\\", "/"))
            entries.append(PdfEntry(
                archive=archive_name,
                archive_path=zip_path,
                relative_path=rel,
                size_bytes=info.file_size,
            ))

    return entries, summary


# ---------------------------------------------------------------------------
# Extraction (in-memory)
# ---------------------------------------------------------------------------

def _extract_pdf_bytes_with_schema(
    data: bytes, schema: Dict[str, Any]
) -> Dict[str, Any]:
    """Run ROI extraction on in-memory PDF bytes."""
    from extraction import _extract_from_open_doc

    doc = fitz.open(stream=data, filetype="pdf")
    try:
        return _extract_from_open_doc(doc, schema)
    finally:
        doc.close()


# ---------------------------------------------------------------------------
# Assignment-driven batch extraction
# ---------------------------------------------------------------------------

def process_zip_with_assignments(
    zip_path: str,
    assignments: Dict[Tuple[str, str], Dict[str, Any]],
    *,
    max_workers: int = 4,
    progress_cb: Optional[Callable[[str], None]] = None,
) -> BulkReport:
    """
    Process one ZIP. Only PDFs present in `assignments` (keyed by
    (archive_basename, relative_path)) are extracted. All others are
    reported as 'skipped_unassigned'.
    """
    report = BulkReport()
    archive_name = os.path.basename(zip_path)
    summary = ArchiveSummary(archive=archive_name, status="ok")
    report.archives.append(summary)

    try:
        zf = zipfile.ZipFile(zip_path, "r")
    except (zipfile.BadZipFile, OSError) as e:
        summary.status = "error"
        summary.error = f"Unable to open archive: {e}"
        return report

    with zf:
        try:
            pdf_infos, skipped, total = _walk_safe_pdfs(zf)
            summary.entry_count = total
            summary.pdf_count = len(pdf_infos)
            summary.skipped_in_scan = skipped
        except ArchiveRejected as e:
            summary.status = "error"
            summary.error = str(e)
            return report

        assigned_jobs: List[Tuple[zipfile.ZipInfo, Dict[str, Any], str]] = []
        for info in pdf_infos:
            rel = posixpath.normpath(info.filename.replace("\\", "/"))
            schema = assignments.get((archive_name, rel))
            if schema is None:
                summary.unassigned += 1
                report.files.append(FileResult(
                    archive=archive_name, relative_path=rel,
                    size_bytes=info.file_size, schema_name=None,
                    status="skipped_unassigned", error=None))
                continue
            schema_name = schema.get("_display_name") or schema.get(
                "schema_name") or "schema"
            assigned_jobs.append((info, schema, schema_name))

        if progress_cb:
            progress_cb(
                f"{archive_name}: {len(assigned_jobs)} assigned, "
                f"{summary.unassigned} unassigned (skipped)")

        payloads: List[Tuple[zipfile.ZipInfo, bytes, Dict[str, Any], str]] = []
        for info, schema, schema_name in assigned_jobs:
            try:
                with zf.open(info, "r") as fh:
                    payloads.append((
                        info,
                        fh.read(MAX_SINGLE_FILE_BYTES + 1),
                        schema,
                        schema_name,
                    ))
            except Exception as e:
                rel = posixpath.normpath(info.filename.replace("\\", "/"))
                report.files.append(FileResult(
                    archive=archive_name, relative_path=rel,
                    size_bytes=info.file_size, schema_name=schema_name,
                    status="error", error=f"Read failed: {e}"))

        def _run(job):
            info, data, schema, schema_name = job
            rel = posixpath.normpath(info.filename.replace("\\", "/"))
            if len(data) > MAX_SINGLE_FILE_BYTES:
                return FileResult(
                    archive=archive_name, relative_path=rel,
                    size_bytes=len(data), schema_name=schema_name,
                    status="skipped_too_large",
                    error="Exceeds per-file size limit")
            try:
                fields = _extract_pdf_bytes_with_schema(data, schema)
                return FileResult(
                    archive=archive_name, relative_path=rel,
                    size_bytes=len(data), schema_name=schema_name,
                    status="ok", fields=fields)
            except Exception as e:
                return FileResult(
                    archive=archive_name, relative_path=rel,
                    size_bytes=len(data), schema_name=schema_name,
                    status="error", error=f"{type(e).__name__}: {e}")

        with ThreadPoolExecutor(max_workers=max_workers) as pool:
            futures = [pool.submit(_run, job) for job in payloads]
            for fut in as_completed(futures):
                fr = fut.result()
                report.files.append(fr)
                if fr.status == "ok":
                    summary.processed += 1
                if progress_cb:
                    progress_cb(
                        f"{archive_name}/{fr.relative_path}: {fr.status}")

    return report


def process_zips_with_assignments(
    zip_paths: List[str],
    assignments: Dict[Tuple[str, str], Dict[str, Any]],
    *,
    max_workers: int = 4,
    progress_cb: Optional[Callable[[str], None]] = None,
) -> BulkReport:
    merged = BulkReport()
    for zp in zip_paths:
        part = process_zip_with_assignments(
            zp, assignments, max_workers=max_workers, progress_cb=progress_cb)
        merged.archives.extend(part.archives)
        merged.files.extend(part.files)
    return merged
