import { render } from 'solid-js/web';
import { reconcile } from 'solid-js/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../types';
import { client } from '../../lib/client';
import { setSessions, setState, state as appState } from '../../lib/state';
import { selectSession } from '../../hooks/useOpenCode';
import {
  getSessionDiffSummaryStateForTests,
  resetSessionDiffSummaryStateForTests,
  SessionListSectionHeader,
  SessionListView,
} from './SessionListView';
import { SessionActionFeedback } from './SessionActionFeedback';
import {
  applySessionShareOverride,
  resetSessionShareOverridesForTests,
} from '../../lib/session-share-overrides';
import { fixture } from '../../test-fixtures';
import { forwardMessageIcon } from '../../lib/ui-icons';
import { toCssUrl } from '../UiIcon';

type TestRuntimeValue =
  | string
  | number
  | boolean
  | bigint
  | symbol
  | null
  | undefined
  | TestRuntimeObject
  | readonly TestRuntimeValue[];
interface TestRuntimeObject {
  readonly [key: string]: TestRuntimeValue;
  readonly type?: string;
  readonly id?: string | number;
  readonly message?: string;
}

const renameSessionMock = vi.hoisted(() => vi.fn());
const reloadSessionsMock = vi.hoisted(() => vi.fn());
const loadMoreSessionsMock = vi.hoisted(() => vi.fn());

/* oxlint-disable anti-slop/no-module-mocking -- These tests exercise SessionListView's useOpenCode module integration. */
vi.mock('../../hooks/useOpenCode', () => ({
  deleteSession: vi.fn(),
  deleteSessionPermanently: vi.fn(),
  emptyRecycleBin: vi.fn(),
  restoreSession: vi.fn(),
  renameSession: renameSessionMock,
  reloadSessions: reloadSessionsMock,
  loadMoreSessions: loadMoreSessionsMock,
  selectSession: vi.fn(),
}));

let container: HTMLDivElement;
let cleanup: (() => void) | undefined;
const originalIntersectionObserver = globalThis.IntersectionObserver;

function session(id: string, updated: number, overrides: Partial<Session> = {}): Session {
  return {
    id,
    projectID: 'project-1',
    directory: '/repo',
    title: id,
    version: '1',
    time: { created: updated - 1_000, updated },
    summary: { files: 0, additions: 0, deletions: 0 },
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function openSessionActions(row: HTMLElement, x = 40, y = 50) {
  row.dispatchEvent(
    new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
    })
  );
}

beforeEach(() => {
  resetSessionShareOverridesForTests();
  resetSessionDiffSummaryStateForTests();
  setState('sessions', []);
  setState('providers', []);
  setState('sessionSelectedModels', reconcile({}));
  setState('pinnedSessionIds', []);
  setState('activeSessionId', null);
  setState('editorTabsOpen', false);
  setState('editorSessionIds', []);
  setState('sessionStatus', {});
  setState('queuedMessages', []);
  setState('editorTabsOpen', false);
  setState('completedSessionResponses', reconcile({}));
  setState('sessionsLoadError', null);
  setState('sessionsHasMore', false);
  setState('sessionsLoadingMore', false);
  setState('sessionsPaginationError', null);
  setState('recycleBinLoadError', null);
  renameSessionMock.mockReset();
  renameSessionMock.mockResolvedValue(true);
  reloadSessionsMock.mockReset();
  reloadSessionsMock.mockResolvedValue(undefined);
  loadMoreSessionsMock.mockReset();
  loadMoreSessionsMock.mockResolvedValue(undefined);
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  container.remove();
  setState('sessions', []);
  setState('providers', []);
  setState('sessionSelectedModels', reconcile({}));
  setState('pinnedSessionIds', []);
  setState('sessionStatus', {});
  setState('queuedMessages', []);
  setState('completedSessionResponses', reconcile({}));
  setState('sessionsLoadError', null);
  setState('sessionsHasMore', false);
  setState('sessionsLoadingMore', false);
  setState('sessionsPaginationError', null);
  setState('recycleBinLoadError', null);
  // SAFETY: The fixture provides the unknown fields read by this statement.
  delete (window as { __sendToExtension?: (message: TestRuntimeValue) => void }).__sendToExtension;
  vi.restoreAllMocks();
  if (originalIntersectionObserver) {
    globalThis.IntersectionObserver = originalIntersectionObserver;
  } else {
    // SAFETY: The fixture provides the Partial<typeof globalThis> fields read by this statement.
    delete (globalThis as Partial<typeof globalThis>).IntersectionObserver;
  }
  resetSessionDiffSummaryStateForTests();
  resetSessionShareOverridesForTests();
});

describe('SessionListSectionHeader icons', () => {
  it('uses sized adapter icons and preserves the expanded chevron state', () => {
    const onToggle = vi.fn();
    cleanup = render(
      () => (
        <SessionListSectionHeader
          title="Archive"
          count={2}
          expanded={true}
          onToggle={onToggle}
          onArchive={vi.fn()}
        />
      ),
      container
    );

    const archiveIcon = container.querySelector<HTMLElement>('.session-list-section-archive-icon');
    expect(archiveIcon?.classList).toContain('ui-icon');
    expect(archiveIcon?.style.getPropertyValue('--ui-icon-width')).toBe('14px');

    const chevron = container.querySelector<HTMLElement>('.session-list-section-chevron');
    expect(chevron?.classList).toContain('ui-icon');
    expect(chevron?.classList).toContain('expanded');
    expect(chevron?.style.getPropertyValue('--ui-icon-width')).toBe('12px');

    container.querySelector<HTMLButtonElement>('.session-list-section-chevron-button')!.click();
    expect(onToggle).toHaveBeenCalledOnce();
  });
});

