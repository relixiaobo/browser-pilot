#!/usr/bin/env python3
"""
v7 bucketed benchmark — stable baseline for ongoing iteration.

12 WebVoyager tasks across 5 buckets, designed to be:
  - Diverse (different sites, different task patterns)
  - Stable (golden reference answers preferred; minor staleness OK)
  - Repeatable (run N=2 by default to measure variance)
  - Bucketed (so we can see which task types each model is good at)

Usage:
  python3 tests/agent/v7_baseline.py                     # both models, N=2
  python3 tests/agent/v7_baseline.py --runs 3            # N=3
  python3 tests/agent/v7_baseline.py --model claude-sonnet-4-6 --runs 1
  python3 tests/agent/v7_baseline.py --bucket lookup     # one bucket only
  python3 tests/agent/v7_baseline.py --dry-run           # list tasks
"""

import argparse
import json
import os
import subprocess
import sys
import time
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
WEBVOYAGER_JSONL = ROOT / "tests" / "agent" / "data" / "WebVoyager_data.jsonl"

# Bucketed task selection. Each task: (id, bucket, why_chosen)
TASKS = [
    # ── lookup: single factual answer, deterministic ─────────────────────────
    ("Cambridge Dictionary--3", "lookup",   "zeitgeist pronunciation/definition"),
    ("Wolfram Alpha--0",        "lookup",   "derivative of x^2 at x=5.6 → 11.2 (golden)"),
    ("Wolfram Alpha--2",        "lookup",   "3^71 in scientific notation → 7.5095e33 (golden)"),

    # ── search: find one item matching criteria from a list ──────────────────
    ("Allrecipes--3",           "search",   "vegan choc chip cookies >60 reviews (golden)"),
    ("Coursera--0",             "search",   "beginner 3d printing course 1-3 months"),
    ("Huggingface--3",          "search",   "model with cc-by-sa-4.0 most likes"),

    # ── compare: weigh 2+ candidates against attributes ──────────────────────
    ("Apple--0",                "compare",  "MacBook Air models price comparison"),
    ("Apple--3",                "compare",  "iPhone 15 pro vs pro max"),
    ("Allrecipes--0",           "compare",  "vegetarian lasagna >100 reviews 4.5+ stars"),

    # ── navigate: follow a chain of pages, extract specific info ─────────────
    ("GitHub--3",               "navigate", "GitHub Enterprise vs Team storage → 48GB (golden)"),
    ("BBC News--5",             "navigate", "climate change really simple guide article (golden)"),
    ("ArXiv--2",                "navigate", "most recent cs.CL paper, show abstract"),
]

BUCKETS = ["lookup", "search", "compare", "navigate"]


