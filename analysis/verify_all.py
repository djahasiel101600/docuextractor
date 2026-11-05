"""Independent, whole-batch verification of job 138c040c against the
authoritative AcroForm (formValue) ground truth surfaced in the inspector.

This reads the exact same per-field diagnostics the Document Inspector renders
(finalValue, formValue, pdfValue, filenameValue, source, status,
confidenceScore, formMethod, explanation, isConflict, reviewRequired) for ALL
104 documents and flags semantic/pairing defects the browser sample hinted at.
"""
import json
import re
from collections import Counter

JOB = "analysis/_job_138c.json"
NAME = "candidate_name"
ADDR = "field_1793589323133"

DATE_RE = re.compile(r"^\d{1,2}([-\./])\d{1,2}\1?\d{2,4}$")
ANY_DATE_RE = re.compile(r"\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}")
STREET_TOKENS = (
    "st", "street", "ave", "avenue", "road", "rd", "blvd", "ln", "lane",
    "g.", "gatve", "str.", "pocht", "house", "blk", "lot", "bldg", "apt",
    "fl ", "floor", "no.", "suite", "road", "nagar", "colony", "village",
)
PROSE_TOKENS = (
    "do not use", "p.o. box", "po box", "in-care-of", "rural route",
    "apt. or suite", "beneficial owner", "account number",
    "type", "enter", "please", "if any",
)

COUNTRIES = {
    "lithuania", "kyrgyz republic", "russia", "philippines", "poland",
    "serbia", "egypt", "india", "pakistan", "ukraine", "belarus", "moldova",
    "georgia", "armenia", "azerbaijan", "uzbekistan", "latvia", "estonia",
    "united states", "usa", "vietnam", "bangladesh", "nepal", "china",
}


def is_date(v):
    return bool(v) and bool(DATE_RE.match(v.strip()))


def has_any_date(v):
    return bool(v) and bool(ANY_DATE_RE.search(v))


def looks_like_country(v):
    return bool(v) and v.strip().casefold() in COUNTRIES


def looks_like_street(v):
    if not v:
        return False
    low = v.lower()
    # a street-ish value usually has a number AND a token, or a known suffix
    has_num = bool(re.search(r"\d", v))
    has_tok = any(tok in low for tok in STREET_TOKENS)
    return has_num and has_tok


def has_prose(v):
    if not v:
        return False
    low = v.lower()
    return any(tok in low for tok in PROSE_TOKENS)