describe('SessionListView model details', () => {
  it('opens an Alt-clicked session row in an editor tab', () => {
    const send = vi.fn((message: TestRuntimeValue) => {
      structuredClone(message);
    });
    // SAFETY: The fixture provides the bridge callback used by postMessage.
    (window as { __sendToExtension?: (message: TestRuntimeValue) => void }).__sendToExtension =
      send;
    setState('sessions', [session('session-1', Date.now())]);
    vi.mocked(selectSession).mockClear();

    cleanup = render(() => <SessionListView />, container);
    container
      .querySelector<HTMLButtonElement>('.session-item-main')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true, altKey: true }));

    expect(send).toHaveBeenCalledWith({
      type: 'session/open-in-editor',
      payload: {
        sessionId: 'session-1',
        rootSessionId: 'session-1',
        title: 'session-1',
        model: undefined,
      },
    });
    expect(selectSession).not.toHaveBeenCalled();
  });

  it('reveals an editor when its session is selected from the sidebar', () => {
    const send = vi.fn((message: TestRuntimeValue) => {
      structuredClone(message);
    });
    // SAFETY: The fixture provides the bridge callback used by postMessage.
    (window as { __sendToExtension?: (message: TestRuntimeValue) => void }).__sendToExtension =
      send;
    setState('editorTabsOpen', true);
    setState('editorSessionIds', ['session-1']);
    setState('sessions', [session('session-1', Date.now())]);
    setState('sessionSelectedModels', {
      'session-1': { providerID: 'openai', modelID: 'gpt-5.6-sol', variant: 'xhigh' },
    });
    vi.mocked(selectSession).mockClear();

    cleanup = render(() => <SessionListView />, container);
    container.querySelector<HTMLButtonElement>('.session-item-main')!.click();

    expect(send).toHaveBeenCalledWith({
      type: 'session/open-in-editor',
      payload: {
        sessionId: 'session-1',
        rootSessionId: 'session-1',
        title: 'session-1',
        model: { providerID: 'openai', modelID: 'gpt-5.6-sol', variant: 'xhigh' },
      },
    });
    expect(selectSession).not.toHaveBeenCalled();
  });

  it('does not show an unread completion dot for a session visible in an editor tab', () => {
    setState('sessions', [session('session-1', 500)]);
    setState('lastSeenSessions', { 'session-1': 100 });
    setState('completedSessionResponses', { 'session-1': 500 });
    setState('editorTabsOpen', true);
    setState('editorSessionIds', ['session-1']);

    cleanup = render(() => <SessionListView />, container);

    expect(container.querySelector('.session-item-indicator.is-completed')).toBeNull();
  });

  it('shows an unread completion dot when its open editor tab is not visible', () => {
    setState('sessions', [session('session-1', 500)]);
    setState('lastSeenSessions', { 'session-1': 100 });
    setState('completedSessionResponses', { 'session-1': 500 });
    setState('editorTabsOpen', true);
    setState('editorSessionIds', []);

    cleanup = render(() => <SessionListView />, container);

    expect(container.querySelector('.session-item-indicator.is-completed')).not.toBeNull();
  });

  it('opens unrelated sidebar sessions in an editor while any chat editor is open', () => {
    const send = vi.fn((message: TestRuntimeValue) => {
      structuredClone(message);
    });
    // SAFETY: The fixture provides the bridge callback used by postMessage.
    (window as { __sendToExtension?: (message: TestRuntimeValue) => void }).__sendToExtension =
      send;
    setState('editorTabsOpen', true);
    setState('editorSessionIds', ['other-session']);
    setState('sessions', [session('session-1', Date.now())]);
    vi.mocked(selectSession).mockClear();

    cleanup = render(() => <SessionListView />, container);
    container.querySelector<HTMLButtonElement>('.session-item-main')!.click();

    expect(send).toHaveBeenCalledWith({
      type: 'session/open-in-editor',
      payload: {
        sessionId: 'session-1',
        rootSessionId: 'session-1',
        title: 'session-1',
        model: undefined,
      },
    });
    expect(selectSession).not.toHaveBeenCalled();
  });

  it('renders hover-only model details and the provider icon in the row', async () => {
    vi.spyOn(client.varro.session, 'diffSummary').mockResolvedValue({
      files: 0,
      additions: 0,
      deletions: 0,
      tokens: 0,
      model: { providerID: 'openai', modelID: 'gpt-5.6-sol', variant: 'very_high' },
      durationMs: 0,
      activeStartedAt: null,
    });
    setState('providers', [
      {
        id: 'openai',
        name: 'OpenAI',
        source: 'api',
        models: {
          'gpt-5.6-sol': {
            id: 'gpt-5.6-sol',
            name: 'GPT-5.6 Sol',
            capabilities: {},
            cost: { input: 0, output: 0 },
          },
        },
      },
    ]);
    setState('sessions', [session('session-1', Date.now())]);

    cleanup = render(() => <SessionListView />, container);

    await vi.waitFor(() => {
      const row = container.querySelector('.session-item');
      expect(row?.getAttribute('title')).toBeNull();
      expect(row?.classList.contains('has-model-details')).toBe(true);
      expect(row?.querySelector('.session-item-model-meta')?.textContent).toBe(
        ' · GPT-5.6 Sol · Very High'
      );
      const icon = row?.querySelector<HTMLElement>('.session-item-provider-icon');
      expect(icon).not.toBeNull();
      expect(icon?.style.getPropertyValue('--provider-icon-mask')).toContain('url(');
      expect(row?.querySelector('.session-item-provider-name')).toBeNull();
    });

    vi.mocked(selectSession).mockClear();
    container.querySelector<HTMLButtonElement>('.session-item-main')!.click();
    expect(selectSession).toHaveBeenCalledWith('session-1', {
      selectedModel: {
        providerID: 'openai',
        modelID: 'gpt-5.6-sol',
        variant: 'very_high',
      },
    });
  });

  it('shows the provider name when no provider icon is available', async () => {
    vi.spyOn(client.varro.session, 'diffSummary').mockResolvedValue({
      files: 0,
      additions: 0,
      deletions: 0,
      tokens: 0,
      durationMs: 0,
      activeStartedAt: null,
    });
    setState('providers', [
      {
        id: 'local-gateway',
        name: 'Local Gateway',
        source: 'custom',
        models: {
          'claude-sonnet': {
            id: 'claude-sonnet',
            name: 'Claude Sonnet',
            capabilities: {},
            cost: { input: 0, output: 0 },
          },
        },
      },
    ]);
    setState('sessions', [
      session('session-1', Date.now(), {
        model: { providerID: 'local-gateway', id: 'claude-sonnet' },
      }),
    ]);

    cleanup = render(() => <SessionListView />, container);

    await vi.waitFor(() => {
      expect(container.querySelector('.session-item-model-meta')?.textContent).toBe(
        ' · Claude Sonnet · Default'
      );
      expect(container.querySelector('.session-item-provider-icon')).toBeNull();
      expect(container.querySelector('.session-item-provider-name')?.textContent).toBe(
        'Local Gateway'
      );
    });
  });

  it('shows and opens with the message summary instead of a persisted selection', async () => {
    vi.spyOn(client.varro.session, 'diffSummary').mockResolvedValue({
      files: 0,
      additions: 0,
      deletions: 0,
      tokens: 0,
      model: { providerID: 'openai', modelID: 'gpt-5.6-sol', variant: 'high' },
      durationMs: 0,
      activeStartedAt: null,
    });
    setState('providers', [
      {
        id: 'openai',
        name: 'OpenAI',
        source: 'api',
        models: {
          'gpt-5.6-sol': {
            id: 'gpt-5.6-sol',
            name: 'GPT-5.6 Sol',
            capabilities: {},
            cost: { input: 0, output: 0 },
          },
          'gpt-5.6-luna': {
            id: 'gpt-5.6-luna',
            name: 'GPT-5.6 Luna',
            capabilities: {},
            cost: { input: 0, output: 0 },
          },
        },
      },
    ]);
    setState('sessionSelectedModels', {
      'session-1': { providerID: 'openai', modelID: 'gpt-5.6-luna', variant: 'max' },
    });
    setState('sessions', [session('session-1', Date.now())]);

    cleanup = render(() => <SessionListView />, container);

    await vi.waitFor(() => {
      expect(container.querySelector('.session-item-model-meta')?.textContent).toBe(
        ' · GPT-5.6 Sol · High'
      );
    });

    vi.mocked(selectSession).mockClear();
    container.querySelector<HTMLButtonElement>('.session-item-main')!.click();
    expect(selectSession).toHaveBeenCalledWith('session-1', {
      selectedModel: {
        providerID: 'openai',
        modelID: 'gpt-5.6-sol',
        variant: 'high',
      },
    });
  });

  it('reveals model details for every row while Alt is held', async () => {
    vi.spyOn(client.varro.session, 'diffSummary').mockResolvedValue({
      files: 0,
      additions: 0,
      deletions: 0,
      tokens: 0,
      model: { providerID: 'openai', modelID: 'gpt-5.6-sol', variant: 'high' },
      durationMs: 0,
      activeStartedAt: null,
    });
    setState('sessions', [session('session-1', Date.now()), session('session-2', Date.now() - 1)]);

    cleanup = render(() => <SessionListView />, container);

    await vi.waitFor(() => {
      expect(container.querySelectorAll('.session-item.has-model-details')).toHaveLength(2);
    });
    const list = container.querySelector('.session-list-view')!;

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control' }));
    expect(list.classList.contains('show-all-model-details')).toBe(false);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Alt' }));
    expect(list.classList.contains('show-all-model-details')).toBe(true);

    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Alt' }));
    expect(list.classList.contains('show-all-model-details')).toBe(false);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Alt' }));
    window.dispatchEvent(new Event('blur'));
    expect(list.classList.contains('show-all-model-details')).toBe(false);
  });
});

describe('SessionListView queued messages', () => {
  it('shows reactive per-session queue counts with the outcome icon', async () => {
    const now = Date.now();
    setState('sessions', [
      session('session-1', now, { summary: { files: 1, additions: 0, deletions: 0 } }),
      session('session-2', now - 1, { summary: { files: 1, additions: 0, deletions: 0 } }),
      session('session-3', now - 2, { summary: { files: 1, additions: 0, deletions: 0 } }),
    ]);
    setState('queuedMessages', [
      { id: 'queue-1', sessionId: 'session-1', text: 'First follow-up' },
      { id: 'queue-2', sessionId: 'session-1', text: 'Second follow-up' },
      { id: 'queue-3', sessionId: 'session-2', text: 'Other session follow-up' },
    ]);

    cleanup = render(() => <SessionListView />, container);

    const rows = () => Array.from(container.querySelectorAll<HTMLElement>('.session-item'));
    const row = (title: string) =>
      rows().find((item) => item.querySelector('.session-item-title-text')?.textContent === title)!;

    const firstCount = row('session-1').querySelector<HTMLElement>(
      '[aria-label="2 queued messages"]'
    );
    const firstButton = row('session-1').querySelector<HTMLButtonElement>('.session-item-main');
    expect(firstCount?.textContent).toBe('2');
    expect(row('session-1').dataset.sessionId).toBe('session-1');
    expect(firstCount?.dataset.sessionId).toBe('session-1');
    expect(firstCount?.dataset.queuedMessageCount).toBe('2');
    expect(firstCount?.id).toBeTruthy();
    expect(firstButton?.getAttribute('aria-describedby')).toBe(firstCount?.id);
    expect(firstCount?.closest('.session-item-trailing')).not.toBeNull();
    expect(
      firstCount
        ?.querySelector<HTMLElement>('.session-item-queued-icon')
        ?.style.getPropertyValue('--ui-icon-mask')
    ).toBe(toCssUrl(forwardMessageIcon));
    const secondCount = row('session-2').querySelector<HTMLElement>(
      '[aria-label="1 queued message"]'
    );
    expect(secondCount?.textContent).toBe('1');
    expect(
      row('session-2').querySelector('.session-item-main')?.getAttribute('aria-describedby')
    ).toBe(secondCount?.id);
    expect(row('session-3').querySelector('.session-item-queued-counter')).toBeNull();
    expect(
      row('session-3').querySelector('.session-item-main')?.getAttribute('aria-describedby')
    ).toBeNull();

    setState(
      'queuedMessages',
      appState.queuedMessages.filter((item) => item.sessionId !== 'session-1')
    );

    await vi.waitFor(() => {
      expect(row('session-1').querySelector('.session-item-queued-counter')).toBeNull();
      expect(row('session-2').querySelector('[aria-label="1 queued message"]')).not.toBeNull();
    });
  });
});

