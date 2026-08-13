---
title: "Shipped Site Seed Freshness"
status: "Implemented"
source_of_truth: "This document and docs/site-knowledge-seed-verification.json"
created: "2026-08-13"
updated: "2026-08-13"
---

# Shipped Site Seed Freshness

## Purpose And Reader

This is the product definition for preventing Browser Pilot releases from
silently carrying site-knowledge seeds that nobody has reverified. It is for
maintainers changing, validating, or releasing the plugin and for Agents that
discover a shipped claim is stale during an ordinary user task. The broader
site-knowledge behavior remains authoritative in `docs/plans/site-knowledge.md`.

## Decision Summary

- **DEC-1:** Use two independent upstream signals: a repository-owned
  verification ledger with scheduled and release gates, and an explicit,
  redacted GitHub report offered only after a shipped original is contradicted.
- **DEC-2:** Never upload, diff, fingerprint, or classify a user's local corpus
  automatically. Local repair remains immediate and does not depend on an
  upstream report.
- **DEC-3:** Warn at 75 days and block releases at 90 days. Reverification must
  bind the exact shipped bytes, their `updated` date, and a human-reviewable
  evidence reference.
- **Primary risk:** The ledger proves recency and binding, not the truth of a
  maintainer's evidence. Live verification remains a human responsibility for
  sites that require accounts or contain private data.

## Objective, Constraints, And Options

- **OBJ-1:** A future release must not silently seed guidance whose shipped
  original has gone 90 days without live verification.
- **Minimum acceptable outcome:** Every shipped original has one current
  verification record; maintainers receive notice before expiry; release fails
  at expiry; a user can report an upstream contradiction without exposing their
  corpus.
- **Clean-slate best answer:** Independent, privacy-safe live canaries
  continuously revalidate every claim on public test accounts.
- **Selected target:** **OPT-2**, because most current seeds require signed-in
  state, personal surfaces, or visual judgment that CI cannot safely reproduce.
- **Revisit trigger:** Reconsider per-seed automated canaries when a stable
  public fixture or dedicated non-personal test account can verify a seed's
  claims without retaining account or page data.

### Constraints

- **CON-1 hard:** `~/.browser-pilot/sites` is user data. No background process,
  release check, Agent instruction, or report flow may transmit it.
- **CON-2 hard:** A public report requires the user's explicit approval after
  the exact redacted draft is shown.
- **CON-3 legacy:** Seeding is directory-level copy-once. An upstream correction
  protects new users but never overwrites an installed corpus.
- **CON-4 legacy:** The design excludes a central registry/CDN and a `bp site`
  command family; freshness work must not reintroduce either surface.
- **CON-5 resolvable:** Current real-site canaries cover no shipped seed. A
  future seed-specific canary can replace manual verification for the claims it
  actually exercises.

### Options Considered

- **OPT-1 clean-slate:** Continuously verify every seed against controlled live
  accounts. Rejected now because the current sites and claims cannot be covered
  without fragile credentials, personal data, or visual interpretation.
- **OPT-2 brownfield target:** Hash-bound ledger, 75/90-day gates, and an
  explicit report form. Selected because it makes silence visible while
  preserving the ownership model.
  - **TRD-1:** Verification remains periodic and manual; drift can exist between
    the site change and the next verification or user report.
- **OPT-3 minimum acceptable:** A release-only age check. Rejected because it
  gives maintainers no lead time and creates pressure to rubber-stamp evidence
  during a release.
- **OPT-4 no-build:** Rely on users repairing local copies. Rejected because
  those corrections are invisible upstream and every new user receives the
  unchanged original.

## Problem, Users, And Evidence

### Problem

The seven shipped originals were all verified on one day. Existing tests prove
that they parse and match their declared hosts, but not that their factual
claims remain true. Local repair contains harm for one corpus yet gives the
project no signal, so a later release can keep distributing the stale original.

### Target Users

- **Maintainer:** Needs advance notice, exact affected seeds, and a release
  boundary that cannot be crossed with expired verification.