def run_task(task_id: str, model: str, max_steps: int = 12) -> dict | None:
    """Run a single task and return parsed results from the saved JSON."""
    cmd = [
        "python3", str(ROOT / "tests" / "agent" / "run.py"),
        "--webvoyager", str(WEBVOYAGER_JSONL),
        "--id", task_id,
        "--model", model,
        "--max-steps", str(max_steps),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    # Find the most recent test-results file
    results_dir = ROOT / "test-results"
    files = sorted(results_dir.glob("agent-*.json"))
    if not files:
        return None
    latest = json.loads(files[-1].read_text())
    if not latest.get("results"):
        return None
    return latest["results"][0]


def summarize(records: list[dict]):
    """Print bucket-level + per-task summary."""
    by_task = defaultdict(list)
    by_bucket_model = defaultdict(list)
    for r in records:
        by_task[(r["model"], r["task_id"])].append(r)
        by_bucket_model[(r["bucket"], r["model"])].append(r)

    # Per-task variance
    print()
    print("=" * 100)
    print("  Per-task variance (mean / range)")
    print("=" * 100)
    print()
    for model in sorted({r["model"] for r in records}):
        print(f"### {model}")
        print(f"{'bucket':<10}{'task':<28}{'steps':>16}{'tokens (K)':>22}{'judge':>14}")
        print(f"{'':<10}{'':<28}{'min/avg/max':>16}{'min/avg/max':>22}{'r1→...':>14}")
        print("-" * 100)
        for tid, bucket, _ in TASKS:
            runs = by_task.get((model, tid), [])
            if not runs:
                continue
            steps = [r["steps"] for r in runs]
            toks  = [r["tokens"] for r in runs]
            judge = [r["judge"] for r in runs]

            s_str = f"{min(steps)}/{sum(steps)/len(steps):.0f}/{max(steps)}"
            t_str = f"{min(toks)/1000:.0f}/{sum(toks)/len(toks)/1000:.0f}/{max(toks)/1000:.0f}"
            j_str = "→".join("Y" if j else "N" for j in judge)
            print(f"{bucket:<10}{tid:<28}{s_str:>16}{t_str:>22}{j_str:>14}")
        print()

    # Per-bucket aggregate
    print("=" * 100)
    print("  Bucket aggregate (judge pass rate, mean tokens)")
    print("=" * 100)
    print()
    print(f"{'bucket':<12}{'model':<22}{'judge':>10}{'mean steps':>14}{'mean tokens':>18}")
    print("-" * 80)
    for bucket in BUCKETS:
        for model in sorted({r["model"] for r in records}):
            runs = by_bucket_model.get((bucket, model), [])
            if not runs:
                continue
            n = len(runs)
            j = sum(1 for r in runs if r["judge"])
            avg_steps = sum(r["steps"] for r in runs) / n
            avg_tokens = sum(r["tokens"] for r in runs) / n
            print(f"{bucket:<12}{model:<22}{f'{j}/{n}':>10}{avg_steps:>14.1f}{avg_tokens:>18,.0f}")
        print()

    # Grand totals
    print("=" * 100)
    print("  Grand totals")
    print("=" * 100)
    print()
    print(f"{'model':<22}{'tasks':>8}{'runs':>8}{'judge':>10}{'lazy':>8}{'tokens':>14}")
    print("-" * 70)
    for model in sorted({r["model"] for r in records}):
        runs = [r for r in records if r["model"] == model]
        n = len(runs)
        unique = len({r["task_id"] for r in runs})
        j = sum(1 for r in runs if r["judge"])
        lazy = sum(1 for r in runs if r["lazy"])
        toks = sum(r["tokens"] for r in runs)
        print(f"{model:<22}{unique:>8}{n:>8}{f'{j}/{n}':>10}{lazy:>8}{toks:>14,}")


def main():
    p = argparse.ArgumentParser(description="v7 bucketed benchmark runner")
    p.add_argument("--model", action="append", default=None,
                   help="model to run (repeatable). Default: claude-sonnet-4-6 + gpt-5.4")
    p.add_argument("--runs", type=int, default=2, help="number of runs per task")
    p.add_argument("--bucket", help="filter to one bucket")
    p.add_argument("--max-steps", type=int, default=12)
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--out", default=None, help="save records to this JSON file")
    args = p.parse_args()

    models = args.model or ["claude-sonnet-4-6", "gpt-5.4"]

    tasks_to_run = TASKS
    if args.bucket:
        tasks_to_run = [t for t in TASKS if t[1] == args.bucket]

    if args.dry_run:
        print(f"{'task':<28}{'bucket':<10}why")
        print("-" * 80)
        for tid, bucket, why in tasks_to_run:
            print(f"{tid:<28}{bucket:<10}{why}")
        print()
        print(f"{len(tasks_to_run)} tasks × {len(models)} models × {args.runs} runs = {len(tasks_to_run)*len(models)*args.runs} runs")
        return

    records = []
    total_runs = len(tasks_to_run) * len(models) * args.runs
    n_done = 0

    for run_idx in range(args.runs):
        for model in models:
            for tid, bucket, why in tasks_to_run:
                n_done += 1
                print(f"\n[{n_done}/{total_runs}] run={run_idx+1}/{args.runs} model={model} task={tid} ({bucket})")
                t0 = time.time()
                r = run_task(tid, model, args.max_steps)
                if r is None:
                    print("  ! no result captured")
                    continue
                judge_pass = False
                lazy = False
                for c in r["checks"]:
                    if "did real work" in c["check"]:
                        lazy = True
                    if "LLM" in c["check"] or "judge" in c["check"].lower():
                        # Use the (now correct) passed field
                        judge_pass = c["passed"]
                if lazy:
                    judge_pass = False

                rec = {
                    "run": run_idx + 1,
                    "model": model,
                    "task_id": tid,
                    "bucket": bucket,
                    "steps": r["steps"],
                    "cmds": r.get("commands_executed", 0),
                    "tokens": r["input_tokens"] + r["output_tokens"],
                    "judge": judge_pass,
                    "lazy": lazy,
                    "answer": r.get("agent_answer", "")[:200],
                }
                records.append(rec)
                marker = "PASS" if judge_pass else ("LAZY" if lazy else "FAIL")
                print(f"  → steps={rec['steps']} cmds={rec['cmds']} tokens={rec['tokens']} judge={marker} ({time.time()-t0:.0f}s)")

    summarize(records)

    if args.out:
        Path(args.out).write_text(json.dumps(records, indent=2))
        print(f"\nRecords saved: {args.out}")


if __name__ == "__main__":
    main()
