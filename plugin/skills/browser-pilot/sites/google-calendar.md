---
name: google-calendar
domains: ["calendar.google.com"]
summary: The grid exposes days but not the events on them, and a read gives counts without titles
updated: 2026-08-10
---
- Events are not addressable. A settled week view observed as roughly 120 elements —
  toolbar, navigation, and one button per day — with no element per event, so there is no
  ref to click an appointment with. Day headers do carry full names such as
  `Monday, August 10, today`, which is how to navigate.
- `bp read` reports how many events a day holds but not what they are: it returns lines
  like `Week of August 10, 2026, 1 event` and `1 all day event, Monday, August 10, today`,
  and `No all day events` for the empty days. Counting from a read is sound; naming an
  event from one is not. Use `bp screenshot` to see titles and times.
- The grid is rendered on the user's own locale settings, so day headers can carry a
  secondary calendar system alongside the date. Do not parse them as plain dates.
- Views are plain URLs and are the reliable way to move around, for example
  `calendar.google.com/calendar/u/0/r/week` and `.../r/day/<yyyy>/<mm>/<dd>`.
