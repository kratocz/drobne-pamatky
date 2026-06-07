#!/usr/bin/env python3
"""
Export publikovaných památek z lokální MariaDB (gk66 mirror) do JSON formátů
plánovaných pro L1 deployment.

Výstup do scripts/snapshot/out/:
  - pamatky.geojson         master GeoJSON (krátké property names n/d/i)
  - lookups.json            druh + místo ID → název (jen použité)
  - details/<nid>.json      detail per památka (lazy-load target)

Spuštění:
  cd scripts/snapshot
  uv run python export.py                 # full export ~82 k záznamů
  uv run python export.py --limit 10      # pilot
"""

import argparse
import json
import os
import time
import pymysql

DB_CFG = dict(host="127.0.0.1", port=13306, user="root", password="REDACTED",
              database="gk66", charset="utf8")

OUT_DIR = os.path.join(os.path.dirname(__file__), "out")
DETAILS_DIR = os.path.join(OUT_DIR, "details")


def connect():
    return pymysql.connect(**DB_CFG, cursorclass=pymysql.cursors.DictCursor)


def fetch_nids(cur, limit=None):
    """Publikované objekty s GPS, seřazené od nejnovějšího. Limit = None = vše."""
    sql = """
        SELECT n.nid
        FROM node n
        JOIN content_type_objekt cto ON cto.nid = n.nid AND cto.vid = n.vid
        JOIN location l ON l.lid = cto.field_pozice_lid
        WHERE n.type = 'objekt' AND n.status = 1
          AND l.latitude != 0 AND l.longitude != 0
        ORDER BY n.nid DESC
    """
    if limit:
        sql += f"\n        LIMIT {int(limit)}"
    cur.execute(sql)
    return [r["nid"] for r in cur.fetchall()]


def fetch_objects(cur):
    """Všechna publikovaná data – jeden řádek per památka. Druh se dotazuje zvlášť."""
    cur.execute(
        """
        SELECT
          n.nid,
          n.title,
          n.uid AS author_uid,
          n.created,
          n.changed,
          l.latitude,
          l.longitude,
          cto.field_pridano_value AS pridano_text,
          cto.field_nkpid_value AS nkpid,
          cto.field_licence_value AS licence,
          cto.field_wd_value AS wikidata_qid,
          cto.field_zvlastnost_value AS popis_zvlastnost,
          cto.field_oborano_value AS popis_oborano,
          cto.field_wiki_value AS wiki_popis,
          cto.field_cesta_value AS cesta_popis,
          cto.field_sidlo_value AS sidlo
        FROM node n
        JOIN content_type_objekt cto ON cto.nid = n.nid AND cto.vid = n.vid
        JOIN location l ON l.lid = cto.field_pozice_lid
        WHERE n.type = 'objekt' AND n.status = 1
          AND l.latitude != 0 AND l.longitude != 0
        """
    )
    return {r["nid"]: r for r in cur.fetchall()}


def fetch_druh_per_nid(cur):
    """Druh památky (vocabulary id 5) pro všechny publikované objekty."""
    cur.execute(
        """
        SELECT tn.nid, td.tid, td.name
        FROM term_node tn
        JOIN term_data td ON td.tid = tn.tid AND td.vid = 5
        JOIN node n ON n.nid = tn.nid AND n.vid = tn.vid
        WHERE n.type = 'objekt' AND n.status = 1
        """
    )
    out = {}
    for r in cur.fetchall():
        out[r["nid"]] = {"tid": r["tid"], "name": r["name"]}
    return out


def fetch_misto_per_nid(cur):
    """Územní hierarchie (vocabulary 4) pro všechny publikované objekty."""
    cur.execute(
        """
        SELECT tn.nid, td.tid, td.name
        FROM term_node tn
        JOIN term_data td ON td.tid = tn.tid AND td.vid = 4
        JOIN node n ON n.nid = tn.nid AND n.vid = tn.vid
        WHERE n.type = 'objekt' AND n.status = 1
        """
    )
    rows_per_nid = {}
    for r in cur.fetchall():
        rows_per_nid.setdefault(r["nid"], []).append(r)
    return rows_per_nid


def fetch_term_hierarchy(cur):
    """Mapping tid → parent_tid pro celý vocabulary 4 (Správní rozdělení)."""
    cur.execute(
        """
        SELECT th.tid, th.parent
        FROM term_hierarchy th
        JOIN term_data td ON td.tid = th.tid AND td.vid = 4
        """
    )
    return {r["tid"]: r["parent"] for r in cur.fetchall()}


