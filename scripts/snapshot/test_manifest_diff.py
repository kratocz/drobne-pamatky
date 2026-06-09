#!/usr/bin/env python3
"""
Lightweight test pro sync_manifest_diff.compute_diff.
Bez frameworku - spustit přes:
  cd scripts/snapshot && uv run python test_manifest_diff.py
Exit code 0 = pass, 1 = aspoň jeden FAIL.
"""

import sys
from sync_manifest_diff import compute_diff


# (wanted, existing, expected_generate, expected_delete, expected_rsync, description)
CASES = [
    (
        {},
        {},
        [], [], [],
        "empty wanted + empty existing → no action",
    ),
    (
        # wanted has new entry → generate + rsync
        {"2020/img_1.avif": {"filepath": "files/2020/img_1.jpg", "fid": 1, "size": 100, "timestamp": 1577836800}},
        {},
        ["2020/img_1.avif"], [], ["files/2020/img_1.jpg"],
        "new entry → generate + rsync",
    ),
    (
        # existing has stale entry → delete
        {},
        {"2020/img_1.avif": {"fid": 1, "size": 100, "timestamp": 1577836800}},
        [], ["2020/img_1.avif"], [],
        "stale entry → delete",
    ),
    (
        # both identical → no action
        {"2020/img_1.avif": {"filepath": "files/2020/img_1.jpg", "fid": 1, "size": 100, "timestamp": 1577836800}},
        {"2020/img_1.avif": {"fid": 1, "size": 100, "timestamp": 1577836800}},
        [], [], [],
        "identical → no action",
    ),
    (
        # differ in size → regenerate
        {"2020/img_1.avif": {"filepath": "files/2020/img_1.jpg", "fid": 1, "size": 200, "timestamp": 1577836800}},
        {"2020/img_1.avif": {"fid": 1, "size": 100, "timestamp": 1577836800}},
        ["2020/img_1.avif"], [], ["files/2020/img_1.jpg"],
        "size differs → regenerate",
    ),
    (
        # differ in timestamp → regenerate
        {"2020/img_1.avif": {"filepath": "files/2020/img_1.jpg", "fid": 1, "size": 100, "timestamp": 1609459200}},
        {"2020/img_1.avif": {"fid": 1, "size": 100, "timestamp": 1577836800}},
        ["2020/img_1.avif"], [], ["files/2020/img_1.jpg"],
        "timestamp differs → regenerate",
    ),
]


def main():
    failed = 0
    for i, (wanted, existing, exp_gen, exp_del, exp_rsync, desc) in enumerate(CASES, 1):
        gen, deleted, rsync = compute_diff(wanted, existing)
        ok = (sorted(gen) == sorted(exp_gen)
              and sorted(deleted) == sorted(exp_del)
              and sorted(rsync) == sorted(exp_rsync))
        status = 'OK  ' if ok else 'FAIL'
        print(f"  {status}  case {i}: {desc}")
        if not ok:
            print(f"        expected: gen={exp_gen}, del={exp_del}, rsync={exp_rsync}")
            print(f"        got:      gen={gen}, del={deleted}, rsync={rsync}")
            failed += 1
    print()
    print(f"{len(CASES) - failed}/{len(CASES)} passed")
    sys.exit(0 if failed == 0 else 1)


if __name__ == '__main__':
    main()