describe('SessionListView diff summaries', () => {
  it('shows a skeleton instead of zero counters while the aggregate summary loads', async () => {
    const pending = deferred<{
      files: number;
      additions: number;
      deletions: number;
      tokens: number;
      durationMs: number;
      activeStartedAt: number | null;
    }>();
    vi.spyOn(client.varro.session, 'diffSummary').mockReturnValue(pending.promise);
    setState('sessions', [session('session-1', Date.now())]);

    cleanup = render(() => <SessionListView />, container);

    await vi.waitFor(() => {
      expect(container.querySelector('.session-item-meta-skeleton')).not.toBeNull();
    });
    expect(container.querySelector('.session-item-meta')?.textContent).not.toContain('0 files');

    pending.resolve({
      files: 2,
      additions: 6,
      deletions: 4,
      tokens: 12_345,
      durationMs: 65_000,
      activeStartedAt: null,
    });
    await vi.waitFor(() => {
      expect(container.querySelector('.session-item-meta-skeleton')).toBeNull();
      expect(container.querySelector('.session-item-meta')?.textContent).toContain('2 files');
    });
  });

  it('uses the aggregate session diff response instead of loading full diffs or messages', async () => {
    const diffSummarySpy = vi.spyOn(client.varro.session, 'diffSummary').mockResolvedValue({
      files: 2,
      additions: 6,
      deletions: 4,
      tokens: 12_345,
      durationMs: 65_000,
      activeStartedAt: null,
    });
    const diffSpy = vi.spyOn(client.session, 'diff').mockResolvedValue([]);
    const messagesSpy = vi.spyOn(client.session, 'messages').mockResolvedValue([]);
    setState('sessions', [session('session-1', Date.now())]);

    cleanup = render(() => <SessionListView />, container);

    await vi.waitFor(() =>
      expect(diffSummarySpy).toHaveBeenCalledWith('session-1', expect.any(Number))
    );
    await vi.waitFor(() => {
      expect(container.querySelector('.session-item-meta')?.textContent).toContain('2 files');
    });
    expect(container.querySelector('.session-item-meta')?.textContent).toContain('+6');
    expect(container.querySelector('.session-item-meta')?.textContent).toContain('-4');
    expect(container.querySelector('.session-item-meta')?.textContent).toContain('12k tokens');
    expect(container.querySelector('.session-item-meta')?.textContent).toContain('1m 5s');
    expect(container.querySelector('[title="12,345 tokens spent"]')).not.toBeNull();
    expect(container.querySelector('[title="1m 5s total time worked"]')).not.toBeNull();
    expect(diffSpy).not.toHaveBeenCalled();
    expect(messagesSpy).not.toHaveBeenCalled();
  });

  it('compacts large edit counts', async () => {
    vi.spyOn(client.varro.session, 'diffSummary').mockResolvedValue({
      files: 62,
      additions: 8_190,
      deletions: 32_568,
      tokens: 0,
      durationMs: 0,
      activeStartedAt: null,
    });
    setState('sessions', [session('session-1', Date.now())]);

    cleanup = render(() => <SessionListView />, container);

    await vi.waitFor(() => {
      const meta = container.querySelector('.session-item-meta')?.textContent;
      expect(meta).toContain('62 files');
      expect(meta).toContain('+8190');
      expect(meta).toContain('-33K');
    });
  });

  it('labels trimmed file summaries without zero line counts', async () => {
    vi.spyOn(client.varro.session, 'diffSummary').mockResolvedValue({
      files: 0,
      filesTruncated: true,
      historyStatsUnavailable: true,
      additions: 0,
      deletions: 0,
      tokens: 0,
      durationMs: 0,
      activeStartedAt: null,
    });
    setState('sessions', [session('session-1', Date.now())]);

    cleanup = render(() => <SessionListView />, container);

    await vi.waitFor(() => {
      const meta = container.querySelector('.session-item-meta')?.textContent;
      expect(meta).toContain('Large change set');
      expect(meta).not.toContain('+0');
      expect(meta).not.toContain('-0');
      expect(meta).not.toContain('tokens');
    });
  });

  it('uses loaded diff counts when stale edit counts already exist on the session', async () => {
    const diffSummarySpy = vi.spyOn(client.varro.session, 'diffSummary').mockResolvedValue({
      files: 2,
      additions: 6,
      deletions: 4,
      tokens: 900,
      durationMs: 0,
      activeStartedAt: null,
    });
    setState('sessions', [
      session('session-1', Date.now(), {
        summary: { files: 1, additions: 3, deletions: 2 },
      }),
    ]);

    cleanup = render(() => <SessionListView />, container);

    await vi.waitFor(() =>
      expect(diffSummarySpy).toHaveBeenCalledWith('session-1', expect.any(Number))
    );
    await vi.waitFor(() => {
      const meta = container.querySelector('.session-item-meta')?.textContent;
      expect(meta).toContain('2 files');
      expect(meta).toContain('+6');
      expect(meta).toContain('-4');
      expect(meta).toContain('900 tokens');
    });
  });

  it('updates the duration of a running session every second', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    vi.spyOn(client.varro.session, 'diffSummary').mockResolvedValue({
      files: 0,
      additions: 0,
      deletions: 0,
      tokens: 100,
      durationMs: 5_000,
      activeStartedAt: 90_000,
    });
    setState('sessionStatus', { 'session-1': { type: 'busy' } });
    setState('sessions', [session('session-1', 100_000)]);

    try {
      cleanup = render(() => <SessionListView />, container);
      await vi.advanceTimersByTimeAsync(0);
      expect(container.querySelector('.session-item-meta')?.textContent).toContain('15s');

      await vi.advanceTimersByTimeAsync(2_000);
      expect(container.querySelector('.session-item-meta')?.textContent).toContain('17s');
    } finally {
      cleanup?.();
      cleanup = undefined;
      vi.useRealTimers();
    }
  });

  it('caps and drops queued work when sessions are no longer visible', async () => {
    const pending = deferred<{
      files: number;
      additions: number;
      deletions: number;
      tokens: number;
      durationMs: number;
      activeStartedAt: number | null;
    }>();
    vi.spyOn(client.varro.session, 'diffSummary').mockReturnValue(pending.promise);
    setState(
      'sessions',
      Array.from({ length: 160 }, (_, index) => session(`session-${index}`, Date.now() - index))
    );

    cleanup = render(() => <SessionListView />, container);

    expect(getSessionDiffSummaryStateForTests()).toMatchObject({ active: 4, queued: 100 });

    setState('sessions', []);
    expect(getSessionDiffSummaryStateForTests().queued).toBe(0);

    pending.resolve({
      files: 0,
      additions: 0,
      deletions: 0,
      tokens: 0,
      durationMs: 0,
      activeStartedAt: null,
    });
    await vi.waitFor(() => expect(getSessionDiffSummaryStateForTests().active).toBe(0));
  });

  it('loads summaries only when rows approach the scroll viewport', async () => {
    const callbacks = new Map<Element, IntersectionObserverCallback>();
    class TestIntersectionObserver {
      constructor(private readonly callback: IntersectionObserverCallback) {}

      observe(target: Element) {
        callbacks.set(target, this.callback);
      }

      disconnect() {}
    }
    // SAFETY: The fixture provides the unknown fields read by this statement.
    globalThis.IntersectionObserver =
      fixture<typeof IntersectionObserver>(TestIntersectionObserver);
    const diffSummarySpy = vi.spyOn(client.varro.session, 'diffSummary').mockResolvedValue({
      files: 0,
      additions: 0,
      deletions: 0,
      tokens: 0,
      durationMs: 0,
      activeStartedAt: null,
    });
    const now = Date.now();
    setState(
      'sessions',
      Array.from({ length: 20 }, (_, index) => session(`viewport-session-${index}`, now - index))
    );

    cleanup = render(() => <SessionListView embedded />, container);
    expect(diffSummarySpy).not.toHaveBeenCalled();

    const rows = Array.from(container.querySelectorAll('.session-item')).slice(0, 3);
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => callbacks.has(row))).toBe(true);
    for (const row of rows) {
      // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
      callbacks.get(row)?.(
        [{ target: row, isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver
      );
    }

    await vi.waitFor(() => expect(diffSummarySpy).toHaveBeenCalledTimes(3));
    await vi.waitFor(() =>
      expect(getSessionDiffSummaryStateForTests()).toMatchObject({ active: 0, queued: 0 })
    );
  });

  it('bounds cached summaries across changing visible session sets', async () => {
    vi.spyOn(client.varro.session, 'diffSummary').mockResolvedValue({
      files: 0,
      additions: 0,
      deletions: 0,
      tokens: 0,
      durationMs: 0,
      activeStartedAt: null,
    });
    cleanup = render(() => <SessionListView />, container);

    for (let batch = 0; batch < 3; batch += 1) {
      setState(
        'sessions',
        Array.from({ length: 90 }, (_, index) =>
          session(`batch-${batch}-session-${index}`, Date.now() - index)
        )
      );
      await vi.waitFor(
        () => {
          const state = getSessionDiffSummaryStateForTests();
          expect(state.active).toBe(0);
          expect(state.queued).toBe(0);
        },
        { timeout: 5_000 }
      );
    }

    const state = getSessionDiffSummaryStateForTests();
    expect(state.cached).toBe(state.cacheLimit);
  });

  it('settles failures for a revision instead of immediately retrying', async () => {
    const diffSummarySpy = vi
      .spyOn(client.varro.session, 'diffSummary')
      .mockRejectedValue(new Error('server unavailable'));
    const updated = Date.now();
    setState('sessions', [session('session-1', updated)]);

    cleanup = render(() => <SessionListView />, container);

    await vi.waitFor(() => expect(getSessionDiffSummaryStateForTests().active).toBe(0));
    expect(diffSummarySpy).toHaveBeenCalledTimes(1);

    setState('sessions', [session('session-1', updated)]);
    await Promise.resolve();
    expect(diffSummarySpy).toHaveBeenCalledTimes(1);

    setState('sessions', [session('session-1', updated + 1)]);
    await vi.waitFor(() => expect(diffSummarySpy).toHaveBeenCalledTimes(2));
  });

  it('refreshes a root summary when a descendant session updates', async () => {
    const diffSummarySpy = vi.spyOn(client.varro.session, 'diffSummary').mockResolvedValue({
      files: 0,
      additions: 0,
      deletions: 0,
      tokens: 100,
      durationMs: 0,
      activeStartedAt: null,
    });
    setSessions([
      session('session-1', 100_000),
      session('child-1', 100_000, { parentID: 'session-1' }),
    ]);

    cleanup = render(() => <SessionListView />, container);
    await vi.waitFor(() => expect(diffSummarySpy).toHaveBeenCalledTimes(1));

    setSessions([
      session('session-1', 100_000),
      session('child-1', 100_001, {
        parentID: 'session-1',
        tokens: {
          input: 200,
          output: 20,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      }),
    ]);

    await vi.waitFor(() => expect(diffSummarySpy).toHaveBeenCalledTimes(2));
    expect(diffSummarySpy).toHaveBeenNthCalledWith(2, 'session-1', 100_001);
  });
});

