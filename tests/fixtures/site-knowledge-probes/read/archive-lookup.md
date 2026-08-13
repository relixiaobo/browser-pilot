---
name: archive-lookup
domains: ["127.0.0.1"]
summary: Hidden route for archive release records
updated: 2026-08-11
---
- Release records are not linked from the visible index. The stable lookup route
  is `/_archive/v2/items/<record-id>/release-label`; navigate there and observe
  the returned page rather than guessing the release codename. Evidence: record
  7319 returned a page headed `Release record 7319` on 2026-08-11.
