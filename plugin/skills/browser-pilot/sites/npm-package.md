---
name: npm-package
domains: ["npmjs.com/package/**"]
summary: A read returns the README whichever tab is active, so version and dependency data needs another command
updated: 2026-08-10
---
- `bp read` on a package page returns the README and the header, and it keeps doing that
  after switching tabs. On the Versions tab a six-thousand character read contained
  neither "Version History" nor "Current Tags", while `bp search` found both on the same
  page. Reading and concluding the data is absent is the mistake this page invites; use
  `bp search` or a selector-scoped read for anything outside the README.
- The header is the cheapest source of package identity and it opens the read: name,
  version, visibility, and publish age arrive in the first line, as
  `commander15.0.0 • Public • Published 2 months ago`.
- The tab labels carry their own counts, so dependency, dependent, and version totals can
  be taken straight from the snapshot without opening any tab — `0 Dependencies`,
  `144846 Dependents`, `124 Versions`.
- `?activeTab=versions` does switch the tab on a fresh navigation, so tabs need not be
  clicked. Confirm the switch with `bp search`, not with `bp read`, for the reason above.
