#!/usr/bin/env python3
"""
Agent end-to-end test runner for browser-pilot.

Gives a real LLM agent a task, lets it call `bp` commands to control Chrome,
then verifies the outcome. Supports both hand-written tasks and the WebVoyager
benchmark (643 tasks across 15 real websites).

Usage:
  # Custom tasks
  python3 tests/agent/run.py --task tests/agent/tasks/heroku_login.json
  python3 tests/agent/run.py --tasks-dir tests/agent/tasks

  # WebVoyager benchmark
  python3 tests/agent/run.py --webvoyager tests/agent/data/WebVoyager_data.jsonl --limit 10
  python3 tests/agent/run.py --webvoyager tests/agent/data/WebVoyager_data.jsonl --site Amazon
  python3 tests/agent/run.py --webvoyager tests/agent/data/WebVoyager_data.jsonl --id "Allrecipes--3"

  # Options
  python3 tests/agent/run.py --model claude-sonnet-4-6 --max-steps 15
  python3 tests/agent/run.py --dry-run
"""

import argparse
import json
import os
import re
import shlex
import subprocess
import sys
import time
from glob import glob
from pathlib import Path

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

_env_path = Path(__file__).resolve().parent.parent.parent / ".env"
if _env_path.exists():
    for line in _env_path.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.strip())

BP = os.environ.get("BP", "bp")

# Load SKILL.md as the system prompt
_skill_path = (
    Path(__file__).resolve().parent.parent.parent
    / "plugin" / "skills" / "browser-pilot" / "SKILL.md"
)
_skill_content = ""
if _skill_path.exists():
    _raw = _skill_path.read_text()
    if _raw.startswith("---"):
        _raw = _raw.split("---", 2)[-1]
    _skill_content = _raw.strip()

SYSTEM_PROMPT = f"""You are a browser automation agent. You control Chrome through the `bp` CLI tool.

{_skill_content}

## Agent Test Rules
- Output `bp` commands one per line. They will be executed and you'll see the results.
- After completing the task, output your final answer on a line starting with: ANSWER: <your answer>
- If the task only requires an action (no answer needed), output: DONE
- If stuck after multiple attempts, output: FAIL
- ALWAYS read actual page data. Never fabricate content.
- The browser is already connected. Start by navigating with `bp open <url>`.
"""

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def bp(args: list[str], timeout: int = 30) -> str:
    """Run a bp command, return stdout."""
    try:
        result = subprocess.run(
            [BP] + args, capture_output=True, text=True, timeout=timeout
        )
        out = result.stdout.strip()
        if result.returncode != 0 and not out:
            out = result.stderr.strip()
        return out
    except subprocess.TimeoutExpired:
        return json.dumps({"ok": False, "error": "Command timed out"})
    except Exception as e:
        return json.dumps({"ok": False, "error": str(e)})


def call_llm(model: str, messages: list[dict]) -> tuple[str, int, int]:
    """Call LLM, return (text, input_tokens, output_tokens)."""
    if "claude" in model or "opus" in model or "sonnet" in model or "haiku" in model:
        import anthropic

        client = anthropic.Anthropic()
        response = client.messages.create(
            model=model,
            max_tokens=4096,
            system=SYSTEM_PROMPT,
            messages=messages,
        )
        return (
            response.content[0].text,
            response.usage.input_tokens,
            response.usage.output_tokens,
        )
    else:
        import openai

        client = openai.OpenAI()
        response = client.chat.completions.create(
            model=model,
            max_completion_tokens=4096,
            messages=[{"role": "system", "content": SYSTEM_PROMPT}] + messages,
        )
        return (
            response.choices[0].message.content,
            response.usage.prompt_tokens,
            response.usage.completion_tokens,
        )


def _extract_bp_commands(text: str) -> list[str]:
    """Extract bp commands from LLM response."""
    commands = []
    lines = text.split("\n")
    i = 0
    while i < len(lines):
        line = lines[i].strip().strip("`")
        if line.startswith("bp "):
            # Handle multi-line eval with unclosed quotes
            if line.count("'") % 2 == 1 or line.count('"') % 2 == 1:
                multi = [line]
                quote_char = "'" if line.count("'") % 2 == 1 else '"'
                i += 1
                while i < len(lines):
                    next_line = lines[i].rstrip()
                    if next_line.strip().startswith("`"):
                        next_line = next_line.strip().strip("`")
                    multi.append(next_line)
                    if quote_char in next_line:
                        break
                    i += 1
                commands.append("\n".join(multi))
            else:
                commands.append(line)
        i += 1
    return commands


