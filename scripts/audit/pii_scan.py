#!/usr/bin/env python3
"""
PII audit skript pro `popis.text` z `data/details/*.json` (issue #9).

Cíl: detekovat potenciální PII v komunitních popisech, které jsme přenesli
z původního Drupal 6 webu do statického exportu. Po deploy jsou texty
permanentně v git historii a indexovatelné vyhledávači.

Spuštění:
  cd scripts/audit
  python3 pii_scan.py                          # default: data/details/
  python3 pii_scan.py --details PATH           # vlastní cesta
  python3 pii_scan.py --random-samples 30      # počet random vzorků (default 30)
  python3 pii_scan.py --pattern-matches 10     # max ukázek per pattern (default 10)
  python3 pii_scan.py --output report.md       # markdown report (default stdout)

Žádné závislosti — jen Python 3 stdlib.
"""

import argparse
import glob
import json
import os
import random
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DETAILS = REPO_ROOT / "data" / "details"

# ── Detection patterny ────────────────────────────────────────────────
# Konzervativní — preferujeme false-positives před false-negatives.

PATTERNS = {
    "email": re.compile(
        r"\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b"
    ),
    "phone_cz": re.compile(
        # CZ telefon: +420 / 00420 prefix nebo 9 digits ve formátu 3+3+3
        r"(?:\+420\s?|00420\s?)?(?:\d{3}[\s/-]?){2}\d{3}\b"
    ),
    "url_personal_profile": re.compile(
        # Profily sociálních sítí - typicky PII vector
        r"\b(?:facebook\.com|instagram\.com|linkedin\.com|twitter\.com|x\.com)/[A-Za-z0-9._-]+",
        re.IGNORECASE,
    ),
    "url_personal_website": re.compile(
        # Osobní weby (drupalní field_wiki je legit URL, ale tady chytíme jen v `popis.text`)
        r"https?://[a-zA-Z0-9.-]+\.(?:cz|sk|com|net|eu|org|info)(?:/[^\s<>'\"]*)?",
        re.IGNORECASE,
    ),
    # Typicky "Autorem fotografie je Jméno Příjmení" / "podle pana Jméno Příjmení" / "Jan Novák, Praha"
    # Jen capitalized full names, ale obecně FALSE-POSITIVE-prone (jména světců, historických osob).
    # Necháváme jako "lower-confidence" signal pro manuální review.
    "person_name_pattern": re.compile(
        r"\b(?:autor(?:em|kou)?|pan|paní|podle|dle)\s+(?:[A-ZČŘŠŽÁÉÍÓÚŮ][a-zčřšžáéíóúůý]+\s+){1,2}[A-ZČŘŠŽÁÉÍÓÚŮ][a-zčřšžáéíóúůý]+\b"
    ),
    # Adresa pattern: jméno ulice + číslo
    "address_street_number": re.compile(
        r"\b[A-ZČŘŠŽÁÉÍÓÚŮ][a-zčřšžáéíóúůý]+(?:ova|ská|cká|ní)\s+\d{1,4}\b"
    ),
    # Citace s rodným číslem (CZ format: 9-10 digits with optional slash, /\d{4}/)
    "rodne_cislo": re.compile(
        r"\b\d{6}\s?/?\s?\d{3,4}\b"
    ),
}


def load_all_texts(details_dir):
    """Vyhledá všechny popis.text napříč buckety. Vrací list of (nid, bucket, text)."""
    texts = []
    for path in sorted(glob.glob(str(Path(details_dir) / "*.json"))):
        bucket = Path(path).stem
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        for nid, detail in data.items():
            text = detail.get("popis", {}).get("text")
            if text:
                texts.append((nid, bucket, text))
    return texts


def context_snippet(text, match_start, match_end, ctx_chars=40):
    """Vrátí výňatek textu s match v něm, ±N znaků kontextu."""
    start = max(0, match_start - ctx_chars)
    end = min(len(text), match_end + ctx_chars)
    snippet = text[start:end]
    if start > 0:
        snippet = "…" + snippet
    if end < len(text):
        snippet = snippet + "…"
    # Highlight match
    rel_start = match_start - start + (1 if start > 0 else 0)
    rel_end = match_end - start + (1 if start > 0 else 0)
    return (snippet[:rel_start]
            + "**" + snippet[rel_start:rel_end] + "**"
            + snippet[rel_end:]).replace("\n", " ")


def scan_patterns(texts, max_per_pattern=10):
    """Spočítá výskyt per pattern. Vrací dict pattern → list of (nid, snippet, match)."""
    findings = defaultdict(list)
    pattern_counts = Counter()

    for nid, bucket, text in texts:
        for pname, regex in PATTERNS.items():
            for m in regex.finditer(text):
                pattern_counts[pname] += 1
                if len(findings[pname]) < max_per_pattern:
                    findings[pname].append({
                        "nid": nid,
                        "bucket": bucket,
                        "match": m.group(0),
                        "snippet": context_snippet(text, m.start(), m.end()),
                    })

    return findings, pattern_counts


def random_samples(texts, n=30, seed=42):
    """Vybere n náhodných záznamů pro manuální review."""
    rng = random.Random(seed)
    return rng.sample(texts, min(n, len(texts)))


