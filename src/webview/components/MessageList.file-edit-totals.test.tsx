import { createEffect, createRoot, flush as flushSolid } from 'solid-js';
import { storePath } from '@solidjs/signals';
import { describe, expect, it, vi } from 'vitest';
import { render } from '@solidjs/web';
import { getFileEditTotals } from '../lib/file-edit-totals';
import { replaceMessages, setState, upsertMessageInfo, upsertPart } from '../lib/state';
import type { ToolPart } from '../types';
import { MessageList } from './MessageList';
import {
  assistantMessage,
  installMessageListTestEnvironment,
  setStateRecord,
  textPart,
  toolPart,
  userMessage,
} from './MessageList.test-utils';

/**
 * Observes the published totals the way a card does. Every notification of the shared source
 * reruns this lookup, so the count is the fan-out that each mounted card would also see.
 */
function observeTotalsLookups(partId: string) {
  let lookups = 0;
  const dispose = createRoot((disposeRoot) => {
    createEffect(
      () => {
        lookups += 1;
        return getFileEditTotals(partId);
      },
      () => undefined
    );
    return disposeRoot;
  });
  flushSolid();
  return { count: () => lookups, dispose };
}

let container: HTMLDivElement | null = null;
let cleanup: (() => void) | undefined;

installMessageListTestEnvironment({
  getContainer: () => container,
  setContainer: (element) => {
    container = element;
  },
  getCleanup: () => cleanup,
  setCleanup: (nextCleanup) => {
    cleanup = nextCleanup;
  },
});

/** A Claude-style edit of src/app.ts; OpenCode v2 stores its counts in `metadata.files`. */
function edit(
  id: string,
  messageID: string,
  status: 'running' | 'completed',
  counts: [number, number] = [1, 0]
): ToolPart {
  const part = toolPart(id, messageID, `${id}-call`);
  const input = { path: 'src/app.ts', oldString: 'a', newString: 'b' };
  part.tool = 'edit';
  part.state =
    status === 'running'
      ? { status: 'running', input, title: 'edit', time: { start: 2 } }
      : {
          status: 'completed',
          input,
          output: 'ok',
          title: 'edit',
          metadata: {
            files: [
              {
                file: 'src/app.ts',
                status: 'modified',
                additions: counts[0],
                deletions: counts[1],
              },
            ],
          },
          time: { start: 2, end: 3 },
        };
  return part;
}

async function settle() {
  flushSolid();
  await vi.advanceTimersByTimeAsync(600);
  flushSolid();
}

describe('combined edit counts in the transcript', () => {
  it('updates only the owning card header, and only when a merged edit completes', async () => {
    setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    setStateRecord('sessionStatus', { 'session-1': { type: 'busy' } });
    flushSolid();
    replaceMessages([
      { info: userMessage('user-1'), parts: [textPart('prompt-1', 'Edit the app')] },
      {
        info: assistantMessage('assistant-1', {
          parentID: 'user-1',
          time: { created: 2, completed: 3 },
        }),
        parts: [
          edit('edit-a', 'assistant-1', 'completed', [1, 0]),
          edit('edit-b', 'assistant-1', 'completed', [2, 1]),
        ],
      },
    ]);
    cleanup = render(() => MessageList(), container!);
    await settle();

    const row = container!.querySelector<HTMLElement>('[data-msg-id="assistant-1"]')!;
    const card = row.querySelector<HTMLElement>('.file-change-card')!;
    expect(row.querySelectorAll('.file-change-card')).toHaveLength(1);
    expect(card.querySelector('.file-edit-diff-stats')?.textContent).toBe('+3-1');

    const records: MutationRecord[] = [];
    const observer = new MutationObserver((batch) => records.push(...batch));
    observer.observe(row, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    const lookups = observeTotalsLookups('edit-b');
    const lookupsBefore = lookups.count();

    // The next step's edit collapses into this card. While it runs, and while unrelated text
    // streams after it, the card's counts are unchanged and nothing in its row is written.
    upsertMessageInfo(
      assistantMessage('assistant-2', { parentID: 'user-1', time: { created: 4 } })
    );
    upsertPart(edit('edit-c', 'assistant-2', 'running'));
    await settle();
    for (const text of ['Checking', 'Checking the', 'Checking the result.']) {
      upsertPart({ ...textPart('note', text), messageID: 'assistant-2' });
      await settle();
    }
    records.push(...observer.takeRecords());
    expect(records).toEqual([]);
    // Unchanged totals publish nothing, so no card re-reads its entry.
    expect(lookups.count() - lookupsBefore).toBe(0);

    upsertPart(edit('edit-c', 'assistant-2', 'completed', [4, 2]));
    await settle();
    records.push(...observer.takeRecords());
    observer.disconnect();
    // The same observer does see the real change, so the zero count above is meaningful.
    expect(lookups.count()).toBeGreaterThan(lookupsBefore);
    lookups.dispose();

    expect(row.querySelector('.file-change-card')).toBe(card);
    expect(card.querySelector('.file-edit-diff-stats')?.textContent).toBe('+7-3');
    expect(card.querySelector<HTMLElement>('.file-edit-diff-stats')?.title).toBe(
      'Combined from 3 edits'
    );
    const header = card.querySelector('.file-change-card-header')!;
    expect(records.length).toBeGreaterThan(0);
    expect(
      records.every((record) => header.contains(record.target)),
      records
        .map(
          (record) =>
            `${record.type}:${record.target instanceof Element ? record.target.className : '#text'}`
        )
        .join(', ')
    ).toBe(true);
    // The collapsed step renders no row content of its own.
    expect(container!.querySelector('[data-msg-id="assistant-2"] .file-change-card')).toBeNull();
  });
});
