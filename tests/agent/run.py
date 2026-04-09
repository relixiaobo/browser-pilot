#!/usr/bin/env python3
"""Thin shim that delegates agent testing to caliper.

This file replaces the 857-line legacy agent test runner that lived
here through v0–v8 of browser-pilot. Every piece of functionality
that run.py had (LLM client, command parser, agent loop, judge,
lazy detection, WebVoyager loader, snapshot truncation, custom-task
verification) has been extracted into caliper as a reusable component:

  Legacy run.py component    → caliper equivalent
  ─────────────────────────────────────────────────
  Agent loop + bp()          → caliper.solvers.text_protocol_agent
  _extract_bp_commands       → caliper.parsers.extract_commands
  _extract_answer            → caliper.parsers.extract_answer
  _truncate_snapshot         → caliper_browser_pilot.tools.bp_truncate_snapshot
  call_llm (Anthropic/OAI)   → Inspect AI model adapters
  verify_custom_task         → caliper.scorers.verify_commands
  verify_webvoyager_task     → caliper.scorers.judge_stale_ref
  lazy detection             → caliper.scorers.lazy_detection
  load_webvoyager_tasks      → caliper.datasets.load_webvoyager_jsonl
  v7_baseline.py bucketing   → caliper.report.bucket + v8_baseline @task

The shim invokes ``inspect eval`` against caliper's heroku_smoke
task (4 deterministic smoke samples scored via verify_commands).
This is Layer 1 per caliper's docs/test-sets.md: fast, deterministic,
no LLM judge, ~1 min runtime.

For the v8 baseline (12 WebVoyager tasks × 2 epochs, LLM judge),
use caliper directly:

    cd ~/Documents/Coding/caliper
    uv run inspect eval \\
        packages/caliper-browser-pilot/src/caliper_browser_pilot/tasks/v8_baseline.py@v8_baseline \\
        --model anthropic/claude-sonnet-4-6 \\
        --max-samples 1 \\
        --epochs 2

See ~/Documents/Coding/caliper/docs/roadmap.md for the full
mapping of old run.py workflows to caliper equivalents.

M1.7b: this shim was written to formally retire run.py and close
Phase 1 of the caliper port.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

# Caliper repo location. Override via CALIPER_ROOT env var if your
# checkout is somewhere else.
CALIPER_ROOT = Path(
    os.environ.get("CALIPER_ROOT", "~/Documents/Coding/caliper")
).expanduser()

# The caliper task file + @task selector for heroku smoke.
SMOKE_TASK = (
    "packages/caliper-browser-pilot/src/"
    "caliper_browser_pilot/tasks/smoke.py@heroku_smoke"
)

# Default model for the smoke run. Override via --model on the
# command line (passed through to inspect eval).
DEFAULT_MODEL = "anthropic/claude-sonnet-4-6"

# ---------------------------------------------------------------------------
# Legacy arg detection
# ---------------------------------------------------------------------------

# These are args the old run.py accepted that no longer make sense
# through the shim. If someone uses them out of muscle memory, give
# them a clear migration message instead of a confusing error.
_LEGACY_ARGS = {
    "--webvoyager": (
        "WebVoyager runs are now handled by caliper's v8_baseline task.\n"
        "  cd {caliper_root}\n"
        "  uv run inspect eval \\\n"
        "    packages/caliper-browser-pilot/src/"
        "caliper_browser_pilot/tasks/v8_baseline.py@v8_baseline \\\n"
        "    --model anthropic/claude-sonnet-4-6 --max-samples 1 --epochs 2"
    ),
    "--task": (
        "Custom single-task runs are now handled via caliper's task "
        "system.\n  See: {caliper_root}/packages/caliper-browser-pilot/"
        "src/caliper_browser_pilot/tasks/smoke.py"
    ),
    "--tasks-dir": "Same as --task — use caliper's task definitions instead.",
    "--site": "Use inspect eval's --sample-id flag to filter by sample.",
    "--id": "Use inspect eval's --sample-id flag to filter by sample.",
    "--limit": "Use inspect eval's --limit flag.",
    "--max-steps": (
        "Use the max_turns parameter on the @task definition, "
        "or --max-turns on the inspect eval CLI."
    ),
}


def _check_legacy_args(argv: list[str]) -> None:
    """Error loudly if someone passes a legacy run.py arg."""
    for arg in argv:
        key = arg.split("=")[0]  # handle --key=value style
        if key in _LEGACY_ARGS:
            msg = _LEGACY_ARGS[key].format(caliper_root=CALIPER_ROOT)
            print(
                f"ERROR: '{key}' is a legacy run.py argument that this "
                f"shim no longer supports.\n\n"
                f"Migration path:\n  {msg}\n",
                file=sys.stderr,
            )
            sys.exit(2)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> int:
    _check_legacy_args(sys.argv[1:])

    if not CALIPER_ROOT.is_dir():
        print(
            f"ERROR: caliper repo not found at {CALIPER_ROOT}\n"
            "Set CALIPER_ROOT to point at your caliper checkout.\n"
            "  export CALIPER_ROOT=~/path/to/caliper",
            file=sys.stderr,
        )
        return 1

    # Detect --dry-run: just print what would happen.
    if "--dry-run" in sys.argv[1:]:
        print("Would run:")
        print(f"  cd {CALIPER_ROOT}")
        print(
            f"  uv run inspect eval {SMOKE_TASK} "
            f"--model {DEFAULT_MODEL} --max-samples 1"
        )
        print()
        print("4 heroku smoke tasks (Layer 1):")
        print("  heroku-checkboxes       — click + DOM state")
        print("  heroku-dropdown         — form option selection")
        print("  heroku-dynamic-loading  — click + wait + content read")
        print("  heroku-login            — form fill + submit + nav check")
        print()
        print(
            "For the full v8 baseline (12 WebVoyager tasks), "
            "use caliper directly — see this file's docstring."
        )
        return 0

    # Build the inspect eval command. Pass through any extra args
    # (e.g. --model, --epochs, --log-dir) so power users can
    # override without editing this file.
    extra_args = sys.argv[1:]
    has_model = any(a.startswith("--model") for a in extra_args)

    cmd = ["uv", "run", "inspect", "eval", SMOKE_TASK, "--max-samples", "1"]
    if not has_model:
        cmd += ["--model", DEFAULT_MODEL]
    cmd += extra_args

    print(f"[browser-pilot] Delegating to caliper ({CALIPER_ROOT})")
    print(f"[browser-pilot] Running: {' '.join(cmd[:8])}...")
    print()

    result = subprocess.run(cmd, cwd=str(CALIPER_ROOT))
    return result.returncode


if __name__ == "__main__":
    sys.exit(main())
