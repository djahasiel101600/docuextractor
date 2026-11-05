import sys
import json
import re

with open("analysis/_reverify.json", encoding="utf-8") as fh:
    out = json.load(fh)

NAME = "candidate_name"
ADDR = "field_1793589323133"
DATE_RE = re.compile(r"^\d{1,2}[-/.\s]\d{1,2}([-/.\s]\d{2,4})?$")
COUNTRIES = {
    "lithuania", "kyrgyzstan", "kyrgyz republic", "russia", "philippines",
    "poland", "serbia", "egypt", "india", "pakistan", "ukraine", "belarus",
}

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

bad = []
for fn, fields in out.items():
    nd = fields.get(NAME, {})
    ad = fields.get(ADDR, {})
    nfinal, afinal = (nd.get("final") or ""), (ad.get("final") or "")
    if nfinal and DATE_RE.match(nfinal.strip()):
        bad.append((fn, "NAME_IS_DATE", nfinal))
    if nfinal and afinal and nfinal.casefold() == afinal.casefold():
        bad.append((fn, "SAME_VALUE_BOTH", nfinal))
    if afinal and afinal.strip().casefold() in COUNTRIES:
        bad.append((fn, "ADDR_IS_COUNTRY", afinal))
    if afinal and not re.search(r"\d", afinal) and len(afinal.split()) < 2:
        bad.append((fn, "ADDR_SINGLE_TOKEN", afinal))
    if nd.get("status") == "MATCHED" and nd.get("source") == "filename":
        bad.append((fn, "FILENAME_STILL_MATCHED", nfinal))
    if ad.get("status") == "MATCHED" and ad.get("source") == "filename":
        bad.append((fn, "FILENAME_STILL_MATCHED_ADDR", afinal))
    for d in (nd, ad):
        if d.get("status") == "MATCHED" and d.get("form") is None and d.get("source") != "pdf_text":
            bad.append((fn, "MATCHED_NO_FORM", d.get("source"), d.get("final")))

print("ANOMALIES:", len(bad))
for b in bad[:40]:
    print(" ", b)

probes = ("Nina Mitrovic_W8", "Jaycee Carlo Calandria_W8", "Titas Vaiciunas_W8",
          "Anjalee", "MARY MAY_BERNIDO")
for fn, fields in out.items():
    if any(fn.startswith(p) or p.lower() in fn.lower() for p in probes):
        print("\n", fn)
        for fid, d in fields.items():
            print("   ", fid, "|", d["status"], d["source"], repr(
                d["final"]), "form=", repr(d["form"]))
