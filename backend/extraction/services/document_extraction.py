from datetime import datetime
from difflib import SequenceMatcher
from functools import lru_cache
from io import BytesIO
import base64
import json
import logging
import math
import re
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

import fitz
import pytesseract
from PIL import Image
from django.conf import settings
from rest_framework.exceptions import ValidationError

from .country_data import is_country_value
from .ollama import extract_with_ollama

logger = logging.getLogger(__name__)

# Free OCR.space cloud OCR endpoint (opt-in fallback for constrained hosts).
OCR_SPACE_PARSE_URL = "https://api.ocr.space/parse/image"

SELECTIVE_AI_REVIEW_SCORE_THRESHOLD = 0.9
# Minimum confidence a purely spatial (label->widget geometry) AcroForm match
# must reach to be trusted. Below this the match is treated as a guess and
# dropped so native-text / OCR / filename sources win during reconciliation.
FORM_FIELD_SPATIAL_TRUST = 0.6
# Value shapes that must never come out of a purely spatial label->widget
# pairing (e.g. a date-of-birth widget grabbed for a Candidate Name label).
_SPATIAL_DATE_RE = re.compile(r"^\d{1,2}[-/.]\d{1,2}([-/.]\d{2,4})?$")
_SPATIAL_CITY_COUNTRY_TOKENS = {
    "city", "country", "state", "province", "region", "nation",
    "postal", "postcode", "zipcode", "zip",
}
_SPATIAL_DATE_TOKENS = {"date", "dob", "birth", "birthday"}

# Fields whose values are semantically constrained beyond length/regex. The
# inference keeps existing profiles accurate without forcing a config
# migration: a field called "citizenship" or "ssn_tin" gets the matching guard
# even when its stored validation block only has min/max length.
_COUNTRY_FIELD_IDS = {
    "country",
    "citizenship",
    "country_of_citizenship",
    "nationality",
    "country_of_residence",
    "residence_country",
    "country_mailing",
    "mailing_country",
}
_SSN_FIELD_IDS = {
    "ssn",
    "ssn_tin",
    "tin",
    "itin",
    "ein",
    "social_security_number",
    "taxpayer_id",
}
_US_SSN_VALUE_RE = re.compile(r"^\d{3}-\d{2}-\d{4}$|^\d{2}-\d{7}$|^\d{9}$")
# The search form must not slice a 9-digit window out of a longer foreign tax
# ID: "30212170201452" (14 digits) or "34-6229091-8" are not US SSNs, so the
# run may not touch another digit or hyphen on either side.
_US_SSN_SEARCH_RE = re.compile(
    r"(?<![\d-])(?:\d{3}-\d{2}-\d{4}|\d{2}-\d{7}|\d{9})(?![\d-])"
)


def _infer_value_type(field):
    """Return the semantic value type for a field, explicit config first."""
    rules = field.get("validation")
    if isinstance(rules, dict):
        explicit = str(rules.get("valueType") or "").strip().casefold()
        if explicit:
            return explicit
    field_id = str(field.get("id") or "").strip().casefold()
    normalized_name = " ".join(str(field.get("name") or "").split()).casefold()
    if field_id in _COUNTRY_FIELD_IDS or normalized_name in {
        "country",
        "citizenship",
        "nationality",
        "country of citizenship",
    }:
        return "country"
    if field_id in _SSN_FIELD_IDS or normalized_name in {
        "ssn",
        "ssn / tin",
        "tin",
        "social security number",
        "taxpayer id",
    }:
        return "us_ssn"
    return ""


def _normalize_field_config(field):
    """Copy a field config and inject the inferred semantic value type.

    Copying keeps the shared profile configuration immutable while threads
    process different documents, and makes every downstream `_validate_value`
    call (candidate selection, AI gating, reconciliation) apply the same rule.
    """
    if not isinstance(field, dict):
        return field
    normalized = dict(field)
    validation = dict(field.get("validation") or {})
    if not validation.get("valueType"):
        inferred = _infer_value_type(field)
        if inferred:
            validation["valueType"] = inferred
    normalized["validation"] = validation
    return normalized


def _is_us_ssn(value):
    return bool(_US_SSN_VALUE_RE.fullmatch(str(value or "").strip()))


def _is_label_fragment(text, labels, max_tokens=2):
    """True when the text is just words lifted from another field's label.

    On the W-8 layout the "Citizenship" label is followed on the same text row
    by the word "address." from the residence-address instructions. Whole-label
    similarity (0.82) cannot see that, so the fragment became the citizenship
    value. A short, digit-free run whose every token already appears in some
    configured label is a label fragment, never a field value.
    """
    value = str(text or "").strip()
    if not value or any(character.isdigit() for character in value):
        return False
    tokens = re.findall(r"[a-z]+", value.casefold())
    if not tokens or len(tokens) > max_tokens:
        return False
    label_tokens = set()
    for label in labels:
        if isinstance(label, str):
            label_tokens.update(re.findall(r"[a-z]+", label.casefold()))
    return bool(label_tokens) and all(
        token in label_tokens for token in tokens
    )


def _ssn_value_from_text(field, text):
    """Pull a value-shaped SSN/TIN out of a noisy label association.

    The SSN format regex used to run only after a whole address line had been
    selected, so "Gateshead Dr" and instruction prose became INVALID values.
    Searching the associated text for a substring that satisfies the field's
    own validation rejects those lines before they can win.
    """
    if _infer_value_type(field) != "us_ssn":
        return text
    validation = field.get("validation") or {}
    for match in _US_SSN_SEARCH_RE.finditer(str(text or "")):
        candidate = match.group(0)
        if _validate_value(candidate, validation)[0]:
            return candidate
    return None


def _spatial_form_value_is_plausible(field, widget):
    """Semantic guard for the label->widget spatial matcher only.

    When the widget that actually belongs to a configured label is empty, pure
    geometry will happily pair the label with the nearest *filled* widget, which
    is how a date of birth ended up in Candidate Name and a country in an
    address. Structural widget-name/pattern matches are self-evidencing and are
    not filtered here; this veto applies exclusively to the least-authoritative
    spatial heuristic."""
    value = (widget.get("value") or "").strip()
    if not value:
        return False
    value_type = _infer_value_type(field)
    if value_type == "country" and not is_country_value(value):
        return False
    if value_type == "us_ssn" and not _is_us_ssn(value):
        return False
    field_text = " ".join(
        str(field.get(key, ""))
        for key in ("name", "label", "description", "type")
    ).casefold()
    labels = field.get("contentRules", {}).get("labels", [])
    if isinstance(labels, list):
        field_text += " " + " ".join(str(label) for label in labels).casefold()
    # Split camelCase and punctuation so 'DateOfBirth' yields the 'date'/'birth'
    # tokens; keyword-only names like 'f1_13[0]' simply produce no keywords.
    widget_tokens = set(
        re.findall(
            r"[a-z]+",
            re.sub(
                r"(?<=[a-z])(?=[A-Z])|[^A-Za-z]+",
                " ",
                _clean_widget_name(widget.get("name", "")),
            ),
        )
    )
    date_expected = any(
        word in field_text for word in ("date", "dob", "birth")
    )
    if _SPATIAL_DATE_RE.match(value) and not date_expected:
        return False
    if "name" in field_text:
        if widget_tokens & (_SPATIAL_CITY_COUNTRY_TOKENS | _SPATIAL_DATE_TOKENS):
            return False
        letters = sum(char.isalpha() for char in value)
        digits = sum(char.isdigit() for char in value)
        if letters == 0 or digits > len(value) * 0.4:
            return False
    if "address" in field_text or field.get("type") == "address":
        if widget_tokens & _SPATIAL_CITY_COUNTRY_TOKENS:
            return False
        if not any(char.isdigit() for char in value):
            tokens = [
                token
                for token in re.split(r"[^A-Za-z\u00C0-\u024F']+", value)
                if token
            ]
            # A single city/country word grabbed from an adjacent widget is
            # never a street address; genuine digit-less addresses on these
            # forms are multi-word phrases.
            if len(tokens) < 2:
                return False
    return True


def _drop_duplicate_form_widgets(form_results):
    """One filled widget holds exactly one value.

    If two different field labels both claim the same widget, at least one
    pairing is a spatial mis-grab (observed: the same DOB widget feeding both
    Candidate Name and Permanent Address, each marked 'validated'). Descriptive
    widget-name/pattern matches are kept, but every spatial claim on a shared
    widget is dropped so reconciliation falls back to honest sources instead of
    a wrong-type false positive."""
    by_widget = {}
    for field_id, candidate in form_results.items():
        if candidate:
            by_widget.setdefault(candidate[6], []).append(field_id)
    for field_ids in by_widget.values():
        if len(field_ids) < 2:
            continue
        for field_id in field_ids:
            if form_results[field_id][4] == "acroform_field":
                form_results[field_id] = None


def normalize_value(value, normalization):
    if not value:
        return ""
    result = value
    if normalization.get("removeExtraSpaces"):
        result = re.sub(r"\s+", " ", result)
    if normalization.get("trim"):
        result = result.strip()
    result = re.sub(r"^[:\-–—\s]+|[:\-–—\s]+$", "", result).strip()
    date_format = normalization.get("dateFormat")
    if date_format and date_format != "as_is":
        result = _normalize_date(result, date_format)
    transform = normalization.get("caseTransform")
    if transform == "uppercase":
        result = result.upper()
    elif transform == "lowercase":
        result = result.lower()
    elif transform == "titlecase":
        result = result.title()
    return result


def _normalize_date(value, date_format):
    common_formats = (
        "%Y-%m-%d",
        "%Y/%m/%d",
        "%Y.%m.%d",
        "%d.%m.%Y",
    )
    month_first_formats = ("%m/%d/%Y", "%m-%d-%Y", "%d/%m/%Y", "%d-%m-%Y")
    day_first_formats = ("%d/%m/%Y", "%d-%m-%Y", "%m/%d/%Y", "%m-%d-%Y")
    ambiguous_formats = (
        day_first_formats
        if date_format in ("DD/MM/YYYY",)
        else month_first_formats
    )
    parsed = None
    for candidate in (*common_formats, *ambiguous_formats):
        try:
            parsed = datetime.strptime(value[:10], candidate)
            break
        except ValueError:
            continue
    if parsed is None:
        return value
    output_format = {
        "YYYY-MM-DD": "%Y-%m-%d",
        "DD/MM/YYYY": "%d/%m/%Y",
        "MM/DD/YYYY": "%m/%d/%Y",
        "MM-DD-YYYY": "%m-%d-%Y",
    }.get(date_format)
    return parsed.strftime(output_format) if output_format else value


