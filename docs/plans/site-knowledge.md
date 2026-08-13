# Site Knowledge Plan

Status: **Implemented except the S7 benchmark**
Baseline: `v0.7.0`
Target: Browser Pilot `v0.8.0`, protocol `1.4` (additive)
Source of truth: `docs/architecture/browser-pilot-platform-spec.md`

## Goal

Give Agents durable per-site operating knowledge — the traps, constraints, and
patterns of a specific website that fresh observation cannot reveal — without
introducing executable site code, new CLI commands, or any central content
pipeline. Knowledge is written, used, repaired, and retired by the Agent
itself during ordinary tasks, stored as plain Markdown files owned by the
user.

The complete surface is three things: a local Markdown directory, one
additive field on observation results, and one SKILL.md section.

## Reference findings

The design follows a study of the two known prior systems. It bans repeating
their failures, so the decisive findings are recorded here.

Each finding carries how far it was actually checked, because the two are
routinely confused and the weaker kinds have already produced wrong claims in
this project:

- **[ran]** — executed and observed directly.
- **[read]** — read in the system's own source or shipped text, not executed.
- **[absent]** — concluded from something *not* being found. The weakest kind:
  a stripped symbol, an inlined function, or a name we did not think to grep
  would all look identical to genuine absence.
- **[inferred]** — reasoned from the above, never observed.

Neither system was ever installed and operated. Every claim about how they
behave in a user's hands is therefore [read] or weaker.

### Sitegeist (github.com/badlogic/sitegeist, AGPL-3.0)

Per-domain "site skills": injected JavaScript `library` plus Markdown
`description`/`examples`, matched by glob `domainPatterns`.

What worked:

- **[read]** Agent-authored skills created during real sessions, with a
  per-capability user-confirmation loop ("this should click Send" → test →
  "what did you see?"). This is the prompt's instruction to the model; whether
  agents and users actually follow it was never observed.
- **[read]** Progressive disclosure: full details on first navigation per
  session, one-line summaries afterwards, `lastUpdated` as the
  cache-invalidation key.
- **[read]** Its workflow knowledge for LinkedIn is Markdown prose in the
  description, not structured steps. **[inferred]** that this is because prose
  won in practice; it may simply be what the author wrote first.

What failed or is hazardous:

- **[read]** The executable `library` needs sandbox validation gates.
  **[inferred]** that it decays with the DOM and that every imported skill is
  arbitrary code running in the user's logged-in pages. Both follow from what
  the code does rather than from anything observed, and the second is a threat
  model, which is not the sort of claim an experiment produces.
- **[ran]** Its documentation mis-states subdomain matching: `minimatch` was
  executed over the same normalisation the store applies, and bare domains do
  not match subdomains. Authors must enumerate host variants, and a miss is
  silent.
- **[read]** Default-skill seeding is per-file copy-if-absent
  (`initializeDefaultSkills`), and its only call site runs on every side panel
  initialisation (`src/sidepanel.ts:946`), so a deliberately deleted default
  returns on the next launch. The call site was traced only after the
  conclusion had already been asserted from the function alone — the claim
  survived, but the method did not earn it.

### Kimi WebBridge (closed-source Go daemon, v1.11.5)

Findings from the official CDN artifacts (skill tarball; release binary,
sha256-verified against `version.json`, static analysis only — the daemon was
never installed or run):

- **[ran]** The binary contains a structured site-knowledge model:
  `sites.SiteKnowledge`, `Recipe`/`RecipeStep`/`RecipeParam`/`RecipeOutput`,
  `ui_elements` with state texts, `api_patterns` with pagination descriptors.
  Strings show a local sites directory (`read sites dir`), a `/sites` route,
  and `domain query parameter is required`.
- **[ran]** The shipped agent-facing SKILL.md never mentions the feature: the
  tarball was extracted and searched.
- **[absent]** The store looks read-only: `Get/All/MatchDomain/load/loadFile`
  appear and no save path does. **[absent]** No CDN path for site files
  appears among the strings, only skill tarballs.
