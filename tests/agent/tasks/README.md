# Legacy task files — ported to caliper

These 4 JSON files are the **historical source** for caliper's
`heroku_smoke` task. They were hand-written during browser-pilot v0
and used by `tests/agent/run.py` through v8.

As of M1.7a / M1.7b (Phase 1 close), they have been ported to:

    ~/Documents/Coding/caliper/packages/caliper-browser-pilot/
      src/caliper_browser_pilot/tasks/smoke.py

The caliper port uses the same URLs, the same verification
commands, and the same expected substrings. The files here are
kept for reference but are **no longer authoritative** — any
changes to the smoke task set should be made in caliper's
`smoke.py`, not here.

To run the smoke tasks:

```bash
# Via browser-pilot's npm script (delegates to caliper):
npm run test:agent

# Or directly via caliper:
cd ~/Documents/Coding/caliper
uv run inspect eval \
    packages/caliper-browser-pilot/src/caliper_browser_pilot/tasks/smoke.py@heroku_smoke \
    --model anthropic/claude-sonnet-4-6 \
    --max-samples 1
```