def fetch_users(cur):
    """Mapping uid → name pro autory publikovaných uzlů.
    Profily na drobnepamatky.cz nejsou veřejné (login wall), takže linkujeme
    jen jméno bez URL – stejné info je veřejně k vidění v atribucích fotek."""
    cur.execute(
        """
        SELECT u.uid, u.name
        FROM users u
        WHERE u.uid IN (
            SELECT DISTINCT n.uid FROM node n
            WHERE n.type IN ('objekt', 'cesta') AND n.status = 1
        )
        """
    )
    return {r["uid"]: r["name"] for r in cur.fetchall()}


def fetch_photos_per_nid(cur):
    """Obrázky vázané na publikované uzly přes content_field_obrazek."""
    cur.execute(
        """
        SELECT
          cfo.nid, cfo.delta,
          cfo.field_obrazek_fid AS fid,
          f.filepath, f.filesize, f.uid AS uploader_uid
        FROM content_field_obrazek cfo
        JOIN files f ON f.fid = cfo.field_obrazek_fid
        JOIN node n ON n.nid = cfo.nid AND n.vid = cfo.vid
        WHERE n.type = 'objekt' AND n.status = 1
        ORDER BY cfo.nid, cfo.delta
        """
    )
    by_nid = {}
    for r in cur.fetchall():
        by_nid.setdefault(r["nid"], []).append(r)
    return by_nid


def resolve_kraj_tid(misto_rows, parents):
    """
    Najde top-level kraj_tid v misto_termy daného uzlu.
    Kraj má v term_hierarchy parent_tid = 0.
    Vrací int (tid kraje) nebo 0 pokud žádný nenalezen.
    """
    for r in misto_rows:
        if parents.get(r["tid"], 0) == 0:
            return r["tid"]
    return 0


def build_geojson(objects, druh_per_nid, kraj_per_nid):
    """Master GeoJSON – krátké property names: n (název), d (druh tid),
    i (nid), k (kraj tid pro bucketed detail load)."""
    features = []
    for nid, obj in objects.items():
        druh = druh_per_nid.get(nid)
        features.append({
            "type": "Feature",
            "geometry": {
                "type": "Point",
                "coordinates": [float(obj["longitude"]), float(obj["latitude"])],
            },
            "properties": {
                "n": obj["title"],
                "d": druh["tid"] if druh else None,
                "i": nid,
                "k": kraj_per_nid.get(nid, 0),
            },
        })
    return {"type": "FeatureCollection", "features": features}


def build_lookups(druh_per_nid, misto_per_nid, parents, users):
    """Druh + místo + autoři lookup tabulky pro klienta."""
    druhy = {}
    for d in druh_per_nid.values():
        druhy[d["tid"]] = d["name"]

    mista = {}
    for rows in misto_per_nid.values():
        for r in rows:
            mista[r["tid"]] = {"name": r["name"], "parent_tid": parents.get(r["tid"], 0)}
    return {"druh": druhy, "misto": mista, "users": users}


def build_search_data(objects, druh_per_nid, misto_per_nid):
    """
    Flat JSON pro pre-build search indexu (Node + MiniSearch, viz build_search_index.js).
    Sloučí kraj/okres/obec/ku termy do jednoho 'misto' stringu, oddělené čárkou.
    """
    entries = []
    for nid, obj in objects.items():
        druh = druh_per_nid.get(nid)
        misto_rows = misto_per_nid.get(nid, [])
        misto_names = ", ".join(r["name"] for r in misto_rows)
        entries.append({
            "i": nid,
            "n": obj["title"],
            "d": druh["name"] if druh else "",
            "m": misto_names,
        })
    return entries


def _strip_empty(d):
    """Odstraní klíče s None / prázdným stringem pro úsporu místa."""
    return {k: v for k, v in d.items() if v not in (None, "", 0)}


def build_detail(obj, druh, misto_rows, photos):
    """Detail JSON per památka – plný metadata + fotky, prázdná pole odstraněna."""
    detail = {
        "nid": obj["nid"],
        "title": obj["title"],
        "druh": druh,
        "misto_termy": [r["tid"] for r in misto_rows],
        "gps": [float(obj["longitude"]), float(obj["latitude"])],
        "metadata": _strip_empty({
            "pridano": obj["pridano_text"],
            "nkpid": obj["nkpid"],
            "licence": obj["licence"],
            "wikidata_qid": obj["wikidata_qid"],
            "author_uid": obj["author_uid"],
            "created_ts": obj["created"],
            "changed_ts": obj["changed"],
        }),
        "popis": _strip_empty({
            "zvlastnost": obj["popis_zvlastnost"],
            "oborano": obj["popis_oborano"],
            "wiki": obj["wiki_popis"],
            "cesta": obj["cesta_popis"],
            "sidlo": obj["sidlo"],
        }),
        "fotky": [
            {
                "fid": p["fid"],
                "delta": p["delta"],
                "path": p["filepath"],
                "size": p["filesize"],
                "uid": p["uploader_uid"],
            }
            for p in photos
        ],
    }
    return detail


