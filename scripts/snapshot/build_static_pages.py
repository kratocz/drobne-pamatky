#!/usr/bin/env python3
"""
Per-pamatka HTML + sitemap builder (issue #5).

Vstup: out/details/*.json, out/lookups.json
Výstup:
  out/pamatka/<nid>-<slug>/index.html × ~82k
  out/sitemap.xml (index)
  out/sitemap-<kraj-slug>.xml × 15
  out/robots.txt

Spuštění:
  cd scripts/snapshot
  uv run python build_static_pages.py                 # full
  uv run python build_static_pages.py --limit 100     # pilot
  uv run python build_static_pages.py --workers 4     # méně paralelismu
"""

import argparse
import json
import os
import re
import time
import unicodedata
from multiprocessing import Pool
from pathlib import Path

from jinja2 import Environment, FileSystemLoader, select_autoescape
from markupsafe import escape

REPO_ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = Path(__file__).parent / "out"
TEMPLATES_DIR = Path(__file__).parent / "templates"

SITE_BASE = "https://kratocz.github.io/drobne-pamatky/"
BASE_PATH = "/drobne-pamatky/"

KRAJ_SLUGS = {
    0: "ostatni", 1: "praha", 2: "stredocesky", 3: "jihocesky", 4: "plzensky",
    5: "karlovarsky", 6: "ustecky", 7: "liberecky", 8: "kralovehradecky",
    9: "pardubicky", 10: "vysocina", 11: "jihomoravsky", 12: "olomoucky",
    13: "moravskoslezsky", 14: "zlinsky",
}


def slugify(text):
    """Diakritika striped, lowercase, jen [a-z0-9-], max 80 znaků, žádné trailing dashes.
    None / nestring → ''."""
    if not text:
        return ""
    nfkd = unicodedata.normalize("NFKD", str(text))
    ascii_text = "".join(c for c in nfkd if not unicodedata.combining(c))
    s = re.sub(r"[^a-zA-Z0-9]+", "-", ascii_text.lower()).strip("-")
    return s[:80].rstrip("-")


def build_context(nid, detail, lookups):
    """Připraví dict pro jinja2 page.html.j2 render."""
    title = detail.get("title", "") or ""
    popis_block = detail.get("popis") or {}
    popis_text = popis_block.get("text") or popis_block.get("teaser") or ""

    if len(popis_text) > 155:
        description = popis_text[:150].rstrip() + "…"
    elif popis_text:
        description = popis_text
    else:
        description = f"Drobná památka {title} v ČR."

    druh = (detail.get("druh") or {}).get("name", "") or ""

    misto_chain = []
    for tid in detail.get("misto_termy") or []:
        info = lookups["misto"].get(str(tid))
        if info:
            misto_chain.append(info["name"])
    misto = " › ".join(misto_chain[:3])

    gps = detail.get("gps") or [0, 0]
    lng, lat = gps[0], gps[1]

    fotky = detail.get("fotky") or []
    hero = hero_abs = None
    if fotky:
        path = fotky[0].get("path", "")
        if "/" in path:
            # files/2020/img.jpg → 2020/img.avif
            avif = path.split("/", 1)[1].replace(".jpg", ".avif")
            hero = f"{BASE_PATH}data/thumbs/{avif}"
            hero_abs = f"{SITE_BASE}data/thumbs/{avif}"

    slug = slugify(title)
    canonical = f"{SITE_BASE}pamatka/{nid}-{slug}/"

    # popis_html: bleach-sanitized z #8; \n → <br>. markupsafe.escape pro defense in depth.
    popis_html = str(escape(popis_text)).replace("\n", "<br>") if popis_text else ""

    jsonld = json.dumps({
        "@context": "https://schema.org",
        "@type": "Place",
        "name": title,
        "description": description,
        **({"image": hero_abs} if hero_abs else {}),
        "geo": {"@type": "GeoCoordinates", "latitude": lat, "longitude": lng},
        "url": canonical,
        "isPartOf": {"@type": "WebSite", "name": "Drobné památky", "url": SITE_BASE},
    }, ensure_ascii=False, separators=(",", ":"))

    return {
        "nid": nid, "slug": slug, "title": title, "description": description,
        "canonical": canonical, "base_path": BASE_PATH,
        "druh": druh, "misto": misto,
        "hero": hero, "hero_abs": hero_abs,
        "popis_html": popis_html, "lat": lat, "lng": lng,
        "jsonld": jsonld,
    }


# ── Worker (multiprocessing.Pool) ───────────────────────────────────
_WORKER_STATE = {}


def _init_worker(lookups_path, template_dir):
    """Per-proces init: nahrát lookups + zkompilovat šablonu jednou."""
    _WORKER_STATE["lookups"] = json.loads(Path(lookups_path).read_text(encoding="utf-8"))
    # nosemgrep: python.flask.security.xss.audit.direct-use-of-jinja2.direct-use-of-jinja2
    env = Environment(
        loader=FileSystemLoader(str(template_dir)),
        autoescape=select_autoescape(["html", "xml"]),
        trim_blocks=True, lstrip_blocks=True,
    )
    _WORKER_STATE["tpl"] = env.get_template("page.html.j2")


def minify_html(html):
    """Trivální minifikace: smazat řádky které jsou jen whitespace, strip vodorovný
    whitespace mezi tagy (`>\\s+<` → `><`). Zachovává obsah uvnitř <script> a <p>
    bloků (popis_html má významný whitespace). Úspora ~25 % na slim+ layoutu.
    """
    # Strip whitespace mezi tagy (mimo content)
    html = re.sub(r">\s+<", "><", html)
    # Strip vedoucí whitespace na řádcích
    html = re.sub(r"\n\s+", "\n", html)
    # Drop duplicate newlines
    html = re.sub(r"\n+", "\n", html)
    return html.strip()