def _extract_answer(text: str) -> str | None:
    """Extract ANSWER: from LLM response.

    Handles three patterns:
      1. ANSWER: text on same line              → just that text
      2. ANSWER: <newline> markdown block       → collect until DONE/FAIL/end
      3. ANSWER: short text + more on next line → collect both, joined
    """
    lines = text.split("\n")
    answer_idx = None
    for i, line in enumerate(lines):
        if line.strip().upper().startswith("ANSWER:"):
            answer_idx = i
            break

    if answer_idx is None:
        return None

    # Collect everything from ANSWER: through end of message,
    # stopping at terminal markers
    parts = []
    first_line_rest = lines[answer_idx].strip()[7:].strip()
    if first_line_rest:
        parts.append(first_line_rest)

    blank_run = 0
    for j in range(answer_idx + 1, len(lines)):
        l = lines[j].rstrip()
        stripped = l.strip()

        # Stop at terminal markers
        if stripped in ("DONE", "FAIL"):
            break
        if stripped.startswith("```"):  # code fence boundary - keep parsing
            continue

        if not stripped:
            blank_run += 1
            # Allow up to 2 consecutive blanks within markdown bullets
            if blank_run >= 3 and parts:
                break
            continue

        blank_run = 0
        parts.append(stripped)

    if not parts:
        return None
    # Join with single space; collapse to keep it on one line for fuzzy match
    answer = " ".join(parts)
    # Cap excessively long answers
    if len(answer) > 2000:
        answer = answer[:2000]
    return answer


def _truncate_snapshot(output: str, max_elements: int = 30) -> str:
    """Reformat snapshot output for the LLM context.

    Snapshots dominate token usage because each one persists in conversation
    history for every subsequent turn. We:
      1. Convert verbose JSON elements ({"ref":1,"role":"link","name":"X"})
         to compact text ([1] link "X") — about 60% smaller per element.
      2. Truncate to max_elements (default 30) since most useful elements
         are listed first.
      3. For non-snapshot results (eval, read, etc.), cap raw output length.
    """
    try:
        data = json.loads(output)
    except (json.JSONDecodeError, TypeError):
        return output[:3000]

    if not isinstance(data, dict):
        return output[:3000]

    # bp read result — keep title/url/text but cap text length
    if "text" in data and "elements" not in data:
        text = data.get("text", "")
        if len(text) > 3000:
            text = text[:3000] + "... [truncated]"
        return f'page: {data.get("title", "")}\nurl: {data.get("url", "")}\n---\n{text}'

    # snapshot result
    if "elements" in data:
        elements = data["elements"]
        total = len(elements)
        shown = elements[:max_elements]
        lines = []
        title = data.get("title", "")
        url = data.get("url", "")
        if title or url:
            lines.append(f"page: {title} | {url}")
        for el in shown:
            ref = el.get("ref")
            role = el.get("role", "")
            name = el.get("name", "")
            line = f'[{ref}] {role} "{name}"'
            if "value" in el and el["value"]:
                line += f' value="{el["value"]}"'
            if el.get("checked"):
                line += " checked"
            lines.append(line)
        if total > max_elements:
            lines.append(f"... ({total - max_elements} more elements)")
        return "\n".join(lines)

    # eval result, error, etc.
    return output[:3000]


# ---------------------------------------------------------------------------
# Task loading
# ---------------------------------------------------------------------------


def load_custom_tasks(path: str) -> list[dict]:
    """Load task(s) from a JSON file or directory."""
    p = Path(path)
    if p.is_file():
        return [json.loads(p.read_text())]
    elif p.is_dir():
        tasks = []
        for f in sorted(p.glob("*.json")):
            tasks.append(json.loads(f.read_text()))
        return tasks
    return []