def _validate_value(value, rules):
    if not value:
        return False, "No value was extracted."
    regex = rules.get("formatRegex")
    if regex:
        try:
            if not re.fullmatch(regex, value):
                return False, "Value does not match the configured format."
        except re.error:
            return False, "The configured validation regex is invalid."
    allowed = rules.get("allowedValues")
    if allowed and value not in allowed:
        return False, "Value is not in the allowed values list."
    if len(value) < rules.get("minLength", 0):
        return False, "Value is shorter than the configured minimum."
    if rules.get("maxLength") is not None and len(value) > rules["maxLength"]:
        return False, "Value exceeds the configured maximum."
    # Semantic value types inferred from the field identity ("citizenship" is a
    # country, "ssn_tin" is a government ID) so a syntactically short value such
    # as "address." or "Gateshead Dr" can never validate as one.
    value_type = str(rules.get("valueType") or "").strip().casefold()
    if value_type == "country" and not is_country_value(value):
        return False, "Value is not a recognized country name."
    if value_type == "us_ssn" and not _is_us_ssn(value):
        return False, "Value is not a valid SSN/TIN format."
    return True, None


def _pdf_document_pages(document, page_indices=None):
    pages = []
    indices = (
        page_indices
        if page_indices is not None
        else range(document.page_count)
    )
    for index in indices:
        page = document.load_page(index)
        text = page.get_text("text")
        words = [
            {
                "text": item[4],
                "x0": float(item[0]),
                "y0": float(item[1]),
                "x1": float(item[2]),
                "y1": float(item[3]),
                "confidence": 1.0,
            }
            for item in page.get_text("words", sort=True)
            if item[4].strip()
        ]
        pages.append(
            {
                "pageNumber": index + 1,
                "rawText": text,
                "lines": text.splitlines(),
                "words": words,
                "width": float(page.rect.width),
                "height": float(page.rect.height),
            }
        )
    return document.page_count, pages


def _page_image_coverage(page):
    page_area = max(page.rect.width * page.rect.height, 1)
    image_area = sum(
        rect.width * rect.height
        for image in page.get_images(full=True)
        for rect in page.get_image_rects(image[0])
    )
    return min(image_area / page_area, 1.0)


def _select_ocr_page_indices(
    document,
    pages,
    threshold,
    missing_fields,
    auto_detect_scanned,
    native_index,
):
    sparse_pages = set()
    image_pages = set()
    missing_label_pages = set()
    missing_labels = {
        label
        for field in missing_fields
        for label in field.get("contentRules", {}).get("labels", [])
        if isinstance(label, str)
    }

    for page_index, page_data in enumerate(pages):
        native_length = len(re.sub(r"\s+", "", page_data["rawText"]))
        if native_length < threshold:
            sparse_pages.add(page_index)
        if auto_detect_scanned and _page_image_coverage(
            document.load_page(page_index)
        ) >= 0.2:
            image_pages.add(page_index)
        if auto_detect_scanned and missing_labels and any(
            match["label"] in missing_labels
            for match in native_index[0][page_index]["labelMatches"]
        ):
            missing_label_pages.add(page_index)

    missing_content_value = bool(missing_fields)
    selected_pages = sparse_pages | image_pages | missing_label_pages
    fallback_to_all_pages = (
        auto_detect_scanned
        and missing_content_value
        and not selected_pages
    )
    should_ocr = bool(sparse_pages) or (
        auto_detect_scanned
        and (missing_content_value or bool(image_pages))
    )
    if fallback_to_all_pages:
        selected_pages = set(range(len(pages)))
    elif should_ocr and not selected_pages:
        selected_pages = set(range(len(pages)))

    return sorted(selected_pages), {
        "sparse_page_count": len(sparse_pages),
        "image_page_count": len(image_pages),
        "missing_label_page_count": len(missing_label_pages),
        "fallback_to_all_pages": int(fallback_to_all_pages),
        "should_ocr": int(should_ocr),
    }


def _ocr_pdf(
    pdf_bytes,
    language,
    max_pages,
    *,
    document=None,
    page_indices=None,
    timings=None,
    render_scale=2.0,
):
    owns_document = document is None
    if owns_document:
        document = fitz.open(stream=pdf_bytes, filetype="pdf")
    pages = []
    render_seconds = 0.0
    ocr_seconds = 0.0
    try:
        selected_indices = (
            page_indices
            if page_indices is not None
            else range(min(document.page_count, max_pages))
        )
        for page_index in selected_indices:
            page = document.load_page(page_index)
            page_area = max(page.rect.width * page.rect.height, 1)
            scale = min(
                max(render_scale, 1.0),
                3.0,
                math.sqrt(20_000_000 / page_area),
            )
            render_started = time.perf_counter()
            pixmap = page.get_pixmap(
                matrix=fitz.Matrix(scale, scale), alpha=False)
            image = Image.frombytes(
                "RGB",
                (pixmap.width, pixmap.height),
                pixmap.samples,
            )
            image_width, image_height = image.size
            render_seconds += time.perf_counter() - render_started
            ocr_started = time.perf_counter()
            try:
                result = pytesseract.image_to_data(
                    image, lang=language, output_type=pytesseract.Output.DICT
                )
            finally:
                image.close()
            ocr_seconds += time.perf_counter() - ocr_started
            scale_x = page.rect.width / image_width
            scale_y = page.rect.height / image_height
            words = []
            lines = {}
            for index, raw_text in enumerate(result["text"]):
                text = raw_text.strip()
                if not text:
                    continue
                try:
                    confidence = max(0.0, float(result["conf"][index]) / 100)
                except (TypeError, ValueError):
                    confidence = 0.0
                left = float(result["left"][index]) * scale_x
                top = float(result["top"][index]) * scale_y
                width = float(result["width"][index]) * scale_x
                height = float(result["height"][index]) * scale_y
                words.append(
                    {
                        "text": text,
                        "x0": left,
                        "y0": top,
                        "x1": left + width,
                        "y1": top + height,
                        "confidence": confidence,
                    }
                )
                line_key = (
                    result["block_num"][index],
                    result["par_num"][index],
                    result["line_num"][index],
                )
                lines.setdefault(line_key, []).append(text)
            page_lines = [" ".join(line) for line in lines.values()]
            pages.append(
                {
                    "pageNumber": page_index + 1,
                    "rawText": "\n".join(page_lines),
                    "lines": page_lines,
                    "words": words,
                    "width": float(page.rect.width),
                    "height": float(page.rect.height),
                }
            )
        if timings is not None:
            timings["pdf_rendering_ms"] = round(render_seconds * 1000, 3)
            timings["ocr_execution_ms"] = round(ocr_seconds * 1000, 3)
        return pages
    finally:
        if owns_document:
            document.close()


class _NoRedirectHandler(HTTPRedirectHandler):
    """Refuse HTTP redirects so a base64 API key is never replayed to a
    attacker-controlled redirect target (SSRF / credential-leak guard)."""

    def redirect_request(self, request, response, code, message, headers, new_url):
        return None


