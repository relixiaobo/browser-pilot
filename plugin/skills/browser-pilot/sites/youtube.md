---
name: youtube
domains: ["youtube.com", "youtu.be"]
summary: The page navigates itself when a video ends, and reads carry player text that is not true
updated: 2026-08-10
---
- A watch page moves on by itself. When the video finishes, autoplay loads the next one and
  the observed URL is no longer the one that was opened — a nineteen-second video changed
  under a single sequence of observations. Check the URL of every observation on a watch
  page, and press `k` to pause before doing anything that takes more than a few seconds.
- `bp read` mixes hidden player boilerplate into the page text, and some of it reads like
  real state: "You're signed out" and "An error occurred while retrieving sharing
  information" both appear on a normally signed-in page with nothing wrong. Never report
  sign-in state or errors from this text; confirm them against controls in the snapshot.
- The tab title is prefixed with the account's unread notification count, so it arrives as
  something like `(37) Me at the zoo - YouTube`. Strip the count before using the title.
- Navigation returns long before the page fills in. The first observation held nineteen
  elements, all player controls, and grew past a hundred a few seconds later. An early
  read finds no title, channel, or metadata.
- Comments do not exist until the page is scrolled down, and once loaded they dominate the
  observation — dozens of like and reply controls that crowd out everything else. Raise
  the limit or work from `bp read` when the comments are the target.
- The recommendation rail is personalised to the signed-in account, so nothing there is a
  property of the video being watched.
