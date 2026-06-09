#!/usr/bin/env python3
"""
Diff "wanted" (z files-manifest.json přes export.py) vs. "existing" (z
data/thumbs-manifest.json) pro orchestraci thumbs sync (issue #1).

CLI:
  uv run python sync_manifest_diff.py \\
      --wanted out/files-manifest.json \\
      --existing ../../data/thumbs-manifest.json \\
      --to-generate /tmp/thumbs-to-generate.txt \\
      --to-delete /tmp/thumbs-to-delete.txt \\
      --to-rsync /tmp/jpg-to-rsync.txt \\
      --new-manifest /tmp/thumbs-manifest-new.json

Filepath → thumb_path mapping (musí ladit s build_thumbnails.convert_one):
  files/2022/img_1.jpg → 2022/img_1.avif
  Konkrétně: parts = filepath.split("/")
             parts[0] musí být "files", parts[1] = rok
             basename = Path(parts[-1]).stem + ".avif"
             thumb_path = f"{parts[1]}/{basename}"
"""

import argparse
import json
import sys
from pathlib import Path


def filepath_to_thumb_path(filepath):
    """files/2022/img_1.jpg → 2022/img_1.avif.
    Vrací None pro neočekávaný tvar (musí ladit s build_thumbnails.convert_one).

    Pozn.: Drupal 6 v gk66 ukládá filepath relativně k web rootu jako
    "files/<rok>/<basename>.jpg" (NE "sites/default/files/..."). VPS web root
    je /www/drobnepamatky.cz/www/, takže rsync --files-from přijímá tyto cesty
    přímo (źdrojový root v rsync je /www/drobnepamatky.cz/www/).
    """
    parts = filepath.split("/")
    if len(parts) < 3 or parts[0] != "files":
        return None
    rok = parts[1]
    basename = Path(parts[-1]).stem + ".avif"
    return f"{rok}/{basename}"


def build_wanted_index(files_manifest):
    """{filepath: {fid, size, timestamp}} → {thumb_path: {filepath, fid, size, timestamp}}."""
    wanted = {}
    for filepath, meta in files_manifest.items():
        thumb_path = filepath_to_thumb_path(filepath)
        if thumb_path is None:
            continue
        wanted[thumb_path] = {
            "filepath": filepath,
            "fid": meta["fid"],
            "size": meta["size"],
            "timestamp": meta["timestamp"],
        }
    return wanted


def compute_diff(wanted, existing):
    """Vrací (to_generate, to_delete, to_rsync) — všechny seznamy stringů.

    to_generate: thumb_paths kterým chybí nebo se změnil obsah (size/timestamp)
    to_delete:   thumb_paths které jsou v existing ale ne ve wanted
    to_rsync:    filepaths JPG ke stažení (1:1 s to_generate, ale jen filepath)
    """
    to_generate = []
    to_delete = []
    to_rsync = []

    wanted_paths = set(wanted.keys())
    existing_paths = set(existing.keys())

    for tp in wanted_paths - existing_paths:
        to_generate.append(tp)
        to_rsync.append(wanted[tp]["filepath"])

    for tp in existing_paths - wanted_paths:
        to_delete.append(tp)

    for tp in wanted_paths & existing_paths:
        w, e = wanted[tp], existing[tp]
        if (w["size"], w["timestamp"]) != (e["size"], e["timestamp"]):
            to_generate.append(tp)
            to_rsync.append(w["filepath"])

    return to_generate, to_delete, to_rsync


def build_new_existing_manifest(wanted):
    """Konvertuje wanted index zpět na tvar, který se ukládá do data/thumbs-manifest.json
    (bez `filepath`, jen fid/size/timestamp)."""
    return {tp: {"fid": w["fid"], "size": w["size"], "timestamp": w["timestamp"]}
            for tp, w in wanted.items()}


def write_lines(path, lines):
    """Zapíše seznam stringů, jeden per řádek."""
    Path(path).write_text("\n".join(lines) + ("\n" if lines else ""), encoding="utf-8")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--wanted", required=True, help="Cesta k out/files-manifest.json")
    p.add_argument("--existing", required=True, help="Cesta k data/thumbs-manifest.json (může neexistovat = empty)")
    p.add_argument("--to-generate", required=True, help="Výstup: thumb_paths k vygenerování (per řádek)")
    p.add_argument("--to-delete", required=True, help="Výstup: thumb_paths ke smazání (per řádek)")
    p.add_argument("--to-rsync", required=True, help="Výstup: JPG filepath ke stažení (per řádek)")
    p.add_argument("--new-manifest", required=True, help="Výstup: nový thumbs-manifest.json (po úspěšném sync se přepíše existing)")
    args = p.parse_args()

    files_manifest = json.loads(Path(args.wanted).read_text(encoding="utf-8"))
    wanted = build_wanted_index(files_manifest["files"])

    if Path(args.existing).exists():
        existing = json.loads(Path(args.existing).read_text(encoding="utf-8"))
    else:
        existing = {}

    to_generate, to_delete, to_rsync = compute_diff(wanted, existing)

    write_lines(args.to_generate, to_generate)
    write_lines(args.to_delete, to_delete)
    write_lines(args.to_rsync, to_rsync)

    new_manifest = build_new_existing_manifest(wanted)
    Path(args.new_manifest).write_text(
        json.dumps(new_manifest, ensure_ascii=False, indent=2, sort_keys=True),
        encoding="utf-8",
    )

    print(f"diff: {len(to_generate)} k vygenerování, "
          f"{len(to_delete)} ke smazání, "
          f"{len(to_rsync)} JPG ke stažení", file=sys.stderr)


if __name__ == "__main__":
    main()
