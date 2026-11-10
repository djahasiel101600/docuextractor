import re
from typing import Any

def _normalize_filename(value: str) -> str:
    name = value.strip()
    if not name:
        return ""
    stem = name.rsplit(".", 1)[0] if "." in name else name
    return stem.casefold()

def _candidate_field_match(filename: str, field: dict[str, Any]) -> dict[str, Any] | None:
    rules = field.get("filenameRules") or {}
    if not rules.get("enabled"):
        return None
    patterns = rules.get("patterns") or []
    if not patterns:
        return None
    basename = _normalize_filename(filename)
    for pattern_text in patterns:
        if not isinstance(pattern_text, str) or not pattern_text.strip():
            continue
        try:
            flags = re.IGNORECASE if rules.get("caseInsensitive", True) else 0
            regex = re.compile(pattern_text, flags)
        except re.error:
            continue
        match = regex.search(filename) or regex.search(basename)
        if not match:
            continue
        group_index = int(rules.get("captureGroup") or 1)
        try:
            value = match.group(group_index)
        except IndexError:
            value = match.group(0)
        if value and value.strip():
            return {
                "pattern": pattern_text,
                "value": value.strip(),
                "confidence": 0.9,
            }
    return None

def classify_filename_for_profiles(filename: str, profiles):
    matches = []
    for profile in profiles:
        for field in profile.configuration.get("fields", []):
            field_match = _candidate_field_match(filename, field)
            if field_match is None:
                continue
            matches.append(
                {
                    "profile_id": profile.id,
                    "profile_name": profile.name,
                    "field_id": field.get("id"),
                    "rule": field_match["pattern"],
                    "value": field_match["value"],
                    "confidence": field_match["confidence"],
                    "method": "filename_rule",
                }
            )
            break
    return matches

def classify_document_assignment(document, profiles, fallback_profile=None):
    matches = classify_filename_for_profiles(document.filename, profiles)
    if len(matches) == 1:
        return {
            "profile_id": matches[0]["profile_id"],
            "status": "assigned",
            "method": "filename_rule",
            "rule": matches[0]["rule"],
            "confidence": matches[0]["confidence"],
            "reason": f"Matched filename pattern for {matches[0]['profile_name']}",
        }
    if len(matches) > 1:
        profiles_named = ", ".join(sorted({item["profile_name"] for item in matches}))
        return {
            "profile_id": None,
            "status": "ambiguous",
            "method": "filename_rule",
            "rule": "multiple matches",
            "confidence": 0.0,
            "reason": f"Filename matches multiple profiles: {profiles_named}",
        }
    if fallback_profile is not None:
        return {
            "profile_id": fallback_profile.id,
            "status": "legacy",
            "method": "job_default",
            "rule": "job_default_profile",
            "confidence": 0.5,
            "reason": "No filename rule matched; kept the job's selected profile for backward compatibility.",
        }
    return {
        "profile_id": None,
        "status": "unassigned",
        "method": "filename_rule",
        "rule": "none",
        "confidence": 0.0,
        "reason": "No extraction profile could be matched to this document.",
    }