def _ocrspace_request(image_b64, *, api_key, timeout, language, url=OCR_SPACE_PARSE_URL):
    """POST one base64 PNG page image to the OCR.space /parse endpoint.

    Returns the decoded JSON object. Raises RuntimeError on any transport or
    protocol failure (timeout, 4xx/5xx, malformed JSON); callers must treat
    that as "remote OCR unavailable" and continue with other candidates."""
    form = urlencode(
        {
            "apikey": api_key,
            "base64Image": f"data:image/PNG;base64,{image_b64}",
            "filetype": "PNG",
            "language": language,
            "OCREngine": "2",
            "scale": "true",
            "isTable": "true",
            "detectOrientation": "true",
        }
    ).encode("utf-8")
    request = Request(
        url,
        data=form,
        headers={"Accept": "application/json",
                 "Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    try:
        opener = build_opener(ProxyHandler({}), _NoRedirectHandler)
        with opener.open(request, timeout=timeout) as response:
            data = json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        raise RuntimeError(f"OCR.space returned HTTP {exc.code}.") from exc
    except (TimeoutError, URLError, OSError) as exc:
        raise RuntimeError(f"OCR.space request failed: {exc}") from exc
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RuntimeError(
            "OCR.space returned a malformed JSON response.") from exc
    if not isinstance(data, dict):
        raise RuntimeError("OCR.space returned an unexpected JSON payload.")
    return data


def _normalize_ocrspace_lines(payload):
    """Convert an OCR.space ``ocredText`` payload into (line_texts, words).

    ``words`` items are dicts ``{"text", "confidence" (0..1), "scale"}`` where
    ``scale`` is ``[x1, y1, x2, y2]`` in image-pixel coordinates (or ``None``
    when the response carried no boxes). Accepts several response shapes and
    never raises, so a format change degrades to fewer candidates rather than
    crashing extraction (fail-open)."""
    line_texts = []
    words = []
    if isinstance(payload, str):
        line_texts.extend(payload.splitlines())
        return [t for t in line_texts if t.strip()], words
    if not isinstance(payload, list):
        return line_texts, words
    for line in payload:
        if isinstance(line, str):
            if line.strip():
                line_texts.append(line)
            continue
        if not isinstance(line, dict):
            continue
        raw_words = line.get("words") or line.get("textWords") or []
        if isinstance(line.get("text"), str):
            if line["text"].strip():
                line_texts.append(line["text"])
        elif isinstance(raw_words, list):
            joined = " ".join(
                str(word.get("text", "")).strip()
                for word in raw_words
                if isinstance(word, dict) and str(word.get("text", "")).strip()
            )
            if joined:
                line_texts.append(joined)
        if not isinstance(raw_words, list):
            continue
        for word in raw_words:
            if not isinstance(word, dict):
                continue
            text = str(word.get("text", "")).strip()
            if not text:
                continue
            conf = word.get("confidence", word.get("conf"))
            try:
                confidence = (
                    max(0.0, min(1.0, float(conf) / 100))
                    if conf is not None
                    else 0.0
                )
            except (TypeError, ValueError):
                confidence = 0.0
            box = word.get("scale") or word.get(
                "boundingBox") or word.get("box")
            coords = None
            if isinstance(box, (list, tuple)) and len(box) == 4:
                try:
                    coords = [float(value) for value in box]
                except (TypeError, ValueError):
                    coords = None
            words.append(
                {"text": text, "confidence": confidence, "scale": coords}
            )
    return line_texts, words


def _ocr_pdf_ocrspace(
    pdf_bytes,
    language,
    *,
    document=None,
    page_indices=None,
    timings=None,
    render_scale=2.0,
    api_key=None,
    timeout=None,
):
    """Render selected pages and OCR them through the OCR.space cloud API.

    Returns page dicts in the SAME shape as ``_ocr_pdf`` (pageNumber, rawText,
    lines, words[], width, height) so the downstream text index and label
    matcher work unchanged. Records ``ocr_space_execution_ms`` in ``timings``.
    Raises RuntimeError on transport failure; ``process_pdf`` converts that
    into a logged warning plus fallback to the pre-existing candidates."""
    if api_key is None:
        api_key = settings.OCR_SPACE_API_KEY
    if timeout is None:
        timeout = settings.OCR_SPACE_TIMEOUT_SECONDS
    if not api_key:
        raise RuntimeError(
            "OCR.space is enabled but no API key is configured.")
    owns_document = document is None
    if owns_document:
        document = fitz.open(stream=pdf_bytes, filetype="pdf")
    pages = []
    ocr_seconds = 0.0
    try:
        selected_indices = (
            page_indices
            if page_indices is not None
            else range(min(document.page_count, settings.MAX_PDF_PAGES))
        )
        for page_index in selected_indices:
            page = document.load_page(page_index)
            page_area = max(page.rect.width * page.rect.height, 1)
            scale = min(
                max(render_scale, 1.0),
                3.0,
                math.sqrt(20_000_000 / page_area),
            )
            pixmap = page.get_pixmap(
                matrix=fitz.Matrix(scale, scale), alpha=False)
            image = Image.frombytes(
                "RGB", (pixmap.width, pixmap.height), pixmap.samples
            )
            image_width, image_height = image.size
            image_buffer = BytesIO()
            image.save(image_buffer, format="PNG")
            image.close()
            image_b64 = base64.b64encode(
                image_buffer.getvalue()).decode("ascii")
            ocr_started = time.perf_counter()
            try:
                data = _ocrspace_request(
                    image_b64, api_key=api_key, timeout=timeout, language=language
                )
            finally:
                ocr_seconds += time.perf_counter() - ocr_started
            payload = data.get("ocredText")
            if payload is None:
                payload = data.get("OcrResponse") or data.get("ParsedResults")
            line_texts, raw_words = _normalize_ocrspace_lines(payload)
            scale_x = page.rect.width / image_width
            scale_y = page.rect.height / image_height
            words = []
            for word in raw_words:
                box = word.get("scale")
                if not box:
                    continue
                x1, y1, x2, y2 = box
                words.append(
                    {
                        "text": word["text"],
                        "x0": x1 * scale_x,
                        "y0": y1 * scale_y,
                        "x1": x2 * scale_x,
                        "y1": y2 * scale_y,
                        "confidence": word["confidence"],
                    }
                )
            page_lines = [text for text in line_texts if text.strip()]
            if not page_lines and words:
                page_lines = [" ".join(word["text"] for word in words)]
            pages.append(
                {
                    "pageNumber": page_index + 1,
                    "rawText": "\n".join(page_lines),
                    "lines": page_lines,
                    "words": words,
                    "width": float(page.rect.width),
                    "height": float(page.rect.height),
                }
            )
        if timings is not None:
            timings["ocr_space_execution_ms"] = round(ocr_seconds * 1000, 3)
        return pages
    finally:
        if owns_document:
            document.close()


def _extract_from_filename(filename, field):
    rules = field.get("filenameRules", {})
    if not rules.get("enabled"):
        return None, None
    basename = filename.rsplit(".", 1)[0] if "." in filename else filename
    flags = re.IGNORECASE if rules.get("caseInsensitive") else 0
    for pattern in rules.get("patterns", []):
        if not pattern.strip():
            continue
        try:
            match = re.search(pattern, basename, flags) or re.search(
                pattern, filename, flags)
        except re.error:
            continue
        if match:
            group = rules.get("captureGroup") or 1
            try:
                value = match.group(group)
            except IndexError:
                value = match.group(0)
            if value and value.strip():
                return value.strip(), pattern
    return None, None


@lru_cache(maxsize=4096)
def _normalized_tokens(text):
    return tuple(re.findall(r"[^\W_]+", text.casefold(), flags=re.UNICODE))


def _label_similarity_threshold(extraction_settings):
    value = extraction_settings.get("labelSimilarityThreshold", 0.82)
    if not isinstance(value, (int, float)) or not math.isfinite(value):
        return 0.82
    return min(1.0, max(0.7, float(value)))


def _group_words_into_rows(words):
    rows = []
    for word in sorted(
        words,
        key=lambda item: ((item["y0"] + item["y1"]) / 2, item["x0"]),
    ):
        center_y = (word["y0"] + word["y1"]) / 2
        matching_row = next(
            (
                row
                for row in reversed(rows)
                if abs(row["centerY"] - center_y)
                <= max(
                    3.0,
                    min(word["y1"] - word["y0"], row["height"]) * 0.45,
                )
            ),
            None,
        )
        if matching_row is None:
            rows.append(
                {
                    "words": [word],
                    "centerY": center_y,
                    "height": max(word["y1"] - word["y0"], 1.0),
                    "x0": word["x0"],
                    "x1": word["x1"],
                    "y0": word["y0"],
                    "y1": word["y1"],
                }
            )
            continue
        matching_row["words"].append(word)
        matching_row["centerY"] = sum(
            (item["y0"] + item["y1"]) / 2 for item in matching_row["words"]
        ) / len(matching_row["words"])
        matching_row["height"] = max(
            matching_row["height"], word["y1"] - word["y0"]
        )
        matching_row["x0"] = min(matching_row["x0"], word["x0"])
        matching_row["x1"] = max(matching_row["x1"], word["x1"])
        matching_row["y0"] = min(matching_row["y0"], word["y0"])
        matching_row["y1"] = max(matching_row["y1"], word["y1"])
    for row in rows:
        row["words"].sort(key=lambda item: item["x0"])
        row["text"] = " ".join(word["text"] for word in row["words"])
    return sorted(rows, key=lambda row: row["centerY"])


def _match_label_in_row(row, label, minimum_similarity=0.82):
    label_tokens = _normalized_tokens(label)
    if not label_tokens:
        return None
    words = row["words"]
    word_tokens = [_normalized_tokens(word["text"]) for word in words]
    token_delta = max(
        2,
        math.ceil(len(label_tokens) * (1.0 - minimum_similarity)),
    )
    min_token_count = max(1, len(label_tokens) - token_delta)
    max_token_count = len(label_tokens) + token_delta
    best_match = None
    for start in range(len(words)):
        candidate_tokens = []
        for end in range(start, len(words)):
            candidate_tokens.extend(word_tokens[end])
            if len(candidate_tokens) > max_token_count:
                break
            if len(candidate_tokens) < min_token_count:
                continue
            if tuple(candidate_tokens) == label_tokens:
                similarity = 1.0
            else:
                sequence_similarity = SequenceMatcher(
                    None, label_tokens, candidate_tokens, autojunk=False
                ).ratio()
                token_coverage = min(
                    len(label_tokens), len(candidate_tokens)
                ) / max(len(label_tokens), len(candidate_tokens))
                similarity = sequence_similarity * token_coverage
            if similarity < minimum_similarity:
                continue
            matched_words = words[start: end + 1]
            confidence = sum(
                word.get("confidence", 1.0) for word in matched_words
            ) / len(matched_words)
            match = {
                "start": start,
                "end": end + 1,
                "x0": min(word["x0"] for word in matched_words),
                "x1": max(word["x1"] for word in matched_words),
                "y0": min(word["y0"] for word in matched_words),
                "y1": max(word["y1"] for word in matched_words),
                "similarity": similarity,
                "confidence": confidence,
                "label": label,
                "text": " ".join(word["text"] for word in matched_words),
            }
            if best_match is None or (
                match["similarity"] * match["confidence"]
                > best_match["similarity"] * best_match["confidence"]
            ):
                best_match = match
    return best_match


def _row_columns(row):
    words = row["words"]
    if not words:
        return []
    median_height = sorted(word["y1"] - word["y0"]
                           for word in words)[len(words) // 2]
    gap_threshold = max(30.0, median_height * 3)
    columns = []
    start = 0
    for index in range(1, len(words)):
        if words[index]["x0"] - words[index - 1]["x1"] > gap_threshold:
            columns.append((start, index))
            start = index
    columns.append((start, len(words)))
    return columns


def _find_label_matches(rows, labels, minimum_similarity=0.82):
    matches = []
    for row_index, row in enumerate(rows):
        columns = _row_columns(row)
        for label in labels:
            for column_start, column_end in columns:
                column_words = row["words"][column_start:column_end]
                match = _match_label_in_row(
                    {"words": column_words}, label, minimum_similarity
                )
                if match:
                    match["start"] += column_start
                    match["end"] += column_start
                    match["rowIndex"] = row_index
                    match["labelEndRowIndex"] = row_index
                    match["endInRow"] = match["end"]
                    matches.append(match)

            for column_start, column_end in columns:
                column_words = row["words"][column_start:column_end]
                for anchor_index in range(len(column_words)):
                    first_word = column_words[anchor_index]
                    first_tokens = _normalized_tokens(first_word["text"])
                    label_tokens = _normalized_tokens(label)
                    if not first_tokens or SequenceMatcher(
                        None,
                        (label_tokens[0],),
                        (first_tokens[0],),
                        autojunk=False,
                    ).ratio() < 0.5:
                        continue
                    first_segment = {
                        "rowIndex": row_index,
                        "baseIndex": column_start + anchor_index,
                        "words": column_words[anchor_index:],
                    }
                    same_row_match = _match_label_in_row(
                        {"words": first_segment["words"]
                         }, label, minimum_similarity
                    )
                    if same_row_match and same_row_match["start"] == 0 and (
                        same_row_match["similarity"] == 1.0
                        or same_row_match["end"] < len(first_segment["words"])
                    ):
                        continue
                    segments = [first_segment]
                    previous_row = row
                    for next_row_index in range(row_index + 1, min(row_index + 3, len(rows))):
                        next_row = rows[next_row_index]
                        gap = next_row["y0"] - previous_row["y1"]
                        if gap > max(18.0, row["height"] * 2.5):
                            break
                        next_columns = _row_columns(next_row)
                        if not next_columns:
                            break
                        next_column = min(
                            next_columns,
                            key=lambda span: abs(
                                next_row["words"][span[0]]["x0"] -
                                first_word["x0"]
                            ),
                        )
                        next_column_start, next_column_end = next_column
                        continuation_x = next_row["words"][next_column_start]["x0"]
                        if abs(continuation_x - first_word["x0"]) > max(
                            45.0, row["height"] * 4
                        ):
                            break
                        continuation_words = next_row["words"][
                            next_column_start:next_column_end
                        ]
                        segments.append(
                            {
                                "rowIndex": next_row_index,
                                "baseIndex": next_column_start,
                                "words": continuation_words,
                            }
                        )
                        combined_words = [
                            word for segment in segments for word in segment["words"]
                        ]
                        wrapped_match = _match_label_in_row(
                            {"words": combined_words}, label, minimum_similarity
                        )
                        if wrapped_match and wrapped_match["start"] == 0:
                            remaining = wrapped_match["end"]
                            matched_words = []
                            end_row_index = row_index
                            end_in_row = column_start + anchor_index
                            for segment in segments:
                                segment_words = segment["words"]
                                if remaining <= len(segment_words):
                                    matched_words.extend(
                                        segment_words[:remaining])
                                    end_row_index = segment["rowIndex"]
                                    end_in_row = segment["baseIndex"] + \
                                        remaining
                                    break
                                matched_words.extend(segment_words)
                                remaining -= len(segment_words)
                            wrapped_match["rowIndex"] = row_index
                            wrapped_match["labelEndRowIndex"] = end_row_index
                            wrapped_match["endInRow"] = end_in_row
                            wrapped_match["start"] = column_start + \
                                anchor_index
                            wrapped_match["end"] = end_in_row
                            wrapped_match["x0"] = min(
                                word["x0"] for word in matched_words)
                            wrapped_match["x1"] = max(
                                word["x1"] for word in matched_words)
                            wrapped_match["y0"] = min(
                                word["y0"] for word in matched_words)
                            wrapped_match["y1"] = max(
                                word["y1"] for word in matched_words)
                            matches.append(wrapped_match)
                            break
                        previous_row = next_row
    matches.sort(key=lambda item: (item["rowIndex"], item["x0"]))
    unique = []
    for match in matches:
        if any(
            existing["rowIndex"] == match["rowIndex"]
            and existing["labelEndRowIndex"] == match["labelEndRowIndex"]
            and abs(existing["x0"] - match["x0"]) < 2
            and abs(existing["x1"] - match["x1"]) < 2
            for existing in unique
        ):
            continue
        unique.append(match)
    return unique


def _contains_known_label(words, labels, minimum_similarity=0.82):
    row = {"words": words}
    return any(
        _match_label_in_row(row, label, minimum_similarity)
        for label in labels
        if isinstance(label, str) and label.strip()
    )


def _row_candidate_text(
    row, left_bound, right_bound, excluded_labels, minimum_similarity=0.82
):
    selected_words = [
        word
        for word in row["words"]
        if left_bound <= (word["x0"] + word["x1"]) / 2 <= right_bound
    ]
    if not selected_words or _contains_known_label(
        selected_words, excluded_labels, minimum_similarity
    ):
        return None
    text = " ".join(word["text"] for word in selected_words).strip()
    if not text or text.endswith(":") or _is_label_fragment(
        text, excluded_labels
    ):
        return None
    return {
        "text": text,
        "words": selected_words,
        "x0": min(word["x0"] for word in selected_words),
        "x1": max(word["x1"] for word in selected_words),
        "confidence": sum(
            word.get("confidence", 1.0) for word in selected_words
        ) / len(selected_words),
    }


def _is_field_instruction(text):
    return bool(
        re.search(
            r"\b(?:do not use|please|enter|provide|use only|must|should)\b",
            text,
            re.IGNORECASE,
        )
    )


def _looks_like_prose(text):
    # Instruction/template runs ("claimed exemption from tax as a nonresident
    # treaty article addressing the income.") are never field values on these
    # documents; real values (names, short addresses, countries, IDs) are
    # concise. Reject long multi-word runs. We deliberately avoid a
    # sentence-termination heuristic because addresses contain abbreviations
    # such as "St. Dona" that are legitimate values, not prose.
    if not text:
        return False
    compact = re.sub(r"\s+", " ", text).strip()
    if len(compact) > 120:
        return True
    return len(compact.split()) >= 10


def _is_parenthetical_label_hint(text):
    if not text.lstrip().startswith("("):
        return False
    return ")" not in text or bool(
        re.search(
            r"\b(?:street|apt\.?|suite|rural route|p\.?o\.? box)\b",
            text,
            re.IGNORECASE,
        )
    )


def _associate_label_value(
    rows,
    label_match,
    all_label_matches,
    excluded_labels,
    page_width,
    minimum_similarity=0.82,
):
    label_row = rows[label_match["labelEndRowIndex"]]
    same_row_peers = [
        match
        for match in all_label_matches
        if match is not label_match
        and match["rowIndex"] <= label_match["labelEndRowIndex"]
        and match["labelEndRowIndex"] >= label_match["rowIndex"]
    ]

    label_row_columns = _row_columns(label_row)
    for column_start, column_end in label_row_columns:
        column_words = label_row["words"][column_start:column_end]
        if not column_words:
            continue
        column_x0 = min(word["x0"] for word in column_words)
        column_x1 = max(word["x1"] for word in column_words)
        if column_x0 >= label_match["x0"] and column_x0 < label_match["x1"]:
            continue
        for row_index in range(label_match["labelEndRowIndex"] + 1, len(rows)):
            row = rows[row_index]
            if row["y0"] - label_match["y1"] > max(
                80.0, label_row["height"] * 8
            ):
                break
            aligned_words = [
                word
                for word in row["words"]
                if column_x0 - 20
                <= (word["x0"] + word["x1"]) / 2
                <= column_x1 + 20
            ]
            if aligned_words:
                same_row_peers.append(
                    {
                        "rowIndex": label_match["rowIndex"],
                        "labelEndRowIndex": label_match["labelEndRowIndex"],
                        "x0": column_x0,
                        "x1": column_x1,
                    }
                )
                break

    same_row_peers = [
        match
        for match in same_row_peers
        if match["x1"] < label_match["x0"] + 2
        or match["x0"] > label_match["x1"] - 2
    ]
    left_peers = [
        match for match in same_row_peers if match["x1"] <= label_match["x0"] + 2
    ]
    right_peers = [
        match for match in same_row_peers if match["x0"] >= label_match["x1"] - 2
    ]
    left_bound = (
        (
            max(left_peers, key=lambda item: item["x1"])["x1"]
            + label_match["x0"]
        )
        / 2
        if left_peers
        else max(0.0, label_match["x0"] - 24)
    )
    right_bound = (
        (
            label_match["x1"]
            + min(right_peers, key=lambda item: item["x0"])["x0"]
        )
        / 2
        if right_peers
        else min(page_width, label_match["x1"] + max(140.0, page_width * 0.35))
    )

    next_label_x = min((peer["x0"]
                       for peer in right_peers), default=right_bound)
    same_row_words = [
        word
        for word in label_row["words"][label_match["endInRow"]:]
        if label_match["x1"] <= word["x0"] and word["x1"] <= next_label_x
    ]
    same_row_text = " ".join(word["text"] for word in same_row_words).strip()
    parenthetical_hint_continues = (
        _is_parenthetical_label_hint(same_row_text)
        and same_row_text.count("(") > same_row_text.count(")")
    )
    if (
        same_row_words
        and not _contains_known_label(
            same_row_words, excluded_labels, minimum_similarity
        )
        and not _is_parenthetical_label_hint(same_row_text)
        and not _is_field_instruction(same_row_text)
        and not _looks_like_prose(same_row_text)
        and not _is_label_fragment(same_row_text, excluded_labels)
    ):
        candidate_text = same_row_text
        if candidate_text and not candidate_text.endswith(":"):
            horizontal_distance = max(
                0.0, same_row_words[0]["x0"] - label_match["x1"]
            )
            spatial_confidence = 1 / (
                1
                + horizontal_distance / max(page_width * 0.5, 1)
            )
            return {
                "text": candidate_text,
                "confidence": min(
                    label_match["similarity"],
                    label_match["confidence"],
                    sum(
                        word.get("confidence", 1.0) for word in same_row_words
                    ) / len(same_row_words),
                    spatial_confidence,
                ),
                "verticalDistance": 0.0,
                "horizontalDistance": horizontal_distance,
                "evidence": label_row["text"],
            }

    candidates = []
    for row_index in range(label_match["labelEndRowIndex"] + 1, len(rows)):
        row = rows[row_index]
        vertical_distance = max(0.0, row["y0"] - label_match["y1"])
        if vertical_distance > max(80.0, label_row["height"] * 8):
            break
        candidate = _row_candidate_text(
            row, left_bound, right_bound, excluded_labels, minimum_similarity
        )
        if candidate is None:
            continue
        if parenthetical_hint_continues:
            if ")" in candidate["text"]:
                parenthetical_hint_continues = False
            continue
        if _is_field_instruction(candidate["text"]) or _looks_like_prose(
            candidate["text"]
        ):
            continue
        candidate_center = (candidate["x0"] + candidate["x1"]) / 2
        label_center = (label_match["x0"] + label_match["x1"]) / 2
        candidates.append(
            {
                **candidate,
                "verticalDistance": vertical_distance,
                "horizontalDistance": abs(candidate_center - label_center),
                "rowIndex": row_index,
            }
        )
        if len(candidates) > 1:
            break

    if not candidates:
        return None
    candidates.sort(
        key=lambda item: (
            item["verticalDistance"] / max(label_row["height"], 1.0)
            + item["horizontalDistance"] / max(page_width * 0.15, 1.0)
            - item["confidence"] * 0.25
        )
    )
    best = candidates[0]
    spatial_confidence = 1 / (
        1
        + best["verticalDistance"] / max(label_row["height"] * 8, 1)
        + best["horizontalDistance"] / max(page_width * 0.5, 1)
    )
    selected_rows = [best]
    previous_row_index = best["rowIndex"]
    for row_index in range(previous_row_index + 1, min(previous_row_index + 3, len(rows))):
        row = rows[row_index]
        gap = row["y0"] - rows[row_index - 1]["y1"]
        if gap > max(24.0, label_row["height"] * 2.5):
            break
        continuation = _row_candidate_text(
            row, left_bound, right_bound, excluded_labels, minimum_similarity
        )
        if continuation is None:
            break
        selected_rows.append(continuation)
    evidence_rows = rows[
        max(0, label_match["rowIndex"] - 1):
        best["rowIndex"] + len(selected_rows) + 1
    ]
    return {
        "text": "\n".join(item["text"] for item in selected_rows),
        "confidence": min(
            label_match["similarity"],
            label_match["confidence"],
            sum(item["confidence"]
                for item in selected_rows) / len(selected_rows),
            spatial_confidence,
        ),
        "verticalDistance": best["verticalDistance"],
        "horizontalDistance": best["horizontalDistance"],
        "evidence": "\n".join(row["text"] for row in evidence_rows),
    }


def _build_text_index(pages, labels, minimum_similarity=0.82):
    index = []
    full_text_parts = []
    for page in pages:
        rows = _group_words_into_rows(page.get("words", []))
        index.append(
            {
                "page": page,
                "rows": rows,
                "labelMatches": (
                    _find_label_matches(rows, labels, minimum_similarity)
                    if rows
                    else []
                ),
            }
        )
        full_text_parts.append(page["rawText"])
    return index, "\n".join(full_text_parts)


def _token_similarity(left_tokens, right_tokens):
    if not left_tokens or not right_tokens:
        return 0.0
    sequence_similarity = SequenceMatcher(
        None, left_tokens, right_tokens, autojunk=False
    ).ratio()
    coverage = min(len(left_tokens), len(right_tokens)) / max(
        len(left_tokens), len(right_tokens)
    )
    return sequence_similarity * coverage


def _clean_widget_name(name):
    # Drop indexing noise such as "[0]", ".Page1", "topmostSubform" and trailing
    # digit rungs so descriptive names like "First Name" or "Routing Number 1"
    # normalize to comparable token sequences.
    cleaned = re.sub(r"\[\d*\]", " ", name)
    cleaned = re.sub(r"(topmostsubform|page\d*|subform\d*)",
                     " ", cleaned, flags=re.IGNORECASE)
    return cleaned


def _widget_fragment_parent(name):
    # Sibling fragments of one split field share a parent path prefix, e.g.
    # '...EmployerID[0].f1_14[0]' / '...EmployerID[0].f1_15[0]'. Only merge
    # when that parent is a descriptive segment (EmployerID, AccountNumber);
    # generic structural segments (Page1, topmostSubform, Step1a) hold many
    # distinct sibling fields and must never be stitched together.
    if "." not in name:
        return ""
    parent = name.rsplit(".", 1)[0]
    segment = parent.rsplit("[", 1)[0]
    leaf = segment.rsplit(".", 1)[-1]
    if len(leaf) < 4 or re.fullmatch(r"[a-z]\d*_?\d*", leaf):
        return ""
    if re.fullmatch(
        r"(?i)(page\d*|topmostsubform|subform\d*|step\d*[a-z]?|form\d*|_?field\d*)",
        leaf,
    ):
        return ""
    return parent


def _merge_widget_fragments(collected):
    """Join adjacent same-row fragments that share an explicit parent segment."""
    merged = []
    used = set()
    ordered = sorted(
        collected, key=lambda item: (
            item["pageNumber"], item["y0"], item["x0"])
    )
    for index, widget in enumerate(ordered):
        if index in used:
            continue
        parent = _widget_fragment_parent(widget["name"])
        group = [widget]
        if parent:
            for other_index in range(index + 1, len(ordered)):
                if other_index in used:
                    continue
                other = ordered[other_index]
                if (
                    other["pageNumber"] != widget["pageNumber"]
                    or _widget_fragment_parent(other["name"]) != parent
                    or other["y0"] > widget["y1"]
                    or other["y1"] < widget["y0"]
                    or other["x0"] - group[-1]["x1"] > 15
                ):
                    continue
                group.append(other)
                used.add(other_index)
        used.add(index)
        if len(group) > 1:
            combined = "-".join(item["value"] for item in group)
            yield_record = dict(group[0])
            yield_record["value"] = combined
            yield_record["x1"] = group[-1]["x1"]
            yield_record["name"] = group[0]["name"]
            merged.append(yield_record)
        else:
            merged.append(widget)
    return merged


def _collect_form_fields(document, page_indices=None):
    """Read filled AcroForm widget values with their page coordinates.

    Text/combo/list widgets contribute their literal string. Check boxes and
    radio buttons contribute their active on-state export value. Signature and
    empty fields are ignored. Returned records keep the widget bounding box so
    downstream logic can associate a label with the exact value location.
    """
    collected = []
    indices = (
        page_indices
        if page_indices is not None
        else range(document.page_count)
    )
    for page_index in indices:
        page = document.load_page(page_index)
        for widget in page.widgets() or []:
            try:
                kind = widget.field_type_string
                raw_value = widget.field_value
                name = widget.field_name or ""
                rect = widget.rect
            except Exception:
                continue
            text_value = None
            if kind in ("Text", "ComboBox", "ListBox", "PushButton") and isinstance(raw_value, str):
                text_value = raw_value.strip()
            elif kind == "CheckBox":
                if raw_value in (True, 1):
                    states = widget.button_states() or {}
                    on_names = [str(item) for item in states.get(
                        "on", ()) if str(item).lower() != "off"]
                    text_value = on_names[0] if on_names else "Yes"
                elif isinstance(raw_value, str) and raw_value not in ("", "Off"):
                    text_value = raw_value.strip()
            elif kind == "RadioButton":
                if isinstance(raw_value, str) and raw_value not in ("", "Off"):
                    text_value = raw_value.strip()
            if not text_value or text_value.casefold() == "off":
                continue
            collected.append(
                {
                    "name": name,
                    "value": text_value,
                    "pageNumber": page_index + 1,
                    "x0": float(rect.x0),
                    "y0": float(rect.y0),
                    "x1": float(rect.x1),
                    "y1": float(rect.y1),
                    "kind": kind,
                }
            )
    return _merge_widget_fragments(collected)


def _match_form_field_by_name(form_fields, field, minimum_similarity):
    validation = field.get("validation", {})
    label_strings = [
        field.get("name", ""),
        field.get("label", ""),
        *field.get("contentRules", {}).get("labels", []),
    ]
    label_sequences = [
        tokens
        for tokens in (
            _normalized_tokens(_clean_widget_name(text))
            for text in label_strings
            if isinstance(text, str) and text.strip()
        )
        if tokens
    ]
    if not label_sequences:
        return None
    best = None
    for widget in form_fields:
        normalized_widget_value = normalize_value(
            widget["value"], field.get("normalization", {})
        )
        if validation and not _validate_value(
            normalized_widget_value, validation
        )[0]:
            # The filled value cannot be this field's value (e.g. a city token
            # inside an SSN/TIN field); never bridge it via name similarity.
            continue
        name_tokens = _normalized_tokens(_clean_widget_name(widget["name"]))
        if not name_tokens:
            continue
        for label_tokens in label_sequences:
            similarity = _token_similarity(label_tokens, name_tokens)
            if similarity < minimum_similarity:
                continue
            confidence = min(1.0, 0.9 + 0.1 * similarity)
            candidate = (
                widget["value"],
                widget["name"],
                f"form field '{widget['name']}' = {widget['value']}",
                widget["pageNumber"],
                "acroform_name",
                round(confidence, 3),
                f"{widget['pageNumber']}|{widget['name']}|{widget['value']}",
            )
            if best is None or candidate[5] > best[5]:
                best = candidate
    return best


def _match_form_field_by_position(
    native_index, form_fields, field, minimum_similarity
):
    """Associate a configured label's on-page position with the nearest filled
    widget value box. Because only real form-field boxes are eligible values,
    this structurally avoids grabbing template/instruction prose. Matches must
    pass a tight distance ceiling and the field's own validation rules, so a
    far-away widget is never grabbed on a weak spatial guess."""
    labels = {
        label
        for label in field.get("contentRules", {}).get("labels", [])
        if isinstance(label, str) and label.strip()
    }
    if not labels:
        return None
    validation = field.get("validation", {})
    best = None
    for page_index, page_entry in enumerate(native_index[0]):
        page = page_entry["page"]
        page_widgets = [
            widget
            for widget in form_fields
            if widget["pageNumber"] == page_index + 1
            and (not validation or _validate_value(
                normalize_value(widget["value"],
                                field.get("normalization", {})),
                validation,
            )[0])
            and _spatial_form_value_is_plausible(field, widget)
        ]
        if not page_widgets:
            continue
        page_height = max(page.get("height", 1.0), 1.0)
        page_width = max(page.get("width", 1.0), 1.0)
        target_matches = [
            match
            for match in page_entry["labelMatches"]
            if match["label"] in labels
        ]
        for label_match in target_matches:
            label_cy = (label_match["y0"] + label_match["y1"]) / 2
            label_height = max(label_match["y1"] - label_match["y0"], 1.0)
            for widget in page_widgets:
                widget_cy = (widget["y0"] + widget["y1"]) / 2
                horizontal_gap = widget["x0"] - label_match["x1"]
                cy_delta = widget_cy - label_cy
                # Fixed line-scale tolerance: a wrapped (tall) label must NOT
                # widen the same-row window, or a widget on the row below gets
                # swallowed as this label's value. ~14pt is one text line.
                same_row = abs(cy_delta) <= 14.0
                x_aligned = abs(widget["x0"] - label_match["x0"]) <= max(
                    60.0, page_width * 0.12
                )
                below = (
                    cy_delta >= 0
                    and x_aligned
                    and cy_delta <= max(40.0, label_height * 4)
                )
                # Same-row and below are evaluated independently (not mutually
                # exclusive): on IRS forms the value box sits on the ruled line
                # just under a left-indented label, so it fails the same-row
                # horizontal test yet is legitimately the label's value. Picking
                # one branch exclusively previously dropped the correct widget
                # and grabbed the next line's field instead.
                distances = []
                if same_row and -page_width * 0.15 <= horizontal_gap <= page_width * 0.45:
                    distances.append(
                        max(0.0, horizontal_gap) / max(page_width, 1.0)
                    )
                if below:
                    distances.append(
                        0.02 + cy_delta / max(page_height, 1.0)
                    )
                if not distances:
                    continue
                distance = min(distances)
                confidence = max(0.0, 0.95 * (1 / (1 + distance * 6)))
                if confidence < 0.34:
                    continue
                candidate = (
                    widget["value"],
                    label_match["label"],
                    f"{label_match['text']} -> {widget['value']}",
                    widget["pageNumber"],
                    "acroform_field",
                    round(confidence, 3),
                    f"{widget['pageNumber']}|{widget['name']}|{widget['value']}",
                )
                if best is None or candidate[5] > best[5]:
                    best = candidate
    return best


def _match_form_field_by_pattern(form_fields, field):
    """Apply the field's own regex rules directly to filled widget values.

    On numeric government identifiers (SSN/TIN/EIN) the value shape is far more
    diagnostic than on-page position: usually exactly one widget matches, so we
    can take it authoritatively and never grab a nearby address/routing box.
    Ambiguous shape matches (several widgets share the pattern) are skipped so
    layout heuristics can decide instead."""
    patterns = [
        pattern
        for pattern in field.get("contentRules", {}).get("regexPatterns", [])
        if isinstance(pattern, str) and pattern.strip()
    ]
    if not patterns:
        return None
    compiled = []
    for pattern in patterns:
        try:
            compiled.append(re.compile(pattern, re.IGNORECASE))
        except re.error:
            continue
    if not compiled:
        return None
    validation = field.get("validation", {})
    hits = []
    for widget in form_fields:
        value = widget["value"]
        matched = None
        for regex in compiled:
            found = regex.search(value)
            if found:
                try:
                    matched = found.group(1)
                except (IndexError, re.error):
                    matched = found.group(0)
                break
        if not matched:
            continue
        matched = matched.strip()
        normalized = normalize_value(matched, field.get("normalization", {}))
        if validation and not _validate_value(normalized, validation)[0]:
            continue
        hits.append((widget, matched))
    if len(hits) != 1:
        return None
    widget, matched = hits[0]
    return (
        matched,
        widget["name"],
        f"form field value {matched!r} matched the configured pattern",
        widget["pageNumber"],
        "acroform_pattern",
        0.9,
        f"{widget['pageNumber']}|{widget['name']}|{widget['value']}",
    )


def _extract_from_form_fields(form_fields, native_index, field, minimum_similarity):
    if not form_fields or not field.get("contentRules", {}).get("enabled"):
        return None
    name_candidate = _match_form_field_by_name(
        form_fields, field, minimum_similarity)
    position_candidate = _match_form_field_by_position(
        native_index, form_fields, field, minimum_similarity
    )
    pattern_candidate = _match_form_field_by_pattern(form_fields, field)
    candidates = [
        item
        for item in (name_candidate, position_candidate, pattern_candidate)
        if item
    ]
    if not candidates:
        return None

    def rank(item):
        # Descriptive widget-name and unique pattern matches are authoritative
        # and win ties over the purely spatial heuristic.
        structural = item[4] in ("acroform_name", "acroform_pattern")
        return (item[5], structural)

    candidates.sort(key=rank, reverse=True)
    winner = candidates[0]
    # A purely spatial (label->widget geometry) match is the least reliable form
    # signal. If the best we can do is a weak spatial guess, suppress it so
    # native-text, OCR or a clean filename match can win during reconciliation
    # instead of a low-confidence value being treated as authoritative.
    if winner[4] == "acroform_field" and winner[5] < FORM_FIELD_SPATIAL_TRUST:
        return None
    return winner


def _build_ollama_document_context(native_pages, ocr_pages):
    sources_by_page = {}
    for kind, pages in (("native PDF text", native_pages), ("OCR text", ocr_pages)):
        for page in pages:
            rows = _group_words_into_rows(page.get("words", []))
            page_width = max(page.get("width", 1.0), 1.0)
            page_height = max(page.get("height", 1.0), 1.0)
            layout = []
            raw_rows = []
            for row_number, row in enumerate(rows, start=1):
                columns = []
                for column_number, (start, end) in enumerate(
                    _row_columns(row), start=1
                ):
                    words = row["words"][start:end]
                    text = " ".join(word["text"] for word in words)
                    if not text:
                        continue
                    x0 = round(min(word["x0"]
                               for word in words) / page_width * 1000)
                    x1 = round(max(word["x1"]
                               for word in words) / page_width * 1000)
                    columns.append(
                        f"column {column_number} x={x0}-{x1}: {text}")
                if columns:
                    y0 = round(row["y0"] / page_height * 1000)
                    y1 = round(row["y1"] / page_height * 1000)
                    layout.append(
                        f"row {row_number} y={y0}-{y1}: " +
                        " || ".join(columns)
                    )
                    raw_rows.append(row["text"])
            if not rows and page.get("rawText", "").strip():
                raw_rows = [
                    line.strip()
                    for line in page["rawText"].splitlines()
                    if line.strip()
                ]
                layout = [
                    f"row {row_number}: {line}"
                    for row_number, line in enumerate(raw_rows, start=1)
                ]
            source = {
                "kind": kind,
                "text": "\n".join(raw_rows),
                "layout": layout,
            }
            sources_by_page.setdefault(page["pageNumber"], []).append(source)

    return [
        {
            "pageNumber": page_number,
            "sources": sources,
            "layout": [
                f"[{source['kind']}] {line}"
                for source in sources
                for line in source["layout"]
            ],
        }
        for page_number, sources in sorted(sources_by_page.items())
    ]


def _extract_from_text(
    pages,
    field,
    all_labels=None,
    text_index=None,
    minimum_similarity=0.82,
):
    rules = field.get("contentRules", {})
    if not rules.get("enabled"):
        return None, None, None, None, "label_proximity", None
    labels = rules.get("labels", [])
    peer_labels = [
        label for label in (all_labels or labels)
        if isinstance(label, str) and label.strip()
    ]
    excluded_labels = list(dict.fromkeys([*peer_labels, *labels]))
    if text_index is None:
        text_index, full_text = _build_text_index(
            pages, excluded_labels, minimum_similarity
        )
    else:
        full_text = text_index[1]
        text_index = text_index[0]
    spatial_candidates = []
    for label in labels:
        if not isinstance(label, str) or not label.strip():
            continue
        for indexed_page in text_index:
            page = indexed_page["page"]
            rows = indexed_page["rows"]
            if not rows:
                continue
            target_matches = [
                match
                for match in indexed_page["labelMatches"]
                if match["label"] == label
            ]
            all_label_matches = indexed_page["labelMatches"]
            for label_match in target_matches:
                association = _associate_label_value(
                    rows,
                    label_match,
                    all_label_matches,
                    excluded_labels,
                    page.get(
                        "width",
                        max(word["x1"] for word in page.get("words", [])),
                    ),
                    minimum_similarity,
                )
                if association:
                    spatial_candidates.append(
                        {
                            **association,
                            "label": label_match["label"],
                            "pageNumber": page["pageNumber"],
                        }
                    )

    if spatial_candidates:
        # Continuation merging can stitch several short instruction lines into
        # one long prose run; drop those before trusting any spatial pick.
        spatial_candidates = [
            item for item in spatial_candidates
            if not _looks_like_prose(item["text"])
        ]
    if spatial_candidates and _infer_value_type(field) == "us_ssn":
        # A spatial pick often spans the whole address/instruction line. Keep
        # only a substring that actually satisfies the field's own validation
        # so "Gateshead Dr" and template prose never reach reconciliation.
        trimmed_candidates = []
        for item in spatial_candidates:
            trimmed_value = _ssn_value_from_text(field, item["text"])
            if trimmed_value:
                trimmed_candidates.append({**item, "text": trimmed_value})
        spatial_candidates = trimmed_candidates
    if spatial_candidates:
        # The value must also be semantically able to fill its field: a date is
        # never a person's name and a one-word city/country grab is never a
        # street address, however good the geometry looks. Same veto the
        # AcroForm spatial matcher applies, extended to the text layer.
        spatial_candidates = [
            item for item in spatial_candidates
            if _spatial_form_value_is_plausible(
                field, {"name": "", "value": item["text"]}
            )
        ]
    if spatial_candidates:
        spatial_candidates.sort(
            key=lambda item: (
                item["verticalDistance"] / 12
                + item["horizontalDistance"] / 100
                - item["confidence"]
            )
        )
        best = spatial_candidates[0]
        if len(spatial_candidates) > 1:
            first_score = (
                best["verticalDistance"] / 12
                + best["horizontalDistance"] / 100
                - best["confidence"]
            )
            next_candidate = spatial_candidates[1]
            next_score = (
                next_candidate["verticalDistance"] / 12
                + next_candidate["horizontalDistance"] / 100
                - next_candidate["confidence"]
            )
            if (
                abs(next_score - first_score) < 0.05
                and next_candidate["text"] != best["text"]
            ):
                return (
                    None,
                    best["label"],
                    best["evidence"],
                    best["pageNumber"],
                    "layout_aware",
                    0.0,
                )
        return (
            best["text"],
            best["label"],
            best["evidence"],
            best["pageNumber"],
            "layout_aware",
            round(best["confidence"], 3),
        )
    for pattern in rules.get("regexPatterns", []):
        try:
            match = re.search(pattern, full_text, re.IGNORECASE)
        except re.error:
            continue
        if match:
            group = rules.get("captureGroup", 1)
            try:
                value = match.group(group)
            except IndexError:
                value = match.group(0)
            if value and value.strip():
                return (
                    value.strip(),
                    pattern,
                    match.group(0),
                    None,
                    "regex_content",
                    None,
                )
    return None, None, None, None, "layout_aware", None


def _score_text_candidate(candidate, field):
    if not candidate:
        return None
    value = candidate[0]
    if not isinstance(value, str) or not value.strip():
        return None
    confidence = candidate[5]
    if not isinstance(confidence, (int, float)) or not math.isfinite(confidence):
        confidence = 0.5
    confidence = min(1.0, max(0.0, float(confidence)))
    normalized = normalize_value(value, field.get("normalization", {}))
    valid, _ = _validate_value(normalized, field.get("validation", {}))
    score = confidence * 0.75 + (0.25 if valid else 0.0)
    return round(score, 3)


def _choose_content_candidate(
    native_candidate,
    ocr_candidate,
    field,
    form_candidate=None,
    ocr_space_candidate=None,
    ocr_space_priority="after_ocr",
):
    candidates = []
    for source, candidate in (
        ("form_field", form_candidate),
        ("pdf_text", native_candidate),
        ("ocr", ocr_candidate),
        ("ocr_space", ocr_space_candidate),
    ):
        score = _score_text_candidate(candidate, field)
        if score is not None:
            candidates.append(
                {"source": source, "candidate": candidate, "score": score}
            )
    # OCR.space is a cloud fallback whose position relative to local Tesseract
    # is decided by priority so the two never compete for the same field:
    # "after_ocr" keeps Tesseract, "before_ocr" keeps OCR.space, "override"
    # lets both compete on evidence score.
    has_ocr = any(item["source"] == "ocr" for item in candidates)
    has_ocr_space = any(item["source"] == "ocr_space" for item in candidates)
    if has_ocr and has_ocr_space:
        if ocr_space_priority == "after_ocr":
            candidates = [
                item for item in candidates if item["source"] != "ocr_space"
            ]
        elif ocr_space_priority == "before_ocr":
            candidates = [
                item for item in candidates if item["source"] != "ocr"
            ]
    if not candidates:
        return None, False, "No native-text, form-field, or OCR candidate was found."
    if len(candidates) == 1:
        selected = candidates[0]
        return selected, False, f"Only the {selected['source']} candidate was available."

    normalized_values = {
        normalize_value(
            item["candidate"][0], field.get("normalization", {})
        ).casefold()
        for item in candidates
    }
    candidates.sort(key=lambda item: item["score"], reverse=True)
    if len(normalized_values) == 1:
        return candidates[0], False, "Document-text, form-field, and OCR candidates agree."
    # A grounded AcroForm value reflects exactly what was filled into the form,
    # so it is authoritative and preferred over conflicting layout guesses.
    form_candidates = [
        item for item in candidates if item["source"] == "form_field"
    ]
    if form_candidates:
        return (
            form_candidates[0],
            False,
            "Selected the filled form-field value for this label.",
        )
    if candidates[0]["score"] - candidates[1]["score"] < 0.03:
        return (
            None,
            True,
            "Native-text and OCR candidates conflict with similar evidence scores.",
        )
    return (
        candidates[0],
        False,
        f"Selected the {candidates[0]['source']} candidate with the stronger evidence score.",
    )


def _needs_selective_ai_review(field, native_candidate, ocr_candidate, filename_value):
    content_candidate, ambiguous, _ = _choose_content_candidate(
        native_candidate, ocr_candidate, field
    )
    candidates = [
        candidate[0]
        for candidate in (native_candidate, ocr_candidate)
        if candidate and candidate[0]
    ]
    if filename_value:
        candidates.append(filename_value)
    if not candidates or ambiguous:
        return True

    normalized_values = {
        normalize_value(value, field.get("normalization", {})).casefold()
        for value in candidates
    }
    if len(normalized_values) > 1:
        return True
    if any(
        not _validate_value(
            normalize_value(value, field.get("normalization", {})),
            field.get("validation", {}),
        )[0]
        for value in candidates
    ):
        return True

    if content_candidate:
        return (
            content_candidate["score"]
            < SELECTIVE_AI_REVIEW_SCORE_THRESHOLD
        )
    return False


def _field_needs_ai_review(
    field, native_candidate, ocr_candidate, filename_value, form_candidate
):
    """Return True only when no trustworthy conventional source already answers
    the field.

    A validated AcroForm value is exactly what the signer typed, and a confirmed
    filename match for a ``filename_first`` field is equally deterministic; the
    per-document Ollama call cannot do better than either, so it is skipped
    entirely on clean fillable forms. This is the AI-fallback gate: it removes
    the dominant latency sink (one LLM request per document) for the majority of
    documents that resolve confidently through conventional sources, while still
    sending genuinely uncertain / missing / conflicting fields to the model.
    """
    normalization = field.get("normalization", {})
    validation = field.get("validation", {})

    def _valid(value):
        if not isinstance(value, str) or not value.strip():
            return False
        return _validate_value(normalize_value(value, normalization), validation)[0]

    # Authoritative filled-form value passes validation -> ground truth, no AI.
    if form_candidate and _valid(form_candidate[0]):
        return False
    # Single-source filename field with a valid match -> deterministic, no AI.
    if field.get("priority") == "filename_first" and _valid(filename_value):
        return False
    # Otherwise fall back to the existing selective-review heuristic.
    return _needs_selective_ai_review(
        field, native_candidate, ocr_candidate, filename_value
    )


def process_pdf(pdf_bytes, filename, profile):
    total_started = time.perf_counter()
    timings = {
        "pdf_loading_ms": 0.0,
        "native_text_extraction_ms": 0.0,
        "text_parsing_ms": 0.0,
        "pdf_rendering_ms": 0.0,
        "ocr_execution_ms": 0.0,
        "ocr_space_execution_ms": 0.0,
        "ollama_model_check_ms": 0.0,
        "ollama_request_ms": 0.0,
        "ollama_queue_ms": 0.0,
        "ollama_attempt_ms": 0.0,
        "form_field_extraction_ms": 0.0,
        "field_extraction_ms": 0.0,
    }
    loading_started = time.perf_counter()
    try:
        document = fitz.open(stream=pdf_bytes, filetype="pdf")
    except (fitz.FileDataError, RuntimeError) as exc:
        raise ValidationError(
            "The PDF could not be opened; it may be encrypted or corrupted."
        ) from exc
    timings["pdf_loading_ms"] = round(
        (time.perf_counter() - loading_started) * 1000, 3
    )
    with document:
        if document.is_encrypted:
            raise ValidationError(
                "Password-protected PDF files are not supported.")
        if document.page_count > settings.MAX_PDF_PAGES:
            raise ValidationError("The PDF exceeds the configured page limit.")

        extraction_settings = profile.get("extractionSettings", {})
        if not isinstance(extraction_settings, dict):
            extraction_settings = {}
        # Multi-page government forms (e.g. a W-9 followed by IRS instruction
        # pages) keep all answers on page 1; later pages otherwise supply
        # instruction prose that label matching can mistake for values.
        first_page_only = extraction_settings.get("firstPageOnly") is True
        selected_page_indices = (
            [0]
            if first_page_only and document.page_count
            else list(range(document.page_count))
        )

        native_started = time.perf_counter()
        page_count, pages = _pdf_document_pages(
            document, selected_page_indices)
        native_text = "\n\n".join(page["rawText"] for page in pages)
        native_length = len(re.sub(r"\s+", "", native_text))
        timings["native_text_extraction_ms"] = round(
            (time.perf_counter() - native_started) * 1000, 3
        )

        fields = [
            _normalize_field_config(field)
            for field in profile.get("fields", [])
        ]
        label_similarity_threshold = _label_similarity_threshold(
            extraction_settings
        )
        all_labels = [
            label
            for item in fields
            for label in item.get("contentRules", {}).get("labels", [])
            if isinstance(label, str)
        ]
        parsing_started = time.perf_counter()
        native_index = _build_text_index(
            pages, all_labels, label_similarity_threshold
        )
        timings["text_parsing_ms"] += round(
            (time.perf_counter() - parsing_started) * 1000, 3
        )

        # AcroForm field values are the most reliable signal on filled
        # government/HR forms; read them before the layout heuristics so they
        # can dominate reconciliation.
        form_started = time.perf_counter()
        form_fields = _collect_form_fields(document, selected_page_indices)
        form_results = {}
        if form_fields:
            for field in fields:
                form_results[field["id"]] = _extract_from_form_fields(
                    form_fields,
                    native_index,
                    field,
                    label_similarity_threshold,
                )
            # A widget can only hold one field's value; two labels claiming
            # the same widget means at least one is a spatial mis-grab.
            _drop_duplicate_form_widgets(form_results)
        timings["form_field_extraction_ms"] = round(
            (time.perf_counter() - form_started) * 1000, 3
        )
        timings["form_field_count"] = len(form_fields)

        field_extraction_started = time.perf_counter()
        native_results = {}
        for field in fields:
            native_results[field["id"]] = _extract_from_text(
                pages,
                field,
                all_labels,
                native_index,
                label_similarity_threshold,
            )
        timings["field_extraction_ms"] += round(
            (time.perf_counter() - field_extraction_started) * 1000, 3
        )

        ocr_pages = []
        ocr_index = None
        ocr_error = ""
        ocr_settings = profile.get("ocrSettings", {})
        threshold = ocr_settings.get("minTextLengthThreshold", 40)
        missing_content_fields = [
            field
            for field in fields
            if field.get("contentRules", {}).get("enabled")
            and not native_results[field["id"]][0]
        ]
        ocr_page_indices, ocr_page_selection = _select_ocr_page_indices(
            document,
            pages,
            threshold,
            missing_content_fields,
            (
                settings.OCR_ENABLED
                and ocr_settings.get("enabledFallback") is True
                and ocr_settings.get("autoDetectScanned") is True
            ),
            native_index,
        )
        should_ocr = (
            settings.OCR_ENABLED
            and ocr_settings.get("enabledFallback")
            and bool(ocr_page_selection["should_ocr"])
        )
        timings.update(
            {
                "page_count": page_count,
                "pages_extracted": len(pages),
                "page_scope": "first" if first_page_only else "all",
                "ocr_pages_considered": len(pages),
                "ocr_pages_selected": len(ocr_page_indices) if should_ocr else 0,
                "ocr_page_numbers": (
                    [index + 1 for index in ocr_page_indices] if should_ocr else []
                ),
                "ocr_sparse_page_count": ocr_page_selection["sparse_page_count"],
                "ocr_image_page_count": ocr_page_selection["image_page_count"],
                "ocr_missing_label_page_count": ocr_page_selection[
                    "missing_label_page_count"
                ],
                "ocr_full_document_fallback": ocr_page_selection[
                    "fallback_to_all_pages"
                ],
            }
        )
        if should_ocr:
            try:
                ocr_pages = _ocr_pdf(
                    pdf_bytes,
                    ocr_settings.get("language", "eng"),
                    page_count,
                    document=document,
                    page_indices=ocr_page_indices,
                    timings=timings,
                    render_scale=(
                        3.0 if ocr_settings.get("quality") == "high" else 2.0
                    ),
                )
                parsing_started = time.perf_counter()
                ocr_index = _build_text_index(
                    ocr_pages, all_labels, label_similarity_threshold
                )
                timings["text_parsing_ms"] += round(
                    (time.perf_counter() - parsing_started) * 1000, 3
                )
            except pytesseract.TesseractNotFoundError:
                ocr_error = "Tesseract OCR is enabled for this profile but is not installed or configured."
            except pytesseract.TesseractError as exc:
                ocr_error = f"OCR failed: {exc}"

        # Opt-in OCR.space cloud fallback. Runs only when enabled and a key is
        # present, over the same page set local OCR deemed worth reading, and is
        # fully fail-open: any remote error is logged and swallowed so the job
        # continues with the native/Tesseract candidates already gathered.
        ocr_space_pages = []
        ocr_space_index = None
        ocr_space_error = ""
        should_ocr_space = (
            settings.OCR_SPACE_ENABLED
            and bool(settings.OCR_SPACE_API_KEY)
            and bool(ocr_page_indices)
        )
        timings["ocr_space_pages_selected"] = (
            len(ocr_page_indices) if should_ocr_space else 0
        )
        if should_ocr_space:
            try:
                ocr_space_pages = _ocr_pdf_ocrspace(
                    pdf_bytes,
                    ocr_settings.get("language", "eng"),
                    document=document,
                    page_indices=ocr_page_indices,
                    timings=timings,
                    render_scale=(
                        3.0 if ocr_settings.get("quality") == "high" else 2.0
                    ),
                )
                parsing_started = time.perf_counter()
                ocr_space_index = _build_text_index(
                    ocr_space_pages, all_labels, label_similarity_threshold
                )
                timings["text_parsing_ms"] += round(
                    (time.perf_counter() - parsing_started) * 1000, 3
                )
            except Exception as exc:  # noqa: BLE001 - fail-open cloud fallback
                ocr_space_pages = []
                ocr_space_index = None
                ocr_space_error = str(exc)
                logger.warning(
                    "OCR.space fallback failed; continuing without remote OCR: %s",
                    exc,
                )

        ai_settings = profile.get("aiSettings", {})
        if not isinstance(ai_settings, dict):
            ai_settings = {}
        ocr_results = {}
        if ocr_pages and ocr_index is not None:
            for field in fields:
                if field.get("contentRules", {}).get("enabled"):
                    ocr_results[field["id"]] = _extract_from_text(
                        ocr_pages,
                        field,
                        all_labels,
                        ocr_index,
                        label_similarity_threshold,
                    )
        ocr_space_results = {}
        if ocr_space_pages and ocr_space_index is not None:
            for field in fields:
                if field.get("contentRules", {}).get("enabled"):
                    ocr_space_results[field["id"]] = _extract_from_text(
                        ocr_space_pages,
                        field,
                        all_labels,
                        ocr_space_index,
                        label_similarity_threshold,
                    )
        ai_values = {}
        ai_error = ""
        if ai_settings.get("enabled") is True:
            ai_strategy = ai_settings.get("strategy", "review")
            ai_fields = [
                field
                for field in fields
                if field.get("contentRules", {}).get("enabled")
                and (
                    # Both "review" and "selective" now run the AI pass only on
                    # fields that no conventional source answered confidently.
                    (
                        ai_strategy in ("review", "selective")
                        and _field_needs_ai_review(
                            field,
                            native_results[field["id"]],
                            ocr_results.get(field["id"]),
                            _extract_from_filename(filename, field)[0],
                            form_results.get(field["id"]),
                        )
                    )
                    or (
                        ai_strategy not in ("review", "selective")
                        and not native_results[field["id"]][0]
                        and not ocr_results.get(field["id"], (None,))[0]
                        and not _extract_from_filename(filename, field)[0]
                        and not (form_results.get(field["id"]) or [None])[0]
                    )
                )
            ]
            if ai_fields:
                ai_started = time.perf_counter()
                try:
                    ai_values, ai_metrics = extract_with_ollama(
                        ai_settings,
                        ai_fields,
                        _build_ollama_document_context(pages, ocr_pages),
                    )
                    timings.update(ai_metrics)
                except (RuntimeError, ValidationError, TypeError, ValueError) as exc:
                    ai_error = str(exc)
                finally:
                    timings["ollama_attempt_ms"] = round(
                        (time.perf_counter() - ai_started) * 1000, 3
                    )

        field_extraction_started = time.perf_counter()
        diagnostics = {}
        values = {}
        used_ocr = False
        used_ai = False
        for field in fields:
            field_id = field["id"]
            filename_value, matched_pattern = _extract_from_filename(
                filename, field)
            native_candidate = native_results[field_id]
            ocr_candidate = ocr_results.get(field_id)
            ocr_space_candidate = ocr_space_results.get(field_id)
            form_candidate = form_results.get(field_id)
            pdf_value = native_candidate[0]
            ocr_value = ocr_candidate[0] if ocr_candidate else None
            ocr_space_value = (
                ocr_space_candidate[0] if ocr_space_candidate else None
            )
            form_value = form_candidate[0] if form_candidate else None
            content_candidate, content_ambiguous, selection_reason = (
                _choose_content_candidate(
                    native_candidate,
                    ocr_candidate,
                    field,
                    form_candidate,
                    ocr_space_candidate,
                    settings.OCR_SPACE_PRIORITY,
                )
            )
            priority = field.get("priority", "pdf_first")
            priority_conflict = False
            selected_source = None
            selected_candidate = None
            if filename_value and priority == "filename_first":
                selected_source = "filename"
                selection_reason = "The field's filename-first priority selected the filename value."
            elif filename_value and priority in ("strict_match", "consensus"):
                comparable_candidates = [
                    candidate
                    for candidate in (
                        native_candidate,
                        ocr_candidate,
                        ocr_space_candidate,
                        form_candidate,
                    )
                    if candidate and candidate[0]
                ]
                normalized_filename = normalize_value(
                    filename_value, field.get("normalization", {})
                ).casefold()
                priority_conflict = any(
                    normalize_value(
                        candidate[0], field.get("normalization", {})
                    ).casefold()
                    != normalized_filename
                    for candidate in comparable_candidates
                )
                if priority_conflict:
                    selection_reason = (
                        f"The field's {priority} priority rejected conflicting filename and document candidates."
                    )
                elif content_candidate:
                    selected_source = content_candidate["source"]
                    selected_candidate = content_candidate["candidate"]
                else:
                    selected_source = "filename"
            elif content_candidate:
                selected_source = content_candidate["source"]
                selected_candidate = content_candidate["candidate"]
            elif filename_value and not content_ambiguous:
                selected_source = "filename"

            if selected_candidate:
                matched_label = selected_candidate[1]
                evidence = selected_candidate[2]
                page_number = selected_candidate[3]
                method = selected_candidate[4]
            else:
                matched_label = None
                evidence = None
                page_number = None
                method = "layout_aware"
            selection_ambiguous = content_ambiguous and not (
                filename_value and priority == "filename_first"
            )

            ai_candidate = ai_values.get(field_id)
            ai_value = ai_candidate["value"] if ai_candidate else None
            ai_evidence = ai_candidate["evidence"] if ai_candidate else None
            ai_page_number = (
                ai_candidate["pageNumber"] if ai_candidate else None
            )
            ai_comparison_value = normalize_value(
                ai_value or "", field.get("normalization", {})
            )
            # When an authoritative form-field value exists, compare it only
            # against the filename value; a low-quality native/OCR layout guess
            # should not manufacture a conflict against a filled form field.
            if form_value:
                conventional_pool = (form_value, filename_value)
            else:
                conventional_pool = (
                    pdf_value,
                    ocr_value,
                    ocr_space_value,
                    filename_value,
                )
            conventional_values = [
                value
                for value in conventional_pool
                if isinstance(value, str) and value.strip()
            ]
            normalized_conventional_values = {
                normalize_value(value, field.get(
                    "normalization", {})).casefold()
                for value in conventional_values
            }
            ai_conflict = bool(
                ai_comparison_value
                and normalized_conventional_values
                and ai_comparison_value.casefold()
                not in normalized_conventional_values
            )
            conflict = len(normalized_conventional_values) > 1 or ai_conflict
            raw_value = (
                filename_value
                if selected_source == "filename"
                else selected_candidate[0]
                if selected_candidate
                else ai_value
                if not selection_ambiguous and not priority_conflict
                else ""
            )
            if selection_ambiguous or priority_conflict:
                raw_value = ""
            value = normalize_value(raw_value, field.get("normalization", {}))
            passed, validation_error = _validate_value(
                value, field.get("validation", {}))
            pdf_candidate_score = _score_text_candidate(
                native_candidate, field
            )
            ocr_candidate_score = _score_text_candidate(
                ocr_candidate, field
            )
            form_candidate_score = _score_text_candidate(
                form_candidate, field
            )
            ocr_space_candidate_score = _score_text_candidate(
                ocr_space_candidate, field
            )
            source = (
                "manual"
                if not raw_value
                else selected_source
                if selected_source
                else "ai"
            )
            used_ocr = used_ocr or source in ("ocr", "ocr_space")
            used_ai = used_ai or source == "ai"
            status = (
                "AMBIGUOUS"
                if selection_ambiguous
                else "MISMATCH"
                if conflict or priority_conflict
                else "NOT_FOUND"
                if not value
                else "MATCHED"
            )
            if value and source == "ocr" and not conflict:
                status = "OCR_EXTRACTED"
            if value and source == "ocr_space" and not conflict:
                # Per-field diagnostic badge only; the document-level enum stays
                # OCR_EXTRACTED (via used_ocr) so no model migration is needed.
                status = "OCR_SPACE_EXTRACTED"
            if value and source == "ai" and not conflict:
                status = "AI_EXTRACTED"
            if value and status == "MATCHED" and source == "filename":
                # Filename-only matches have no document-side corroboration at
                # all; they must never wear the same badge as a form-verified
                # value (the old 'MATCHED @ 0% evidence' false positives).
                status = "FILENAME_ONLY"
            if value and not passed:
                status = "INVALID"
            review_required = (
                (field.get("required", False) and not value)
                or conflict
                or ai_conflict
                or selection_ambiguous
                or priority_conflict
                or not passed
                or source == "ai"
            )
            extraction_errors = [
                error for error in (ocr_error, ai_error) if error
            ]
            explanation = (
                " ".join(extraction_errors) if not value and extraction_errors else
                "Extracted by Ollama; verify this value." if source == "ai" else
                "Ollama disagrees with a conventional candidate; verify both candidates." if ai_conflict else
                validation_error if validation_error else
                "Sources disagree; verify the selected value." if conflict else
                "Filename rule supplied this value; no document-side candidate existed to cross-check it." if status == "FILENAME_ONLY" else
                "Value extracted and validated." if value else
                "No matching value was found."
            )
            diagnostic = {
                "fieldId": field_id,
                "fieldName": field.get("name", field_id),
                "status": status,
                "filenameValue": filename_value,
                "pdfValue": pdf_value,
                "ocrValue": ocr_value,
                "ocrSpaceValue": ocr_space_value,
                "formValue": form_value,
                "aiValue": ai_value,
                "aiEvidence": ai_evidence,
                "aiSourceKind": (
                    ai_candidate.get("sourceKind") if ai_candidate else None
                ),
                "finalValue": value,
                "source": source,
                "method": (
                    "regex_filename" if source == "filename"
                    else "ollama_llm" if source == "ai"
                    else method
                ),
                "matchedPatternOrLabel": (
                    matched_pattern if source == "filename"
                    else "Ollama" if source == "ai"
                    else matched_label
                ),
                "validationPassed": passed,
                "validationError": validation_error,
                "confidenceScore": (
                    content_candidate["score"]
                    if selected_candidate and content_candidate
                    else 0.0
                    if selection_ambiguous
                    or priority_conflict
                    or (
                        not selected_source
                        and native_candidate[5] == 0.0
                    )
                    else None
                ),
                "pdfConfidenceScore": native_candidate[5],
                "ocrConfidenceScore": (
                    ocr_candidate[5] if ocr_candidate else None
                ),
                "ocrSpaceConfidenceScore": (
                    ocr_space_candidate[5] if ocr_space_candidate else None
                ),
                "formConfidenceScore": (
                    form_candidate[5] if form_candidate else None
                ),
                "formMethod": (
                    form_candidate[4] if form_candidate else None
                ),
                "pdfEvidence": native_candidate[2],
                "pdfPageNumber": native_candidate[3],
                "ocrEvidence": ocr_candidate[2] if ocr_candidate else None,
                "ocrPageNumber": ocr_candidate[3] if ocr_candidate else None,
                "ocrSpaceEvidence": (
                    ocr_space_candidate[2] if ocr_space_candidate else None
                ),
                "ocrSpacePageNumber": (
                    ocr_space_candidate[3] if ocr_space_candidate else None
                ),
                "formEvidence": form_candidate[2] if form_candidate else None,
                "formPageNumber": form_candidate[3] if form_candidate else None,
                "aiPageNumber": ai_page_number,
                "candidateScores": {
                    source_name: score
                    for source_name, score in (
                        ("form_field", form_candidate_score),
                        ("pdf_text", pdf_candidate_score),
                        ("ocr", ocr_candidate_score),
                        ("ocr_space", ocr_space_candidate_score),
                    )
                    if score is not None
                },
                "selectionReason": (
                    "Conflicting candidates had similar evidence scores; no value was selected."
                    if selection_ambiguous
                    else selection_reason
                ),
                "supportingEvidence": evidence,
                "pageNumber": (
                    ai_page_number if source == "ai" else page_number
                ),
                "explanation": explanation,
                "isConflict": conflict,
                "reviewRequired": review_required,
                "isManuallyCorrected": False,
            }
            diagnostics[field_id] = diagnostic
            values[field_id] = value
        timings["field_extraction_ms"] += round(
            (time.perf_counter() - field_extraction_started) * 1000, 3
        )

    timings["total_processing_ms"] = round(
        (time.perf_counter() - total_started) * 1000, 3
    )
    return {
        "pageCount": page_count,
        "rawPdfText": native_text,
        "pdfTextLength": native_length,
        "diagnostics": diagnostics,
        "finalValues": values,
        "extractionMethodUsed": (
            "AI_EXTRACTED" if used_ai
            else "OCR_EXTRACTED" if used_ocr
            else "NATIVE_PDF_TEXT"
        ),
        "ocrError": ocr_error,
        "ocrSpaceError": ocr_space_error,
        "aiError": ai_error,
        "processingMetrics": timings,
    }
