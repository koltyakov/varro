import type { ServerEvent } from '../src/shared/protocol.js';
import type { MessageEntry, Session, SessionStatus } from '../src/webview/types/index.js';

export type BurstCase = 'text-bursts' | 'tool-handoffs' | 'overlapping-parts';
export const BURST_CASES: BurstCase[];
export type BurstCapture = {
  label: string;
  scenario: string;
  capturedAt: string;
  model: string;
  session: Session;
  initialMessages: MessageEntry[];
  initialStatus: SessionStatus;
  finalMessages: MessageEntry[];
  events: { offsetMs: number; event: ServerEvent }[];
  reproduction: {
    kind: BurstCase;
    historyPairs: number;
    toolCount: number;
    settleMs: number;
    timing: string;
  };
};
export function createBurstCapture(kind: BurstCase, historyPairs?: number): BurstCapture;