describe('SessionListView pins', () => {
  it('pins and unpins a session from its row menu and marks it', async () => {
    const setPinned = vi
      .spyOn(client.varro.session, 'setPinned')
      .mockResolvedValueOnce(['session-1'])
      .mockResolvedValueOnce([]);
    vi.spyOn(client.varro.session, 'diffSummary').mockResolvedValue({
      files: 0,
      additions: 0,
      deletions: 0,
      tokens: 0,
      durationMs: 0,
      activeStartedAt: null,
    });
    setState('sessions', [session('session-1', Date.now())]);
    cleanup = render(() => <SessionListView />, container);

    const row = () => container.querySelector<HTMLElement>('.session-item')!;
    expect(row().querySelector('.session-item-pin')).toBeNull();
    expect(row().querySelector('.session-item-archive')).toBeNull();

    expect(row().querySelector('[aria-label="Session actions"]')).toBeNull();
    openSessionActions(row());
    Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
      .find((button) => button.textContent?.trim() === 'Pin session')!
      .click();

    await vi.waitFor(() => expect(setPinned).toHaveBeenCalledWith('session-1', true));
    await vi.waitFor(() => {
      expect(row().classList.contains('is-pinned')).toBe(true);
      const pinnedIcon = row().querySelector<HTMLElement>('.session-item-pinned-icon');
      expect(pinnedIcon?.classList).toContain('ui-icon');
      expect(pinnedIcon?.style.getPropertyValue('--ui-icon-width')).toBe('12px');
    });
    openSessionActions(row());
    Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
      .find((button) => button.textContent?.trim() === 'Unpin session')!
      .click();

    await vi.waitFor(() => expect(setPinned).toHaveBeenLastCalledWith('session-1', false));
    await vi.waitFor(() => {
      expect(row().classList.contains('is-pinned')).toBe(false);
      expect(row().querySelector('[aria-label="Pinned session"]')).toBeNull();
    });
  });

  it('separates the pinned group from the first unpinned session', () => {
    const now = Date.now();
    setState('sessions', [
      session('unpinned', now),
      session('pinned-newer', now - 1_000),
      session('pinned-older', now - 2_000),
    ]);
    setState('pinnedSessionIds', ['pinned-newer', 'pinned-older']);

    cleanup = render(() => <SessionListView />, container);

    const rows = Array.from(container.querySelectorAll<HTMLElement>('.session-item'));
    expect(rows.map((row) => row.querySelector('.session-item-title-text')?.textContent)).toEqual([
      'pinned-newer',
      'pinned-older',
      'unpinned',
    ]);
    expect(rows.filter((row) => row.classList.contains('starts-unpinned-group'))).toEqual([
      rows[2],
    ]);
  });
});

