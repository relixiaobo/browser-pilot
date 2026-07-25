import assert from 'node:assert/strict';
import test from 'node:test';
import {
  accessBlockedAgentHint,
  downloadAgentHint,
  observationAgentHints,
  repeatedActionAgentHint,
} from '../dist/services.js';

function guidance(overrides = {}) {
  return {
    authenticationSurface: false,
    modalCount: 0,
    blockingModalCount: 0,
    explicitAutocompleteCount: 0,
    explicitFilterCount: 0,
    autocompleteRefs: [],
    modalRefs: [],
    filterRefs: [],
    ...overrides,
  };
}

test('observation hints are deterministic, bounded, and based on explicit browser signals', () => {
  const hints = observationAgentHints(guidance({
    authenticationSurface: true,
    modalCount: 2,
    blockingModalCount: 1,
    explicitAutocompleteCount: 1,
    explicitFilterCount: 1,
    autocompleteRefs: [7, 7, ...Array.from({ length: 40 }, (_, index) => index + 1)],
    modalRefs: [2, 3],
    filterRefs: [9],
  }));

  assert.deepEqual(hints.map(hint => hint.code), [
    'modal_overlay',
    'authentication_surface',
    'autocomplete',
    'filter_controls',
  ]);
  assert.equal(hints[0].blocking, true);
  assert.equal(hints[1].state, 'present');
  assert.equal(hints[2].confidence, 'strong');
  assert.equal(hints[2].refs.length, 32);
  assert.equal(new Set(hints[2].refs).size, hints[2].refs.length);
});

test('authentication hints distinguish entering, remaining on, and leaving an auth surface', () => {
  const absent = guidance();
  const present = guidance({ authenticationSurface: true });

  assert.deepEqual(observationAgentHints(absent), []);
  assert.equal(observationAgentHints(present)[0].state, 'present');
  assert.equal(observationAgentHints(present, absent)[0].state, 'entered');
  assert.equal(observationAgentHints(present, present)[0].state, 'present');
  assert.equal(observationAgentHints(absent, present)[0].state, 'left');
});

test('access-blocked hints apply only to main-document 403 and 429 responses', () => {
  assert.equal(accessBlockedAgentHint('Document', 403)?.status, 403);
  assert.equal(accessBlockedAgentHint('document', 429)?.status, 429);
  assert.equal(accessBlockedAgentHint('XHR', 403), undefined);
  assert.equal(accessBlockedAgentHint('Document', 401), undefined);
});

test('download and repeated-action hints expose bounded public recovery data', () => {
  assert.equal(downloadAgentHint({ state: 'started' }).recommendedAction, 'wait_for_download');
  assert.deepEqual(downloadAgentHint({ state: 'completed', artifactId: 'artifact:public' }), {
    code: 'download',
    source: 'download',
    confidence: 'strong',
    recommendedAction: 'inspect_download_artifact',
    state: 'completed',
    artifactId: 'artifact:public',
  });
  assert.equal(downloadAgentHint({
    state: 'failed',
    reason: 'x'.repeat(200),
  }).reason.length, 128);

  const repeated = repeatedActionAgentHint(Number.MAX_SAFE_INTEGER, 'y'.repeat(200));
  assert.equal(repeated.streak, 1_000_000);
  assert.equal(repeated.reason.length, 128);
});
