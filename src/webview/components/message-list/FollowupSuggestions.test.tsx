import { flush as flushSolid, createSignal, reconcile } from 'solid-js';
import { storePath } from '@solidjs/signals';
/* oxlint-disable anti-slop/no-module-mocking -- Sending is isolated so these UI tests cannot execute an agent. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@solidjs/web';
import { client } from '../../lib/client';
import type { FollowupSuggestionSet } from '../../../shared/followups';
import { checkIcon, xmarkIcon } from '../../lib/ui-icons';
import { error, replaceMessages, setError, setState, state } from '../../lib/state';
import * as clipboard from '../../lib/write-clipboard';
import { assistantMessage, session, textPart, userMessage } from '../MessageList.test-utils';
import { FollowupSuggestions } from './FollowupSuggestions';

const mocks = vi.hoisted(() => ({
  fork: vi.fn<(id: string) => Promise<string | null>>(),
  rename: vi.fn<(id: string, title: string) => Promise<boolean>>(),
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
  renameSession: mocks.rename,
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
  setState(storePath('activeSessionId', 'session-1'));
  flushSolid();
  setState(storePath('serverStatus', { state: 'running', url: 'mock://server', apiVersion: 2 }));
  flushSolid();
  setState(storePath('followupModel', 'test/small'));
  flushSolid();
  setState(storePath('followupsEnabled', true));
  flushSolid();
  setState(storePath('selectedModel', { providerID: 'test', modelID: 'session', variant: 'high' }));
  flushSolid();
  setState((draft) => {
    const current = draft['sessionSelectedModels'];
    const incoming = {} satisfies typeof current;
    if (incoming === null || incoming === undefined || current === null || current === undefined)
      draft['sessionSelectedModels'] = incoming;
    else reconcile(incoming)(current);
  });
  flushSolid();
  setState(storePath('messagesLoading', false));
  flushSolid();
  setState(storePath('followupOpening', null));
  flushSolid();
  setState(storePath('sessions', [session('session-1')]));
  flushSolid();
  setState(storePath('queuedMessages', []));
  flushSolid();
  setState((draft) => {
    const current = draft['sessionStatus'];
    const incoming = {} satisfies typeof current;
    if (incoming === null || incoming === undefined || current === null || current === undefined)
      draft['sessionStatus'] = incoming;
    else reconcile(incoming)(current);
  });
  flushSolid();
  setState(storePath('failedSessionIds', []));
  flushSolid();
  setError(null);
  flushSolid();
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
  flushSolid();
  mocks.send.mockReset().mockResolvedValue(true);
  mocks.select.mockClear();
  mocks.rename.mockReset().mockResolvedValue(true);
  mocks.fork.mockReset().mockImplementation(async () => {
    setState(storePath('sessions', [session('session-1'), session('fork-1')]));
    return 'fork-1';
  });
  vi.spyOn(client.varro, 'followups').mockImplementation(async (_id, _source, options) =>
    options.allowGenerate ? suggestions : { summary: '', actions: [] }
  );
  vi.spyOn(client.varro, 'dismissFollowups').mockResolvedValue(true);
  vi.spyOn(client.varro, 'linkFollowupSession').mockResolvedValue(true);
  vi.spyOn(clipboard, 'writeClipboard').mockResolvedValue(true);
});
afterEach(() => {
  dispose?.();
  flushSolid();
  dispose = undefined;
  container.remove();
  flushSolid();
  setState(storePath('followupModel', ''));
  flushSolid();
  setState(storePath('followupsEnabled', true));
  flushSolid();
  setState(storePath('selectedModel', null));
  flushSolid();
  setState((draft) => {
    const current = draft['sessionSelectedModels'];
    const incoming = {} satisfies typeof current;
    if (incoming === null || incoming === undefined || current === null || current === undefined)
      draft['sessionSelectedModels'] = incoming;
    else reconcile(incoming)(current);
  });
  flushSolid();
  setState(storePath('messages', []));
  flushSolid();
  setState(storePath('queuedMessages', []));
  flushSolid();
  setState((draft) => {
    const current = draft['sessionStatus'];
    const incoming = {} satisfies typeof current;
    if (incoming === null || incoming === undefined || current === null || current === undefined)
      draft['sessionStatus'] = incoming;
    else reconcile(incoming)(current);
  });
  flushSolid();
  setState(storePath('failedSessionIds', []));
  flushSolid();
  setError(null);
  flushSolid();
  vi.restoreAllMocks();
  flushSolid();
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
      storePath(
        'messages',
        1,
        'info',
        assistantMessage('answer', {
          parentID: 'user',
          agent,
          mode: agent,
          time: { created: 1, completed: 2 },
        })
      )
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
    flushSolid();
    setWorking(false);
    flushSolid();
    await flush();
    flushSolid();
    vi.mocked(client.varro.followups).mockResolvedValue(suggestions);
    mocks.send.mockImplementationOnce(async (_prompt, options) => {
      expect(await options?.validateBeforeSend?.()).toBe(true);
      return true;
    });
    await openActionMenu(1);
    flushSolid();
    const item = menuItem('Run in new session');
    item.click();
    flushSolid();
    item.click();
    flushSolid();
    await flush();
    flushSolid();
    expect(mocks.fork).toHaveBeenCalledExactlyOnceWith('session-1', undefined, { select: false });
    expect(mocks.send).toHaveBeenCalledExactlyOnceWith(actions[1]!.prompt, {
      targetSessionId: 'fork-1',
      agent: 'build',
      preserveComposer: true,
      omitContext: true,
      followupTitle: actions[1]!.title,
      validateBeforeSend: expect.any(Function),
    });
    expect(client.varro.linkFollowupSession).toHaveBeenCalledExactlyOnceWith(
      'session-1',
      expect.objectContaining({ assistantMessageId: 'answer', userMessageId: 'user' }),
      { ...actions[1]!, sessionId: 'fork-1' },
      '/workspace'
    );
    expect(mocks.rename).toHaveBeenCalledExactlyOnceWith(
      'fork-1',
      `${actions[1]!.title} (session-1)`
    );
    expect(state.activeSessionId).toBe('session-1');
    expect(mocks.select).not.toHaveBeenCalled();
    expect(state.messages.map((entry) => entry.info.id)).toEqual(['user', 'answer']);
    const link = container.querySelector<HTMLAnchorElement>('.followup-session-link');
    expect(link?.textContent).toBe(actions[1]!.title);
    expect(link?.getAttribute('href')).toBe('#session/fork-1');
    expect(container.querySelectorAll('.followup-suggestions-actions button')).toHaveLength(2);
    link!.click();
    flushSolid();
    expect(mocks.select).toHaveBeenCalledExactlyOnceWith('fork-1', { directory: '/workspace' });
    expect(mocks.send).toHaveBeenCalledOnce();
    expect(state.queuedMessages).toHaveLength(0);
    expect(client.varro.dismissFollowups).not.toHaveBeenCalled();
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it.each([
    ['Parser review', 'Inspect parser failures (Parser review)'],
    ['  Parser review  ', 'Inspect parser failures (Parser review)'],
    ['', 'Inspect parser failures'],
    ['   ', 'Inspect parser failures'],
  ])('names the follow-up session using the original title %j', async (originalTitle, title) => {
    setState(storePath('sessions', 0, 'title', originalTitle));
    flushSolid();
    const { setWorking } = mount();
    flushSolid();
    setWorking(false);
    flushSolid();
    await flush();
    flushSolid();
    vi.mocked(client.varro.followups).mockResolvedValue(suggestions);
    await openActionMenu();
    flushSolid();
    menuItem('Run in new session').click();
    flushSolid();
    await flush();
    flushSolid();
    expect(mocks.rename).toHaveBeenCalledExactlyOnceWith('fork-1', title);
    expect(container.querySelector('.followup-session-link')?.textContent).toBe(actions[0]!.title);
  });

  it('updates the linked session spinner from live busy, retry, and idle status', async () => {
    const { setWorking } = mount();
    flushSolid();
    setWorking(false);
    flushSolid();
    await flush();
    flushSolid();
    vi.mocked(client.varro.followups).mockResolvedValue(suggestions);
    setState(storePath('sessionStatus', 'fork-1', { type: 'busy' }));
    flushSolid();
    await openActionMenu();
    flushSolid();
    menuItem('Run in new session').click();
    flushSolid();
    await flush();
    flushSolid();
    const link = container.querySelector<HTMLAnchorElement>('.followup-session-link')!;
    expect(link.querySelector('.session-status-indicator.is-running')).not.toBeNull();
    expect(link.getAttribute('aria-label')).toContain('Running');
    setState(
      storePath('sessionStatus', 'fork-1', {
        type: 'retry',
        attempt: 1,
        message: 'Retrying',
        next: 10,
      })
    );
    flushSolid();
    expect(link.querySelector('.session-status-indicator.is-running')).not.toBeNull();
    setState(storePath('sessionStatus', 'fork-1', { type: 'idle' }));
    flushSolid();
    expect(link.querySelector('.session-status-indicator.is-running')).toBeNull();
    expect(link.getAttribute('aria-label')).toContain('Completed');
    expect(
      link.querySelector<HTMLElement>('.ui-icon')?.style.getPropertyValue('--ui-icon-mask')
    ).toContain(checkIcon);
    setState(storePath('failedSessionIds', ['fork-1']));
    flushSolid();
    expect(link.getAttribute('aria-label')).toContain('Failed');
    expect(
      link.querySelector<HTMLElement>('.ui-icon')?.style.getPropertyValue('--ui-icon-mask')
    ).toContain(xmarkIcon);
    expect(mocks.send).toHaveBeenCalledOnce();
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it.each(['busy', 'idle'] as const)(
    'restores the linked action after a webview reload, status=%s',
    async (type) => {
      const { setWorking } = mount();
      flushSolid();
      setWorking(false);
      flushSolid();
      await flush();
      flushSolid();
      let stored: FollowupSuggestionSet = suggestions;
      vi.mocked(client.varro.followups).mockImplementation(async () => stored);
      vi.mocked(client.varro.linkFollowupSession).mockImplementationOnce(
        async (_id, _source, action) => {
          stored = {
            ...suggestions,
            actions: suggestions.actions.map((item) =>
              item.title === action.title ? action : item
            ),
          };
          return true;
        }
      );
      await openActionMenu();
      flushSolid();
      menuItem('Run in new session').click();
      flushSolid();
      await flush();
      flushSolid();
      dispose?.();
      flushSolid();
      dispose = undefined;
      setState(storePath('sessionStatus', 'fork-1', { type }));
      flushSolid();
      mount(false);
      flushSolid();
      await flush();
      flushSolid();
      const link = container.querySelector<HTMLAnchorElement>('.followup-session-link')!;
      expect(link.getAttribute('href')).toBe('#session/fork-1');
      expect(link.textContent).toBe(actions[0]!.title);
      expect(link.getAttribute('aria-label')).toContain(type === 'busy' ? 'Running' : 'Completed');
      expect(!!link.querySelector('.session-status-indicator.is-running')).toBe(type === 'busy');
      expect(mocks.fork).toHaveBeenCalledOnce();
      expect(mocks.send).toHaveBeenCalledOnce();
    }
  );

  it('restores a session linked in another window instead of forking it again', async () => {
    const { setWorking } = mount();
    flushSolid();
    setWorking(false);
    flushSolid();
    await flush();
    flushSolid();
    vi.mocked(client.varro.followups).mockResolvedValue({
      ...suggestions,
      actions: [{ ...actions[0]!, sessionId: 'other-fork' }, ...actions.slice(1)],
    });
    await openActionMenu();
    flushSolid();
    menuItem('Run in new session').click();
    flushSolid();
    await flush();
    flushSolid();
    expect(mocks.fork).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(container.querySelector('.followup-session-link')?.getAttribute('href')).toBe(
      '#session/other-fork'
    );
  });

  it('clears the linked action on a new prompt even while its persistence is pending', async () => {
    const { setWorking } = mount();
    flushSolid();
    setWorking(false);
    flushSolid();
    await flush();
    flushSolid();
    vi.mocked(client.varro.followups).mockResolvedValue(suggestions);
    let finish!: (saved: boolean) => void;
    vi.mocked(client.varro.linkFollowupSession).mockImplementationOnce(
      () => new Promise((resolve) => (finish = resolve))
    );
    await openActionMenu();
    flushSolid();
    menuItem('Run in new session').click();
    flushSolid();
    await flush();
    flushSolid();
    expect(container.querySelector('.followup-session-link')).not.toBeNull();
    setWorking(true);
    flushSolid();
    finish(false);
    await flush();
    flushSolid();
    expect(container.querySelector('.followup-suggestions')).toBeNull();
  });

  it('keeps the live link and reports a save failure without rerunning the action', async () => {
    const { setWorking } = mount();
    flushSolid();
    setWorking(false);
    flushSolid();
    await flush();
    flushSolid();
    vi.mocked(client.varro.followups).mockResolvedValue(suggestions);
    vi.mocked(client.varro.linkFollowupSession).mockRejectedValueOnce(
      new Error('Storage unavailable')
    );
    await openActionMenu();
    flushSolid();
    menuItem('Run in new session').click();
    flushSolid();
    await flush();
    flushSolid();
    expect(container.querySelector('.followup-session-link')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'session link could not be saved'
    );
    expect(mocks.send).toHaveBeenCalledOnce();
  });

  it('keeps other suggestions runnable after a background fork', async () => {
    const { setWorking } = mount();
    flushSolid();
    setWorking(false);
    flushSolid();
    await flush();
    flushSolid();
    vi.mocked(client.varro.followups).mockResolvedValue(suggestions);
    await openActionMenu();
    flushSolid();
    menuItem('Run in new session').click();
    flushSolid();
    await flush();
    flushSolid();
    await openActionMenu();
    flushSolid();
    menuItem('Add to queue (paused)').click();
    flushSolid();
    await flush();
    flushSolid();
    expect(state.queuedMessages).toMatchObject([{ text: actions[1]!.prompt, paused: true }]);
    expect(container.querySelector('.followup-session-link')?.textContent).toBe(actions[0]!.title);
    expect(mocks.fork).toHaveBeenCalledOnce();
  });

  it.each(['rejected', 'error'])(
    'keeps the running session link when renaming is %s',
    async (failure) => {
      const { setWorking } = mount();
      flushSolid();
      setWorking(false);
      flushSolid();
      await flush();
      flushSolid();
      vi.mocked(client.varro.followups).mockResolvedValue(suggestions);
      if (failure === 'error') mocks.rename.mockRejectedValueOnce(new Error('Unavailable'));
      else mocks.rename.mockResolvedValueOnce(false);
      await openActionMenu();
      flushSolid();
      menuItem('Run in new session').click();
      flushSolid();
      await flush();
      flushSolid();
      expect(mocks.rename).toHaveBeenCalledExactlyOnceWith(
        'fork-1',
        `${actions[0]!.title} (session-1)`
      );
      expect(container.querySelector('.followup-session-link')?.getAttribute('href')).toBe(
        '#session/fork-1'
      );
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        'session could not be renamed'
      );
      expect(mocks.send).toHaveBeenCalledOnce();
      expect(client.varro.linkFollowupSession).toHaveBeenCalledOnce();
      expect(state.activeSessionId).toBe('session-1');
    }
  );

  it('does not show a rename failure in a different session', async () => {
    const { setWorking } = mount();
    flushSolid();
    setWorking(false);
    flushSolid();
    await flush();
    flushSolid();
    vi.mocked(client.varro.followups).mockResolvedValue(suggestions);
    let finish!: (renamed: boolean) => void;
    mocks.rename.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    await openActionMenu();
    flushSolid();
    menuItem('Run in new session').click();
    flushSolid();
    await flush();
    flushSolid();
    expect(mocks.rename).toHaveBeenCalledOnce();
    setState(storePath('activeSessionId', 'session-2'));
    flushSolid();
    finish(false);
    await flush();
    flushSolid();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(state.activeSessionId).toBe('session-2');
  });

  it('does not fork an action dismissed in another window', async () => {
    const { setWorking } = mount();
    flushSolid();
    setWorking(false);
    flushSolid();
    await flush();
    flushSolid();
    await openActionMenu();
    flushSolid();
    menuItem('Run in new session').click();
    flushSolid();
    await flush();
    flushSolid();
    expect(mocks.fork).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('ignores fork validation after switching sessions', async () => {
    const { setWorking } = mount();
    flushSolid();
    setWorking(false);
    flushSolid();
    await flush();
    flushSolid();
    let finish!: (value: typeof suggestions) => void;
    vi.mocked(client.varro.followups).mockImplementationOnce(
      () => new Promise((resolve) => (finish = resolve))
    );
    await openActionMenu();
    flushSolid();
    menuItem('Run in new session').click();
    flushSolid();
    setState(storePath('activeSessionId', 'session-2'));
    flushSolid();
    finish(suggestions);
    await flush();
    flushSolid();
    expect(mocks.fork).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('does not send when navigation supersedes a pending fork', async () => {
    const { setWorking } = mount();
    flushSolid();
    setWorking(false);
    flushSolid();
    await flush();
    flushSolid();
    vi.mocked(client.varro.followups).mockResolvedValue(suggestions);
    let finish!: (id: string) => void;
    mocks.fork.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    await openActionMenu();
    flushSolid();
    menuItem('Run in new session').click();
    flushSolid();
    await flush();
    flushSolid();
    setState(storePath('activeSessionId', 'session-2'));
    flushSolid();
    finish('fork-1');
    await flush();
    flushSolid();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(state.activeSessionId).toBe('session-2');
    expect(error()).toBeNull();
  });

  it.each(['dismissed', 'navigation'])(
    'revalidates the action before fork send admission after %s',
    async (change) => {
      const { setWorking } = mount();
      flushSolid();
      setWorking(false);
      flushSolid();
      await flush();
      flushSolid();
      vi.mocked(client.varro.followups).mockResolvedValue(suggestions);
      mocks.send.mockImplementationOnce(async (_prompt, options) => {
        if (change === 'dismissed')
          vi.mocked(client.varro.followups).mockResolvedValue({ summary: '', actions: [] });
        else setState(storePath('activeSessionId', 'session-2'));
        expect(await options?.validateBeforeSend?.()).toBe(false);
        return false;
      });
      await openActionMenu();
      flushSolid();
      menuItem('Run in new session').click();
      flushSolid();
      await flush();
      flushSolid();
      expect(client.varro.dismissFollowups).not.toHaveBeenCalled();
      if (change === 'navigation') expect(error()).toBeNull();
    }
  );

  it('keeps suggestions available for retry when forking fails', async () => {
    const { setWorking } = mount();
    flushSolid();
    setWorking(false);
    flushSolid();
    await flush();
    flushSolid();
    vi.mocked(client.varro.followups).mockResolvedValue(suggestions);
    mocks.fork.mockResolvedValueOnce(null);
    await openActionMenu();
    flushSolid();
    menuItem('Run in new session').click();
    flushSolid();
    await flush();
    flushSolid();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Could not run');
    expect(container.querySelectorAll('button:disabled')).toHaveLength(0);
    await openActionMenu();
    flushSolid();
    menuItem('Run in new session').click();
    flushSolid();
    await flush();
    flushSolid();
    expect(mocks.send).toHaveBeenCalledOnce();
  });

  it.each(['rejected', 'error'])(
    'reports a %s background send without replacing the action',
    async (failure) => {
      const { setWorking } = mount();
      flushSolid();
      setWorking(false);
      flushSolid();
      await flush();
      flushSolid();
      vi.mocked(client.varro.followups).mockResolvedValue(suggestions);
      if (failure === 'error') mocks.send.mockRejectedValueOnce(new Error('Unavailable'));
      else mocks.send.mockResolvedValueOnce(false);
      await openActionMenu();
      flushSolid();
      menuItem('Run in new session').click();
      flushSolid();
      await flush();
      flushSolid();
      expect(container.querySelector('[role="alert"]')?.textContent).toContain('Could not run');
      expect(container.querySelector('.followup-session-link')).toBeNull();
      expect(container.querySelectorAll('.followup-suggestions-actions button')).toHaveLength(3);
      expect(state.activeSessionId).toBe('session-1');
      expect(client.varro.dismissFollowups).not.toHaveBeenCalled();
      expect(mocks.rename).not.toHaveBeenCalled();
    }
  );

  it('copies the full action description from the context menu without sending or dismissing', async () => {
    const { setWorking } = mount();
    flushSolid();
    setWorking(false);
    flushSolid();
    await flush();
    flushSolid();
    const button = await openActionMenu();
    flushSolid();
    menuItem('Copy description').click();
    flushSolid();
    expect(clipboard.writeClipboard).toHaveBeenCalledExactlyOnceWith(actions[0]!.prompt);
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(button);
    expect(container.querySelector('.followup-suggestions')).not.toBeNull();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(client.varro.dismissFollowups).not.toHaveBeenCalled();
  });

  it('queues multiple actions paused while keeping the remaining suggestions available', async () => {
    const { setWorking } = mount();
    flushSolid();
    setWorking(false);
    flushSolid();
    await flush();
    flushSolid();
    vi.mocked(client.varro.followups).mockResolvedValue(suggestions);
    for (const index of [0, 1]) {
      await openActionMenu(index);
      flushSolid();
      menuItem('Add to queue (paused)').click();
      flushSolid();
      await flush();
      flushSolid();
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
    flushSolid();
    setWorking(false);
    flushSolid();
    await flush();
    flushSolid();
    vi.mocked(client.varro.followups).mockResolvedValue(suggestions);
    const button = await openActionMenu();
    flushSolid();
    const item = menuItem('Add to queue (paused)');
    const outsidePointerDown = vi.fn();
    const outsideClick = vi.fn();
    window.addEventListener('pointerdown', outsidePointerDown);
    flushSolid();
    window.addEventListener('click', outsideClick);
    flushSolid();
    try {
      item.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      flushSolid();
      item.focus();
      flushSolid();
      expect(document.querySelector('[role="menu"]')).not.toBeNull();
      expect(document.activeElement).toBe(item);
      expect(state.queuedMessages).toHaveLength(0);
      item.click();
      flushSolid();
      await flush();
      flushSolid();
      expect(document.querySelector('[role="menu"]')).toBeNull();
      expect(document.activeElement).toBe(button);
      expect(state.queuedMessages).toMatchObject([{ text: actions[0]!.prompt, paused: true }]);
      expect(outsidePointerDown).not.toHaveBeenCalled();
      expect(outsideClick).not.toHaveBeenCalled();
      expect(mocks.send).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('pointerdown', outsidePointerDown);
      flushSolid();
      window.removeEventListener('click', outsideClick);
      flushSolid();
    }
  });

  it('does not queue an action dismissed in another window', async () => {
    const { setWorking } = mount();
    flushSolid();
    setWorking(false);
    flushSolid();
    await flush();
    flushSolid();
    await openActionMenu();
    flushSolid();
    menuItem('Add to queue (paused)').click();
    flushSolid();
    await flush();
    flushSolid();
    expect(state.queuedMessages).toHaveLength(0);
    expect(container.querySelector('.followup-suggestions')).toBeNull();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('ignores a queue validation result after switching sessions', async () => {
    const { setWorking } = mount();
    flushSolid();
    setWorking(false);
    flushSolid();
    await flush();
    flushSolid();
    let finish!: (value: typeof suggestions) => void;
    vi.mocked(client.varro.followups).mockImplementationOnce(
      () => new Promise((resolve) => (finish = resolve))
    );
    await openActionMenu();
    flushSolid();
    menuItem('Add to queue (paused)').click();
    flushSolid();
    setState(storePath('activeSessionId', 'session-2'));
    flushSolid();
    finish(suggestions);
    await flush();
    flushSolid();
    expect(state.queuedMessages).toHaveLength(0);
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it('supports menu keyboard navigation, Escape, and outside dismissal', async () => {
    const { setWorking } = mount();
    flushSolid();
    setWorking(false);
    flushSolid();
    await flush();
    flushSolid();
    const button = await openActionMenu();
    flushSolid();
    expect(document.activeElement).toBe(menuItem('Copy description'));
    menuItem('Copy description').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })
    );
    flushSolid();
    expect(document.activeElement).toBe(menuItem('Add to queue (paused)'));
    menuItem('Add to queue (paused)').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })
    );
    flushSolid();
    expect(document.activeElement).toBe(menuItem('Run in new session'));
    menuItem('Run in new session').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
    );
    flushSolid();
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(button);
    await openActionMenu();
    flushSolid();
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    flushSolid();
    expect(document.querySelector('[role="menu"]')).toBeNull();
    await openActionMenu();
    flushSolid();
    setWorking(true);
    flushSolid();
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it('renders backticked text in the summary and actions as inline code', async () => {
    vi.mocked(client.varro.followups).mockResolvedValue({
      summary: 'The `parseToken` helper still fails.',
      actions: [{ title: 'Fix `parseToken`', prompt: 'Fix the `parseToken` helper.' }],
    });
    const { setWorking } = mount();
    flushSolid();
    setWorking(false);
    flushSolid();
    await flush();
    flushSolid();
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
    flushSolid();
    setWorking(false);
    flushSolid();
    await flush();
    flushSolid();
    expect(container.querySelector('.followup-suggestions')).not.toBeNull();
    vi.mocked(client.varro.followups).mockResolvedValue({ summary: '', actions: [] });
    container.querySelector<HTMLButtonElement>('.followup-suggestions-actions button')!.click();
    flushSolid();
    await flush();
    flushSolid();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(container.querySelector('.followup-suggestions')).toBeNull();
    expect(vi.mocked(client.varro.followups).mock.lastCall?.[2].allowGenerate).toBe(false);
  });

  it('rejects an action dismissed while send preparation is in progress', async () => {
    const { setWorking } = mount();
    flushSolid();
    setWorking(false);
    flushSolid();
    await flush();
    flushSolid();
    vi.mocked(client.varro.followups).mockResolvedValue(suggestions);
    let admitted = false;
    mocks.send.mockImplementationOnce(async (_prompt, options) => {
      vi.mocked(client.varro.followups).mockResolvedValue({ summary: '', actions: [] });
      admitted = (await options?.validateBeforeSend?.()) === true;
      return admitted;
    });
    container.querySelector<HTMLButtonElement>('.followup-suggestions-actions button')!.click();
    flushSolid();
    await flush();
    flushSolid();
    expect(mocks.send).toHaveBeenCalledOnce();
    expect(admitted).toBe(false);
    expect(container.querySelector('.followup-suggestions')).toBeNull();
  });

  it.each([0, 2, 3])(
    'admits an unread opening only when the answer completed after the prior seen marker %s',
    async (seenAt) => {
      const onRestoreStart = vi.fn<() => (() => void) | undefined>();
      vi.mocked(client.varro.followups).mockResolvedValue(suggestions);
      setState(storePath('followupOpening', { sessionId: 'session-1', seenAt }));
      flushSolid();
      mount(false, 'build', onRestoreStart);
      flushSolid();
      await flush();
      flushSolid();
      expect(vi.mocked(client.varro.followups).mock.calls[0]?.[2].allowGenerate).toBe(seenAt < 2);
      expect(onRestoreStart).toHaveBeenCalledOnce();
    }
  );

  it('never arms completed history hydrated under a stale busy status', async () => {
    setState(storePath('messagesLoading', true));
    flushSolid();
    const { setWorking } = mount(false);
    flushSolid();
    setWorking(true);
    flushSolid();
    setState(storePath('messagesLoading', false));
    flushSolid();
    setWorking(false);
    flushSolid();
    await flush();
    flushSolid();
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
    flushSolid();
    await flush();
    flushSolid();
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
    flushSolid();
    setWorking(false);
    flushSolid();
    await flush();
    flushSolid();
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
    flushSolid();
    await flush();
    flushSolid();
    expect(finishRestore).not.toHaveBeenCalled();
    expect(container.querySelector('.followup-suggestions')).toBeNull();
    finish(suggestions);
    await flush();
    flushSolid();
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
      setState(storePath('followupOpening', { sessionId: 'session-1', seenAt: 0 }));
      flushSolid();
      mount(false, 'build', () => finishRestore);
      flushSolid();
      await flush();
      flushSolid();
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
      flushSolid();
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
    flushSolid();
    const signal = vi.mocked(client.varro.followups).mock.calls[0]![2].signal;
    await vi.advanceTimersByTimeAsync(2_001);
    flushSolid();
    expect(signal.aborted).toBe(true);
    expect(finishRestore).toHaveBeenCalledOnce();
    finish(suggestions);
    await flush();
    flushSolid();
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
    flushSolid();
    const signal = vi.mocked(client.varro.followups).mock.calls[0]![2].signal;
    setState(storePath('activeSessionId', 'session-2'));
    flushSolid();
    expect(signal.aborted).toBe(true);
    expect(finishRestore).toHaveBeenCalledOnce();
    finish(suggestions);
    await flush();
    flushSolid();
    expect(container.querySelector('.followup-suggestions')).toBeNull();
  });

  it('persists explicit dismissal without sending a prompt', async () => {
    const { setWorking } = mount();
    flushSolid();
    setWorking(false);
    flushSolid();
    await flush();
    flushSolid();
    expect(client.varro.dismissFollowups).not.toHaveBeenCalled();
    container.querySelector<HTMLButtonElement>('[aria-label="Dismiss follow-ups"]')!.click();
    flushSolid();
    expect(client.varro.dismissFollowups).toHaveBeenCalledTimes(1);
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it.each(['ask', 'plan', 'review', 'custom'])(
    'does not request or display suggestions for %s',
    async (agent) => {
      const { setWorking } = mount(true, agent);
      flushSolid();
      setWorking(false);
      flushSolid();
      await flush();
      flushSolid();
      expect(client.varro.followups).not.toHaveBeenCalled();
      expect(container.querySelector('.followup-suggestions')).toBeNull();
    }
  );
  it('does not reinterpret an old final response as new work after a failed send', async () => {
    const { setWorking } = mount(false);
    flushSolid();
    setWorking(true);
    flushSolid();
    setWorking(false);
    flushSolid();
    await flush();
    flushSolid();
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
      flushSolid();
      setWorking(false);
      flushSolid();
      await flush();
      flushSolid();
      if (result === 'dismissed')
        container.querySelector<HTMLButtonElement>('[aria-label="Dismiss follow-ups"]')!.click();
      flushSolid();
      expect(container.querySelector('.followup-suggestions')).toBeNull();
      setBlocked(true);
      flushSolid();
      setBlocked(false);
      flushSolid();
      setWorking(true);
      flushSolid();
      setWorking(false);
      flushSolid();
      await flush();
      flushSolid();
      expect(client.varro.followups).toHaveBeenCalledTimes(1);
      expect(container.querySelector('.followup-suggestions')).toBeNull();
    }
  );

  it('never generates for idle history or when explicitly disabled', async () => {
    mount(false);
    flushSolid();
    await flush();
    flushSolid();
    expect(client.varro.followups).toHaveBeenCalledTimes(1);
    expect(vi.mocked(client.varro.followups).mock.calls[0]?.[2].allowGenerate).toBe(false);
    dispose?.();
    flushSolid();
    vi.mocked(client.varro.followups).mockClear();
    setState(storePath('followupsEnabled', false));
    flushSolid();
    const { setWorking } = mount();
    flushSolid();
    setWorking(false);
    flushSolid();
    await flush();
    flushSolid();
    expect(client.varro.followups).not.toHaveBeenCalled();
  });

  it.each(['high', undefined])(
    'uses the session model and reasoning %s without an override',
    async (variant) => {
      setState(storePath('followupModel', ''));
      flushSolid();
      setState(
        storePath('sessionSelectedModels', 'session-1', {
          providerID: 'test',
          modelID: 'session',
          variant,
        })
      );
      flushSolid();
      setState(
        storePath('selectedModel', { providerID: 'other', modelID: 'draft', variant: 'low' })
      );
      flushSolid();
      const { setWorking } = mount();
      flushSolid();
      setWorking(false);
      flushSolid();
      await flush();
      flushSolid();
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
    flushSolid();
    setWorking(false);
    flushSolid();
    const signal = vi.mocked(client.varro.followups).mock.calls[0]![2].signal;
    setState(storePath('followupsEnabled', false));
    flushSolid();
    expect(signal.aborted).toBe(true);
    finish(suggestions);
    await flush();
    flushSolid();
    expect(container.querySelector('.followup-suggestions')).toBeNull();
    expect(client.varro.followups).toHaveBeenCalledTimes(1);
  });

  it.each(['model', 'variant'] as const)(
    'invalidates session-model suggestions on a %s change without new inference',
    async (change) => {
      setState(storePath('followupModel', ''));
      flushSolid();
      const { setWorking } = mount();
      flushSolid();
      setWorking(false);
      flushSolid();
      await flush();
      flushSolid();
      expect(container.querySelector('.followup-suggestions')).not.toBeNull();
      setState(storePath('selectedModel', change === 'model' ? 'modelID' : 'variant', 'other'));
      flushSolid();
      await flush();
      flushSolid();
      expect(container.querySelector('.followup-suggestions')).toBeNull();
      expect(client.varro.followups).toHaveBeenCalledTimes(2);
      expect(vi.mocked(client.varro.followups).mock.calls[1]?.[2].allowGenerate).toBe(false);
    }
  );

  it('sends an action immediately on click, without a dialog or duplicate sends', async () => {
    const { setWorking } = mount();
    flushSolid();
    expect(client.varro.followups).not.toHaveBeenCalled();
    setWorking(false);
    flushSolid();
    await flush();
    flushSolid();
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
    flushSolid();
    button.click();
    flushSolid();
    await flush();
    flushSolid();
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
    flushSolid();
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
    flushSolid();
    setWorking(false);
    flushSolid();
    await flush();
    flushSolid();
    vi.mocked(client.varro.followups).mockResolvedValue(suggestions);
    container.querySelector<HTMLButtonElement>('.followup-suggestions-actions button')!.click();
    flushSolid();
    await flush();
    flushSolid();
    expect(container.querySelector('.followup-suggestions')).toBeNull();
    expect(client.varro.dismissFollowups).not.toHaveBeenCalled();
    finish(true);
    await flush();
    flushSolid();
    expect(client.varro.dismissFollowups).toHaveBeenCalledTimes(1);
  });

  it.each(['rejected', 'error'])(
    'retains the card for retry after a %s send and optimistic busy transition',
    async (failure) => {
      const { setWorking } = mount();
      flushSolid();
      setWorking(false);
      flushSolid();
      await flush();
      flushSolid();
      vi.mocked(client.varro.followups).mockResolvedValue(suggestions);
      mocks.send.mockImplementationOnce(async (_prompt, options) => {
        options?.onOptimisticPublish?.();
        flushSolid();
        expect(container.querySelector('.followup-suggestions')).toBeNull();
        setWorking(true);
        await Promise.resolve();
        setWorking(false);
        if (failure === 'error') throw new Error('Unavailable');
        return false;
      });
      container.querySelector<HTMLButtonElement>('.followup-suggestions-actions button')!.click();
      flushSolid();
      await flush();
      flushSolid();
      expect(container.querySelector('.followup-suggestions')).not.toBeNull();
      expect(container.querySelectorAll('button:disabled')).toHaveLength(0);
      expect(document.querySelector('[role="alert"]')?.textContent).toContain('Could not send');
      expect(client.varro.dismissFollowups).not.toHaveBeenCalled();
      container.querySelector<HTMLButtonElement>('.followup-suggestions-actions button')!.click();
      flushSolid();
      await flush();
      flushSolid();
      expect(mocks.send).toHaveBeenCalledTimes(2);
      expect(container.querySelector('.followup-suggestions')).toBeNull();
      expect(client.varro.dismissFollowups).toHaveBeenCalledTimes(1);
    }
  );

  it.each(['busy', 'model', 'session', 'blocked', 'text', 'disabled'])(
    'invalidates suggestions on %s changes without sending or regenerating',
    async (change) => {
      const { setWorking, setBlocked } = mount();
      flushSolid();
      setWorking(false);
      flushSolid();
      await flush();
      flushSolid();
      if (change === 'busy') setWorking(true);
      flushSolid();
      if (change === 'model') setState(storePath('followupModel', 'test/other'));
      flushSolid();
      if (change === 'session') setState(storePath('activeSessionId', 'session-2'));
      flushSolid();
      if (change === 'blocked') setBlocked(true);
      flushSolid();
      if (change === 'text')
        setState(storePath('messages', 1, 'parts', [textPart('a', 'Already fixed.')]));
      flushSolid();
      if (change === 'disabled') setState(storePath('followupsEnabled', false));
      flushSolid();
      await flush();
      flushSolid();
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
      flushSolid();
      setWorking(false);
      flushSolid();
      await flush();
      flushSolid();
      vi.mocked(client.varro.followups).mockResolvedValue(suggestions);
      container.querySelector<HTMLButtonElement>('.followup-suggestions-actions button')!.click();
      flushSolid();
      await flush();
      flushSolid();
      setState(storePath('activeSessionId', 'session-2'));
      flushSolid();
      finish(accepted);
      await flush();
      flushSolid();
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
    flushSolid();
    setWorking(false);
    flushSolid();
    setState(storePath('activeSessionId', 'session-2'));
    flushSolid();
    finish(suggestions);
    await flush();
    flushSolid();
    expect(container.querySelector('.followup-suggestions')).toBeNull();
    setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    setWorking(true);
    flushSolid();
    setWorking(false);
    flushSolid();
    await flush();
    flushSolid();
    expect(client.varro.followups).toHaveBeenCalledTimes(2);
    expect(vi.mocked(client.varro.followups).mock.calls[1]?.[2].allowGenerate).toBe(false);
  });
});