describe('SessionListView selection', () => {
  it('does not steal focus after pointer interaction during mount', () => {
    let focusCallback: FrameRequestCallback | undefined;
    const requestFrame = vi
      .spyOn(globalThis, 'requestAnimationFrame')
      .mockImplementation((callback) => {
        focusCallback = callback;
        return 42;
      });
    const cancelFrame = vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});
    setState('sessions', [session('session-1', Date.now())]);
    cleanup = render(() => <SessionListView />, container);

    const sessionButton = container.querySelector<HTMLButtonElement>('.session-item-main')!;
    sessionButton.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    sessionButton.focus();
    focusCallback?.(performance.now());

    expect(document.activeElement).toBe(sessionButton);
    expect(requestFrame).toHaveBeenCalledOnce();
    cleanup();
    cleanup = undefined;
    expect(cancelFrame).toHaveBeenCalledWith(42);
  });

  it('does not highlight the active session in the session picker', () => {
    vi.spyOn(client.varro.session, 'diffSummary').mockResolvedValue({
      files: 0,
      additions: 0,
      deletions: 0,
      tokens: 0,
      durationMs: 0,
      activeStartedAt: null,
    });
    setState('sessions', [session('session-1', Date.now())]);
    setState('activeSessionId', 'session-1');

    cleanup = render(() => <SessionListView />, container);

    expect(container.querySelector('.session-item')?.classList.contains('active')).toBe(false);
    expect(container.querySelector('.session-item-main')?.getAttribute('aria-current')).toBeNull();
  });

  it('highlights the active session in the embedded desktop list', () => {
    vi.spyOn(client.varro.session, 'diffSummary').mockResolvedValue({
      files: 0,
      additions: 0,
      deletions: 0,
      tokens: 0,
      durationMs: 0,
      activeStartedAt: null,
    });
    setState('sessions', [session('session-1', Date.now()), session('session-2', Date.now() - 1)]);
    setState('activeSessionId', 'session-1');

    cleanup = render(() => <SessionListView embedded />, container);

    const items = container.querySelectorAll('.session-item');
    expect(items[0]?.classList.contains('active')).toBe(true);
    expect(items[0]?.querySelector('.session-item-main')?.getAttribute('aria-current')).toBe(
      'page'
    );
    expect(items[1]?.classList.contains('active')).toBe(false);
    expect(items[1]?.querySelector('.session-item-main')?.getAttribute('aria-current')).toBeNull();
  });

  it('reports an active session reselect without reloading it', () => {
    vi.mocked(selectSession).mockClear();
    const onActiveSessionReselect = vi.fn();
    setState('sessions', [session('session-1', Date.now())]);
    setState('activeSessionId', 'session-1');
    cleanup = render(
      () => <SessionListView embedded onActiveSessionReselect={onActiveSessionReselect} />,
      container
    );

    container.querySelector<HTMLButtonElement>('.session-item-main')!.click();

    expect(selectSession).not.toHaveBeenCalled();
    expect(onActiveSessionReselect).toHaveBeenCalledOnce();
  });

  it('navigates, wraps, scrolls, and selects sessions with the keyboard', async () => {
    const scrollIntoView = vi.fn();
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    setState('sessions', [session('session-1', Date.now()), session('session-2', Date.now() - 1)]);

    try {
      cleanup = render(() => <SessionListView embedded />, container);
      const list = container.querySelector<HTMLElement>('.session-list-view')!;
      const items = Array.from(container.querySelectorAll<HTMLElement>('.session-item'));

      list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
      await Promise.resolve();
      expect(items[1]?.classList.contains('keyboard-focus')).toBe(true);
      expect(scrollIntoView).toHaveBeenLastCalledWith({ block: 'nearest' });

      list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      await Promise.resolve();
      expect(items[0]?.classList.contains('keyboard-focus')).toBe(true);

      list.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      expect(selectSession).toHaveBeenCalledWith('session-1');
    } finally {
      HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    }
  });

  it('synchronizes keyboard selection when a session receives focus', () => {
    setState('sessions', [session('session-1', Date.now()), session('session-2', Date.now() - 1)]);
    cleanup = render(() => <SessionListView embedded />, container);

    const buttons = container.querySelectorAll<HTMLButtonElement>('.session-item-main');
    buttons[1]!.focus();

    expect(
      container.querySelectorAll('.session-item')[1]?.classList.contains('keyboard-focus')
    ).toBe(true);
  });

  it('does not let stationary hover override keyboard selection after a refresh', async () => {
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = vi.fn();
    const now = Date.now();
    setState('sessions', [session('session-1', now), session('session-2', now - 1)]);

    try {
      cleanup = render(() => <SessionListView embedded />, container);

      const list = container.querySelector<HTMLElement>('.session-list-view')!;
      let items = container.querySelectorAll<HTMLElement>('.session-item');
      items[0]!.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
      list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      expect(items[1]?.classList.contains('keyboard-focus')).toBe(true);

      setState('sessions', [session('session-1', now + 1), session('session-2', now - 1)]);
      await Promise.resolve();
      items = container.querySelectorAll<HTMLElement>('.session-item');
      items[0]!.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));

      expect(items[1]?.classList.contains('keyboard-focus')).toBe(true);
      items[0]!.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
      expect(items[0]?.classList.contains('keyboard-focus')).toBe(true);
    } finally {
      HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    }
  });

  it('clears pointer focus when the pointer leaves a session', () => {
    setState('sessions', [session('session-1', Date.now())]);
    cleanup = render(() => <SessionListView embedded />, container);

    const item = container.querySelector<HTMLElement>('.session-item')!;
    item.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    expect(item.classList.contains('keyboard-focus')).toBe(true);

    item.dispatchEvent(new MouseEvent('mouseleave'));
    expect(item.classList.contains('keyboard-focus')).toBe(false);
  });

  it('selects a session from the trailing row area', () => {
    vi.mocked(selectSession).mockClear();
    setState('sessions', [session('session-1', Date.now())]);
    cleanup = render(() => <SessionListView embedded />, container);

    container.querySelector<HTMLElement>('.session-item-age')!.click();

    expect(selectSession).toHaveBeenCalledWith('session-1');
  });

  it('opens desktop sessions on pointer down without double-selecting on click', () => {
    vi.mocked(selectSession).mockClear();
    setState('sessions', [session('session-1', Date.now())]);
    cleanup = render(() => <SessionListView embedded />, container);
    const row = container.querySelector<HTMLElement>('.session-item')!;
    const capturePointer = vi.fn();
    row.setPointerCapture = capturePointer;

    row.querySelector<HTMLElement>('.session-item-main')!.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        button: 0,
        pointerId: 7,
        pointerType: 'mouse',
      })
    );
    expect(capturePointer).toHaveBeenCalledWith(7);
    expect(selectSession).toHaveBeenCalledWith('session-1');

    row.querySelector<HTMLElement>('.session-item-main')!.click();
    expect(selectSession).toHaveBeenCalledTimes(1);

    const trailingControl = document.createElement('button');
    row.append(trailingControl);
    trailingControl.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 8 })
    );
    expect(capturePointer).toHaveBeenCalledTimes(1);
    expect(selectSession).toHaveBeenCalledTimes(1);
  });

  it('opens picker sessions on pointer down without starting text selection', () => {
    vi.mocked(selectSession).mockClear();
    const now = Date.now();
    setState('sessions', [session('session-1', now), session('session-2', now - 1)]);
    cleanup = render(() => <SessionListView />, container);
    const row = container.querySelector<HTMLElement>('.session-item')!;

    const pointerDown = new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      button: 0,
      pointerId: 7,
      pointerType: 'mouse',
    });
    row.querySelector<HTMLElement>('.session-item-main')!.dispatchEvent(pointerDown);

    expect(pointerDown.defaultPrevented).toBe(true);
    expect(selectSession).toHaveBeenCalledWith('session-1');
    setState('sessions', [session('session-2', now + 1), session('session-1', now)]);
    row.querySelector<HTMLElement>('.session-item-main')!.click();
    expect(selectSession).toHaveBeenCalledTimes(1);
  });
});

describe('SessionListView ordering', () => {
  it('keeps the spinner when a completion dot briefly returns to running', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    setState('sessions', [session('session-1', 500)]);
    setState('sessionStatus', { 'session-1': { type: 'busy' } });
    setState('completedSessionResponses', { 'session-1': 10_000 });

    try {
      cleanup = render(() => <SessionListView />, container);
      expect(
        container.querySelector('.session-item-indicator')?.classList.contains('is-running')
      ).toBe(true);

      setState('sessionStatus', 'session-1', { type: 'idle' });
      await vi.advanceTimersByTimeAsync(600);
      expect(
        container.querySelector('.session-item-indicator')?.classList.contains('is-running')
      ).toBe(true);

      setState('sessionStatus', 'session-1', { type: 'busy' });
      await vi.advanceTimersByTimeAsync(1200);
      expect(
        container.querySelector('.session-item-indicator')?.classList.contains('is-running')
      ).toBe(true);

      setState('sessionStatus', 'session-1', { type: 'idle' });
      await vi.advanceTimersByTimeAsync(1199);
      expect(
        container.querySelector('.session-item-indicator')?.classList.contains('is-running')
      ).toBe(true);

      await vi.advanceTimersByTimeAsync(1);
      expect(
        container.querySelector('.session-item-indicator')?.classList.contains('is-completed')
      ).toBe(true);
    } finally {
      cleanup?.();
      cleanup = undefined;
      vi.useRealTimers();
    }
  });

  it('preserves a running indicator across same-session updates', () => {
    vi.spyOn(client.varro.session, 'diffSummary').mockResolvedValue({
      files: 0,
      additions: 0,
      deletions: 0,
      tokens: 0,
      durationMs: 0,
      activeStartedAt: null,
    });
    const now = Date.now();
    setSessions([session('session-1', now)]);
    setState('sessionStatus', { 'session-1': { type: 'busy' } });

    cleanup = render(() => <SessionListView />, container);

    const indicator = container.querySelector('.session-item-indicator.is-running');
    expect(indicator).not.toBeNull();

    setSessions([session('session-1', now + 1, { title: 'Updated title' })]);

    expect(container.querySelector('.session-item-indicator.is-running')).toBe(indicator);
  });

  it('keeps similarly updated sessions in newest-created-first order', () => {
    vi.spyOn(client.varro.session, 'diffSummary').mockResolvedValue({
      files: 0,
      additions: 0,
      deletions: 0,
      tokens: 0,
      durationMs: 0,
      activeStartedAt: null,
    });
    const now = Date.now();
    setSessions([
      session('older-created', now - 1_000, {
        time: { created: now - 50_000, updated: now - 1_000 },
      }),
      session('newer-created', now - 20_000, {
        time: { created: now - 30_000, updated: now - 20_000 },
      }),
    ]);

    cleanup = render(() => <SessionListView />, container);

    expect(
      Array.from(container.querySelectorAll('.session-item-title-text')).map(
        (element) => element.textContent
      )
    ).toEqual(['newer-created', 'older-created']);
  });
});

