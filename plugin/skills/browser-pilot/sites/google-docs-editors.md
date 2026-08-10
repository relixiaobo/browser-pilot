---
name: google-docs-editors
domains: ["docs.google.com"]
summary: Document content is painted, not built from DOM, so no text observation can reach it
updated: 2026-08-10
---
- The document surface carries no text in the observation. Typing `DOCPROBE9` into a blank
  document put it on screen, yet neither the snapshot nor `bp read` contained it: the
  snapshot held 69 entries, all of them menus, toolbar buttons, and panels. A Sheets grid
  behaves the same way, and its cells have no refs at all.
- `bp read` here returns only the surrounding interface — outline, tabs, template names —
  so an almost-empty read means the content is unreachable this way, never that the
  document is empty. Do not report a document as blank on that evidence.
- Read content with `bp screenshot` and look at the image. That is also the only way to
  confirm an edit: since the text is invisible to observation, a successful command proves
  nothing about what actually landed. In Sheets a blind `bp keyboard` left a single stray
  character in the cell and opened a side panel, and the snapshot gave no sign of either.
- Menus, toolbar, dialogs, and the Sheets name box are ordinary controls and do appear
  with refs. Prefer a real ref for anything outside the document surface; the name box,
  which reports and sets the current cell, is how to address a cell at all.
- Creating a blank file is a plain navigation: `docs.google.com/document/create` and
  `/spreadsheets/create`.
