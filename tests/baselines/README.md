# Browser capability baselines

`browser-capability.v1.json` records results from the local capability fixture
matrix against an isolated system Chrome. It never contacts a third-party site
or attaches to the user's running browser.

The metrics are:

- observable target recall: expected actionable role/name pairs returned by an
  Observation, divided by all expected actionable pairs;
- false interactable rate: returned role/name pairs that the controlled fixture
  declares currently non-actionable, divided by all returned pairs;
- action failure detection: expected unsafe or unsuccessful actions rejected by
  Browser Pilot, divided by all failure cases;
- stale ref detection: same-document semantic changes or detachments rejected as
  `stale_ref`, divided by all stale-ref cases;
- output size: the largest UTF-8 serialized Observation data sample after the
  ephemeral local origin is normalized to its path.

Run `npm run test:capabilities` to measure the current implementation. The gate
allows recall and detection rates to improve and false-interactable rate to
decrease. It rejects regressions, unclassified new refs, corpus drift, and an
increase beyond the recorded output-size maximum. Update the fixture ground
truth and baseline together only after reviewing an intentional behavior change.
