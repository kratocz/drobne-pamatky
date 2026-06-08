#!/usr/bin/env python3
"""
Lightweight test skript pro sanitize_body z export.py.
Bez frameworku - spustit přes:
  cd scripts/snapshot && uv run python test_sanitize.py
Exit code 0 = všechny case pass, 1 = aspoň jeden FAIL.
"""

import sys
from export import sanitize_body

# (input, format, expectation, description)
# expectation:
#   None       → očekáváme None (text byl prázdný)
#   ('in', s)  → očekáváme, že 's' je substring výsledku
#   ('out', s) → očekáváme, že 's' NENÍ substring výsledku
#
# Heuristickou nav-dump detekci jsme z sanitize_body vypustili
# (false-positives na seznamech jmen padlých). bleach + DOMPurify drží
# XSS protection. Případné cizí nav-dumpy vidí uživatel jako zvláštní text,
# ne jako bezpečnostní problém.
CASES = [
    ('',                                                  1, None,                      'empty string → None'),
    (None,                                                1, None,                      'None → None'),
    ('   \n\n   ',                                        1, None,                      'whitespace only → None'),
    ('<script>alert(1)</script>Hello',                    1, ('out', '<script>'),       'script tag stripped'),
    ('<script>alert(1)</script>Hello',                    1, ('in', 'Hello'),           'text after script preserved'),
    ('<a href="javascript:alert(1)">x</a>',               1, ('out', 'javascript:'),    'javascript: protocol blocked'),
    ('<a href="https://ok.cz" onclick="bad()">x</a>',     1, ('out', 'onclick'),        'onclick attribute stripped'),
    ('<a href="https://ok.cz" onclick="bad()">x</a>',     1, ('in', 'href="https://ok.cz"'), 'href atribut zachován'),
    ('Kaple sv. Jana.\nPostavena 1885.\nObnova 2010.',    1, ('in', 'Kaple'),           'real text kept'),
    ('<b>bold</b> a <em>italic</em>',                     1, ('out', '<b>'),            '<b> stripped (mimo whitelist)'),
    ('<b>bold</b> a <em>italic</em>',                     1, ('in', '<em>italic</em>'), '<em> zachován'),
    ('<a href="http://x.cz" rel="nofollow">x</a>',        2, ('out', '<a'),             'format=2 strips all tags'),
    ('<a href="http://x.cz" rel="nofollow">x</a>',        2, ('in', 'x'),               'format=2 text zachován'),
]


def check(text, fmt, expectation, desc):
    got = sanitize_body(text, fmt)
    if expectation is None:
        return (got is None), got
    kind, needle = expectation
    if got is None:
        return False, got
    if kind == 'in':
        return (needle in got), got
    if kind == 'out':
        return (needle not in got), got
    raise ValueError(f'unknown expectation kind: {kind}')


def main():
    failed = 0
    for text, fmt, expectation, desc in CASES:
        ok, got = check(text, fmt, expectation, desc)
        status = 'OK  ' if ok else 'FAIL'
        print(f'  {status}  {desc:60}  → {got!r}')
        if not ok:
            failed += 1
    print()
    print(f'{len(CASES) - failed}/{len(CASES)} passed')
    sys.exit(0 if failed == 0 else 1)


if __name__ == '__main__':
    main()
