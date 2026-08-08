---
name: google-search
domains: ["google.com/search*", "google.*/search*"]
summary: Reach results by constructing the search URL, and read them by text rather than by class
updated: 2026-08-08
---
- Navigate straight to `https://www.google.com/search?q=<url-encoded query>`. Driving the
  home page search box costs extra turns and raises a suggestions overlay over the page
  for no gain.
- Result markup is obfuscated and unstable: container classes are short generated hashes
  that change without notice, so a selector written today will not survive. Read results
  with `bp read` or locate one with `bp search <phrase>` instead.
- Layout varies by locale, account, and live experiment, so the same query can return a
  different arrangement on two machines. Treat the shape of a result page as something to
  observe each time, not something to remember.
