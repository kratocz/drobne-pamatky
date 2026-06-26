#!/usr/bin/env python3
"""
Lightweight test pro build_static_pages.slugify + build_context.
Bez frameworku - spustit přes:
  cd scripts/snapshot && uv run python test_build_static_pages.py
Exit code 0 = pass, 1 = aspoň jeden FAIL.
"""

import sys
from build_static_pages import slugify, build_context, _cf_beacon_snippet

LOOKUPS_FIXTURE = {
    "druh": {"5": "Kříž", "10": "Socha"},
    "misto": {
        "100": {"name": "Praha", "parent_tid": 0},
        "200": {"name": "Praha 1", "parent_tid": 100},
    },
    "users": {},
}

failed = 0


def check(label, actual, expected_substr_or_value, mode="eq"):
    global failed
    if mode == "eq":
        ok = (actual == expected_substr_or_value)
    elif mode == "in":
        ok = (expected_substr_or_value in actual) if actual is not None else False
    elif mode == "not_in":
        ok = (expected_substr_or_value not in actual) if actual is not None else True
    else:
        raise ValueError(mode)
    status = "OK  " if ok else "FAIL"
    print(f"  {status}  {label}")
    if not ok:
        print(f"        actual:   {actual!r}")
        print(f"        expected: {expected_substr_or_value!r} ({mode})")
        failed += 1


# ── slugify tests ──────────────────────────────────────────────────
print("slugify():")
check("normální text", slugify("Socha sv. Iva"), "socha-sv-iva")
check("diakritika", slugify("Příliš žluťoučký kůň"), "prilis-zlutoucky-kun")
check("empty string", slugify(""), "")
check("None vstup", slugify(None), "")
check("jen separátory", slugify("@#$%^&*()"), "")
check("dlouhý text (>80)", len(slugify("a" * 200)), 80)
check("trailing dash", slugify("foo --- "), "foo")

# ── build_context tests ─────────────────────────────────────────────
print("\nbuild_context():")
minimal = {
    "nid": 1234,
    "title": "Socha sv. Iva",
    "druh": {"tid": 5, "name": "Kříž"},
    "misto_termy": [100, 200],
    "gps": [14.4, 50.08],
    "fotky": [{"path": "files/2020/img.jpg", "fid": 1}],
    "popis": {"text": "Krátký popis."},
    "metadata": {"changed_ts": 1577836800},
}
ctx = build_context(1234, minimal, LOOKUPS_FIXTURE)
check("title", ctx["title"], "Socha sv. Iva")
check("slug", ctx["slug"], "socha-sv-iva")
check("canonical URL obsahuje slug", ctx["canonical"], "1234-socha-sv-iva", mode="in")
check("druh", ctx["druh"], "Kříž")
check("misto chain", ctx["misto"], "Praha", mode="in")
check("hero path", ctx["hero"], "2020/img.avif", mode="in")
check("hero_abs absolutní", ctx["hero_abs"], "https://", mode="in")
check("description z popisu", ctx["description"], "Krátký popis", mode="in")
check("popis_html escapovaný", ctx["popis_html"], "Krátký popis", mode="in")
check("jsonld obsahuje Place", ctx["jsonld"], "Place", mode="in")
check("jsonld obsahuje geo", ctx["jsonld"], "GeoCoordinates", mode="in")
check("jsonld_breadcrumb existuje", ctx["jsonld_breadcrumb"], "BreadcrumbList", mode="in")
check("jsonld_breadcrumb obsahuje title", ctx["jsonld_breadcrumb"], "Socha sv. Iva", mode="in")
check("jsonld_breadcrumb obsahuje Drobné památky", ctx["jsonld_breadcrumb"], "Drobné památky", mode="in")
check("jsonld_breadcrumb XSS-safe (< escaped)", ctx["jsonld_breadcrumb"], "<", mode="not_in")

# Edge: prázdný popis → fallback description
empty_popis = dict(minimal)
empty_popis["popis"] = {}
ctx2 = build_context(1234, empty_popis, LOOKUPS_FIXTURE)
check("fallback description bez popisu", ctx2["description"], "Drobná památka", mode="in")
check("popis_html prázdný", ctx2["popis_html"], "")

# Edge: prázdné fotky → hero=None
no_fotky = dict(minimal)
no_fotky["fotky"] = []
ctx3 = build_context(1234, no_fotky, LOOKUPS_FIXTURE)
check("hero=None bez fotek", ctx3["hero"], None)
check("hero_abs=None bez fotek", ctx3["hero_abs"], None)

# XSS sanity: title se <script> tagem → escaped v jsonld i popis_html
xss = dict(minimal)
xss["title"] = "<script>alert(1)</script>"
xss["popis"] = {"text": "<script>alert(2)</script>"}
ctx4 = build_context(1234, xss, LOOKUPS_FIXTURE)
check("title escapován v popis_html context", ctx4["popis_html"], "&lt;script&gt;", mode="in")
check("popis_html neobsahuje exec script", ctx4["popis_html"], "<script>alert", mode="not_in")
check("jsonld breadcrumb XSS-safe (title)", ctx4["jsonld_breadcrumb"], "<script>", mode="not_in")

# ── cf_beacon (issue #14) ──────────────────────────────────────────
print("\ncf_beacon:")
import os as _os

# build_context default cf_beacon → prázdný
check("build_context bez cf_beacon → prázdný", build_context(1234, minimal, LOOKUPS_FIXTURE).get("cf_beacon", "MISSING"), "")
# build_context s cf_beacon param → vloží
ctx_b = build_context(1234, minimal, LOOKUPS_FIXTURE, cf_beacon="<beacon-snippet>")
check("build_context s cf_beacon → vloží", ctx_b["cf_beacon"], "<beacon-snippet>")

# _cf_beacon_snippet: validní 32-hex token
_os.environ["CF_BEACON_TOKEN"] = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
check("snippet validní token → obsahuje beacon.min.js", _cf_beacon_snippet(), "beacon.min.js", mode="in")
check("snippet validní token → obsahuje token", _cf_beacon_snippet(), "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", mode="in")
check("snippet validní token → má defer", _cf_beacon_snippet(), "<script defer", mode="in")
# nevalidní token (krátký)
_os.environ["CF_BEACON_TOKEN"] = "xyz"
check("snippet nevalidní token → prázdný", _cf_beacon_snippet(), "")
# XSS pokus v tokenu
_os.environ["CF_BEACON_TOKEN"] = "'><script>alert(1)</script>"
check("snippet XSS token → prázdný", _cf_beacon_snippet(), "")
# bez env
del _os.environ["CF_BEACON_TOKEN"]
check("snippet bez env → prázdný", _cf_beacon_snippet(), "")

print()
total = 37
print(f"{total - failed}/{total} passed")
sys.exit(0 if failed == 0 else 1)