def _render_one(args):
    """Render 1 stránka. Vrací (nid, slug, lastmod, kraj_tid, status)."""
    nid, detail, kraj_tid = args
    try:
        ctx = build_context(nid, detail, _WORKER_STATE["lookups"])
        html = _WORKER_STATE["tpl"].render(**ctx)
        html = minify_html(html)
        target_dir = OUT_DIR / "pamatka" / f"{nid}-{ctx['slug']}"
        target_dir.mkdir(parents=True, exist_ok=True)
        (target_dir / "index.html").write_text(html, encoding="utf-8")
        meta = detail.get("metadata") or {}
        ts = meta.get("changed_ts") or meta.get("created_ts") or 0
        lastmod = time.strftime("%Y-%m-%d", time.gmtime(int(ts))) if ts else ""
        return (nid, ctx["slug"], lastmod, kraj_tid, "ok")
    except Exception as e:
        return (nid, "", "", kraj_tid, f"err: {type(e).__name__}: {e}")


# ── Orchestrátor ────────────────────────────────────────────────────
def load_all_inputs(limit=None):
    """Načte details bucket files. Vrací (items, lookups), items = list (nid, detail, kraj_tid)."""
    lookups = json.loads((OUT_DIR / "lookups.json").read_text(encoding="utf-8"))
    items = []
    for bucket_path in sorted((OUT_DIR / "details").glob("*.json")):
        kraj_tid = int(bucket_path.stem)
        data = json.loads(bucket_path.read_text(encoding="utf-8"))
        for nid, detail in data.items():
            items.append((int(nid), detail, kraj_tid))
            if limit and len(items) >= limit:
                return items, lookups
    return items, lookups


def write_sitemaps(rendered, build_date, env):
    """Per-kraj sitemap + master index + robots.txt."""
    by_kraj = {}
    for nid, slug, lastmod, kraj_tid, status in rendered:
        if status != "ok":
            continue
        by_kraj.setdefault(kraj_tid, []).append({
            "canonical": f"{SITE_BASE}pamatka/{nid}-{slug}/",
            "lastmod": lastmod or build_date,
        })

    sitemap_tpl = env.get_template("sitemap.xml.j2")
    index_entries = []
    for kraj_tid in sorted(by_kraj.keys()):
        slug = KRAJ_SLUGS.get(kraj_tid, f"kraj-{kraj_tid}")
        xml = sitemap_tpl.render(pages=by_kraj[kraj_tid])  # nosemgrep: python.flask.security.xss.audit.direct-use-of-jinja2.direct-use-of-jinja2
        (OUT_DIR / f"sitemap-{slug}.xml").write_text(xml, encoding="utf-8")
        index_entries.append({"slug": slug})

    idx_tpl = env.get_template("sitemap-index.xml.j2")
    (OUT_DIR / "sitemap.xml").write_text(
        idx_tpl.render(krajse=index_entries, site_base=SITE_BASE, build_date=build_date),  # nosemgrep: python.flask.security.xss.audit.direct-use-of-jinja2.direct-use-of-jinja2
        encoding="utf-8",
    )

    robots_tpl = env.get_template("robots.txt.j2")
    (OUT_DIR / "robots.txt").write_text(
        robots_tpl.render(site_base=SITE_BASE), encoding="utf-8",  # nosemgrep: python.flask.security.xss.audit.direct-use-of-jinja2.direct-use-of-jinja2
    )


def main():
    p = argparse.ArgumentParser(description="Per-pamatka HTML + sitemap (issue #5)")
    p.add_argument("--limit", type=int, default=None, help="Pilot: jen N záznamů")
    p.add_argument("--workers", type=int, default=os.cpu_count() or 4)
    args = p.parse_args()

    (OUT_DIR / "pamatka").mkdir(parents=True, exist_ok=True)

    print("Načítám details + lookups …", flush=True)
    items, _ = load_all_inputs(limit=args.limit)
    print(f"  → {len(items)} záznamů", flush=True)

    t0 = time.time()
    print(f"Renderuji ({args.workers} workers) …", flush=True)
    init_args = (str(OUT_DIR / "lookups.json"), str(TEMPLATES_DIR))
    rendered = []
    counts = {"ok": 0, "err": 0}
    with Pool(args.workers, initializer=_init_worker, initargs=init_args) as pool:
        for i, result in enumerate(
            pool.imap_unordered(_render_one, items, chunksize=200), 1
        ):
            rendered.append(result)
            counts["ok" if result[4] == "ok" else "err"] += 1
            if i % 5000 == 0 or i == len(items):
                rate = i / (time.time() - t0)
                print(f"  {i:>6}/{len(items)}  ok={counts['ok']}  err={counts['err']}  {rate:.0f} stránek/s",
                      flush=True)

    build_date = time.strftime("%Y-%m-%d", time.gmtime())
    print("Zapisuji sitemap + robots …", flush=True)
    # nosemgrep: python.flask.security.xss.audit.direct-use-of-jinja2.direct-use-of-jinja2
    env = Environment(
        loader=FileSystemLoader(str(TEMPLATES_DIR)),
        autoescape=select_autoescape(["html", "xml"]),
        trim_blocks=True, lstrip_blocks=True,
    )
    write_sitemaps(rendered, build_date, env)

    dt = time.time() - t0
    print(f"\nHotovo za {dt:.1f}s ({len(items)/dt:.0f} stránek/s, {counts['ok']} ok, {counts['err']} err)",
          flush=True)
    if counts["err"]:
        first_errs = [r for r in rendered if r[4] != "ok"][:5]
        print("První err:", flush=True)
        for r in first_errs:
            print(f"  nid={r[0]}: {r[4]}", flush=True)


if __name__ == "__main__":
    main()