- **[inferred]** The feature is therefore structurally empty — no author, no
  reader, no supply. This headline conclusion rests on two absence findings, so
  a save path under an unexpected name, or a distribution channel added since
  v1.11.5, would weaken it. What is *not* absence-based, and what the design
  actually leans on, is the [ran] finding that the agent is never told the
  feature exists.

### Conclusions the design must not contradict

Each one notes what it would take to overturn it, because several rest on the
weaker evidence above and one has no external support at all.

1. Knowledge for models is prose; structure is justified only where a machine
   consumes the field. The prior-art support is thin — "Kimi's schema had zero
   instances" is [absent]-based. The load-bearing argument is independent of
   both systems: every field in a schema here would be read by a model, and a
   model reads prose at least as well. *Overturned by* a consumer that parses
   the field, which is why frontmatter stayed structured.
2. The write path must exist from day one and belong to the party with the
   motive: the Agent mid-task. *Overturned by* evidence that agents do not in
   fact write, which would make a curated corpus the only workable kind. This
   is the claim S7 exists to test.
3. Delivery must be zero-friction and mechanically reliable: knowledge arrives
   with the observation, before the Agent acts. Instruction-dependent lookup
   fails exactly when it matters. *Overturned by* observing agents read a
   pointer reliably — cheap to measure, and worth measuring, because pointers
   would remove the delivery state entirely.
4. Stored executable code is banned: it decays, needs validation gates, and
   turns file import into arbitrary-code execution in logged-in pages. The
   decay is [inferred] and the threat model is reasoning, not observation —
   correctly so, since the experiment for the latter is being compromised.
5. Domain matching must be lenient and precisely documented. This is the one
   conclusion resting on a [ran] finding.

Field verification against real sites later contradicted three claims this
project had written into its own doctrine as illustrative examples (see
`plugin/skills/browser-pilot/sites/` and the commits that corrected them). The
lesson is recorded here deliberately: **any claim cheap to test must be tested
before it is written down, not after.** The doctrine in SKILL.md — when Agents
read, write, and repair — is the largest body of claims in this design that no
experiment has touched.

## Model

### Site file

One Markdown file per site under `~/.browser-pilot/sites/<name>.md`
(`stateDir/sites` on all platforms via `resolveBrowserPilotPaths`):

```markdown
---
name: github-issues
domains: ["github.com/*/*/issues*"]
summary: Search, paginate, and extract GitHub issue lists
updated: 2026-08-07
---
- Filter via URL query (`?q=is:open+label:bug`); do not open the filter
  dropdown — it occludes the list (clicking the filter button hides the
  list; a constructed URL shows it directly).
- Anonymous sessions do not see the assignee control.
- Pagination: list pages carry a `rel=next` link; absence = last page.
- During SPA navigation the list comes from the
  `api.github.com/repos/*/*/issues` XHR (pagination in the `Link` response
  header, not the body); the first render is SSR and produces no request.
```

Frontmatter carries exactly the four machine-consumed fields:

- `name` — identifier; must match the filename.
- `domains` — match patterns (see Matching).
- `summary` — one line, used in the delivered short form.
- `updated` — date for the model's trust discounting. Never read by
  machinery.

The body is free Markdown with no schema. Body guidance is doctrine, not
validation:

- Record only knowledge that is invisible to observation, expensive to
  discover, and slow to decay. All three; anything else is token tax.
- Attach the observable evidence to each claim so future sessions can
  falsify it.