- **Affected user:** Needs the immediate local task and repair to succeed, then
  may choose to report the smallest safe upstream evidence.
- **Agent:** Needs to distinguish a local-only edit from a contradiction that
  also exists in the shipped original.

### Evidence And Assumptions

- **EVD-1:** All seven current originals carry `updated: 2026-08-10`; the
  prior plan recorded no continuous revalidation path.
- **EVD-2:** The real-site canary suite covers only
  `the-internet.herokuapp.com`, which is not a shipped seed host.
- **EVD-3:** Copy-once seeding and guardrail tests intentionally prevent the
  product from rewriting installed files.
- **ASM-1:** A 75-day warning gives enough time to reverify before the 90-day
  release boundary. The first two cycles should be used to reassess this
  interval rather than treating it as universal truth.

## Scope

### In Scope

- Exact ledger coverage for every Markdown file in the shipped seed directory.
- SHA-256 binding between each record and the shipped file bytes.
- Equality between the note's `updated` date and the ledger's verification date.
- A non-blocking structural CI check, weekly warning gate, and release expiry
  gate.
- An explicit GitHub issue form and Agent doctrine for redacted upstream
  reports.

### Out Of Scope

- Automatic live browsing, automatic issue creation, telemetry, or corpus
  upload.
- Updating or identifying previously installed seed copies.
- Treating a local file with a shipped filename as vendor-owned.
- Claim-level schemas, central distribution, or a new CLI command.

## Product Model

- **Shipped original:** A Markdown note inside the plugin's `sites/` directory.
- **Installed copy:** A user-owned file copied once from a shipped original. It
  has no privileged identity after copying.
- **Verification record:** Seed name, exact content digest, live-verification
  date, and evidence reference stored in the repository ledger.
- **Fresh:** Fewer than 75 full UTC days since verification.
- **Warning:** At least 75 and fewer than 90 full UTC days since verification.
- **Expired:** At least 90 full UTC days since verification.
- **Upstream contradiction:** Current observation disproves a claim in both the
  user's local file and the current shipped original.

## User Flows

### FLOW-1: Scheduled Reverification

- **Actor:** Maintainer.
- **Entry path:** Weekly Site Seed Freshness GitHub Action.
- **Entry state:** At least one record is warning or expired.
- **Goal:** Restore fresh, evidence-backed originals before release pressure.
- **Mainline:** Reproduce each affected claim with Browser Pilot; correct or
  remove false claims; set `updated` to the verification date; update the
  ledger digest, date, and evidence; run all three verification modes.
- **Validation:** Exact seed coverage, digest match, date match, real date,
  evidence presence, and policy thresholds.
- **Result state:** Every verified record is fresh and the weekly action passes.
- **Failure/recovery:** If the site is unavailable, rerun later without changing
  the verification date. If a claim cannot be safely reverified before expiry,
  remove that shipped seed or defer the release.
- **Requirements:** FR-1, FR-2, FR-3.

### FLOW-2: Release Gate

- **Actor:** Release maintainer.
- **Entry path:** Native build and publish jobs.
- **Entry state:** A release tag is being built from the repository.
- **Goal:** Prevent expired or unbound originals from reaching new users.
- **Mainline:** The release check reads only repository files, validates every
  record, and allows packaging while all records are fresh or warning.
- **Result state:** Packaging proceeds with no expired verification.
- **Failure/recovery:** Any expired or invalid record blocks release and names
  the affected seed; the maintainer follows FLOW-1 or removes the seed.
- **Requirements:** FR-1, FR-2, FR-3.

### FLOW-3: Explicit User Report

- **Actor:** User, assisted by an Agent.
- **Entry path:** Observation contradicts a local note during an ordinary task.
- **Entry state:** The local task is recoverable and a same-named shipped
  original exists.
- **Goal:** Make a genuine upstream defect visible without disclosing local
  data.
