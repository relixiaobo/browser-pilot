---
name: google-search
domains: ["google.com/search*", "google.*/search*"]
summary: Reach results by constructing the search URL, and read them as text
updated: 2026-08-10
---
- Navigate straight to `https://www.google.com/search?q=<url-encoded query>`. Driving the
  home page search box costs extra turns and raises a suggestions overlay for no gain.
- Read results with `bp read`, which returns them cleanly as title, source, and snippet in
  order. Do not build selectors from result classes: they are short generated hashes such
  as `LC20lb MBeuO DKV0Md` that carry no meaning and change without notice.
- The page chrome is localised to the account and region, so accessible names arrive in
  the user's language rather than in English. Never match a control by its English text
  here; use its role and position in the snapshot.
- Layout also varies by account and live experiment, so the same query can be arranged
  differently on two machines. Observe the result page each time rather than remembering
  its shape.
