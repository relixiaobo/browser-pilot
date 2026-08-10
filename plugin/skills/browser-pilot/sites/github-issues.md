---
name: github-issues
domains: ["github.com/*/*/issues*"]
summary: The list arrives after navigation returns, and the last page still advertises a next link
updated: 2026-08-10
---
- The list is fetched after the document loads, so the observation `bp open` returns can
  hold the page chrome and no issues at all. Seeing no issue links means the fetch has not
  landed yet, not that the query found nothing. Observe again before concluding anything
  about the result set.
- Do not decide whether more pages exist by looking for a next-page anchor in the DOM. On
  the last page that anchor is still present and still visible, and only its `href` is
  gone. Use the snapshot instead: while more pages remain it lists a Next Page link, and
  on the last page that link is absent while a Previous Page link remains.
- Filter through the URL rather than the filter buttons: append a query such as
  `?q=is%3Aopen+label%3Abug`. The counts beside Open and Closed confirm it took effect,
  and a Clear filter control appears while a filter is active.
- Opening a filter button floods the observation with its options — the label picker
  alone contributes more entries than a default snapshot returns — so the issues vanish
  from view while it is open. Close it with Escape before observing the list again.
