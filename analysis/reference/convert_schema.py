"""Convert pdf_annotator.py's field_schema.json into an annotationSchema.

The annotator and the application describe the same geometry in two shapes:

    field_schema.json   {page, name, bbox_pdf_pt, bbox_normalized}
    annotationSchema    {pageNumber, fieldId, rect: [x0, y0, x1, y1]}

field_schema.json is NOT directly consumable by process_pdf_roi. Annotation
names are free text, while fieldId must match a field id in the profile, so
pass a map for anything not named after its field id.

    python analysis/reference/convert_schema.py field_schema.json \
        --field-map names.json --out annotation_schema.json

`names.json` is a JSON object: {"Print name of signer": "print_name_of_signer"}.
Unmapped names are slugified. bbox_normalized is ignored; the application
stores PDF points only. Reference-tool support: the app never imports this.
"""

import argparse
import json
import re
from pathlib import Path


def slugify(name):
    return re.sub(r"[^a-z0-9]+", "_", str(name).casefold()).strip("_") or "field"


def convert(source, name_map):
    pages = []
    for page in source.get("pages", []):
        fields = []
        for item in page.get("fields", []):
            box = item["bbox_pdf_pt"]
            fields.append(
                {
                    "fieldId": name_map.get(item["name"])
                    or slugify(item["name"]),
                    "rect": [box["x0"], box["y0"], box["x1"], box["y1"]],
                }
            )
        if fields:
            pages.append({"pageNumber": int(page["page"]), "fields": fields})
    schema = {"coordinateSystem": "pdf_points_top_left", "pages": pages}
    if source.get("source_pdf"):
        schema["sourcePdf"] = source["source_pdf"]
    return schema


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("schema", type=Path, help="field_schema.json")
    parser.add_argument(
        "--field-map",
        type=Path,
        help="JSON object mapping annotation name -> profile field id",
    )
    parser.add_argument(
        "--out", type=Path, default=Path("annotation_schema.json")
    )
    args = parser.parse_args()

    name_map = (
        json.loads(args.field_map.read_text(encoding="utf-8"))
        if args.field_map
        else {}
    )
    source = json.loads(args.schema.read_text(encoding="utf-8"))
    schema = convert(source, name_map)
    args.out.write_text(json.dumps(schema, indent=2), encoding="utf-8")
    boxes = sum(len(page["fields"]) for page in schema["pages"])
    print(f"wrote {args.out}: {boxes} boxes on {len(schema['pages'])} page(s)")


if __name__ == "__main__":
    main()
