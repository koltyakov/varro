import type { RalphIteration } from '../../../shared/ralph';
import { state } from '../../lib/state';

export function getRalphIterationLiveIssue(
  iteration: RalphIteration | null | undefined
): string | null {
  const childSessionId = iteration?.childSessionId;
  if (!childSessionId) return null;

  const usageLimit = state.sessionUsageLimits[childSessionId];
  if (usageLimit?.message) return usageLimit.message;

  if (!state.failedSessionIds.includes(childSessionId)) return null;

  const status = state.sessionStatus[childSessionId];
  if (status?.type === 'retry') return status.message?.trim() || 'Iteration retry failed';
  return 'Iteration failed';
}