describe('SessionListView actions', () => {
  it('hides rename and recycle-bin actions for sub-agent sessions', () => {
    vi.spyOn(client.varro.session, 'diffSummary').mockResolvedValue({
      files: 0,
      additions: 0,
      deletions: 0,
      tokens: 0,
      durationMs: 0,
      activeStartedAt: null,
    });
    setSessions([session('parent', 2), session('child', 1, { parentID: 'parent' })]);

    cleanup = render(() => <SessionListView subagentParentId="parent" />, container);
    openSessionActions(container.querySelector<HTMLElement>('.session-item')!);

    const menu = document.querySelector<HTMLElement>('[aria-label="Session actions"]');
    expect(menu?.textContent).not.toContain('Rename');
    expect(menu?.textContent).not.toContain('Move to Recycle Bin');
    expect(menu?.textContent).toContain('Copy session ID');
    expect(menu?.textContent).toContain('Open in Editor');
    expect(menu?.textContent).toContain('Open in terminal');
    expect(menu?.textContent).toContain('Share session');
  });

  it('opens a session in a terminal from its row menu', () => {
    const send = vi.fn();
    // SAFETY: The fixture provides the unknown fields read by this statement.
    (window as { __sendToExtension?: (message: TestRuntimeValue) => void }).__sendToExtension =
      send;
    vi.spyOn(client.varro.session, 'diffSummary').mockResolvedValue({
      files: 0,
      additions: 0,
      deletions: 0,
      tokens: 0,
      durationMs: 0,
      activeStartedAt: null,
    });
    setSessions([session('session-1', Date.now())]);
    cleanup = render(() => <SessionListView />, container);

    openSessionActions(container.querySelector<HTMLElement>('.session-item')!);
    Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
      .find((button) => button.textContent?.trim() === 'Open in terminal')!
      .click();

    expect(send).toHaveBeenCalledWith({
      type: 'session/open-in-opencode',
      payload: { sessionId: 'session-1' },
    });
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it('opens a session in the sidebar from its row menu', () => {
    const send = vi.fn();
    // SAFETY: The fixture provides the unknown fields read by this statement.
    (window as { __sendToExtension?: (message: TestRuntimeValue) => void }).__sendToExtension =
      send;
    setSessions([session('session-1', Date.now())]);
    cleanup = render(() => <SessionListView />, container);

    openSessionActions(container.querySelector<HTMLElement>('.session-item')!);
    Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
      .find((button) => button.textContent?.trim() === 'Open')!
      .click();

    expect(send).toHaveBeenCalledWith({
      type: 'session/open-in-sidebar',
      payload: { sessionId: 'session-1' },
    });
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it('opens a session in an editor tab from its row menu', () => {
    const send = vi.fn((message: TestRuntimeValue) => {
      structuredClone(message);
    });
    // SAFETY: The fixture provides the unknown fields read by this statement.
    (window as { __sendToExtension?: (message: TestRuntimeValue) => void }).__sendToExtension =
      send;
    vi.spyOn(client.varro.session, 'diffSummary').mockResolvedValue({
      files: 0,
      additions: 0,
      deletions: 0,
      tokens: 0,
      durationMs: 0,
      activeStartedAt: null,
    });
    setSessions([session('session-1', Date.now())]);
    setState('sessionSelectedModels', {
      'session-1': { providerID: 'openai', modelID: 'gpt-5.6-sol', variant: 'xhigh' },
    });
    cleanup = render(() => <SessionListView />, container);

    openSessionActions(container.querySelector<HTMLElement>('.session-item')!);
    Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
      .find((button) => button.textContent?.trim() === 'Open in Editor')!
      .click();

    expect(send).toHaveBeenCalledWith({
      type: 'session/open-in-editor',
      payload: {
        sessionId: 'session-1',
        title: 'session-1',
        model: { providerID: 'openai', modelID: 'gpt-5.6-sol', variant: 'xhigh' },
      },
    });
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it('shares, copies, and unshares a session from its row menu', async () => {
    const activityUpdatedAt = Date.now() - 60_000;
    const shareUpdatedAt = Date.now();
    vi.spyOn(client.varro.session, 'diffSummary').mockResolvedValue({
      files: 0,
      additions: 0,
      deletions: 0,
      tokens: 0,
      durationMs: 0,
      activeStartedAt: null,
    });
    const share = vi
      .spyOn(client.session, 'share')
      .mockResolvedValue(
        session('session-1', shareUpdatedAt, { share: { url: 'https://share.test/1' } })
      );
    const unshareResult = session('session-1', shareUpdatedAt + 1, {
      share: { url: 'https://share.test/1' },
    });
    const pendingUnshare = deferred<Session>();
    const unshare = vi.spyOn(client.session, 'unshare').mockReturnValue(pendingUnshare.promise);
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    setState('sessions', [session('session-1', activityUpdatedAt)]);

    try {
      cleanup = render(
        () => (
          <>
            <SessionListView />
            <SessionActionFeedback />
          </>
        ),
        container
      );
      const row = container.querySelector<HTMLElement>('.session-item')!;

      openSessionActions(row);
      Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
        .find((button) => button.textContent?.trim() === 'Share session')!
        .click();

      await vi.waitFor(() =>
        expect(share).toHaveBeenCalledWith('session-1', { directory: '/repo' })
      );
      await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('https://share.test/1'));
      expect(appState.sessions[0]?.time.updated).toBe(activityUpdatedAt);
      expect(row.querySelector('.session-item-shared-marker')?.getAttribute('title')).toBe(
        'Session is shared'
      );
      const sharedIcon = row.querySelector<HTMLElement>('.shared-session-icon');
      expect(sharedIcon?.classList).toContain('ui-icon');
      expect(sharedIcon?.style.getPropertyValue('--ui-icon-width')).toBe('12px');
      await vi.waitFor(() => {
        const feedback = document.querySelector<HTMLElement>('.session-action-feedback');
        expect(feedback?.textContent?.trim()).toBe('Share link copied');
        expect(feedback?.getAttribute('aria-live')).toBe('polite');
        expect(feedback?.querySelector('.session-action-feedback-glyph')?.classList).toContain(
          'ui-icon'
        );
      });

      openSessionActions(row);
      const sharedActions = Array.from(
        document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')
      );
      sharedActions.find((button) => button.textContent?.trim() === 'Unshare session')!.click();

      expect(document.querySelector('[role="menu"]')).toBeNull();
      await vi.waitFor(() =>
        expect(unshare).toHaveBeenCalledWith('session-1', { directory: '/repo' })
      );
      const inFlightEvent = applySessionShareOverride({
        ...unshareResult,
        share: undefined,
      });
      expect(inFlightEvent.time.updated).toBe(activityUpdatedAt);

      pendingUnshare.resolve(unshareResult);
      await vi.waitFor(() => {
        expect(document.querySelector('.session-action-feedback')?.textContent?.trim()).toBe(
          'Session unshared'
        );
      });
      expect(appState.sessions[0]?.time.updated).toBe(activityUpdatedAt);
      expect(row.querySelector('.session-item-shared-marker')).toBeNull();
      openSessionActions(row);
      const unsharedActions = Array.from(
        document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')
      );
      expect(unsharedActions.some((button) => button.textContent?.trim() === 'Share session')).toBe(
        true
      );
      unsharedActions.find((button) => button.textContent?.trim() === 'Copy session ID')!.click();
      await vi.waitFor(() => expect(writeText).toHaveBeenLastCalledWith('session-1'));
      await vi.waitFor(() => {
        expect(document.querySelector('.session-action-feedback')?.textContent?.trim()).toBe(
          'Session ID copied'
        );
      });
    } finally {
      if (clipboardDescriptor) {
        Object.defineProperty(navigator, 'clipboard', clipboardDescriptor);
      } else {
        Reflect.deleteProperty(navigator, 'clipboard');
      }
    }
  });

  it('closes the context menu without selecting another session with one click', () => {
    vi.spyOn(client.varro.session, 'diffSummary').mockResolvedValue({
      files: 0,
      additions: 0,
      deletions: 0,
      tokens: 0,
      durationMs: 0,
      activeStartedAt: null,
    });
    const updated = Date.now();
    setState('sessions', [session('session-1', updated), session('session-2', updated - 1)]);
    cleanup = render(() => <SessionListView />, container);

    const rows = container.querySelectorAll<HTMLElement>('.session-item');
    const owningRow = rows[0]!;
    const otherRow = rows[1]!;
    vi.mocked(selectSession).mockClear();
    openSessionActions(owningRow);

    expect(owningRow.classList.contains('is-context-selected')).toBe(true);
    expect(otherRow.classList.contains('is-context-obscured')).toBe(true);
    expect(owningRow.inert).toBe(true);
    expect(otherRow.inert).toBe(true);

    otherRow.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    expect(otherRow.classList.contains('keyboard-focus')).toBe(false);

    otherRow.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    otherRow.querySelector<HTMLButtonElement>('.session-item-main')!.click();

    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(otherRow.classList.contains('is-context-obscured')).toBe(false);
    expect(otherRow.inert).not.toBe(true);
    expect(selectSession).not.toHaveBeenCalled();
  });

  it('freezes session row order until the context menu closes', () => {
    vi.spyOn(client.varro.session, 'diffSummary').mockResolvedValue({
      files: 0,
      additions: 0,
      deletions: 0,
      tokens: 0,
      durationMs: 0,
      activeStartedAt: null,
    });
    const updated = Date.now();
    setSessions([session('session-1', updated), session('session-2', updated - 1)]);
    cleanup = render(() => <SessionListView />, container);

    openSessionActions(container.querySelector<HTMLElement>('.session-item')!);
    setSessions([session('session-1', updated), session('session-2', updated + 1)]);

    const rowTitles = () =>
      Array.from(container.querySelectorAll('.session-item-title-text')).map(
        (element) => element.textContent
      );
    expect(rowTitles()).toEqual(['session-1', 'session-2']);

    document.body.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, cancelable: true })
    );

    expect(rowTitles()).toEqual(['session-2', 'session-1']);
  });

  it('keeps the context menu and owning row selected across session list updates', () => {
    vi.spyOn(client.varro.session, 'diffSummary').mockResolvedValue({
      files: 0,
      additions: 0,
      deletions: 0,
      tokens: 0,
      durationMs: 0,
      activeStartedAt: null,
    });
    const now = Date.now();
    setSessions([session('session-1', now, { title: 'First session' })]);
    cleanup = render(() => <SessionListView />, container);
    openSessionActions(container.querySelector<HTMLElement>('.session-item')!);

    expect(
      container.querySelector('.session-item')?.classList.contains('is-context-selected')
    ).toBe(true);
    expect(document.querySelector('[role="menu"]')).not.toBeNull();

    setSessions([
      session('session-1', now + 1, { title: 'Updated session' }),
      session('archived-session', now - 2 * 24 * 60 * 60 * 1_000),
    ]);

    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    expect(
      container.querySelector('.session-item')?.classList.contains('is-context-selected')
    ).toBe(true);
  });

  it('keeps an in-progress rename across session list updates', async () => {
    vi.spyOn(client.varro.session, 'diffSummary').mockResolvedValue({
      files: 0,
      additions: 0,
      deletions: 0,
      tokens: 0,
      durationMs: 0,
      activeStartedAt: null,
    });
    const now = Date.now();
    setSessions([session('session-1', now, { title: 'First session' })]);
    cleanup = render(() => <SessionListView />, container);
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(
        container.querySelector<HTMLInputElement>('.session-list-search-input')
      )
    );

    openSessionActions(container.querySelector<HTMLElement>('.session-item')!);
    Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
      .find((button) => button.textContent?.trim() === 'Rename')!
      .click();
    await Promise.resolve();
    const input = document.querySelector<HTMLInputElement>('[id^="session-rename-"]')!;
    input.value = 'Draft rename';
    input.dispatchEvent(new InputEvent('input', { bubbles: true }));
    input.focus();
    input.setSelectionRange(5, 5);
    input.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));

    const unrelatedMutation = document.createElement('div');
    document.body.append(unrelatedMutation);
    await Promise.resolve();
    expect(input.selectionStart).toBe(5);
    expect(input.selectionEnd).toBe(5);
    unrelatedMutation.remove();

    setSessions([
      session('session-1', now + 1, { title: 'Updated session' }),
      session('archived-session', now - 2 * 24 * 60 * 60 * 1_000),
    ]);

    await vi.waitFor(() => {
      const updatedInput = document.querySelector<HTMLInputElement>('[id^="session-rename-"]');
      expect(updatedInput?.value).toBe('Draft rename');
      expect(document.activeElement).toBe(updatedInput);
      expect(updatedInput?.selectionStart).toBe(5);
      expect(updatedInput?.selectionEnd).toBe(5);
    });
    expect(
      container.querySelector('.session-item')?.classList.contains('is-context-selected')
    ).toBe(true);
  });

  it('does not override repeated caret placement while renaming', async () => {
    vi.spyOn(client.varro.session, 'diffSummary').mockResolvedValue({
      files: 0,
      additions: 0,
      deletions: 0,
      tokens: 0,
      durationMs: 0,
      activeStartedAt: null,
    });
    const now = Date.now();
    setSessions([session('session-1', now, { title: 'First session' })]);
    cleanup = render(() => <SessionListView />, container);

    openSessionActions(container.querySelector<HTMLElement>('.session-item')!);
    Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
      .find((button) => button.textContent?.trim() === 'Rename')!
      .click();
    await Promise.resolve();

    const input = document.querySelector<HTMLInputElement>('[id^="session-rename-"]')!;
    const setSelectionRange = vi.spyOn(input, 'setSelectionRange');

    input.setSelectionRange(3, 3);
    setSelectionRange.mockClear();
    input.dispatchEvent(new Event('select', { bubbles: true }));
    input.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));

    input.setSelectionRange(8, 8);
    setSelectionRange.mockClear();
    input.dispatchEvent(new Event('select', { bubbles: true }));
    input.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    await Promise.resolve();

    expect(setSelectionRange).not.toHaveBeenCalled();
    expect(input.selectionStart).toBe(8);
    expect(input.selectionEnd).toBe(8);
  });

  it('closes the context menu when rename is cancelled', () => {
    vi.spyOn(client.varro.session, 'diffSummary').mockResolvedValue({
      files: 0,
      additions: 0,
      deletions: 0,
      tokens: 0,
      durationMs: 0,
      activeStartedAt: null,
    });
    const updated = Date.now();
    setSessions([session('session-1', updated), session('session-2', updated - 1)]);
    cleanup = render(() => <SessionListView />, container);

    const rows = container.querySelectorAll<HTMLElement>('.session-item');
    openSessionActions(rows[0]!);
    Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
      .find((button) => button.textContent?.trim() === 'Rename')!
      .click();
    Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Cancel')!
      .click();

    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.querySelector('.session-item-actions-backdrop')).toBeNull();
    expect(rows[0]!.classList.contains('is-context-selected')).toBe(false);
    expect(rows[1]!.classList.contains('is-context-obscured')).toBe(false);
  });

  it('renames a session from its row action menu', async () => {
    vi.spyOn(client.varro.session, 'diffSummary').mockResolvedValue({
      files: 0,
      additions: 0,
      deletions: 0,
      tokens: 0,
      durationMs: 0,
      activeStartedAt: null,
    });
    setState('sessions', [session('session-1', Date.now())]);
    cleanup = render(() => <SessionListView />, container);

    openSessionActions(container.querySelector<HTMLElement>('.session-item')!);
    Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
      .find((button) => button.textContent?.trim() === 'Rename')!
      .click();

    const input = document.querySelector<HTMLInputElement>('[id^="session-rename-"]')!;
    input.value = '  Better title  ';
    input.dispatchEvent(new InputEvent('input', { bubbles: true }));
    input.closest('form')!.dispatchEvent(new SubmitEvent('submit', { bubbles: true }));

    await vi.waitFor(() => {
      expect(renameSessionMock).toHaveBeenCalledWith('session-1', 'Better title');
    });
    await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).toBeNull());
  });

  it('opens the row menu at the right-click position without an actions button', () => {
    vi.spyOn(client.varro.session, 'diffSummary').mockResolvedValue({
      files: 0,
      additions: 0,
      deletions: 0,
      tokens: 0,
      durationMs: 0,
      activeStartedAt: null,
    });
    const updated = Date.now();
    setState('sessions', [
      session('parent', updated),
      session('child', updated - 1, { parentID: 'parent' }),
    ]);
    cleanup = render(() => <SessionListView onOpenSubagents={vi.fn()} />, container);

    const row = container.querySelector<HTMLElement>('.session-item')!;
    expect(row.querySelector('.session-item-actions-trigger')).toBeNull();

    openSessionActions(row, 72, 84);

    const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
    expect(menu.style.left).toBe('72px');
    expect(menu.style.top).toBe('84px');
  });
});