def main():
    with open(JOB, encoding="utf-8-sig") as fh:
        job = json.load(fh)

    docs = job["documents"]
    total = len(docs)

    src_name = Counter()
    src_addr = Counter()
    method_name = Counter()

    anomalies = []  # (filename, code, detail)
    name_date = []          # date in Candidate Name
    addr_name = []          # address field holds a person name / equals name
    addr_country = []       # country in address
    addr_city_only = []     # address with no digits (likely city/country)
    prose_name = []
    prose_addr = []
    swap = []               # name formValue == address formValue
    fp_zero_matched = []    # MATCHED but 0% evidence and no form row
    mismatch_form = []      # finalValue != formValue while formValue present
    name_missing = 0
    addr_missing = 0
    name_ok = 0
    addr_ok = 0

    for d in docs:
        fn = d["filename"]
        diag = d.get("diagnostics", {}) or {}
        nd = diag.get(NAME, {}) or {}
        ad = diag.get(ADDR, {}) or {}

        nfinal = (nd.get("finalValue") or "").strip()
        nform = (nd.get("formValue") or "").strip(
        ) if nd.get("formValue") else ""
        nsrc = nd.get("source") or ""
        nstatus = nd.get("status") or ""
        nconf = nd.get("confidenceScore")
        nmethod = nd.get("method") or ""

        afinal = (ad.get("finalValue") or "").strip()
        aform = (ad.get("formValue") or "").strip(
        ) if ad.get("formValue") else ""
        asrc = ad.get("source") or ""
        astatus = ad.get("status") or ""
        aconf = ad.get("confidenceScore")

        src_name[nsrc or "NONE"] += 1
        src_addr[asrc or "NONE"] += 1
        method_name[nmethod or "NONE"] += 1

        # missing
        if not nfinal:
            name_missing += 1
        else:
            name_ok += 1
        if not afinal:
            addr_missing += 1
        else:
            addr_ok += 1

        # date in name
        if nfinal and (is_date(nfinal) or (is_date(nform))):
            name_date.append((fn, nfinal, nform))
            anomalies.append(
                (fn, "NAME_IS_DATE", f"final={nfinal!r} form={nform!r}"))

        # country / city-only in address
        if afinal and looks_like_country(afinal):
            addr_country.append((fn, afinal))
            anomalies.append((fn, "ADDR_IS_COUNTRY", f"final={afinal!r}"))
        elif afinal and not re.search(r"\d", afinal) and not looks_like_street(afinal):
            addr_city_only.append((fn, afinal))
            anomalies.append((fn, "ADDR_NO_DIGITS", f"final={afinal!r}"))

        # address equals name (swap / same widget)
        if nform and aform and nform.casefold() == aform.casefold():
            swap.append((fn, nform, aform))
            anomalies.append((fn, "SAME_WIDGET_NAME_ADDR",
                             f"form={nform!r} used for both fields"))
        if nfinal and afinal and nfinal.casefold() == afinal.casefold():
            anomalies.append((fn, "SAME_FINAL_NAME_ADDR",
                             f"final={nfinal!r} for both fields"))

        # address holds a person name (heuristic: equals name final, or is a short
        # multi-word alpha string that also validates as name). Mostly covered by
        # SAME_* checks; add explicit name-in-address signal:
        if afinal and nfinal and afinal.casefold() == nfinal.casefold():
            addr_name.append((fn, afinal))

        # prose leakage
        if nfinal and has_prose(nfinal):
            prose_name.append((fn, nfinal))
            anomalies.append((fn, "PROSE_IN_NAME", f"final={nfinal!r}"))
        if afinal and has_prose(afinal):
            prose_addr.append((fn, afinal))
            anomalies.append((fn, "PROSE_IN_ADDR", f"final={afinal!r}"))

        # false positive: MATCHED with 0 evidence and no authoritative form row
        if nstatus == "MATCHED" and (nconf == 0 or nconf is None) and not nform:
            fp_zero_matched.append((fn, "name", nfinal, nconf))
            anomalies.append((fn, "FP_NAME_MATCHED_ZERO",
                             f"final={nfinal!r} conf={nconf} no form row"))
        if astatus == "MATCHED" and (aconf == 0 or aconf is None) and not aform:
            fp_zero_matched.append((fn, "addr", afinal, aconf))
            anomalies.append((fn, "FP_ADDR_MATCHED_ZERO",
                             f"final={afinal!r} conf={aconf} no form row"))

        # mismatch: form present but final diverges from it
        if nform and nfinal and nform.casefold() != nfinal.casefold():
            mismatch_form.append((fn, "name", nform, nfinal))
        if aform and afinal and aform.casefold() != afinal.casefold():
            mismatch_form.append((fn, "addr", aform, afinal))

    def dump(title, rows, fmt=lambda r: r):
        print("\n" + "=" * 70)
        print(f"{title}  ({len(rows)})")
        print("=" * 70)
        for r in rows[:60]:
            print("  ", fmt(r))

    print(f"TOTAL DOCS: {total}")
    print(f"Candidate Name : extracted={name_ok}  missing={name_missing}")
    print(f"Permanent Addr : extracted={addr_ok}  missing={addr_missing}")
    print(f"\nName source dist : {dict(src_name)}")
    print(f"Addr source dist : {dict(src_addr)}")
    print(f"Name method dist : {dict(method_name)}")

    print("\n### HEADLINE ANOMALY COUNTS")
    print(f"  date in Candidate Name ......... {len(name_date)}")
    print(f"  same widget name & address ..... {len(swap)}")
    print(f"  country in Address ............. {len(addr_country)}")
    print(f"  address with no digits ......... {len(addr_city_only)}")
    print(
        f"  prose leakage (name or addr) ... {len(prose_name) + len(prose_addr)}")
    print(f"  FP MATCHED@0% (no form row) .... {len(fp_zero_matched)}")
    print(f"  final != formValue (diverged) .. {len(mismatch_form)}")
    print(f"  TOTAL anomaly events ........... {len(anomalies)}")

    def fmt_t3(r): return f"{r[0]} | {r[1]!r} | {r[2]!r}"
    dump("DATE IN CANDIDATE NAME", name_date, fmt_t3)
    dump("SAME WIDGET USED FOR NAME + ADDRESS", swap, fmt_t3)
    dump("COUNTRY IN ADDRESS", addr_country, lambda r: f"{r[0]} | {r[1]!r}")
    dump("ADDRESS WITH NO DIGITS (city/country-only?)",
         addr_city_only, lambda r: f"{r[0]} | {r[1]!r}")
    dump("PROSE IN NAME", prose_name, lambda r: f"{r[0]} | {r[1]!r}")
    dump("PROSE IN ADDRESS", prose_addr, lambda r: f"{r[0]} | {r[1]!r}")
    dump("FP: status=MATCHED @0% with no form row", fp_zero_matched,
         lambda r: f"{r[0]} | {r[1]} | {r[2]!r} | conf={r[3]}")
    dump("FINAL DIVERGED FROM AUTHORITATIVE FORM VALUE", mismatch_form, fmt_t3)


if __name__ == "__main__":
    main()
