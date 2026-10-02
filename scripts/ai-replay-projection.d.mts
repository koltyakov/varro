import type { ServerEvent } from '../src/shared/protocol';
import type { MessageEntry, Session, SessionStatus } from '../src/webview/types';

export class ReplayProjection {
  constructor(recordedMessages: MessageEntry[]);
  apply(
    state: {
      session: Session;
      messages: MessageEntry[];
      status?: SessionStatus;
      todos?: unknown[];
      diff?: unknown[];
    },
    event: ServerEvent
  ): void;
}