describe('SessionListView load errors', () => {
  it('loads an archive session instead of showing an unknown zero count', async () => {
    const now = Date.now();
    const recent = session('recent', now);
    const archived = session('archived', now - 2 * 86_400_000);
    loadMoreSessionsMock.mockImplementationOnce(async () => {
      setState('sessions', [recent, archived]);
      setState('sessionsHasMore', false);
    });
    setState('sessions', [recent]);
    setState('sessionsHasMore', true);
    cleanup = render(() => <SessionListView />, container);

    expect(container.textContent).not.toContain('0+');
    await vi.waitFor(() => expect(loadMoreSessionsMock).toHaveBeenCalledOnce());
    await vi.waitFor(() => {
      const archive = Array.from(
        container.querySelectorAll<HTMLButtonElement>('.session-list-section-toggle')
      ).find((button) => button.textContent?.includes('Archive'));
      expect(archive?.textContent).toContain('1');
    });
  });

  it('offers continuation when the loaded page has no visible sessions', () => {
    setState('sessionsHasMore', true);
    cleanup = render(() => <SessionListView />, container);

    expect(container.textContent).not.toContain('No sessions yet');
    expect(container.querySelector('.session-list-continuation')).not.toBeNull();
    expect(container.textContent).not.toContain('Load more');
  });

  it('does not paginate beyond recent sessions for a status filter', () => {
    setState('sessions', [session('running', Date.now())]);
    setState('sessionStatus', { running: { type: 'busy' } });
    setState('sessionsHasMore', true);

    cleanup = render(() => <SessionListView sessionFilter="running" />, container);

    expect(container.querySelector('.session-item-title-text')?.textContent).toBe('running');
    expect(container.querySelector('.session-list-continuation')).toBeNull();
    expect(loadMoreSessionsMock).not.toHaveBeenCalled();
  });

  it('shows a lower-bound archive count and loads another session window', async () => {
    const callbacks = new Map<Element, IntersectionObserverCallback>();
    class TestIntersectionObserver {
      constructor(private readonly callback: IntersectionObserverCallback) {}
      observe(target: Element) {
        callbacks.set(target, this.callback);
      }
      unobserve(target: Element) {
        callbacks.delete(target);
      }
      disconnect() {}
    }
    // SAFETY: The fixture provides the unknown fields read by this statement.
    globalThis.IntersectionObserver =
      fixture<typeof IntersectionObserver>(TestIntersectionObserver);
    const now = Date.now();
    const archivedSessions = Array.from({ length: 50 }, (_, index) =>
      session(`archived-${index}`, now - (index + 2) * 86_400_000)
    );
    setState('sessions', [session('recent', now), ...archivedSessions]);
    setState('sessionsHasMore', true);
    cleanup = render(() => <SessionListView />, container);

    const archive = Array.from(
      container.querySelectorAll<HTMLButtonElement>('.session-list-section-toggle')
    ).find((button) => button.textContent?.includes('Archive'));
    expect(archive?.textContent).toContain('50+');
    expect(loadMoreSessionsMock).not.toHaveBeenCalled();

    archive!.click();
    const continuation = container.querySelector('.session-list-continuation')!;
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    callbacks.get(continuation)?.(
      [{ target: continuation, isIntersecting: true } as IntersectionObserverEntry],
      {} as IntersectionObserver
    );

    await vi.waitFor(() => expect(loadMoreSessionsMock).toHaveBeenCalledOnce());
  });

  it('loads another session window by default while Archive has fewer than 50 sessions', async () => {
    const now = Date.now();
    setState('sessions', [session('recent', now), session('archived', now - 2 * 86_400_000)]);
    setState('sessionsHasMore', true);

    cleanup = render(() => <SessionListView />, container);

    await vi.waitFor(() => expect(loadMoreSessionsMock).toHaveBeenCalledOnce());
  });

  it('searches all sessions without adding search-only sessions to the archive', async () => {
    const now = Date.now();
    const loadedSessions = [session('recent', now), session('archived', now - 2 * 86_400_000)];
    const searchOnlySession = session('deep-archive', now - 30 * 86_400_000, {
      title: 'Flick through old notes',
    });
    vi.spyOn(client.session, 'list').mockResolvedValueOnce({
      items: [searchOnlySession],
      hasMore: false,
    });
    setState('sessions', loadedSessions);
    setState('sessionsHasMore', true);
    cleanup = render(() => <SessionListView />, container);

    await vi.waitFor(() => expect(loadMoreSessionsMock).toHaveBeenCalledOnce());

    const getArchive = () =>
      Array.from(
        container.querySelectorAll<HTMLButtonElement>('.session-list-section-toggle')
      ).find((button) => button.textContent?.includes('Archive'))!;
    expect(getArchive().textContent).toContain('1+');
    getArchive().click();

    const search = container.querySelector<HTMLInputElement>('.session-list-search-input')!;
    search.value = '  flick  ';
    search.dispatchEvent(new InputEvent('input', { bubbles: true }));

    await vi.waitFor(() => {
      expect(container.querySelector('.session-item-title-text')?.textContent).toBe(
        'Flick through old notes'
      );
    });
    expect(client.session.list).toHaveBeenCalledOnce();
    expect(client.session.list).toHaveBeenCalledWith({
      limit: 30,
      search: 'flick',
      roots: true,
      signal: expect.any(AbortSignal),
    });
    expect(loadMoreSessionsMock).toHaveBeenCalledOnce();
    expect(container.querySelector('.session-list-continuation')).toBeNull();
    expect(appState.sessions).toEqual(loadedSessions);

    const clearIcon = container.querySelector<HTMLElement>('.session-list-search-clear-icon');
    expect(clearIcon?.classList).toContain('ui-icon');
    expect(clearIcon?.style.getPropertyValue('--ui-icon-width')).toBe('10px');
    container.querySelector<HTMLButtonElement>('.session-list-search-clear')!.click();

    expect(container.textContent).not.toContain('Flick through old notes');
    expect(getArchive().textContent).toContain('1+');
    expect(appState.sessions).toEqual(loadedSessions);
  });

  it('resolves paginated sub-agents without adding archive sessions to loaded state', async () => {
    const now = Date.now();
    const loadedSessions = [
      session('parent', now),
      session('loaded-child', now - 1, { parentID: 'parent' }),
    ];
    const unrelatedArchiveSession = session('unrelated-archive', now - 30 * 86_400_000);
    const paginatedChild = session('paginated-child', now - 2, { parentID: 'parent' });
    vi.spyOn(client.session, 'list')
      .mockResolvedValueOnce({
        items: [...loadedSessions, unrelatedArchiveSession],
        hasMore: true,
      })
      .mockResolvedValueOnce({
        items: [...loadedSessions, unrelatedArchiveSession, paginatedChild],
        hasMore: false,
      });
    setState('sessions', loadedSessions);
    setState('sessionsHasMore', true);

    cleanup = render(() => <SessionListView subagentParentId="parent" />, container);

    await vi.waitFor(() => {
      expect(
        Array.from(container.querySelectorAll('.session-item-title-text')).map(
          (element) => element.textContent
        )
      ).toEqual(['loaded-child', 'paginated-child']);
    });
    expect(client.session.list).toHaveBeenNthCalledWith(1, { limit: 100 });
    expect(client.session.list).toHaveBeenNthCalledWith(2, { limit: 200 });
    expect(loadMoreSessionsMock).not.toHaveBeenCalled();
    expect(container.querySelector('.session-list-continuation')).toBeNull();
    expect(container.textContent).not.toContain('unrelated-archive');
    expect(appState.sessions).toEqual(loadedSessions);
  });

  it('shows a retryable error instead of the empty state when sessions fail to load', async () => {
    setState('sessionsLoadError', 'Failed to load sessions');
    cleanup = render(() => <SessionListView />, container);

    const errorRow = container.querySelector('.session-load-error');
    expect(errorRow?.textContent).toContain('Failed to load sessions');
    expect(container.textContent).not.toContain('No sessions yet');

    const retry = errorRow?.querySelector<HTMLButtonElement>('.session-load-error-retry');
    expect(retry).not.toBeNull();
    retry!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await vi.waitFor(() => expect(reloadSessionsMock).toHaveBeenCalledTimes(1));
  });

  it('keeps the empty state when sessions load fine', () => {
    cleanup = render(() => <SessionListView />, container);

    expect(container.querySelector('.session-load-error')).toBeNull();
    expect(container.textContent).toContain('No sessions yet');
  });
});
