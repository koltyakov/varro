/* oxlint-disable anti-slop/no-module-mocking -- Sending is isolated so these UI tests cannot execute an agent. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSignal } from 'solid-js';
import { reconcile } from 'solid-js/store';
import { render } from 'solid-js/web';
import { client } from '../../lib/client';
import { error, replaceMessages, setError, setState, state } from '../../lib/state';
import * as clipboard from '../../lib/write-clipboard';
import { assistantMessage, session, textPart, userMessage } from '../MessageList.test-utils';
import { FollowupSuggestions } from './FollowupSuggestions';

const mocks = vi.hoisted(() => ({
  fork: vi.fn<(id: string) => Promise<string | null>>(),
  select: vi.fn(async () => true),
  send: vi.fn<
    (
      prompt: string,
      options?: { onOptimisticPublish?: () => void; validateBeforeSend?: () => Promise<boolean> }
    ) => Promise<boolean>
  >(),
}));
vi.mock('../../hooks/useOpenCode', () => ({
  sendMessage: mocks.send,
  forkSession: mocks.fork,
  selectSession: mocks.select,
}));

const actions = [
  { title: 'Inspect parser failures', prompt: 'Investigate only the reported parser failures.' },
  { title: 'Add a regression test', prompt: 'Add focused regression coverage for empty tokens.' },
  {
    title: 'Explain the blocker',
    prompt: 'Explain the unresolved parser blocker without making changes.',
  },
];
const summary =
  'The parser review found an unresolved empty-token bug and missing regression coverage. A focused investigation and test would address the reported gaps.';
const suggestions = { summary, actions };
let container: HTMLDivElement;
let dispose: (() => void) | undefined;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  setState('activeSessionId', 'session-1');
  setState('serverStatus', { state: 'running', url: 'mock://server', apiVersion: 2 });
  setState('followupModel', 'test/small');
  setState('followupsEnabled', true);
  setState('selectedModel', { providerID: 'test', modelID: 'session', variant: 'high' });
  setState('sessionSelectedModels', reconcile({}));
  setState('messagesLoading', false);
  setState('followupOpening', null);
  setState('sessions', [session('session-1')]);
  setState('queuedMessages', []);
  setState('sessionStatus', reconcile({}));
  setState('failedSessionIds', []);
  setError(null);
  replaceMessages([
    { info: userMessage('user'), parts: [textPart('u', 'Fix the parser')] },
    {
      info: assistantMessage('answer', {
        parentID: 'user',
        mode: 'build',
        agent: 'build',
        time: { created: 1 },
      }),
      parts: [textPart('a', 'The empty-token bug remains.')],
    },
  ]);
  mocks.send.mockReset().mockResolvedValue(true);
  mocks.select.mockClear();
  mocks.fork.mockReset().mockImplementation(async () => {
    setState('sessions', [session('session-1'), session('fork-1')]);
    return 'fork-1';
  });
  vi.spyOn(client.varro, 'followups').mockImplementation(async (_id, _source, options) =>
    options.allowGenerate ? suggestions : { summary: '', actions: [] }
  );
  vi.spyOn(client.varro, 'dismissFollowups').mockResolvedValue(true);
  vi.spyOn(clipboard, 'writeClipboard').mockResolvedValue(true);
});
afterEach(() => {
  dispose?.();
  dispose = undefined;
  container.remove();
  setState('followupModel', '');
  setState('followupsEnabled', true);
  setState('selectedModel', null);
  setState('sessionSelectedModels', reconcile({}));
  setState('messages', []);
  setState('queuedMessages', []);
  setState('sessionStatus', reconcile({}));
  setState('failedSessionIds', []);
  setError(null);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}
function mount(
  initialWorking = true,
  agent = 'build',
  onRestoreStart?: () => (() => void) | undefined
) {
  const complete = () =>
    setState(
      'messages',
      1,
      'info',
      assistantMessage('answer', {
        parentID: 'user',
        agent,
        mode: agent,
        time: { created: 1, completed: 2 },
      })
    );
  if (!initialWorking) complete();
  const [working, setWorking] = createSignal(initialWorking);
  const [blocked, setBlocked] = createSignal(false);
  dispose = render(
    () => (
      <FollowupSuggestions
        finalMessageId={working() ? null : 'answer'}
        turnId="user"
        working={working()}
        blocked={blocked()}
        onRestoreStart={onRestoreStart}
      />
    ),
    container
  );
  return {
    setWorking: (value: boolean) => {
      if (!value) complete();
      setWorking(value);
    },
    setBlocked,
  };
}

async function openActionMenu(index = 0) {
  const button = container.querySelectorAll<HTMLButtonElement>(
    '.followup-suggestions-actions button'
  )[index]!;
  button.focus();
  button.dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 30 })
  );
  await flush();
  return button;
}

function menuItem(text: string) {
  const item = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find(
    (button) => button.textContent?.trim() === text
  );
  if (!item) throw new Error(`Missing follow-up menu item: ${text}`);
  return item;
}

describe('FollowupSuggestions', () => {
  it('runs the selected action in a background fork and replaces only that action with a session link', async () => {
    const { setWorking } = mount();
    setWorking(false);
    await flush();
    vi.mocked(client.varro.followups).mockResolvedValue(suggestions);
    mocks.send.mockImplementationOnce(async (_prompt, options) => {
      expect(await options?.validateBeforeSend?.()).toBe(true);
      return true;
    });
    await openActionMenu(1);
    const item = menuItem('Run in new session');
    item.click();
    item.click();
    await flush();
    expect(mocks.fork).toHaveBeenCalledExactlyOnceWith('session-1', undefined, { select: false });
    expect(mocks.send).toHaveBeenCalledExactlyOnceWith(actions[1]!.prompt, {
      targetSessionId: 'fork-1',
      agent: 'build',
      preserveComposer: true,
      omitContext: true,
      followupTitle: actions[1]!.title,
      validateBeforeSend: expect.any(Function),
    });
    expect(state.activeSessionId).toBe('session-1');
    expect(mocks.select).not.toHaveBeenCalled();
    expect(state.messages.map((entry) => entry.info.id)).toEqual(['user', 'answer']);
    const link = container.querySelector<HTMLAnchorElement>('.followup-session-link');
    expect(link?.textContent).toBe(actions[1]!.title);
    expect(link?.getAttribute('href')).toBe('#session/fork-1');
    expect(container.querySelectorAll('.followup-suggestions-actions button')).toHaveLength(2);
    link!.click();
    expect(mocks.select).toHaveBeenCalledExactlyOnceWith('fork-1', { directory: '/workspace' });
    expect(mocks.send).toHaveBeenCalledOnce();
    expect(state.queuedMessages).toHaveLength(0);
    expect(client.varro.dismissFollowups).not.toHaveBeenCalled();
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it('updates the linked session spinner from live busy, retry, and idle status', async () => {
    const { setWorking } = mount();
    setWorking(false);
    await flush();
    vi.mocked(client.varro.followups).mockResolvedValue(suggestions);
    setState('sessionStatus', 'fork-1', { type: 'busy' });
    await openActionMenu();
    menuItem('Run in new session').click();
    await flush();
    const link = container.querySelector<HTMLAnchorElement>('.followup-session-link')!;
    expect(link.querySelector('.session-status-indicator.is-running')).not.toBeNull();
    expect(link.getAttribute('aria-label')).toContain('Running');
    setState('sessionStatus', 'fork-1', {
      type: 'retry',
      attempt: 1,
      message: 'Retrying',
      next: 10,
    });
    expect(link.querySelector('.session-status-indicator.is-running')).not.toBeNull();
    setState('sessionStatus', 'fork-1', { type: 'idle' });
    expect(link.querySelector('.session-status-indicator.is-running')).toBeNull();
    expect(link.getAttribute('aria-label')).toContain('Idle');
    setState('failedSessionIds', ['fork-1']);
    expect(link.getAttribute('aria-label')).toContain('Failed');
    expect(mocks.send).toHaveBeenCalledOnce();
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it('keeps other suggestions runnable after a background fork', async () => {
    const { setWorking } = mount();
    setWorking(false);
    await flush();
    vi.mocked(client.varro.followups).mockResolvedValue(suggestions);
    await openActionMenu();
    menuItem('Run in new session').click();
    await flush();
    await openActionMenu();
    menuItem('Add to queue (paused)').click();
    await flush();
    expect(state.queuedMessages).toMatchObject([{ text: actions[1]!.prompt, paused: true }]);
    expect(container.querySelector('.followup-session-link')?.textContent).toBe(actions[0]!.title);
    expect(mocks.fork).toHaveBeenCalledOnce();
  });

  it('does not fork an action dismissed in another window', async () => {
    const { setWorking } = mount();
    setWorking(false);
    await flush();
    await openActionMenu();
    menuItem('Run in new session').click();
    await flush();
    expect(mocks.fork).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('ignores fork validation after switching sessions', async () => {
    const { setWorking } = mount();
    setWorking(false);
    await flush();
    let finish!: (value: typeof suggestions) => void;
    vi.mocked(client.varro.followups).mockImplementationOnce(
      () => new Promise((resolve) => (finish = resolve))
    );
    await openActionMenu();
    menuItem('Run in new session').click();
    setState('activeSessionId', 'session-2');
    finish(suggestions);
    await flush();
    expect(mocks.fork).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('does not send when navigation supersedes a pending fork', async () => {
    const { setWorking } = mount();
    setWorking(false);
    await flush();
    vi.mocked(client.varro.followups).mockResolvedValue(suggestions);
    let finish!: (id: string) => void;
    mocks.fork.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    await openActionMenu();
    menuItem('Run in new session').click();
    await flush();
    setState('activeSessionId', 'session-2');
    finish('fork-1');
    await flush();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(state.activeSessionId).toBe('session-2');
    expect(error()).toBeNull();
  });

  it.each(['dismissed', 'navigation'])(
    'revalidates the action before fork send admission after %s',
    async (change) => {
      const { setWorking } = mount();
      setWorking(false);
      await flush();
      vi.mocked(client.varro.followups).mockResolvedValue(suggestions);
      mocks.send.mockImplementationOnce(async (_prompt, options) => {
        if (change === 'dismissed')
          vi.mocked(client.varro.followups).mockResolvedValue({ summary: '', actions: [] });
        else setState('activeSessionId', 'session-2');
        expect(await options?.validateBeforeSend?.()).toBe(false);
        return false;
      });
      await openActionMenu();
      menuItem('Run in new session').click();
      await flush();
      expect(client.varro.dismissFollowups).not.toHaveBeenCalled();
      if (change === 'navigation') expect(error()).toBeNull();
    }
  );

  it('keeps suggestions available for retry when forking fails', async () => {
    const { setWorking } = mount();
    setWorking(false);
    await flush();
    vi.mocked(client.varro.followups).mockResolvedValue(suggestions);
    mocks.fork.mockResolvedValueOnce(null);
    await openActionMenu();
    menuItem('Run in new session').click();
    await flush();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Could not run');
    expect(container.querySelectorAll('button:disabled')).toHaveLength(0);
    await openActionMenu();
    menuItem('Run in new session').click();
    await flush();
    expect(mocks.send).toHaveBeenCalledOnce();
  });

  it.each(['rejected', 'error'])(
    'reports a %s background send without replacing the action',
    async (failure) => {
      const { setWorking } = mount();
      setWorking(false);
      await flush();
      vi.mocked(client.varro.followups).mockResolvedValue(suggestions);
      if (failure === 'error') mocks.send.mockRejectedValueOnce(new Error('Unavailable'));
      else mocks.send.mockResolvedValueOnce(false);
      await openActionMenu();
      menuItem('Run in new session').click();
      await flush();
      expect(container.querySelector('[role="alert"]')?.textContent).toContain('Could not run');
      expect(container.querySelector('.followup-session-link')).toBeNull();
      expect(container.querySelectorAll('.followup-suggestions-actions button')).toHaveLength(3);
      expect(state.activeSessionId).toBe('session-1');
      expect(client.varro.dismissFollowups).not.toHaveBeenCalled();
    }
  );

  it('copies the full action description from the context menu without sending or dismissing', async () => {
    const { setWorking } = mount();
    setWorking(false);
    await flush();
    const button = await openActionMenu();
    menuItem('Copy description').click();
    expect(clipboard.writeClipboard).toHaveBeenCalledExactlyOnceWith(actions[0]!.prompt);
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(button);
    expect(container.querySelector('.followup-suggestions')).not.toBeNull();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(client.varro.dismissFollowups).not.toHaveBeenCalled();
  });

  it('queues multiple actions paused while keeping the remaining suggestions available', async () => {
    const { setWorking } = mount();
    setWorking(false);
    await flush();
    vi.mocked(client.varro.followups).mockResolvedValue(suggestions);
    for (const index of [0, 1]) {
      await openActionMenu(index);
      menuItem('Add to queue (paused)').click();
      await flush();
    }
    expect(state.queuedMessages).toEqual(
      actions.slice(0, 2).map((action) => ({
        id: expect.any(String),
        sessionId: 'session-1',
        text: action.prompt,
        followupTitle: action.title,
        agent: 'build',
        paused: true,
      }))
    );
    expect(new Set(state.queuedMessages.map((item) => item.id)).size).toBe(2);
    expect(JSON.parse(localStorage.getItem('varro.queuedMessages') ?? '[]')).toMatchObject([
      { text: actions[0]!.prompt, followupTitle: actions[0]!.title, paused: true },
      { text: actions[1]!.prompt, followupTitle: actions[1]!.title, paused: true },
    ]);
    expect(container.querySelectorAll('.followup-suggestions-actions button')).toHaveLength(3);
    expect(mocks.send).not.toHaveBeenCalled();
    expect(client.varro.dismissFollowups).not.toHaveBeenCalled();
  });

  it('keeps queue pointer input inside the menu until the click activates it', async () => {
    const { setWorking } = mount();
    setWorking(false);
    await flush();
    vi.mocked(client.varro.followups).mockResolvedValue(suggestions);
    const button = await openActionMenu();
    const item = menuItem('Add to queue (paused)');
    const outsidePointerDown = vi.fn();
    const outsideClick = vi.fn();
    window.addEventListener('pointerdown', outsidePointerDown);
    window.addEventListener('click', outsideClick);
    try {
      item.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      item.focus();
      expect(document.querySelector('[role="menu"]')).not.toBeNull();
      expect(document.activeElement).toBe(item);
      expect(state.queuedMessages).toHaveLength(0);
      item.click();
      await flush();
      expect(document.querySelector('[role="menu"]')).toBeNull();
      expect(document.activeElement).toBe(button);
      expect(state.queuedMessages).toMatchObject([{ text: actions[0]!.prompt, paused: true }]);
      expect(outsidePointerDown).not.toHaveBeenCalled();
      expect(outsideClick).not.toHaveBeenCalled();
      expect(mocks.send).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('pointerdown', outsidePointerDown);
      window.removeEventListener('click', outsideClick);
    }
  });

  it('does not queue an action dismissed in another window', async () => {
    const { setWorking } = mount();
    setWorking(false);
    await flush();
    await openActionMenu();
    menuItem('Add to queue (paused)').click();
    await flush();
    expect(state.queuedMessages).toHaveLength(0);
    expect(container.querySelector('.followup-suggestions')).toBeNull();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('ignores a queue validation result after switching sessions', async () => {
    const { setWorking } = mount();
    setWorking(false);
    await flush();
    let finish!: (value: typeof suggestions) => void;
    vi.mocked(client.varro.followups).mockImplementationOnce(
      () => new Promise((resolve) => (finish = resolve))
    );
    await openActionMenu();
    menuItem('Add to queue (paused)').click();
    setState('activeSessionId', 'session-2');
    finish(suggestions);
    await flush();
    expect(state.queuedMessages).toHaveLength(0);
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it('supports menu keyboard navigation, Escape, and outside dismissal', async () => {
    const { setWorking } = mount();
    setWorking(false);
    await flush();
    const button = await openActionMenu();
    expect(document.activeElement).toBe(menuItem('Copy description'));
    menuItem('Copy description').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })
    );
    expect(document.activeElement).toBe(menuItem('Add to queue (paused)'));
    menuItem('Add to queue (paused)').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })
    );
    expect(document.activeElement).toBe(menuItem('Run in new session'));
    menuItem('Run in new session').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
    );
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(button);
    await openActionMenu();
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(document.querySelector('[role="menu"]')).toBeNull();
    await openActionMenu();
    setWorking(true);
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it('renders backticked text in the summary and actions as inline code', async () => {
    vi.mocked(client.varro.followups).mockResolvedValue({
      summary: 'The `parseToken` helper still fails.',
      actions: [{ title: 'Fix `parseToken`', prompt: 'Fix the `parseToken` helper.' }],
    });
    const { setWorking } = mount();
    setWorking(false);
    await flush();
    const summaryCode = container.querySelector('.followup-suggestions-summary code');
    const actionCode = container.querySelector('.followup-suggestions-actions button code');
    expect(summaryCode?.textContent).toBe('parseToken');
    expect(actionCode?.textContent).toBe('parseToken');
    expect(container.querySelector('.followup-suggestions-actions button')?.textContent).toBe(
      'Fix parseToken'
    );
  });

  it('does not send an action dismissed in another window', async () => {
    const { setWorking } = mount();
    setWorking(false);
    await flush();
    expect(container.querySelector('.followup-suggestions')).not.toBeNull();
    vi.mocked(client.varro.followups).mockResolvedValue({ summary: '', actions: [] });
    container.querySelector<HTMLButtonElement>('.followup-suggestions-actions button')!.click();
    await flush();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(container.querySelector('.followup-suggestions')).toBeNull();
    expect(vi.mocked(client.varro.followups).mock.lastCall?.[2].allowGenerate).toBe(false);
  });

  it('rejects an action dismissed while send preparation is in progress', async () => {
    const { setWorking } = mount();
    setWorking(false);
    await flush();
    vi.mocked(client.varro.followups).mockResolvedValue(suggestions);
    let admitted = false;
    mocks.send.mockImplementationOnce(async (_prompt, options) => {
      vi.mocked(client.varro.followups).mockResolvedValue({ summary: '', actions: [] });
      admitted = (await options?.validateBeforeSend?.()) === true;
      return admitted;
    });
    container.querySelector<HTMLButtonElement>('.followup-suggestions-actions button')!.click();
    await flush();
    expect(mocks.send).toHaveBeenCalledOnce();
    expect(admitted).toBe(false);
    expect(container.querySelector('.followup-suggestions')).toBeNull();
  });

  it.each([0, 2, 3])(
    'admits an unread opening only when the answer completed after the prior seen marker %s',
    async (seenAt) => {
      const onRestoreStart = vi.fn<() => (() => void) | undefined>();
      vi.mocked(client.varro.followups).mockResolvedValue(suggestions);
      setState('followupOpening', { sessionId: 'session-1', seenAt });
      mount(false, 'build', onRestoreStart);
      await flush();
      expect(vi.mocked(client.varro.followups).mock.calls[0]?.[2].allowGenerate).toBe(seenAt < 2);
      expect(onRestoreStart).toHaveBeenCalledOnce();
    }
  );

  it('never arms completed history hydrated under a stale busy status', async () => {
    setState('messagesLoading', true);
    const { setWorking } = mount(false);
    setWorking(true);
    setState('messagesLoading', false);
    setWorking(false);
    await flush();
    expect(
      vi
        .mocked(client.varro.followups)
        .mock.calls.every(([, , options]) => options.allowGenerate === false)
    ).toBe(true);
  });

  it('restores a cached card on a read-history visit without allowing inference', async () => {
    const finishRestore = vi.fn(() => {
      expect(container.querySelector('.followup-suggestions')).not.toBeNull();
    });
    const onRestoreStart = vi.fn(() => {
      expect(container.querySelector('.followup-suggestions')).toBeNull();
      return finishRestore;
    });
    vi.mocked(client.varro.followups).mockResolvedValue(suggestions);
    mount(false, 'build', onRestoreStart);
    await flush();
    expect(onRestoreStart).toHaveBeenCalledOnce();
    expect(finishRestore).toHaveBeenCalledOnce();
    expect(client.varro.followups).toHaveBeenCalledOnce();
    expect(container.querySelector('.followup-suggestions')).not.toBeNull();
    expect(vi.mocked(client.varro.followups).mock.calls[0]?.[2].allowGenerate).toBe(false);
    expect(vi.mocked(client.varro.followups).mock.calls[0]?.[2].cacheOnly).toBe(true);
  });

  it('does not hold or cache-probe fresh live-turn suggestions', async () => {
    const onRestoreStart = vi.fn<() => (() => void) | undefined>();
    const { setWorking } = mount(true, 'build', onRestoreStart);
    setWorking(false);
    await flush();
    expect(container.querySelector('.followup-suggestions')).not.toBeNull();
    expect(onRestoreStart).not.toHaveBeenCalled();
    expect(client.varro.followups).toHaveBeenCalledOnce();
    expect(vi.mocked(client.varro.followups).mock.calls[0]?.[2].cacheOnly).toBeUndefined();
  });

  it('holds initial reveal until a delayed cached card has mounted', async () => {
    let finish!: (value: typeof suggestions) => void;
    vi.mocked(client.varro.followups).mockImplementationOnce(
      () => new Promise((resolve) => (finish = resolve))
    );
    const finishRestore = vi.fn();
    mount(false, 'build', () => finishRestore);
    await flush();
    expect(finishRestore).not.toHaveBeenCalled();
    expect(container.querySelector('.followup-suggestions')).toBeNull();
    finish(suggestions);
    await flush();
    expect(container.querySelector('.followup-suggestions')).not.toBeNull();
    expect(finishRestore).toHaveBeenCalledOnce();
  });

  it.each(['miss', 'error'])(
    'releases initial reveal after a cache %s without waiting for generation',
    async (result) => {
      if (result === 'miss')
        vi.mocked(client.varro.followups).mockResolvedValueOnce({ summary: '', actions: [] });
      else vi.mocked(client.varro.followups).mockRejectedValueOnce(new Error('Cache unavailable'));
      let finish!: (value: typeof suggestions) => void;
      vi.mocked(client.varro.followups).mockImplementationOnce(
        () => new Promise((resolve) => (finish = resolve))
      );
      const finishRestore = vi.fn();
      setState('followupOpening', { sessionId: 'session-1', seenAt: 0 });
      mount(false, 'build', () => finishRestore);
      await flush();
      expect(finishRestore).toHaveBeenCalledOnce();
      expect(container.querySelector('.followup-suggestions')).toBeNull();
      expect(
        vi.mocked(client.varro.followups).mock.calls.map(([, , options]) => ({
          cacheOnly: options.cacheOnly === true,
          allowGenerate: options.allowGenerate,
        }))
      ).toEqual([
        { cacheOnly: true, allowGenerate: false },
        { cacheOnly: false, allowGenerate: true },
      ]);
      finish(suggestions);
      await flush();
      expect(container.querySelector('.followup-suggestions')).not.toBeNull();
    }
  );

  it('bounds the initial cache hold and ignores a cache result arriving after its deadline', async () => {
    vi.useFakeTimers();
    let finish!: (value: typeof suggestions) => void;
    vi.mocked(client.varro.followups).mockImplementationOnce(
      () => new Promise((resolve) => (finish = resolve))
    );
    const finishRestore = vi.fn();
    mount(false, 'build', () => finishRestore);
    const signal = vi.mocked(client.varro.followups).mock.calls[0]![2].signal;
    await vi.advanceTimersByTimeAsync(2_001);
    expect(signal.aborted).toBe(true);
    expect(finishRestore).toHaveBeenCalledOnce();
    finish(suggestions);
    await flush();
    expect(container.querySelector('.followup-suggestions')).toBeNull();
    vi.useRealTimers();
  });

  it('releases an obsolete cache hold on session replacement and ignores its late result', async () => {
    let finish!: (value: typeof suggestions) => void;
    vi.mocked(client.varro.followups).mockImplementationOnce(
      () => new Promise((resolve) => (finish = resolve))
    );
    const finishRestore = vi.fn();
    mount(false, 'build', () => finishRestore);
    const signal = vi.mocked(client.varro.followups).mock.calls[0]![2].signal;
    setState('activeSessionId', 'session-2');
    expect(signal.aborted).toBe(true);
    expect(finishRestore).toHaveBeenCalledOnce();
    finish(suggestions);
    await flush();
    expect(container.querySelector('.followup-suggestions')).toBeNull();
  });

  it('persists explicit dismissal without sending a prompt', async () => {
    const { setWorking } = mount();
    setWorking(false);
    await flush();
    expect(client.varro.dismissFollowups).not.toHaveBeenCalled();
    container.querySelector<HTMLButtonElement>('[aria-label="Dismiss follow-ups"]')!.click();
    expect(client.varro.dismissFollowups).toHaveBeenCalledTimes(1);
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it.each(['ask', 'plan', 'review', 'custom'])(
    'does not request or display suggestions for %s',
    async (agent) => {
      const { setWorking } = mount(true, agent);
      setWorking(false);
      await flush();
      expect(client.varro.followups).not.toHaveBeenCalled();
      expect(container.querySelector('.followup-suggestions')).toBeNull();
    }
  );
  it('does not reinterpret an old final response as new work after a failed send', async () => {
    const { setWorking } = mount(false);
    setWorking(true);
    setWorking(false);
    await flush();
    expect(
      vi.mocked(client.varro.followups).mock.calls.every(([, , options]) => !options.allowGenerate)
    ).toBe(true);
  });
  it.each(['empty', 'error', 'dismissed'])(
    'does not retry %s suggestions during the same turn',
    async (result) => {
      if (result === 'empty')
        vi.mocked(client.varro.followups).mockResolvedValueOnce({ summary: '', actions: [] });
      if (result === 'error')
        vi.mocked(client.varro.followups).mockRejectedValueOnce(new Error('Unavailable'));
      const { setWorking, setBlocked } = mount();
      setWorking(false);
      await flush();
      if (result === 'dismissed')
        container.querySelector<HTMLButtonElement>('[aria-label="Dismiss follow-ups"]')!.click();
      expect(container.querySelector('.followup-suggestions')).toBeNull();
      setBlocked(true);
      setBlocked(false);
      setWorking(true);
      setWorking(false);
      await flush();
      expect(client.varro.followups).toHaveBeenCalledTimes(1);
      expect(container.querySelector('.followup-suggestions')).toBeNull();
    }
  );

  it('never generates for idle history or when explicitly disabled', async () => {
    mount(false);
    await flush();
    expect(client.varro.followups).toHaveBeenCalledTimes(1);
    expect(vi.mocked(client.varro.followups).mock.calls[0]?.[2].allowGenerate).toBe(false);
    dispose?.();
    vi.mocked(client.varro.followups).mockClear();
    setState('followupsEnabled', false);
    const { setWorking } = mount();
    setWorking(false);
    await flush();
    expect(client.varro.followups).not.toHaveBeenCalled();
  });

  it.each(['high', undefined])(
    'uses the session model and reasoning %s without an override',
    async (variant) => {
      setState('followupModel', '');
      setState('sessionSelectedModels', 'session-1', {
        providerID: 'test',
        modelID: 'session',
        variant,
      });
      setState('selectedModel', { providerID: 'other', modelID: 'draft', variant: 'low' });
      const { setWorking } = mount();
      setWorking(false);
      await flush();
      expect(client.varro.followups).toHaveBeenCalledExactlyOnceWith(
        'session-1',
        expect.any(Object),
        expect.objectContaining({
          allowGenerate: true,
          model: { providerID: 'test', modelID: 'session', variant },
        })
      );
      expect(container.querySelector('.followup-suggestions')).not.toBeNull();
    }
  );

  it('cancels pending suggestions when opted out and ignores the late result', async () => {
    let finish!: (value: typeof suggestions) => void;
    vi.mocked(client.varro.followups).mockImplementationOnce(
      () => new Promise((resolve) => (finish = resolve))
    );
    const { setWorking } = mount();
    setWorking(false);
    const signal = vi.mocked(client.varro.followups).mock.calls[0]![2].signal;
    setState('followupsEnabled', false);
    expect(signal.aborted).toBe(true);
    finish(suggestions);
    await flush();
    expect(container.querySelector('.followup-suggestions')).toBeNull();
    expect(client.varro.followups).toHaveBeenCalledTimes(1);
  });

  it.each(['model', 'variant'] as const)(
    'invalidates session-model suggestions on a %s change without new inference',
    async (change) => {
      setState('followupModel', '');
      const { setWorking } = mount();
      setWorking(false);
      await flush();
      expect(container.querySelector('.followup-suggestions')).not.toBeNull();
      setState('selectedModel', change === 'model' ? 'modelID' : 'variant', 'other');
      await flush();
      expect(container.querySelector('.followup-suggestions')).toBeNull();
      expect(client.varro.followups).toHaveBeenCalledTimes(2);
      expect(vi.mocked(client.varro.followups).mock.calls[1]?.[2].allowGenerate).toBe(false);
    }
  );

  it('sends an action immediately on click, without a dialog or duplicate sends', async () => {
    const { setWorking } = mount();
    expect(client.varro.followups).not.toHaveBeenCalled();
    setWorking(false);
    await flush();
    expect(client.varro.followups).toHaveBeenCalledTimes(1);
    expect(container.querySelectorAll('.followup-suggestions-actions button')).toHaveLength(3);
    expect(container.querySelector('.followup-suggestions-summary')?.textContent).toBe(summary);
    const close = container.querySelector('[aria-label="Dismiss follow-ups"]');
    expect(close?.querySelector('.ui-icon')).not.toBeNull();
    expect(close?.textContent?.trim()).toBe('');
    expect(
      container.querySelector('.followup-suggestions-actions button')?.hasAttribute('title')
    ).toBe(false);
    expect(mocks.send).not.toHaveBeenCalled();
    const button = container.querySelector<HTMLButtonElement>(
      '.followup-suggestions-actions button'
    )!;
    vi.mocked(client.varro.followups).mockResolvedValue(suggestions);
    button.click();
    button.click();
    await flush();
    expect(mocks.send).toHaveBeenCalledExactlyOnceWith(actions[0]!.prompt, {
      targetSessionId: 'session-1',
      preserveComposer: true,
      omitContext: true,
      followupTitle: actions[0]!.title,
      validateBeforeSend: expect.any(Function),
      onOptimisticPublish: expect.any(Function),
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await flush();
    expect(container.querySelector('.followup-suggestions')).toBeNull();
    expect(client.varro.dismissFollowups).toHaveBeenCalledTimes(1);
  });

  it('hides the card with optimistic publication, before admission, without persisting premature dismissal', async () => {
    let finish!: (accepted: boolean) => void;
    mocks.send.mockImplementationOnce((_prompt, options) => {
      options?.onOptimisticPublish?.();
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const { setWorking } = mount();
    setWorking(false);
    await flush();
    vi.mocked(client.varro.followups).mockResolvedValue(suggestions);
    container.querySelector<HTMLButtonElement>('.followup-suggestions-actions button')!.click();
    await flush();
    expect(container.querySelector('.followup-suggestions')).toBeNull();
    expect(client.varro.dismissFollowups).not.toHaveBeenCalled();
    finish(true);
    await flush();
    expect(client.varro.dismissFollowups).toHaveBeenCalledTimes(1);
  });

  it.each(['rejected', 'error'])(
    'retains the card for retry after a %s send and optimistic busy transition',
    async (failure) => {
      const { setWorking } = mount();
      setWorking(false);
      await flush();
      vi.mocked(client.varro.followups).mockResolvedValue(suggestions);
      mocks.send.mockImplementationOnce(async (_prompt, options) => {
        options?.onOptimisticPublish?.();
        expect(container.querySelector('.followup-suggestions')).toBeNull();
        setWorking(true);
        await Promise.resolve();
        setWorking(false);
        if (failure === 'error') throw new Error('Unavailable');
        return false;
      });
      container.querySelector<HTMLButtonElement>('.followup-suggestions-actions button')!.click();
      await flush();
      expect(container.querySelector('.followup-suggestions')).not.toBeNull();
      expect(container.querySelectorAll('button:disabled')).toHaveLength(0);
      expect(document.querySelector('[role="alert"]')?.textContent).toContain('Could not send');
      expect(client.varro.dismissFollowups).not.toHaveBeenCalled();
      container.querySelector<HTMLButtonElement>('.followup-suggestions-actions button')!.click();
      await flush();
      expect(mocks.send).toHaveBeenCalledTimes(2);
      expect(container.querySelector('.followup-suggestions')).toBeNull();
      expect(client.varro.dismissFollowups).toHaveBeenCalledTimes(1);
    }
  );

  it.each(['busy', 'model', 'session', 'blocked', 'text', 'disabled'])(
    'invalidates suggestions on %s changes without sending or regenerating',
    async (change) => {
      const { setWorking, setBlocked } = mount();
      setWorking(false);
      await flush();
      if (change === 'busy') setWorking(true);
      if (change === 'model') setState('followupModel', 'test/other');
      if (change === 'session') setState('activeSessionId', 'session-2');
      if (change === 'blocked') setBlocked(true);
      if (change === 'text') setState('messages', 1, 'parts', [textPart('a', 'Already fixed.')]);
      if (change === 'disabled') setState('followupsEnabled', false);
      await flush();
      expect(container.querySelector('.followup-suggestions')).toBeNull();
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(client.varro.followups).toHaveBeenCalledTimes(change === 'model' ? 2 : 1);
      if (change === 'model')
        expect(vi.mocked(client.varro.followups).mock.calls[1]?.[2].allowGenerate).toBe(false);
      expect(mocks.send).not.toHaveBeenCalled();
      expect(client.varro.dismissFollowups).not.toHaveBeenCalled();
    }
  );

  it.each([true, false])(
    'does not apply a late send result to another session, accepted=%s',
    async (accepted) => {
      let finish!: (value: boolean) => void;
      mocks.send.mockImplementationOnce(
        (_prompt, options) =>
          new Promise((resolve) => {
            options?.onOptimisticPublish?.();
            finish = resolve;
          })
      );
      const { setWorking } = mount();
      setWorking(false);
      await flush();
      vi.mocked(client.varro.followups).mockResolvedValue(suggestions);
      container.querySelector<HTMLButtonElement>('.followup-suggestions-actions button')!.click();
      await flush();
      setState('activeSessionId', 'session-2');
      finish(accepted);
      await flush();
      expect(container.querySelector('.followup-suggestions')).toBeNull();
      expect(container.querySelector('[role="alert"]')).toBeNull();
      expect(client.varro.dismissFollowups).toHaveBeenCalledTimes(accepted ? 1 : 0);
      if (accepted)
        expect(vi.mocked(client.varro.dismissFollowups).mock.calls[0]?.[0]).toBe('session-1');
    }
  );

  it('ignores a late result after session switch and never retries empty results', async () => {
    let finish!: (value: typeof suggestions) => void;
    vi.mocked(client.varro.followups).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const { setWorking } = mount();
    setWorking(false);
    setState('activeSessionId', 'session-2');
    finish(suggestions);
    await flush();
    expect(container.querySelector('.followup-suggestions')).toBeNull();
    setState('activeSessionId', 'session-1');
    setWorking(true);
    setWorking(false);
    await flush();
    expect(client.varro.followups).toHaveBeenCalledTimes(2);
    expect(vi.mocked(client.varro.followups).mock.calls[1]?.[2].allowGenerate).toBe(false);
  });
});