def format_report(texts, findings, counts, samples, args):
    """Markdown report."""
    lines = []
    lines.append("# PII audit report: popis.text v data/details/")
    lines.append("")
    lines.append(f"**Datum:** 2026-06-11  ·  **Issue:** #9  ·  **Skript:** `scripts/audit/pii_scan.py`")
    lines.append("")
    lines.append(f"## Souhrn")
    lines.append("")
    lines.append(f"- Celkem skenovaných záznamů s `popis.text`: **{len(texts)}**")
    lines.append(f"- Random vzorky pro manuální review: {len(samples)}")
    lines.append(f"- Max ukázek per pattern: {args.pattern_matches}")
    lines.append("")
    lines.append("### Pattern detection (počet výskytů)")
    lines.append("")
    lines.append("| Pattern | Počet | False-positive risk |")
    lines.append("|---|---:|---|")
    risk_notes = {
        "email": "Nízké",
        "phone_cz": "Středně (matches roky 1918, 1945 apod.)",
        "url_personal_profile": "Nízké",
        "url_personal_website": "Vysoké (legit attribution/citace)",
        "person_name_pattern": "Vysoké (svatí, historické osoby, donátoři)",
        "address_street_number": "Nízké",
        "rodne_cislo": "Středně",
    }
    for pname in PATTERNS:
        cnt = counts.get(pname, 0)
        risk = risk_notes.get(pname, "?")
        lines.append(f"| `{pname}` | {cnt} | {risk} |")
    lines.append("")

    lines.append("## Findings per pattern (ukázky)")
    lines.append("")
    for pname in PATTERNS:
        cnt = counts.get(pname, 0)
        if cnt == 0:
            lines.append(f"### `{pname}` — 0 výskytů ✓")
            lines.append("")
            continue
        lines.append(f"### `{pname}` — {cnt} výskytů")
        lines.append("")
        for f in findings[pname]:
            lines.append(f"- nid **{f['nid']}** (bucket {f['bucket']}): `{f['match']}`")
            lines.append(f"  > {f['snippet']}")
        lines.append("")

    lines.append("## Random samples pro manuální review")
    lines.append("")
    lines.append("Tyto vzorky jsou vybrány náhodně (seed=42, reproducible). "
                 "Projdi je očima a hledej PII typů, které regex nezachytil.")
    lines.append("")
    for nid, bucket, text in samples:
        truncated = text[:500] + ("…" if len(text) > 500 else "")
        truncated = truncated.replace("\n", " ").replace("  ", " ")
        lines.append(f"### nid {nid} (bucket {bucket})")
        lines.append("")
        lines.append(f"> {truncated}")
        lines.append("")
        lines.append(f"<sub>URL: https://www.drobnepamatky.cz/node/{nid}</sub>")
        lines.append("")

    lines.append("## Doporučení k rozhodnutí")
    lines.append("")
    lines.append("Pro každý významný pattern (>0 výskytů) rozhodnout:")
    lines.append("")
    lines.append("1. **Accept**: PII risk je akceptovatelný (např. URL na drobnepamatky.cz)")
    lines.append("2. **Redact**: Doplnit sanitization patternu do `sanitize_body` v `export.py`")
    lines.append("3. **Per-nid blacklist**: Smazat konkrétní záznamy z exportu")
    lines.append("4. **Opt-out kanál**: Přidat README/AGENTS info o tom, jak požádat o odstranění")
    lines.append("")
    lines.append("Pokud rozhodnutí 2 nebo 3 → samostatný issue na implementaci + redeploy.")
    return "\n".join(lines) + "\n"


def main():
    p = argparse.ArgumentParser(description="PII audit pro popis.text (issue #9)")
    p.add_argument("--details", default=str(DEFAULT_DETAILS),
                   help=f"Cesta k details adresáři (default: {DEFAULT_DETAILS})")
    p.add_argument("--random-samples", type=int, default=30,
                   help="Počet náhodných vzorků pro manuální review (default: 30)")
    p.add_argument("--pattern-matches", type=int, default=10,
                   help="Max ukázek per pattern (default: 10)")
    p.add_argument("--output", default=None,
                   help="Výstupní markdown soubor (default: stdout)")
    args = p.parse_args()

    print(f"Načítám {args.details}/*.json …", file=sys.stderr)
    texts = load_all_texts(args.details)
    print(f"  → {len(texts)} záznamů s popis.text", file=sys.stderr)

    print(f"Skenuji patterny …", file=sys.stderr)
    findings, counts = scan_patterns(texts, max_per_pattern=args.pattern_matches)
    for pname, cnt in counts.most_common():
        print(f"  {pname:30} {cnt:>6}", file=sys.stderr)

    print(f"Vybírám {args.random_samples} náhodných vzorků …", file=sys.stderr)
    samples = random_samples(texts, n=args.random_samples)

    print(f"Generuji report …", file=sys.stderr)
    report = format_report(texts, findings, counts, samples, args)

    if args.output:
        Path(args.output).write_text(report, encoding="utf-8")
        print(f"Hotovo. Report: {args.output}", file=sys.stderr)
    else:
        print(report)


if __name__ == "__main__":
    main()
