import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render } from 'solid-js/web';
import type { CompactionPart } from '../../types';
import { CompactionDivider } from './CompactionDivider';

let container: HTMLDivElement | null = null;
let cleanup: (() => void) | undefined;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  container?.remove();
  container = null;
});

function compactionPart(overrides: Partial<CompactionPart> = {}): CompactionPart {
  return {
    id: 'compaction-1',
    sessionID: 'session-1',
    messageID: 'message-1',
    type: 'compaction',
    auto: false,
    ...overrides,
  };
}

describe('CompactionDivider', () => {
  it('renders the manual compaction label by default', () => {
    cleanup = render(() => CompactionDivider({ part: compactionPart() }), container!);

    expect(container?.textContent).toContain('Context compacted (manual)');
  });

  it('renders the auto compaction label', () => {
    cleanup = render(() => CompactionDivider({ part: compactionPart({ auto: true }) }), container!);

    expect(container?.textContent).toContain('Context compacted (auto)');
  });

  it('includes the overflow suffix when compaction happened after overflow', () => {
    cleanup = render(
      () => CompactionDivider({ part: compactionPart({ auto: true, overflow: true }) }),
      container!
    );

    expect(container?.textContent).toContain('Context compacted (auto, after overflow)');
  });
});
