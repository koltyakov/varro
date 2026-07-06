import type { RalphConfig } from '../../../shared/ralph';
import { postMessage } from '../../lib/bridge';
import { ralphStore } from '../../lib/stores/ralph-store';

/**
 * Thin protocol proxy to the Ralph orchestrator on the extension host. The
 * loop itself runs host-side (shared/ralph-runner-core.ts) so autonomous
 * runs survive webview disposal; this proxy forwards control messages and
 * applies optimistic mirror updates so the dashboard reacts immediately.
 * Authoritative state arrives via `ralph/state` broadcasts.
 */
export const ralphRunner = {
  isActive(managerSessionId: string): boolean {
    return ralphStore.isRunnerActive(managerSessionId);
  },

  async start(config: RalphConfig): Promise<void> {
    ralphStore.startRun(config);
    postMessage({ type: 'ralph/start', payload: { config } });
  },

  stop(managerSessionId: string): void {
    ralphStore.setStatus(managerSessionId, 'stopped', 'manual_stop');
    postMessage({ type: 'ralph/stop', payload: { managerSessionId } });
  },

  pause(managerSessionId: string): void {
    ralphStore.setStatus(managerSessionId, 'paused');
    postMessage({ type: 'ralph/pause', payload: { managerSessionId } });
  },

  async resume(managerSessionId: string): Promise<void> {
    const run = ralphStore.getRun(managerSessionId);
    if (!run) return;
    if (run.status !== 'paused' && run.status !== 'failed' && run.status !== 'incomplete') return;
    ralphStore.setStatus(managerSessionId, 'running');
    postMessage({ type: 'ralph/resume', payload: { managerSessionId } });
  },

  /**
   * Ask the host for the current Ralph state, handing over any runs an older
   * build left in webview localStorage. The host reattaches in-flight loops
   * itself; this only synchronizes the mirror.
   */
  reattachAll(): void {
    const legacyRuns = ralphStore.consumeLegacyRuns();
    postMessage({
      type: 'ralph/sync',
      payload: legacyRuns ? { legacyRuns } : {},
    });
  },
};
