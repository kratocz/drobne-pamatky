#!/usr/bin/env python3
"""
Batch konverze JPG → AVIF 250×Y q50 pro L1 deployment.

Vstup: filepath z DB tabulky `files` (jen mime image/jpeg), zdrojový soubor
v ~/IdeaProjects/github.com/kratocz/drobnepamatky.cz/<filepath>.

Výstup: data/thumbs/<rok>/<basename>.avif v root tohoto repa.

Pipeline per fotka:
  sips -Z 250    (resize na max 250 px na delší straně, preserve aspect)
  avifenc -q 50 --speed 6

Spuštění:
  cd scripts/snapshot
  uv run python build_thumbnails.py                  # full ~125 k souborů
  uv run python build_thumbnails.py --limit 100      # pilot
  uv run python build_thumbnails.py --workers 4      # méně paralelismu
"""

import argparse
import os
import subprocess
import sys
import tempfile
import time
from multiprocessing import Pool
from pathlib import Path

import pymysql

MIRROR_ROOT = Path.home() / "IdeaProjects/github.com/kratocz/drobnepamatky.cz"
REPO_ROOT = Path(__file__).resolve().parents[2]
OUTPUT_ROOT = REPO_ROOT / "data" / "thumbs"
DB_CFG = dict(host="127.0.0.1", port=13306, user="root", password="REDACTED",
              database="gk66", charset="utf8")


def fetch_jpg_paths(limit=None):
    """Filepath všech image/jpeg z DB tabulky files."""
    conn = pymysql.connect(**DB_CFG)
    try:
        with conn.cursor() as cur:
            sql = "SELECT filepath FROM files WHERE filemime = 'image/jpeg'"
            if limit:
                sql += f" LIMIT {int(limit)}"
            cur.execute(sql)
            return [r[0] for r in cur.fetchall()]
    finally:
        conn.close()


def convert_one(filepath):
    """Konvertuje 1 fotku. Vrací (status, filepath)."""
    src = MIRROR_ROOT / filepath
    if not src.exists():
        return ("missing", filepath)

    parts = filepath.split("/")
    if len(parts) < 3 or parts[0] != "files":
        return ("skip", filepath)

    rok = parts[1]
    basename = Path(parts[-1]).stem + ".avif"
    target_dir = OUTPUT_ROOT / rok
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / basename
    if target.exists():
        return ("cached", filepath)

    tmp_fd, tmp_path = tempfile.mkstemp(suffix=".jpg")
    os.close(tmp_fd)
    try:
        subprocess.run(
            ["sips", "-Z", "250", str(src), "--out", tmp_path],
            check=True, capture_output=True,
        )
        subprocess.run(
            ["avifenc", "--speed", "6", "-q", "50", tmp_path, str(target)],
            check=True, capture_output=True,
        )
        return ("ok", filepath)
    except subprocess.CalledProcessError:
        # Pokud zůstal částečný target, smaž
        if target.exists():
            target.unlink()
        return ("err", filepath)
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=None,
                        help="Omezit počet fotek (default: vše)")
    parser.add_argument("--workers", type=int, default=os.cpu_count() or 4,
                        help=f"Počet workerů (default: {os.cpu_count()})")
    args = parser.parse_args()

    OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)

    print(f"Mirror: {MIRROR_ROOT}")
    print(f"Output: {OUTPUT_ROOT}")
    paths = fetch_jpg_paths(limit=args.limit)
    print(f"Source: {len(paths)} JPG souborů z DB files tabulky")
    print(f"Workers: {args.workers}")
    print()

    t0 = time.time()
    counts = {"ok": 0, "cached": 0, "missing": 0, "err": 0, "skip": 0}

    with Pool(args.workers) as pool:
        for i, (status, fp) in enumerate(
            pool.imap_unordered(convert_one, paths, chunksize=20), 1
        ):
            counts[status] += 1
            if i % 1000 == 0 or i == len(paths):
                elapsed = time.time() - t0
                rate = i / elapsed
                eta = (len(paths) - i) / rate if rate > 0 else 0
                print(f"  {i:>6}/{len(paths)}  "
                      f"ok={counts['ok']:>6} cached={counts['cached']:>5} "
                      f"missing={counts['missing']:>4} err={counts['err']:>4}  "
                      f"{rate:.1f} fotek/s  ETA {eta/60:.1f} min", flush=True)

    dt = time.time() - t0
    print()
    print(f"Hotovo za {dt/60:.1f} min ({dt:.0f}s, {len(paths)/dt:.1f} fotek/s)")
    print(f"Výsledek: {counts}")

    # Měření velikosti
    total_size = 0
    file_count = 0
    for root, _, files in os.walk(OUTPUT_ROOT):
        for f in files:
            total_size += os.path.getsize(os.path.join(root, f))
            file_count += 1
    print(f"Output: {file_count} AVIF souborů, {total_size/1024/1024:.1f} MB total")


if __name__ == "__main__":
    main()
