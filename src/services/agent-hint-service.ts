import type { AgentHint, ArtifactId } from '../protocol/model.js';
import type { SnapshotGuidanceSignals } from '../snapshot.js';

const MAX_HINT_REFS = 32;
const MAX_REASON_LENGTH = 128;

function refs(values: readonly number[]): number[] {
  return [...new Set(values)]
    .filter(value => Number.isSafeInteger(value) && value > 0)
    .slice(0, MAX_HINT_REFS);
}

function reason(value: string): string {
  return value.slice(0, MAX_REASON_LENGTH) || 'unknown';
}

export function observationAgentHints(
  current: SnapshotGuidanceSignals,
  previous?: SnapshotGuidanceSignals,
): AgentHint[] {
  const hints: AgentHint[] = [];
  if (current.modalCount > 0 || current.blockingModalCount > 0) {
    hints.push({
      code: 'modal_overlay',
      source: 'observation',
      confidence: current.blockingModalCount > 0 ? 'strong' : 'possible',
      recommendedAction: 'resolve_overlay_first',
      blocking: current.blockingModalCount > 0,
      refs: refs(current.modalRefs),
    });
  }
  if (current.authenticationSurface || previous?.authenticationSurface) {
    const state = previous === undefined
      ? 'present'
      : current.authenticationSurface && !previous.authenticationSurface
        ? 'entered'
        : !current.authenticationSurface && previous.authenticationSurface
          ? 'left'
          : 'present';
    hints.push({
      code: 'authentication_surface',
      source: 'observation',
      confidence: 'strong',
      recommendedAction: 'inspect_authentication_state',
      state,
    });
  }
  if (current.explicitAutocompleteCount > 0 || current.autocompleteRefs.length > 0) {
    hints.push({
      code: 'autocomplete',
      source: 'observation',
      confidence: current.explicitAutocompleteCount > 0 ? 'strong' : 'possible',
      recommendedAction: 'observe_then_select',
      refs: refs(current.autocompleteRefs),
    });
  }
  if (current.explicitFilterCount > 0 || current.filterRefs.length > 0) {
    hints.push({
      code: 'filter_controls',
      source: 'observation',
      confidence: 'strong',
      recommendedAction: 'review_refinement_controls',
      refs: refs(current.filterRefs),
    });
  }
  return hints;
}

export function accessBlockedAgentHint(type: string, status: number | undefined): AgentHint | undefined {
  if (type.toLowerCase() !== 'document' || (status !== 403 && status !== 429)) return undefined;
  return {
    code: 'access_blocked',
    source: 'network',
    confidence: 'strong',
    recommendedAction: 'avoid_same_navigation_retry',
    status,
  };
}

export function downloadAgentHint(input:
  | { state: 'started' }
  | { state: 'completed'; artifactId: ArtifactId }
  | { state: 'failed' | 'cancelled'; reason: string }
): AgentHint {
  const common = {
    code: 'download' as const,
    source: 'download' as const,
    confidence: 'strong' as const,
  };
  if (input.state === 'started') {
    return { ...common, recommendedAction: 'wait_for_download', state: input.state };
  }
  if (input.state === 'completed') {
    return {
      ...common,
      recommendedAction: 'inspect_download_artifact',
      state: input.state,
      artifactId: input.artifactId,
    };
  }
  return {
    ...common,
    recommendedAction: 'inspect_download_failure',
    state: input.state,
    reason: reason(input.reason),
  };
}

export function repeatedActionAgentHint(streak: number, value: string): AgentHint {
  return {
    code: 'repeated_action',
    source: 'watchdog',
    confidence: 'strong',
    recommendedAction: 'change_strategy',
    streak: Math.max(1, Math.min(Number.isSafeInteger(streak) ? streak : 1, 1_000_000)),
    reason: reason(value),
  };
}
