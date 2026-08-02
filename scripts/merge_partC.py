import json
import re
import os
import hashlib
from collections import Counter

BASE = os.path.join(os.path.dirname(__file__), "..", "draftgen", "static")
MANIFEST = os.path.join(BASE, "figure-manifest.json")
PARTC = os.path.join(BASE, "figure-manifest.partC.json")
IMG_EXT = {".jpg", ".jpeg", ".png", ".gif", ".tif", ".tiff", ".webp"}


def slug(wm):
    s = wm.lower()
    s = re.sub(r"\.[a-z0-9]+$", "", s)
    s = re.sub(r"[^a-z0-9]+", "-", s)
    return s.strip("-")[:60]


def main():
    with open(MANIFEST, encoding="utf-8") as f:
        existing = json.load(f)
    with open(PARTC, encoding="utf-8") as f:
        partc = json.load(f)

    seen_ids = set(x.get("id") for x in existing if x.get("id"))
    seen_wms = set(x.get("wm") for x in existing if x.get("wm"))

    added = 0
    skipped = 0
    for x in partc:
        wm = x.get("wm")
        if not wm:
            skipped += 1
            continue
        if wm in seen_wms:  # dedup against existing wm
            skipped += 1
            continue
        ext = os.path.splitext(wm)[1].lower()
        if ext not in IMG_EXT:
            skipped += 1
            continue
        base = slug(wm)
        eid = base
        if eid in seen_ids:
            eid = base + "-" + hashlib.md5(wm.encode("utf-8")).hexdigest()[:6]
        seen_ids.add(eid)
        seen_wms.add(wm)
        existing.append(
            {
                "id": eid,
                "title": x.get("title", ""),
                "artist": x.get("artist", "多人"),
                "year": x.get("year", ""),
                "en": x.get("en", wm),
                "wm": wm,
                "category": x.get("category", "构图草稿"),
                "tags": x.get("tags", ["构图草稿"]),
            }
        )
        added += 1

    existing.sort(key=lambda e: (e.get("category", ""), e.get("artist", ""), e.get("title", "")))

    with open(MANIFEST, "w", encoding="utf-8") as f:
        json.dump(existing, f, ensure_ascii=False, indent=2)

    print(f"ADDED {added}  SKIPPED {skipped}  TOTAL {len(existing)}")
    print("category counts:", dict(Counter(e.get("category") for e in existing)))


if __name__ == "__main__":
    main()
