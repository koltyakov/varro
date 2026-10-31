/* oxlint-disable anti-slop/no-module-mocking -- Sending is isolated so these UI tests cannot execute an agent. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSignal } from 'solid-js';
import { reconcile } from 'solid-js/store';
import { render } from 'solid-js/web';
import { client } from '../../lib/client';
import { replaceMessages, setState } from '../../lib/state';
import { assistantMessage, session, textPart, userMessage } from '../MessageList.test-utils';
import { FollowupSuggestions } from './FollowupSuggestions';

const mocks = vi.hoisted(() => ({
  send: vi.fn<
    (
      prompt: string,
      options?: { onOptimisticPublish?: () => void; validateBeforeSend?: () => Promise<boolean> }
    ) => Promise<boolean>
  >(),
}));
vi.mock('../../hooks/useOpenCode', () => ({ sendMessage: mocks.send }));

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
  vi.spyOn(client.varro, 'followups').mockImplementation(async (_id, _source, options) =>
    options.allowGenerate ? suggestions : { summary: '', actions: [] }
  );
  vi.spyOn(client.varro, 'dismissFollowups').mockResolvedValue(true);
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
  vi.restoreAllMocks();
});

async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}
function mount(initialWorking = true, agent = 'build') {
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

describe('FollowupSuggestions', () => {
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
      setState('followupOpening', { sessionId: 'session-1', seenAt });
      mount(false);
      await flush();
      expect(vi.mocked(client.varro.followups).mock.calls[0]?.[2].allowGenerate).toBe(seenAt < 2);
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
    vi.mocked(client.varro.followups).mockResolvedValue(suggestions);
    mount(false);
    await flush();
    expect(container.querySelector('.followup-suggestions')).not.toBeNull();
    expect(vi.mocked(client.varro.followups).mock.calls[0]?.[2].allowGenerate).toBe(false);
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
