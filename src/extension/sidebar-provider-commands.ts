import type { ExtensionMessage } from '../shared/protocol';
import type { SidebarProviderUiState } from './sidebar-provider-ui-state';
import type { SessionStateManager } from './session-state-manager';

export class SidebarProviderCommands {
  constructor(
    private readonly uiState: SidebarProviderUiState,
    private readonly sessionState: SessionStateManager
  ) {}

  postCommand(post: (message: ExtensionMessage) => void, cmd: 'new-session' | 'abort') {
    post({ type: `command/${cmd}` } as ExtensionMessage);
  }

  requestInputFocus(flush: () => void) {
    this.uiState.pendingInputFocus = true;
    flush();
  }

  hasPendingAttention() {
    return this.sessionState.pending.size > 0;
  }

  openAttentionSessions(flush: () => void) {
    this.uiState.pendingOpenAttentionSessions = true;
    flush();
  }

  flushPendingInputFocus(
    view: { visible?: boolean } | undefined,
    post: (message: ExtensionMessage) => void
  ) {
    this.uiState.flushPendingInputFocus(view as never, post);
  }

  flushPendingOpenAttentionSessions(
    view: { visible?: boolean } | undefined,
    post: (message: ExtensionMessage) => void
  ) {
    this.uiState.flushPendingOpenAttentionSessions(view as never, post);
  }
}
