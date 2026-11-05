from dataclasses import dataclass
from io import BytesIO
from pathlib import PurePosixPath
import zipfile

from django.conf import settings
from rest_framework.exceptions import ValidationError


@dataclass(frozen=True)
class PdfEntry:
    filename: str
    relative_path: str
    content: bytes


def _safe_member_path(raw_path: str) -> str:
    normalized = raw_path.replace("\\", "/")
    path = PurePosixPath(normalized)
    if (
        path.is_absolute()
        or (path.parts and path.parts[0].endswith(":"))
        or any(part in ("..", "") for part in path.parts)
        or any(ord(character) < 32 or ord(character) == 127 for character in normalized)
    ):
        raise ValidationError("The archive contains an unsafe path.")
    return path.as_posix()


def discover_pdf_files(upload) -> list[PdfEntry]:
    if upload.size > settings.MAX_UPLOAD_SIZE_BYTES:
        raise ValidationError("The uploaded archive exceeds the configured size limit.")
    if not upload.name.lower().endswith(".zip"):
        raise ValidationError("Upload a ZIP archive containing PDF files.")

    try:
        archive = zipfile.ZipFile(BytesIO(upload.read()))
    except (OSError, zipfile.BadZipFile) as exc:
        raise ValidationError("The uploaded file is not a valid ZIP archive.") from exc

    with archive:
        entries = [item for item in archive.infolist() if not item.is_dir()]
        if len(entries) > settings.MAX_ARCHIVE_FILES:
            raise ValidationError("The archive contains more files than allowed.")
        if sum(item.file_size for item in entries) > settings.MAX_ARCHIVE_UNCOMPRESSED_BYTES:
            raise ValidationError("The uncompressed archive exceeds the configured size limit.")

        pdfs = []
        for item in entries:
            safe_path = _safe_member_path(item.filename)
            path = PurePosixPath(safe_path)
            if path.name.startswith(".") or "__MACOSX" in path.parts:
                continue
            if path.suffix.lower() != ".pdf":
                continue
            if item.file_size > settings.MAX_UPLOAD_SIZE_BYTES:
                raise ValidationError(f"{path.name} exceeds the per-file size limit.")
            if item.file_size / max(item.compress_size, 1) > 1000:
                raise ValidationError(f"{path.name} has an unsafe compression ratio.")
            try:
                content = archive.read(item)
            except (OSError, RuntimeError, zipfile.BadZipFile) as exc:
                raise ValidationError(f"Could not read {path.name} from the archive.") from exc
            if not content.startswith(b"%PDF-"):
                raise ValidationError(f"{path.name} is not a valid PDF file.")
            pdfs.append(PdfEntry(path.name, safe_path, content))

    if not pdfs:
        raise ValidationError("The archive does not contain any valid PDF files.")
    return pdfs
