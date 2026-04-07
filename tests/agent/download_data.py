#!/usr/bin/env python3
"""
Download WebVoyager benchmark data.

Downloads the task definitions and reference answers from the WebVoyager
GitHub repository into tests/agent/data/.

Usage:
  python3 tests/agent/download_data.py
"""

import json
import os
import urllib.request
from pathlib import Path

DATA_DIR = Path(__file__).parent / "data"

FILES = {
    "WebVoyager_data.jsonl": "https://raw.githubusercontent.com/MinorJerry/WebVoyager/main/data/WebVoyager_data.jsonl",
    "reference_answer.json": "https://raw.githubusercontent.com/MinorJerry/WebVoyager/main/data/reference_answer.json",
}


def download():
    DATA_DIR.mkdir(exist_ok=True)

    for name, url in FILES.items():
        dest = DATA_DIR / name
        if dest.exists():
            print(f"  [skip] {name} (already exists)")
            continue

        print(f"  Downloading {name}...")
        try:
            urllib.request.urlretrieve(url, dest)
            size = dest.stat().st_size
            print(f"  [done] {name} ({size:,} bytes)")
        except Exception as e:
            print(f"  [fail] {name}: {e}")
            continue

    # Print summary
    jsonl = DATA_DIR / "WebVoyager_data.jsonl"
    if jsonl.exists():
        count = sum(1 for line in open(jsonl) if line.strip())
        print(f"\n{count} WebVoyager tasks ready.")

        # Count by site
        sites: dict[str, int] = {}
        with open(jsonl) as f:
            for line in f:
                if line.strip():
                    task = json.loads(line)
                    site = task.get("web_name", "unknown")
                    sites[site] = sites.get(site, 0) + 1

        print("\nTasks by website:")
        for site, n in sorted(sites.items(), key=lambda x: -x[1]):
            print(f"  {site:20s} {n:4d}")

    ref = DATA_DIR / "reference_answer.json"
    if ref.exists():
        with open(ref) as f:
            refs = json.load(f)
        print(f"\n{len(refs)} reference answers loaded.")


if __name__ == "__main__":
    print("Downloading WebVoyager benchmark data...\n")
    download()
    print(f"\nData directory: {DATA_DIR}")
    print("Run tests with:")
    print(f"  python3 tests/agent/run.py --webvoyager {DATA_DIR / 'WebVoyager_data.jsonl'} --limit 5")