def main():
    parser = argparse.ArgumentParser(description="Export gk66 → JSON")
    parser.add_argument("--limit", type=int, default=None,
                        help="Omezení počtu záznamů (default: vše)")
    args = parser.parse_args()

    os.makedirs(DETAILS_DIR, exist_ok=True)

    t0 = time.time()
    conn = connect()
    try:
        with conn.cursor() as cur:
            print("[1/6] fetch nids …", flush=True)
            nids = set(fetch_nids(cur, limit=args.limit))
            print(f"      → {len(nids)} nidů", flush=True)

            print("[2/6] fetch objects (1 row / nid) …", flush=True)
            objects = fetch_objects(cur)
            if args.limit:
                objects = {nid: o for nid, o in objects.items() if nid in nids}
            print(f"      → {len(objects)} objektů", flush=True)

            print("[3/6] fetch druh + místo + hierarchie + autoři …", flush=True)
            druh_per_nid = fetch_druh_per_nid(cur)
            misto_per_nid = fetch_misto_per_nid(cur)
            parents = fetch_term_hierarchy(cur)
            users = fetch_users(cur)
            if args.limit:
                druh_per_nid = {k: v for k, v in druh_per_nid.items() if k in nids}
                misto_per_nid = {k: v for k, v in misto_per_nid.items() if k in nids}
            print(f"      → {len(druh_per_nid)} druh, {len(misto_per_nid)} mist, "
                  f"{len(parents)} hierarchy, {len(users)} autorů", flush=True)

            print("[4/6] fetch photos (1 row / fotka) …", flush=True)
            photos_per_nid = fetch_photos_per_nid(cur)
            if args.limit:
                photos_per_nid = {k: v for k, v in photos_per_nid.items() if k in nids}
            total_photos = sum(len(v) for v in photos_per_nid.values())
            print(f"      → {len(photos_per_nid)} nodes, {total_photos} fotek", flush=True)

            print("[5/7] build & zapsat master GeoJSON + lookups + search-data …", flush=True)
            # Pre-compute kraj_tid per nid (top-level region pro bucketed detail JSONs)
            kraj_per_nid = {
                nid: resolve_kraj_tid(misto_per_nid.get(nid, []), parents)
                for nid in objects
            }

            geojson = build_geojson(objects, druh_per_nid, kraj_per_nid)
            lookups = build_lookups(druh_per_nid, misto_per_nid, parents, users)
            search_data = build_search_data(objects, druh_per_nid, misto_per_nid)

            with open(os.path.join(OUT_DIR, "pamatky.geojson"), "w", encoding="utf-8") as f:
                json.dump(geojson, f, ensure_ascii=False, separators=(",", ":"))

            with open(os.path.join(OUT_DIR, "lookups.json"), "w", encoding="utf-8") as f:
                json.dump(lookups, f, ensure_ascii=False, separators=(",", ":"))

            with open(os.path.join(OUT_DIR, "search-data.json"), "w", encoding="utf-8") as f:
                json.dump(search_data, f, ensure_ascii=False, separators=(",", ":"))

            print("[6/7] zapsat bucketed detail JSONy (per kraj_tid) …", flush=True)
            # Sloučit detaily do bucketů per kraj_tid.
            # Strategie B z plánu: 14 krajů + bucket 0 pro památky bez resolution kraje.
            # Sníží Pages disk usage z ~319 MB (per-file 4 KB block padding)
            # na ~30 MB (14 souborů × ~2 MB).
            buckets = {}
            for nid, obj in objects.items():
                detail = build_detail(
                    obj,
                    druh_per_nid.get(nid),
                    misto_per_nid.get(nid, []),
                    photos_per_nid.get(nid, []),
                )
                kraj_tid = kraj_per_nid[nid]
                buckets.setdefault(kraj_tid, {})[str(nid)] = detail

            for kraj_tid, bucket in buckets.items():
                kraj_name = lookups["misto"].get(kraj_tid, {}).get("name", "(unknown)")
                with open(os.path.join(DETAILS_DIR, f"{kraj_tid}.json"), "w", encoding="utf-8") as f:
                    json.dump(bucket, f, ensure_ascii=False, separators=(",", ":"), default=str)
                print(f"      bucket {kraj_tid:>5} ({kraj_name:<22}) "
                      f"= {len(bucket):>5} památek", flush=True)

            written = sum(len(b) for b in buckets.values())
            print(f"[7/7] hotovo, {written} detailů v {len(buckets)} bucketech zapsáno",
                  flush=True)

        dt = time.time() - t0
        print(f"\nHotovo za {dt:.1f}s. Výstup: {OUT_DIR}", flush=True)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
