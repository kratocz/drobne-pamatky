#!/usr/bin/env python3
"""
Pilot export 10 publikovaných památek z lokální MariaDB (gk66 mirror) do JSON formátů
plánovaných pro L1 deployment.

Výstup do scripts/snapshot/out/:
  - pamatky-pilot.geojson         master GeoJSON (10 features, krátké property names)
  - lookups-pilot.json            druh + obec ID → název (jen použité v pilotu)
  - details/<nid>.json            detail per památka (lazy-load target)

Spuštění:
  cd scripts/snapshot
  source venv/bin/activate
  python export_pilot.py
"""

import json
import os
import pymysql

DB_CFG = dict(host="127.0.0.1", port=13306, user="root", password="REDACTED",
              database="gk66", charset="utf8")

OUT_DIR = os.path.join(os.path.dirname(__file__), "out")
DETAILS_DIR = os.path.join(OUT_DIR, "details")
PILOT_LIMIT = 10


def connect():
    return pymysql.connect(**DB_CFG, cursorclass=pymysql.cursors.DictCursor)


def fetch_pilot_nids(cur):
    """10 nejnovějších publikovaných objektů s GPS."""
    cur.execute(
        """
        SELECT n.nid
        FROM node n
        JOIN content_type_objekt cto ON cto.nid = n.nid AND cto.vid = n.vid
        JOIN location l ON l.lid = cto.field_pozice_lid
        WHERE n.type = 'objekt' AND n.status = 1
          AND l.latitude != 0 AND l.longitude != 0
        ORDER BY n.nid DESC
        LIMIT %s
        """,
        (PILOT_LIMIT,),
    )
    return [r["nid"] for r in cur.fetchall()]


def fetch_objects(cur, nids):
    """Základní data – jeden řádek per památka. Druh se dotazuje zvlášť."""
    placeholders = ",".join(["%s"] * len(nids))
    cur.execute(
        f"""
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
        WHERE n.nid IN ({placeholders})
        """,
        nids,
    )
    return {r["nid"]: r for r in cur.fetchall()}


def fetch_druh_per_nid(cur, nids):
    """Druh památky (vocabulary id 5)."""
    placeholders = ",".join(["%s"] * len(nids))
    cur.execute(
        f"""
        SELECT tn.nid, td.tid, td.name
        FROM term_node tn
        JOIN term_data td ON td.tid = tn.tid AND td.vid = 5
        WHERE tn.nid IN ({placeholders})
        """,
        nids,
    )
    out = {}
    for r in cur.fetchall():
        out[r["nid"]] = {"tid": r["tid"], "name": r["name"]}
    return out


def fetch_misto_per_nid(cur, nids):
    """
    Územní hierarchie (vocabulary 4 = Správní rozdělení).
    Vrátí nejhlubší term (nejvyšší úroveň specifity) – typicky obec nebo ku.
    Plus rozpad hierarchie přes term_hierarchy.parent.
    """
    placeholders = ",".join(["%s"] * len(nids))
    cur.execute(
        f"""
        SELECT tn.nid, td.tid, td.name
        FROM term_node tn
        JOIN term_data td ON td.tid = tn.tid AND td.vid = 4
        WHERE tn.nid IN ({placeholders})
        """,
        nids,
    )
    rows_per_nid = {}
    for r in cur.fetchall():
        rows_per_nid.setdefault(r["nid"], []).append(r)
    # Sestavíme hierarchii: pro pilot vrátíme všechny termy + necháme klienta určit obec/kraj
    return rows_per_nid


def fetch_term_hierarchy(cur, tids):
    """Pro daný seznam tids vrátí mapping tid → parent_tid (vid=4)."""
    if not tids:
        return {}
    placeholders = ",".join(["%s"] * len(tids))
    cur.execute(
        f"""
        SELECT tid, parent FROM term_hierarchy
        WHERE tid IN ({placeholders})
        """,
        tids,
    )
    return {r["tid"]: r["parent"] for r in cur.fetchall()}