- **Mainline:** Trust observation and repair locally; compare only the disputed
  shipped claim; if it is also wrong, explain the upstream defect and offer the
  issue form; draft the minimum report; redact it; show the exact draft; submit
  only after explicit approval.
- **Decision points:** If the shipped original is still correct, stop after the
  local repair. If the user declines, do not create a report.
- **Result state:** The user's task remains complete and, when approved, an
  upstream issue contains only minimal public evidence.
- **Failure/recovery:** If safe reproduction requires private data, omit it and
  leave the report unsent unless the user supplies an acceptable redacted form.
- **Requirements:** FR-4, NFR-1.

## Requirements And Acceptance Criteria

- **FR-1:** The repository shall keep exactly one verification record for every
  shipped Markdown seed.
  - **AC-1:** When a seed is added, removed, renamed, or changed without a
    matching ledger update, the structural check shall fail and identify the
    mismatch.
  - **AC-2:** When a record's digest differs from the shipped bytes or its date
    differs from `updated`, every check mode shall fail.
- **FR-2:** The checker shall classify age in full UTC days using fixed 75-day
  warning and 90-day expiry boundaries.
  - **AC-3:** When a record reaches 75 days, the scheduled gate shall fail while
    the release gate remains open.
  - **AC-4:** When a record reaches 90 days, the scheduled and release gates
    shall both fail.
- **FR-3:** Repository automation shall surface decay before and during release.
  - **AC-5:** While all records are fresh, structural, scheduled, and release
    checks shall pass and report the seven-record summary.
  - **AC-6:** If scheduled automation is unavailable, the independent release
    gate shall still enforce expiry.
- **FR-4:** The Agent shall offer an upstream report only for a contradiction in
  the current shipped original and shall require explicit approval of a
  redacted draft.
  - **AC-7:** When a contradiction is local-only or the user declines, no
    external issue shall be created.
  - **AC-8:** When a report is drafted, the form shall require the seed name,
    disputed sentence, observable evidence, redacted host/path pattern,
    reproduction, version, and both privacy confirmations.
- **NFR-1:** The freshness and report mechanisms shall never read or transmit a
  user's corpus, credentials, account identifiers, private URLs, private page
  content, screenshots, or local paths automatically.
  - **AC-9:** The scheduled, CI, and release checks shall read only tracked
    repository originals and their ledger.

## Edge Cases And Failure States

- **EC-1:** A content change keeps the old date and ledger: fail on digest.
- **EC-2:** A maintainer updates the ledger date but not `updated`: fail on date
  mismatch.
- **EC-3:** A verification date is invalid or in the future: fail as an invalid
  ledger rather than classifying it as fresh.
- **EC-4:** A fork never runs scheduled Actions: structural CI still validates
  binding, and release still enforces expiry.
- **EC-5:** Site drift occurs one day after verification: user contradiction
  reporting can surface it early; the ledger does not claim continuous truth.
- **EC-6:** Reverification cannot avoid personal data: do not capture the data;
  remove the seed if its claims cannot be safely established.

## Completion Signals

- **SM-1:** Every shipped original has a current, matching ledger record.
- **SM-2:** Weekly automation fails at warning and names affected seeds.
- **SM-3:** Release automation fails at expiry independently of the weekly job.
- **SM-4:** The issue form and skill doctrine require explicit, redacted consent.
- **Counter-metric:** Do not increase the amount of local or page data sent
  upstream in order to raise report volume.

## Implementation And Verification

The current implementation is intentionally repository-local:

- `scripts/verify-site-seed-freshness.mjs`
- `docs/site-knowledge-seed-verification.json`
- `.github/workflows/site-seed-freshness.yml`
- `.github/ISSUE_TEMPLATE/stale-site-seed.yml`

Verification commands:

```bash
npm run verify:site-seeds
npm run verify:site-seeds:scheduled
npm run verify:site-seeds:release
node --test tests/site-seed-freshness.test.mjs
npm run validate:skill
```

The first two completed 75/90-day cycles are the revisit point for **ASM-1**.
