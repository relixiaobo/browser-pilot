---
name: google-docs-editors
domains: ["docs.google.com"]
summary: Docs, Sheets, and Slides paint their content to canvas and are nearly invisible to a snapshot
updated: 2026-08-08
---
- The document surface is painted to `<canvas>`, not built from DOM text. A snapshot
  returns the surrounding chrome — menus, toolbar, sidebars — and almost nothing of the
  content, and `bp read` returns little or none of it. An almost-empty result here means
  canvas rendering, not an empty document. Do not report the document as blank on that
  evidence.
- Read content with `bp screenshot` and look at the image.
- Edit through the focused editor rather than through refs: `bp keyboard` for text,
  `bp press` for arrows, Enter, Tab, and Ctrl/Cmd shortcuts. In Sheets, the name box
  above the grid jumps to a cell or selects a range, which is how to address a cell at
  all — individual cells have no ref.
- Toolbar, menu, and dialog controls are ordinary DOM and do appear in a snapshot. Only
  the document surface is canvas, so prefer a real ref for anything in the chrome.
- Creating a blank file is a plain navigation: `docs.google.com/document/create`,
  `/spreadsheets/create`, `/presentation/create`.