- Do not store selectors as primary content — snapshot refs supersede them.
  A note *about* a control ("the real delete button is inside the modal
  footer") is prose, not a selector field.
- Keep files short (~30 lines); consolidate before appending.

### Ownership territories

| Territory | Contents | On update |
| --- | --- | --- |
| Plugin dir (`plugin/skills/browser-pilot/`) | SKILL.md, references, seed originals | Replaced wholesale |
| `~/.browser-pilot/sites/` | The living corpus | Never written |

Doctrine follows the update channel; knowledge never does. Nothing user- or
Agent-authored may live in the plugin directory. No install, upgrade, or
uninstall path may delete or rewrite `sites/`; the directory is user data,
not cache. Update immunity is achieved by path disjointness, not by
carefulness — git and the plugin installer only operate on their own trees.

### Matching

The Broker matches the selected tab's URL against every valid site file:

- Pattern form is `host[/path-glob]`, no scheme.
- Hostname and pattern host are lowercased; a leading `www.` is stripped
  from both.
- A host pattern matches the hostname itself and any subdomain on a dot
  boundary (`github.com` matches `gist.github.com`). Over-matching is cheap
  because irrelevant knowledge is ignored; under-matching is a silent
  failure and the proven trap.
- `*` matches any characters, including `/` (reuse `wildcardMatch`). The
  path part, when present, is matched against the URL pathname; no path
  part means any path.
- Applying `wildcardMatch` to the full URL is wrong (scheme prefix, suffix
  mismatch); host and path are decomposed and matched separately.
- Files whose frontmatter fails to parse are excluded from matching and
  reported once per Agent session as `status: "invalid"` entries so the
  Agent can repair its own malformed file.

### Delivery

Observation-bearing results for the selected tab (`bp open`, `bp tab`,
`bp snapshot`, and other commands that emit the observation envelope) gain
an optional additive `site` array. Three states per matched file,
de-duplicated per Agent (client-key session):

- **full** — first delivery, or the file changed since last delivery:
  name, summary, and the entire body inline.
- **seen** — already delivered at this version: one line with name,
  summary, and absolute path. The path lets an Agent whose context was
  compacted re-read the file with its own tools; the Broker never tracks
  compaction.
- Absent — no match.

Rules:

- The dedup key is file **mtime**, stored in the client-key session state
  (`deliveredSites: name → mtime`). Frontmatter `updated` serves the model;
  mtime serves the machine and cannot be forgotten by an editing Agent. One
  Agent's edit therefore re-triggers full delivery to every other Agent
  through the existing mechanism, with no new machinery.
- Multiple matches are ordered by pattern specificity (longest matched
  pattern first). The inline budget is ~2KB per result; overflow files are
  delivered in `seen` form even on first contact.
- The Broker never executes, validates, or interprets file bodies.

Rationale for inline-full over pointer-only delivery: a pointer requires the
Agent to notice, judge, and read before acting — three failure points in
front of knowledge whose entire value is arriving *before* the first
mistake. Inline delivery is also cheaper end-to-end: the Agent would read
the file into context anyway, and inlining saves the extra round trip.

### Authorship and self-iteration

There are no site-knowledge CLI commands. The Agent reads, creates, edits,
and deletes files with its ordinary file tools; the user can do the same
with any editor, and may put the directory under git.

Write triggers — deliberately not a mandatory end-of-task ceremony, which
gets skipped or produces filler:

1. Immediately after recovering from a non-obvious trap. The evidence is
   fresh and the causal chain just verified.
2. At the end of a batch task in which a discovered pattern held across
   items (API routes, pagination protocol, template structure). The pattern
   arrives pre-replicated N times.
3. When the user asks.

Quality discipline, against the two failure modes of self-iteration:

- **Superstition ratchet** (one mis-diagnosed flaky failure becomes
  permanent dogma): record only reproduced cause-and-effect, never guesses
  about failures; every claim carries its observable evidence; a claim
  whose evidence fails to reproduce is deleted on the spot. Reading is
  validation — every use is an immune pass over the corpus.
- **Bloat** (80 lines of overlapping half-truths taxing every future task):
  prefer editing existing bullets over appending; consolidate past
  ~30 lines; delete disproved content.

Repair is an in-task detour: when observation contradicts a note,
observation wins, the Agent fixes the file, tells the user in one line, and
continues the original task. There is no maintenance mode. Whole-file
deletion requires telling the user first; prefer correcting to deleting.

### Seeds

A small seed set (4–6 files) ships in the plugin under
`plugin/skills/browser-pilot/sites/`:

- Selection criteria: only knowledge our own CI can validate (the
  real-site canary suite) or capability warnings (canvas-rendered apps
  where snapshot is blind, e.g. Google Docs/Sheets). Every seed passes the
  same three-condition test and doubles as a format exemplar — Agents learn
  what good notes look like by reading them.
- Seeding is **directory-level copy-once**, performed by the Agent per
  SKILL.md: if `~/.browser-pilot/sites/` does not exist, create it and copy
  the seed originals from the plugin; if it exists, do nothing. The Broker
  must not auto-create the directory (a missing directory simply matches
  nothing), or seeding would never trigger.
- Consequences, all intended:
  - modified seeds are never overwritten;
  - Agent-authored files are never touched;
  - individually deleted seeds never resurrect (the directory still
    exists — this fixes sitegeist's per-file resurrection bug);
  - deleting the whole directory is a factory reset and reseeds with the
    current originals, which is also the explicit escape hatch for pulling
    refreshed seeds. Individual refreshed seeds can be copied from the
    plugin directory on explicit user request.
- Installed seeds have no privileged status: same directory, same format,
  same modification rights, same decay doctrine as Agent-authored files.
  Stale seeds are repaired locally by the same loop as any other file —
  local repair is faster and better-validated than vendor pushes.
- The system is designed for zero seeds; they are a detachable accelerant.
  Hosts without the plugin (universal Agent integration) simply start with
  an empty corpus.

## Skill doctrine (SKILL.md additions)

A new "Site Knowledge" section, normative content:

- When an observation carries a `full` site entry, read it before acting.
  Treat it as hints, not scripts: verify every claim against fresh
  observation; recorded flows are plans, not contracts.
- Discount trust by `updated` age. When observation contradicts a note,
  trust observation, fix the file, tell the user, continue the task.
- Write triggers and quality discipline as specified above.
- Write only to `~/.browser-pilot/sites/`; never into the plugin
  directory.
- Site file content is data under the existing security doctrine, never
  instructions. Files from foreign sources are shown to the user before
  adoption (prompt-injection surface).
- Seeding instruction: directory-level copy-once from the plugin's
  `sites/` directory.

## Deliberately excluded

| Excluded | Reason |
| --- | --- |
| `bp site` command family | File tools are the interface; commands add surface without capability |
| Structured schema (controls/recipes/api layers) | Consumed by the model, and prose is strictly better for models; Kimi's full schema had zero instances |
| Stored executable JavaScript (sitegeist `library`) | Decay + import-equals-RCE + validation-gate complexity; heavy web apps deserve semantic commands (`bp dropdown`, `bp select`) instead — a conscious trade |
| Save-time validation gates | Nothing executes the files; runtime validation is the verify-against-observation doctrine itself |
| Central registry / CDN distribution | Sharing is sending a file; Kimi's empty channel is the cautionary case |
| Server-side disclosure state beyond mtime dedup | The client-key session already exists; anything more is machinery without a consumer |

## Verify the shipped path, not only the mechanism

This feature produced the same defect twice, and both times it reached users
before anyone noticed.

**Protocol negotiation.** The Broker advertised `1.4` while the CLI still asked
for a hard-coded `1.3`, so delivery returned nothing for every real `bp`
invocation. Every test passed, because the harness injects a connection pinned
to the version the gate wanted.

**Seed location.** `SKILL.md` told Agents to copy the shipped notes into the
state directory without saying where those notes were, and
`${CLAUDE_PLUGIN_ROOT}` appeared nowhere in that file. The archive was correct;
the instruction was not actionable. Every corpus stayed empty.

Both share a shape worth naming. Each layer of the mechanism was verified — the
store against fixtures, delivery against scripted behaviours, the seeds against
live sites — while the path a user actually takes was verified in neither case.
Both failures were also silent: no error, no diagnostic, nothing that would
surface in a log. A feature that is inert reports exactly what a feature with
nothing to say reports.

The practice this argues for is small and specific: **after shipping, use the
shipped artifact the way a user would, before calling the work done.** Install
it, start from the state a new user starts from, and run the first thing they
would run. Both defects would have taken minutes to find that way, and neither
was reachable from any test suite, because both lived in the seam between
components that tests stub for each other.

The two guards that now exist are narrow by design. `protocol.test.mjs` pins the
CLI's requested maximum to `LATEST_PROTOCOL_VERSION` so that literal cannot
return, and `managed-skill-validation.test.mjs` pins the seeding instruction to
the tree it names. Neither generalises: a third seam will need its own guard, or
the habit above.

## Residual risks

- **Seams are still only guarded where they broke.** Two have guards; the rest
  are covered by nothing but the practice above.
- **The doctrine itself is untested.** Whether Agents read a delivered entry
  before acting, write at the two prescribed moments, and repair rather than
  work around a stale note are all reasoned claims with no evidence behind
  them. Sitegeist at least shipped its confirmation loop to users; this design
  discarded that shape for a reasoned one and has measured nothing. This is the
  largest unverified surface in the feature and the subject of S7.
- **Quietly wrong conclusions.** A note like "absence of `rel=next` means
  last page" can mislead after a redesign without producing an error. This is
  not hypothetical: that exact claim was written into this plan, and field
  verification found the anchor still present on the last page with only its
  `href` removed.
  Mitigated — not eliminated — by evidence-carrying notes and age
  discounting. Inherent to any stored knowledge, structured or not.
- **Shipped seed decay has no upstream feedback loop.** All seven current seeds
  were field-verified on 2026-08-10, while automated checks only prove that the
  files parse and match their declared hosts. A user Agent may repair its local
  copy, but that correction never reaches the plugin source, so a later release
  can still seed stale guidance for new users.
- **Write rate depends on instruction adherence.** The design promises
  monotone accumulation, not coverage.
- **Concurrent edits** to one file are last-write-wins. Rare, low-stakes
  (notes, not code); accepted.
- **Coincidence-backed superstition** that keeps reproducing survives
  falsification.

## Workstreams

- [x] **S1** Broker site store: read `stateDir/sites`, parse frontmatter,
  match host/path with lenient normalization. Unit tests: subdomain, `www.`
  stripping, path globs, case, invalid-frontmatter exclusion, missing
  directory.
  - Complete: `src/services/site-knowledge-store.ts`. The frontmatter parser
    is hand-written because the runtime carries no YAML dependency and only
    four fields are machine-consumed.
- [x] **S2** Delivery: `site` field on observation-bearing results, mtime
  dedup in client-key session state, specificity ordering, ~2KB budget with
  overflow-to-seen, invalid-file diagnostics once per session. Protocol
  `1.4` additive. Tests: full-then-seen transition, redelivery after edit
  (mtime bump), cross-Agent redelivery, budget overflow.
  - Complete: `src/services/site-knowledge-delivery.ts`, scoped to the
    Workspace. Site content is classified `user_file`, which the nine
    observation-bearing tools now declare.
- [x] **S3** CLI output: render `site` entries in JSON and human modes.
  - Complete: delivered with S2, since the JSON path was needed to observe
    the field at all.
- [x] **S4** Plugin: SKILL.md "Site Knowledge" section with the doctrine
  above, including the seeding instruction; update `compatibility.json` for
  the paired versions.
  - Complete. `bp status` also reports `paths.sites`: the corpus location
    differs per platform and moves with `BROWSER_PILOT_HOME`, so a hardcoded
    path in the doctrine would have been wrong on Windows.
- [x] **S5** Seeds: author 4–6 files meeting the selection criteria;
  validate the validatable ones against the real-site canary suite; review
  each as a format exemplar.
  - Complete at seven files, one above the original range. All seven were
    field-verified with a real browser on 2026-08-10. The real-site canary suite
    still covers only one synthetic host (`the-internet.herokuapp.com`), so it
    does not continuously revalidate any shipped seed; current automated tests
    cover format, store acceptance, and host matching only. Growing or
    refreshing the set therefore still needs live verification or new canary
    hosts.
- [x] **S6** Guardrails: assert no install/upgrade/uninstall path writes to
  `sites/`; document the user-data (not cache) classification for future
  uninstall work.
  - Complete: `tests/site-knowledge-guardrails.test.mjs`. Each assertion was
    checked by violating the property it protects.
- [x] **S7** Doctrine-adherence probes. Redefined: the original wording asked
  for a turn-count delta and pointed at `tests/agent/`, and both were wrong.
  `tests/agent/` is legacy — its README marks the JSON tasks non-authoritative
  and the harness now lives in the separate caliper checkout under
  `CALIPER_ROOT`. More importantly, turn count measures whether knowledge
  *helps*, while the untested claims are about whether Agents *follow the
  doctrine at all*. Those claims are the largest unverified surface in this
  design; everything else has either shipped tests or field verification.

  Each probe targets one rule, is scored by deterministic post-hoc shell
  checks (caliper's `verify_commands`, no LLM judge), and reports a **rate over
  N samples** rather than pass/fail, because adherence is probabilistic. All
  three need the Broker built from this branch and `CALIPER_BP_SKILL_PATH`
  pointed at its skill, with an isolated `BROWSER_PILOT_HOME` per sample so the
  corpus starts in a known state.

  - [x] **S7.1** *Repair on contradiction* — the highest-stakes rule and the
    easiest to score. Pre-seed a file whose note is demonstrably false for the
    page. Give a task that must act on what the note describes. Afterwards,
    check whether the false line was corrected. Three outcomes are worth
    distinguishing and all are observable: corrected, silently worked around
    (task done, file untouched), and obeyed anyway (task failed).
    - Initial baseline on 2026-08-11: the caliper adapter completed three
      independent serial `anthropic/claude-sonnet-4-6` samples. Every sample
      received the full false note and the host's scoped file-edit capability,
      observed the post-click `Loading...` state, completed the page task, and
      left the note untouched: corrected 0/3, worked around 3/3, failed with
      the false note 0/3, invalid 0/3. The three valid samples used 89,510
      tokens in total and are recorded under caliper's
      `logs/site-knowledge-s7-valid/`. This establishes the first directional
      baseline, not a confidence claim; the task's default N=10 remains
      available when a tighter estimate is worth the model cost.
    - Three earlier samples are excluded: caliper's output formatter removed
      the delivered `site` field and its text-protocol host exposed no file
      edit capability. Both measurement defects now have regression tests.
    - Native-tool follow-up completed on 2026-08-12 with CC Switch's current
      Codex `OpenAI_1` provider, `openai/gpt-5.6-sol`, and `xhigh` reasoning.
      The N=1 calibration advertised `site_knowledge_replace` on both model
      requests, but the model never called it, never acted on the page, and
      scored `failed_with_false_note`; it used 18,720 tokens. The directional
      N=3 run advertised the tool on all eight model requests. Two samples each
      called it once and removed the false claim with a factually correct
      replacement; the third never called it. None clicked Start, so the two
      repaired samples were `corrected_task_failed` and the untouched sample was
      `failed_with_false_note`: complete repair adherence 0/3, successful native
      replacement 2/3, untouched task failure 1/3. The N=3 samples used 78,581
      tokens. Logs are caliper's
      `logs/site-knowledge-s7-repair-native-calibration/2026-08-12T09-27-15-00-00_site-knowledge-repair_eLufjQdEbodMb32YM7GtWA.eval`
      and
      `logs/site-knowledge-s7-repair-native-n3-openai1/2026-08-12T09-31-39-00-00_site-knowledge-repair_N6URSoRGEzSg7BjN7xx853.eval`.
      This is evidence that the native editor is usable and can improve repair
      behavior, but the mixed protocol still leaves `bp` as text-only while the
      editor is a native API tool; the model repeatedly claimed no browser tool
      was available. Therefore these runs do not isolate doctrine adherence from
      command-affordance recognition, and they do not supersede the original
      all-text baseline.
    - All-native channel calibration completed on 2026-08-12 with the same
      current Codex `OpenAI_1` provider, `openai/gpt-5.6-sol`, and `xhigh`
      reasoning. Caliper exposed both page operations and note repair as native
      API tools, disabled model-emitted textual `bp ...` execution, and still
      used structured argv without a shell. All seven model requests advertised
      `[browser_pilot, site_knowledge_replace]`. The model called
      `browser_pilot` six times, clicked Start, observed `Hello World!`, and
      answered correctly, but called `site_knowledge_replace` zero times and
      left the false claim untouched. Result: corrected 0/1, worked around 1/1,
      failed with false note 0/1, invalid 0/1, using 71,325 tokens. The log is
      caliper's
      `logs/site-knowledge-s7-repair-all-native-n1-openai1/2026-08-12T10-45-45-00-00_site-knowledge-repair_JANQ4mHoMALxWEfBTRG5jL.eval`.
      This removes the mixed-channel affordance confound from the earlier
      native-editor follow-up: the browser tool was both available and used,
      while the contradicted note still was not repaired. N=1 remains a channel
      calibration rather than a confidence estimate.
  - [x] **S7.2** *Read before acting* — pre-seed a note that is the only cheap
    route to a correct answer, and pair every sample with a control run that
    has an empty corpus. Without the control the probe proves nothing, because
    a capable model may reach the answer unaided.
    - Harness implemented on 2026-08-11. Each epoch pairs two isolated model
      samples against a local Archive Lookup fixture: treatment receives a
      valid note containing an otherwise undiscoverable release-record route;
      control receives an empty corpus. The visible index leaks neither the
      route nor the answer, and the scorer requires both the exact answer and
      deterministic final-page evidence. It reports treatment success, control
      success, their `knowledge_lift`, and pair balance.
    - One-pair real-model calibration completed on 2026-08-11 with CC Switch's
      current Codex `OpenAI_1` provider, `openai/gpt-5.6-sol`, and `xhigh`
      reasoning. Treatment succeeded 1/1, control succeeded 0/1,
      `knowledge_lift` was 1.0, and pair balance was 1.0. The treatment's
      initial observation delivered the route note as `status: full`; its first
      browser action opened that route and it answered `cobalt-lantern` from the
      live page. The control received no `site` entry, never reached the route,
      and produced no answer. The pair used 87,698 tokens and is recorded under
      caliper's `logs/site-knowledge-s7-read-calibration/`.
    - Evaluation transport caveat: this provider returns 502 for Inspect
      0.3.205's automatic Responses field `truncation: "auto"`, while the same
      request succeeds without that field. The runs used a process-local
      compatibility adapter that removed only that field; provider credentials
      remained process-local and were not persisted.
    - Directional N=3 baseline completed on 2026-08-11 with the same provider,
      model, and reasoning setting. Treatment succeeded 3/3, control succeeded
      0/3, `knowledge_lift` was 1.0, and pair balance was 1.0. Every treatment
      received `status: full`, opened the hidden route, observed the live
      codename, and answered correctly; no control received a `site` entry,
      reached the route, or observed the codename. The six samples used 240,147
      tokens. The merged successful log is caliper's
      `logs/2026-08-11T10-08-03-00-00_site-knowledge-read_fTnVGNhXAq227sj4ajPXnv.eval`.
    - The first N=3 attempt was interrupted after one valid treatment because
      the next Chrome authorization was not approved. Inspect retry preserved
      that completed sample and ran the remaining five. The interrupted log
      under caliper's `logs/site-knowledge-s7-read-n3-openai1/` remains as an
      audit record and is not counted as an additional sample.
    - This closes the directional S7.2 baseline. The task's default N=5 remains
      available if a tighter estimate becomes worth another ten model samples.
  - [x] **S7.3** *Write after recovery* — start from an empty corpus, give a
    task containing a non-obvious trap, and check afterwards whether a file
    appeared that the store accepts and whose patterns match the host. Expect a
    low rate; the design only claims monotone accumulation, so the number to
    record is the baseline, not a threshold to pass.
    - Harness implemented on 2026-08-11. Each sample starts with an empty corpus
      and a local Dispatch Console fixture. Standard transport must fail before
      the otherwise hidden Legacy option can recover the task. The final
      stimulus reports only the rejected transport and policy code; it does not
      reveal the recovery steps. The scorer separately requires the failed-then-
      recovered page state, the exact live receipt, and a note accepted by the
      product's `SiteKnowledgeStore` whose domains match the loopback host.
    - The finalized one-sample calibration used CC Switch's current Codex
      `OpenAI_1` provider, `openai/gpt-5.6-sol`, and `xhigh` reasoning. The task
      succeeded, the corpus remained empty, and the sample therefore scored
      `not_written`; it used 47,324 tokens. The log is caliper's
      `logs/site-knowledge-s7-write-calibration/2026-08-11T10-40-41-00-00_site-knowledge-write_8PGL3RNxw2RBG3cHmzwgs5.eval`.
    - Directional N=3 completed on 2026-08-11 with the same provider, model,
      reasoning setting, and process-local Responses compatibility adapter used
      by S7.2. All three samples first reproduced the Standard-transport failure,
      independently explored and enabled Legacy transport, generated and
      reported `ember-417`, and passed both deterministic page checks. None
      attempted `file-write`; all three corpora remained empty. Results: valid
      write 0/3, not written 3/3, invalid write 0/3, task failure 0/3, probe
      error 0/3. The samples used 251,500 tokens in total and are recorded in
      caliper's
      `logs/site-knowledge-s7-write-n3-openai1/2026-08-11T10-44-02-00-00_site-knowledge-write_J23qygq5tWfcRTXvbaPvfq.eval`.
    - Two earlier calibration artifacts are excluded. One completed no sample
      because Inspect parsed the profile task argument as an integer; all S7
      tasks now normalize it before subprocess dispatch and have a regression
      test. The next ran a valid harness but its error message disclosed the
      exact Legacy recovery steps, making a missing note doctrinally ambiguous;
      the final fixture and its contract test prohibit that leakage.
    - Native-tool follow-up completed on 2026-08-12 with the same `OpenAI_1`
      provider, model, reasoning setting, and process-local Responses
      compatibility adapter. The N=1 calibration completed the page task and
      reported `ember-417`, but left the corpus empty: valid write 0/1,
      not written 1/1. `site_knowledge_write` was advertised on all 10 model
      requests and called zero times; the sample used 99,195 tokens. The N=3
      run advertised it on every model request (16/16) and again received zero
      calls. Two samples recovered the page task and left the corpus empty; one
      stopped before any page action after reporting that no `bp` runner was
      available. Results: valid write 0/3, not written 2/3, invalid write 0/3,
      task failure 1/3, probe error 0/3, using 159,532 tokens. Logs are caliper's
      `logs/site-knowledge-s7-write-native-calibration/2026-08-12T08-04-59-00-00_site-knowledge-write_mkQDBVq89DCt9CyonKWNe6.eval`
      and
      `logs/site-knowledge-s7-write-native-n3-openai1/2026-08-12T09-02-05-00-00_site-knowledge-write_7YQhLmLniBLmKqPaEAFZLn.eval`.
      Five earlier N=3 artifacts in that directory completed zero samples after
      Chrome authorization failed and are excluded. The native tool's presence
      is proven, but it did not improve write adherence; this follow-up remains
      separate from the original all-text baseline because the browser command
      channel was still text-only.
    - All-native channel calibration completed on 2026-08-12 with the same
      provider, model, and reasoning setting. All seven model requests
      advertised `[browser_pilot, site_knowledge_write]`. The model called
      `browser_pilot` six times, reproduced the Standard-transport failure,
      opened Delivery options, enabled Legacy transport, generated
      `ember-417`, and passed both deterministic page checks. It called
      `site_knowledge_write` zero times and left the corpus empty. Result: valid
      write 0/1, not written 1/1, invalid write 0/1, task failure 0/1, probe
      error 0/1, using 69,504 tokens. The log is caliper's
      `logs/site-knowledge-s7-write-all-native-n1-openai1/2026-08-12T10-50-19-00-00_site-knowledge-write_kwbrWkyHv86jpEBNPKbCTQ.eval`.
      As in S7.1, the model used the native browser channel successfully but did
      not use the simultaneously available native corpus tool. The earlier
      "no bp runner" ambiguity is therefore absent; N=1 still measures only a
      calibrated observation, not a stable rate.

  All six successful native follow-up logs were checked byte-for-byte against
  the selected `OpenAI_1` credential after completion. None contains the key,
  the `ANTHROPIC_API_KEY` marker, or a Claude Code auth marker. Each real sample
  ran serially with `--max-samples 1`; no Anthropic or Claude Code
  authentication was used. The two all-native samples used Inspect 0.3.205's
  same process-local compatibility adapter, removing only the unsupported
  Responses field `truncation: "auto"` and leaving site-packages unchanged.

  Implementation lives in caliper, not here. What belongs in this repo is the
  fixture corpus each probe seeds, kept beside the tests rather than in
  `plugin/.../sites/`, so probe fixtures are never confused with shipped seeds.
