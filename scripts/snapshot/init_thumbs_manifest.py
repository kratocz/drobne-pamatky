#!/usr/bin/env python3
"""
Jednorázový helper: sestaví `data/thumbs-manifest.json` ze současného stavu
`data/thumbs/` adresáře + DB.files manifestu.

Cíl: po prvním pushí issue #1 byl manifest prázdný {} a první full sync by
zbytečně regeneroval všech ~111k existujících thumbs. Tento skript:
  1. Stáhne aktuální DB.files manifest (přes SSH tunel + DB query).
  2. Pro každý záznam ověří, zda lokálně existuje odpovídající AVIF thumb.
  3. Pokud ano, přidá ho do manifestu (s fid/size/timestamp z DB).
  4. Pokud ne, vynechá (sync skript ho pak vygeneruje normálně).

Po něm: `bash scripts/sync-from-source.sh` ukáže diff jen pro skutečně
chybějící thumbs (nové JPG od posledního manuálního build_thumbnails běhu).

Spuštění:
  cd scripts/snapshot
  uv run python init_thumbs_manifest.py

Vyžaduje aktivní SSH tunel na port 13306 (viz AGENTS.md sekce Starý server).
"""

import json
import os
from pathlib import Path

import pymysql

from sync_manifest_diff import filepath_to_thumb_path

DB_CFG = dict(
    host="127.0.0.1",
    port=13306,
    user=os.environ["OLD_DB_USER"],
    password=os.environ["OLD_DB_PASSWORD"],
    database=os.environ["OLD_DB_NAME"],
    charset="utf8",
    cursorclass=pymysql.cursors.DictCursor,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
THUMBS_DIR = REPO_ROOT / "data" / "thumbs"
MANIFEST_PATH = REPO_ROOT / "data" / "thumbs-manifest.json"


def fetch_files_from_db():
    """Stejný query jako export.fetch_files_manifest."""
    conn = pymysql.connect(**DB_CFG)
    try:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT DISTINCT
                  f.fid, f.filepath, f.filesize, f.timestamp
                FROM files f
                JOIN content_field_obrazek cfo ON cfo.field_obrazek_fid = f.fid
                JOIN node n ON n.nid = cfo.nid AND n.vid = cfo.vid
                WHERE n.type = 'objekt' AND n.status = 1
                  AND f.filemime = 'image/jpeg'
            """)
            return cur.fetchall()
    finally:
        conn.close()


def main():
    print(f"Načítám DB.files manifest …", flush=True)
    files = fetch_files_from_db()
    print(f"  → {len(files)} JPG záznamů v DB", flush=True)

    manifest = {}
    skipped_no_thumb = 0
    skipped_bad_path = 0

    for r in files:
        thumb_path = filepath_to_thumb_path(r["filepath"])
        if thumb_path is None:
            skipped_bad_path += 1
            continue
        target = THUMBS_DIR / thumb_path
        if not target.exists():
            skipped_no_thumb += 1
            continue
        manifest[thumb_path] = {
            "fid": r["fid"],
            "size": r["filesize"],
            "timestamp": r["timestamp"],
        }

    print(f"  → {len(manifest)} thumbs nalezeno lokálně")
    print(f"  → {skipped_no_thumb} thumbs CHYBÍ (sync je vygeneruje)")
    if skipped_bad_path:
        print(f"  → {skipped_bad_path} JPG s neočekávaným filepath (skipped)")

    print(f"Zapisuji {MANIFEST_PATH} …")
    MANIFEST_PATH.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True),
        encoding="utf-8",
    )
    print(f"  ✓ hotovo, {len(manifest)} záznamů")


if __name__ == "__main__":
    main()