def fetch_photos_per_nid(cur, nids):
    """Obrázky vázané na uzly přes content_field_obrazek."""
    placeholders = ",".join(["%s"] * len(nids))
    cur.execute(
        f"""
        SELECT
          cfo.nid, cfo.delta,
          cfo.field_obrazek_fid AS fid,
          cfo.field_obrazek_data AS metadata_serialized,
          f.filepath, f.filename, f.filesize, f.uid AS uploader_uid
        FROM content_field_obrazek cfo
        JOIN files f ON f.fid = cfo.field_obrazek_fid
        JOIN node n ON n.nid = cfo.nid AND n.vid = cfo.vid
        WHERE cfo.nid IN ({placeholders})
        ORDER BY cfo.nid, cfo.delta
        """,
        nids,
    )
    by_nid = {}
    for r in cur.fetchall():
        by_nid.setdefault(r["nid"], []).append(r)
    return by_nid


def build_geojson(objects, druh_per_nid):
    """Master GeoJSON – krátké property names: n, d, o, i, t."""
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
            },
        })
    return {"type": "FeatureCollection", "features": features}


def build_lookups(druh_per_nid, misto_per_nid, parents):
    """Sběr použitých druh/místo termů pro pilot lookups.json."""
    druhy = {}
    for d in druh_per_nid.values():
        druhy[d["tid"]] = d["name"]

    mista = {}
    for rows in misto_per_nid.values():
        for r in rows:
            mista[r["tid"]] = {"name": r["name"], "parent_tid": parents.get(r["tid"], 0)}
    return {"druh": druhy, "misto": mista}


def build_detail(obj, druh, misto_rows, photos):
    """Detail JSON per památka – plný metadata + fotky."""
    return {
        "nid": obj["nid"],
        "title": obj["title"],
        "druh": druh,
        "misto_termy": [{"tid": r["tid"], "name": r["name"]} for r in misto_rows],
        "gps": {
            "lat": float(obj["latitude"]),
            "lon": float(obj["longitude"]),
        },
        "metadata": {
            "pridano": obj["pridano_text"],
            "nkpid": obj["nkpid"],
            "licence": obj["licence"],
            "wikidata_qid": obj["wikidata_qid"],
            "author_uid": obj["author_uid"],
            "created_ts": obj["created"],
            "changed_ts": obj["changed"],
        },
        "popis": {
            "zvlastnost": obj["popis_zvlastnost"],
            "oborano": obj["popis_oborano"],
            "wiki": obj["wiki_popis"],
            "cesta": obj["cesta_popis"],
            "sidlo": obj["sidlo"],
        },
        "fotky": [
            {
                "fid": p["fid"],
                "delta": p["delta"],
                "filepath": p["filepath"],
                "filename": p["filename"],
                "filesize": p["filesize"],
                "uploader_uid": p["uploader_uid"],
            }
            for p in photos
        ],
    }


def main():
    os.makedirs(DETAILS_DIR, exist_ok=True)

    conn = connect()
    try:
        with conn.cursor() as cur:
            nids = fetch_pilot_nids(cur)
            print(f"Pilot nidy: {nids}")

            objects = fetch_objects(cur, nids)
            druh_per_nid = fetch_druh_per_nid(cur, nids)
            misto_per_nid = fetch_misto_per_nid(cur, nids)
            photos_per_nid = fetch_photos_per_nid(cur, nids)

            all_misto_tids = {r["tid"] for rows in misto_per_nid.values() for r in rows}
            parents = fetch_term_hierarchy(cur, list(all_misto_tids))

            geojson = build_geojson(objects, druh_per_nid)
            lookups = build_lookups(druh_per_nid, misto_per_nid, parents)

            with open(os.path.join(OUT_DIR, "pamatky-pilot.geojson"), "w", encoding="utf-8") as f:
                json.dump(geojson, f, ensure_ascii=False, separators=(",", ":"))

            with open(os.path.join(OUT_DIR, "lookups-pilot.json"), "w", encoding="utf-8") as f:
                json.dump(lookups, f, ensure_ascii=False, indent=2)

            for nid in nids:
                detail = build_detail(
                    objects[nid],
                    druh_per_nid.get(nid),
                    misto_per_nid.get(nid, []),
                    photos_per_nid.get(nid, []),
                )
                with open(os.path.join(DETAILS_DIR, f"{nid}.json"), "w", encoding="utf-8") as f:
                    json.dump(detail, f, ensure_ascii=False, indent=2, default=str)

        print(f"Hotovo. Výstup: {OUT_DIR}")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