def load_webvoyager_tasks(
    jsonl_path: str,
    ref_path: str | None = None,
    site: str | None = None,
    task_id: str | None = None,
    limit: int | None = None,
) -> list[dict]:
    """Load WebVoyager tasks from JSONL, convert to our format."""
    # Load reference answers — keyed by web_name, each with an answers[] array
    # where answer.id is the index within that site (e.g. "Allrecipes--3" → id=3)
    refs: dict[str, dict[int, dict]] = {}  # web_name → {idx: answer}
    if ref_path is None:
        ref_path = str(Path(jsonl_path).parent / "reference_answer.json")
    if Path(ref_path).exists():
        with open(ref_path) as f:
            raw_refs = json.load(f)
        for web_name, site_data in raw_refs.items():
            refs[web_name] = {}
            for answer in site_data.get("answers", []):
                refs[web_name][answer["id"]] = answer

    tasks = []
    with open(jsonl_path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            raw = json.loads(line)

            # Filter
            if site and raw.get("web_name", "").lower() != site.lower():
                continue
            if task_id and raw.get("id") != task_id:
                continue

            # Parse task index from ID (e.g. "Allrecipes--3" → 3)
            web_name = raw.get("web_name", "")
            try:
                idx = int(raw["id"].rsplit("--", 1)[-1])
            except (ValueError, IndexError):
                idx = -1

            ref = refs.get(web_name, {}).get(idx, {})
            task = {
                "id": raw["id"],
                "name": f"[WebVoyager] {web_name}: {raw['ques'][:60]}...",
                "goal": raw["ques"],
                "start_url": raw["web"],
                "source": "webvoyager",
                "reference_answer": ref.get("ans", ""),
                "answer_type": ref.get("type", "possible"),
            }
            tasks.append(task)

            if limit and len(tasks) >= limit:
                break

    return tasks


# ---------------------------------------------------------------------------
# Verification
# ---------------------------------------------------------------------------


def verify_custom_task(task: dict) -> list[dict]:
    """Run verification checks for custom tasks (same as computer-pilot)."""
    results = []
    for check in task.get("verify", []):
        desc = check["description"]

        if "command" in check:
            output = bp(check["command"][1:])  # skip "bp" prefix
            try:
                parsed = json.loads(output)
                value = str(parsed.get("result", parsed.get("value", output)))
            except (json.JSONDecodeError, TypeError):
                value = output

            if "expect_contains" in check:
                expected = check["expect_contains"]
                passed = expected.lower() in value.lower()
                results.append({
                    "check": desc,
                    "passed": passed,
                    "detail": f"expected '{expected}' in output, got: {value[:200]}",
                })

            if "expect_min_length" in check:
                min_len = check["expect_min_length"]
                passed = len(value) >= min_len
                results.append({
                    "check": desc,
                    "passed": passed,
                    "detail": f"length={len(value)}, min={min_len}",
                })

        if "cross_check" in check:
            cc = check["cross_check"]
            source_out = bp(cc["source_command"][1:])
            target_out = bp(cc["target_command"][1:])
            try:
                source_val = str(json.loads(source_out).get("result", source_out))
                target_val = str(json.loads(target_out).get("result", target_out))
            except (json.JSONDecodeError, TypeError):
                source_val = source_out
                target_val = target_out

            source_clean = source_val.strip().strip('"')
            tokens = [t for t in source_clean.split() if len(t) > 3]
            found = (
                any(t.lower() in target_val.lower() for t in tokens[:5])
                if tokens
                else False
            )
            results.append({
                "check": f"{desc} (cross-check)",
                "passed": found,
                "detail": f"source tokens: {tokens[:5]}, found: {found}",
            })

    return results


def verify_webvoyager_task(
    task: dict, agent_answer: str, model: str
) -> list[dict]:
    """Verify WebVoyager task: fuzzy match + optional LLM judge."""
    results = []
    ref = task.get("reference_answer", "")

    if not ref:
        # No reference answer — can only check agent produced an answer
        results.append({
            "check": "Agent produced an answer",
            "passed": bool(agent_answer),
            "detail": f"answer: {agent_answer[:200]}" if agent_answer else "no answer",
        })
        return results

    # 1. Fuzzy token match (cheap, no API call)
    ref_tokens = [t for t in re.split(r"[,\s]+", ref) if len(t) > 2]
    answer_lower = agent_answer.lower()
    matched = [t for t in ref_tokens if t.lower() in answer_lower]
    token_ratio = len(matched) / len(ref_tokens) if ref_tokens else 0
    fuzzy_pass = token_ratio >= 0.4

    results.append({
        "check": "Fuzzy token match",
        "passed": fuzzy_pass,
        "detail": f"matched {len(matched)}/{len(ref_tokens)} tokens ({token_ratio:.0%}), "
                  f"ref: {ref[:100]}",
    })

    # 2. LLM-as-judge (more accurate, costs API call)
    # Use structured JSON output to avoid the "CORRECT" ⊂ "INCORRECT" substring trap
    # that silently inflated 38% of judge results in earlier runs.
    judge_prompt = f"""You are grading whether a web agent correctly answered a question.

Task: {task['goal']}
Reference answer: {ref}
Agent's answer: {agent_answer}

Rules:
- The agent's wording may differ but the substantive content must match the reference.
- Partial answers covering the key information count as correct.
- The reference may admit multiple valid answers.
- An answer that *describes how to do it* without actually having done it is INCORRECT.
- An empty or evasive answer is INCORRECT.

Respond with ONLY a JSON object on a single line:
{{"verdict": "correct"}} or {{"verdict": "incorrect", "reason": "<short reason>"}}"""

    try:
        judge_response, _, _ = call_llm(model, [{"role": "user", "content": judge_prompt}])
        llm_pass, judge_reason = _parse_judge_verdict(judge_response)
        results.append({
            "check": "LLM judge",
            "passed": llm_pass,
            "detail": f"judge: {'CORRECT' if llm_pass else 'INCORRECT'} — {judge_reason[:80]}",
        })
    except Exception as e:
        results.append({
            "check": "LLM judge",
            "passed": fuzzy_pass,  # fallback to fuzzy
            "detail": f"judge error: {e}, fell back to fuzzy match",
        })

    return results


def _parse_judge_verdict(response: str) -> tuple[bool, str]:
    """Parse {"verdict": "correct|incorrect", "reason": "..."} from judge response.

    Falls back to keyword check (with INCORRECT-first ordering) if JSON
    parsing fails — defensive against models that ignore the format spec.
    """
    # Try JSON first
    text = response.strip()
    # Strip markdown code fences if present
    if text.startswith("```"):
        text = re.sub(r"^```\w*\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    # Find first { and matching }
    start = text.find("{")
    if start >= 0:
        depth = 0
        for i in range(start, len(text)):
            if text[i] == "{":
                depth += 1
            elif text[i] == "}":
                depth -= 1
                if depth == 0:
                    try:
                        obj = json.loads(text[start : i + 1])
                        verdict = str(obj.get("verdict", "")).lower().strip()
                        reason = str(obj.get("reason", "")).strip()
                        if verdict in ("correct", "incorrect"):
                            return verdict == "correct", reason or verdict
                    except json.JSONDecodeError:
                        pass
                    break
    # Fallback: keyword check (INCORRECT first to avoid substring trap)
    upper = response.upper()
    if "INCORRECT" in upper:
        return False, "fallback parse"
    if "CORRECT" in upper:
        return True, "fallback parse"
    return False, f"unparseable: {response[:60]}"


# ---------------------------------------------------------------------------
# Agent loop
# ---------------------------------------------------------------------------


def run_agent_task(
    task: dict, model: str, max_steps: int = 15, verbose: bool = True
) -> dict:
    """Run one agent task end-to-end."""
    task_id = task["id"]
    goal = task["goal"]
    start_url = task.get("start_url", "")
    is_webvoyager = task.get("source") == "webvoyager"

    if verbose:
        print(f"\n{'=' * 60}")
        print(f"Task: {task['name']}")
        print(f"Goal: {goal}")
        if start_url:
            print(f"URL:  {start_url}")
        print(f"{'=' * 60}")

    # Setup (custom tasks only)
    for cmd in task.get("setup", []):
        bp(cmd[1:])
        time.sleep(0.5)

    # Open start URL
    last_snapshot = ""
    if start_url:
        time.sleep(0.5)
        result = bp(["open", start_url])
        last_snapshot = _truncate_snapshot(result)
        if verbose:
            print(f"  Opened: {start_url}")

    messages = []
    total_input = 0
    total_output = 0
    steps = 0
    status = "incomplete"
    agent_answer = ""
    commands_executed = 0  # tracks real bp commands the agent ran (not the start_url open)
    observed_page = False  # did the agent actually look at any page state?

    for step in range(1, max_steps + 1):
        steps = step

        # Build prompt
        user_msg = f"Task: {goal}\n\nStep {step}/{max_steps}."
        if last_snapshot:
            user_msg += f"\n\nCurrent page state:\n{last_snapshot}"
        user_msg += "\n\nWhat bp commands should I run next?"

        messages.append({"role": "user", "content": user_msg})

        try:
            response, inp, out = call_llm(model, messages)
        except Exception as e:
            if verbose:
                print(f"  Step {step}: LLM error: {e}")
            status = "error"
            break

        total_input += inp
        total_output += out
        messages.append({"role": "assistant", "content": response})

        if verbose:
            print(f"  Step {step}: {response[:150]}...")

        # Check for answer/done/fail
        answer = _extract_answer(response)
        if answer:
            agent_answer = answer
            status = "done"
            if verbose:
                print(f"  ANSWER: {answer[:100]}")

        bp_commands = _extract_bp_commands(response)

        # No commands + terminal signal → stop
        if not bp_commands:
            if "DONE" in response or answer:
                status = "done"
                break
            if "FAIL" in response:
                status = "fail"
                break

        # Execute commands (then stop if answer was already given)
        results = []
        for cmd_line in bp_commands:
            try:
                args = shlex.split(cmd_line[3:])  # skip "bp "
            except ValueError:
                args = cmd_line[3:].split()

            if verbose:
                display = " ".join(args[:5]) + ("..." if len(args) > 5 else "")
                print(f"    $ bp {display}")

            r = bp(args)
            commands_executed += 1
            # Track whether agent ever observed page state. bp open alone is navigation,
            # not observation — agents that only navigate then answer are "lazy".
            if args and args[0] in ("read", "snapshot", "eval", "screenshot", "tabs", "cookies", "locate"):
                observed_page = True
            truncated = _truncate_snapshot(r)
            results.append(f"$ {cmd_line[:200]}\n{truncated}")
            last_snapshot = truncated

            if verbose:
                # Show first line of result
                first_line = r.split("\n")[0][:150]
                print(f"      -> {first_line}")

            time.sleep(0.3)

        if results:
            messages.append({
                "role": "user",
                "content": "Results:\n" + "\n---\n".join(results),
            })

        # If answer was found this step, stop after executing remaining commands
        if answer:
            status = "done"
            break

        time.sleep(0.2)

    # Lazy agent detection: agent claimed completion without observing the page.
    # "Real work" requires at least one read/snapshot/eval/etc. — bp open alone is
    # just navigation, not observation. An agent that only navigates and then writes
    # an answer is hallucinating from training data, not reading the live page.
    # (The runner auto-opens start_url and feeds the resulting snapshot to the LLM,
    # so for "ESPN standings" the agent CAN see the homepage links but not the
    # actual standings table — answering anyway without a follow-up read is lazy.)
    lazy = bool(agent_answer) and not observed_page
    if lazy:
        status = "lazy_failure"
        if verbose:
            print("  [LAZY] agent answered without observing the page")

    # Verify
    time.sleep(0.5)
    if lazy:
        # Skip judge — we already know the answer is bogus
        verify_results = [{
            "check": "Agent did real work",
            "passed": False,
            "detail": "agent produced answer without executing any bp commands",
        }]
    elif is_webvoyager:
        verify_results = verify_webvoyager_task(task, agent_answer, model)
    else:
        verify_results = verify_custom_task(task)

    all_passed = all(v["passed"] for v in verify_results) if verify_results else (status == "done")

    if verbose:
        print(f"\n  Agent status: {status}")
        if agent_answer:
            print(f"  Agent answer: {agent_answer[:200]}")
        print(f"  Verification:")
        for v in verify_results:
            mark = "PASS" if v["passed"] else "FAIL"
            print(f"    [{mark}] {v['check']}")
            if not v["passed"]:
                print(f"           {v['detail']}")

    # Cleanup (custom tasks only)
    for cmd in task.get("cleanup", []):
        bp(cmd[1:])
        time.sleep(0.3)

    return {
        "task_id": task_id,
        "task_name": task["name"],
        "agent_status": status,
        "agent_answer": agent_answer,
        "verified": all_passed,
        "checks": verify_results,
        "steps": steps,
        "commands_executed": commands_executed,
        "input_tokens": total_input,
        "output_tokens": total_output,
    }


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main():
    parser = argparse.ArgumentParser(description="browser-pilot agent test runner")
    parser.add_argument("--task", help="Path to a single task JSON file")
    parser.add_argument("--tasks-dir", help="Directory of task JSON files")
    parser.add_argument("--webvoyager", help="Path to WebVoyager_data.jsonl")
    parser.add_argument("--ref", help="Path to reference_answer.json (auto-detected if omitted)")
    parser.add_argument("--site", help="Filter WebVoyager tasks by website name")
    parser.add_argument("--id", help="Run a single WebVoyager task by ID")
    parser.add_argument("--limit", type=int, help="Max number of tasks to run")
    parser.add_argument("--model", default="claude-sonnet-4-6")
    parser.add_argument("--max-steps", type=int, default=15)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    # Collect tasks
    tasks = []
    if args.webvoyager:
        tasks = load_webvoyager_tasks(
            args.webvoyager,
            ref_path=args.ref,
            site=args.site,
            task_id=args.id,
            limit=args.limit,
        )
    elif args.task:
        tasks = load_custom_tasks(args.task)
    elif args.tasks_dir:
        tasks = load_custom_tasks(args.tasks_dir)
    else:
        # Default: load from tests/agent/tasks/
        default_dir = Path(__file__).parent / "tasks"
        if default_dir.exists():
            tasks = load_custom_tasks(str(default_dir))

    if not tasks:
        print("No tasks found. Use --task, --tasks-dir, or --webvoyager.", file=sys.stderr)
        sys.exit(1)

    if args.limit and not args.webvoyager:
        tasks = tasks[: args.limit]

    if args.dry_run:
        for t in tasks:
            src = f" [{t.get('source', 'custom')}]" if t.get("source") else ""
            print(f"  {t['id']}: {t['name']}{src}")
            print(f"    Goal: {t['goal'][:80]}...")
            if t.get("start_url"):
                print(f"    URL:  {t['start_url']}")
            checks = len(t.get("verify", []))
            ref = t.get("reference_answer", "")
            if checks:
                print(f"    Verify: {checks} checks")
            if ref:
                print(f"    Ref: {ref[:80]}")
        print(f"\n{len(tasks)} tasks")
        return

    # Ensure bp is connected
    print("Checking bp connection...")
    status_out = bp(["tabs"])
    try:
        status = json.loads(status_out)
        if not status.get("ok", True):
            print("bp not connected. Run `bp connect` first.", file=sys.stderr)
            sys.exit(1)
    except (json.JSONDecodeError, TypeError):
        pass  # Non-JSON output is fine (TTY mode)
    print("Connected.\n")

    # Run tasks
    results = []
    for t in tasks:
        result = run_agent_task(t, args.model, args.max_steps)
        results.append(result)

    # Summary
    passed = sum(1 for r in results if r["verified"])
    total = len(results)
    tokens = sum(r["input_tokens"] + r["output_tokens"] for r in results)

    print(f"\n{'=' * 60}")
    print(f"AGENT TEST RESULTS: {passed}/{total} verified")
    print(f"Total tokens: {tokens:,}")
    print(f"Model: {args.model}")
    print(f"{'=' * 60}")

    for r in results:
        mark = "PASS" if r["verified"] else "FAIL"
        print(f"  [{mark}] {r['task_name']} (steps={r['steps']}, status={r['agent_status']})")
        for c in r["checks"]:
            cm = "+" if c["passed"] else "-"
            print(f"         {cm} {c['check']}")

    # Save results
    out_dir = Path(__file__).parent.parent.parent / "test-results"
    out_dir.mkdir(exist_ok=True)
    out_path = out_dir / f"agent-{int(time.time())}.json"
    with open(out_path, "w") as f:
        json.dump(
            {"model": args.model, "passed": passed, "total": total, "results": results},
            f,
            indent=2,
        )
    print(f"\nResults saved: {out_path}")

    sys.exit(0 if passed == total else 1)


if __name__ == "__main__":
    main()
