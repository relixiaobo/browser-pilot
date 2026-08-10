---
name: stackoverflow
domains: ["stackoverflow.com/questions/**", "stackexchange.com/questions/**"]
summary: A verification interstitial answers the first navigation, and extracted code carries a stray Copy
updated: 2026-08-10
---
- The first navigation lands on a verification interstitial, not the question. It observes
  as a single element with the title `Just a moment...`, which looks exactly like a page
  that failed to load. It clears itself within a few seconds — wait and observe again
  rather than retrying the navigation or reporting the question as missing.
- A read starts with the vote buttons' tooltip text and the score, not with the question:
  "This question shows research effort; it is useful and clear", then the number, then the
  downvote wording. Skip past that rather than treating it as the opening of the post.
- Code blocks survive extraction with their line breaks, but indentation collapses to
  single spaces and the copy button's label is glued to the front of the block, so a
  snippet arrives as `Copy#include <algorithm>`. Strip the leading `Copy` and re-indent
  before using extracted code.
