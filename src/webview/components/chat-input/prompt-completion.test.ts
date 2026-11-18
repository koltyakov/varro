import { flush as flushSolid, createRoot, createSignal } from 'solid-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PromptCompletion } from './prompt-completion';
import type { PromptCompletionRequest } from '../../../shared/prompt-completion';

let dispose: (() => void) | undefined;
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  dispose?.();
  flushSolid();
  vi.useRealTimers();
});

function setup() {
  return createRoot((cleanup) => {
    dispose = cleanup;
    const [draft, setDraft] = createSignal('Add a test');
    const [model, setModel] = createSignal('openai/fast');
    const [eligible, setEligible] = createSignal(true);
    const [scope, setScope] = createSignal('session-1');
    const [lastAssistantResponse, setLastAssistantResponse] = createSignal<string | undefined>();
    const request = vi.fn<
      (input: PromptCompletionRequest, signal: AbortSignal) => Promise<{ suffix: string }>
    >(async () => ({ suffix: ' for the new feature' }));
    const completion = new PromptCompletion({
      draft,
      model,
      eligible,
      scope,
      request,
      history: () => ['Previous prompt'],
      lastAssistantResponse,
    });
    return {
      suggestion: completion.suggestion,
      error: completion.error,
      pending: completion.pending,
      dismiss: () => completion.dismiss(),
      setDraft,
      setModel,
      setEligible,
      setScope,
      setLastAssistantResponse,
      request,
    };
  });
}

describe('inline prompt completion scheduling', () => {
  it('snapshots the latest reply after the pause without rescheduling when it streams', async () => {
    const test = setup();
    flushSolid();
    test.setLastAssistantResponse('An earlier partial reply');
    flushSolid();
    await vi.advanceTimersByTimeAsync(400);
    flushSolid();
    test.setLastAssistantResponse('The final reply asks which option to implement');
    flushSolid();
    await vi.advanceTimersByTimeAsync(200);
    flushSolid();
    expect(test.request).toHaveBeenCalledWith(
      {
        draft: 'Add a test',
        history: ['Previous prompt'],
        lastAssistantResponse: 'The final reply asks which option to implement',
      },
      expect.any(AbortSignal)
    );
    test.setLastAssistantResponse('More streamed reply text');
    flushSolid();
    await vi.advanceTimersByTimeAsync(1_000);
    flushSolid();
    expect(test.request).toHaveBeenCalledOnce();
  });

  it('bounds the latest reply while keeping its concluding question', async () => {
    const test = setup();
    flushSolid();
    const reply = `${'Earlier details '.repeat(1_000)}Which option should I implement?`;
    test.setLastAssistantResponse(reply);
    flushSolid();
    await vi.advanceTimersByTimeAsync(600);
    flushSolid();
    expect(test.request.mock.calls[0]![0].lastAssistantResponse).toBe(reply.slice(-6_000));
  });

  it('omits blank or missing replies', async () => {
    const test = setup();
    flushSolid();
    test.setLastAssistantResponse('  \n ');
    flushSolid();
    await vi.advanceTimersByTimeAsync(600);
    flushSolid();
    expect(test.request.mock.calls[0]![0]).not.toHaveProperty('lastAssistantResponse');
  });

  it.each(['suggestion', 'empty', 'error'] as const)(
    'reports pending only during generation and clears it after %s',
    async (result) => {
      const test = setup();
      flushSolid();
      let resolve!: (result: { suffix: string }) => void;
      let reject!: (error: Error) => void;
      test.request.mockImplementationOnce(
        () =>
          new Promise((done, fail) => {
            resolve = done;
            reject = fail;
          })
      );
      expect(test.pending()).toBe(false);
      await vi.advanceTimersByTimeAsync(599);
      flushSolid();
      expect(test.pending()).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      flushSolid();
      expect(test.pending()).toBe(true);
      if (result === 'error') reject(new Error('Unavailable'));
      else resolve({ suffix: result === 'empty' ? '' : ' for the feature' });
      flushSolid();
      await Promise.resolve();
      flushSolid();
      expect(test.pending()).toBe(false);
    }
  );

  it('does not let an old response clear a newer pending request', async () => {
    const test = setup();
    flushSolid();
    let resolveOld!: (result: { suffix: string }) => void;
    let resolveNew!: (result: { suffix: string }) => void;
    test.request.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolveOld = done;
        })
    );
    test.request.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolveNew = done;
        })
    );
    await vi.advanceTimersByTimeAsync(600);
    flushSolid();
    expect(test.pending()).toBe(true);
    test.setDraft('Add a different test');
    flushSolid();
    expect(test.pending()).toBe(false);
    await vi.advanceTimersByTimeAsync(600);
    flushSolid();
    expect(test.pending()).toBe(true);
    resolveOld({ suffix: ' old response' });
    flushSolid();
    await Promise.resolve();
    flushSolid();
    expect(test.pending()).toBe(true);
    resolveNew({ suffix: ' new response' });
    flushSolid();
    await Promise.resolve();
    flushSolid();
    expect(test.pending()).toBe(false);
  });

  it.each(['draft', 'model', 'scope', 'eligible', 'dispose', 'dismiss'] as const)(
    'clears pending when cancelled by %s',
    async (change) => {
      const test = setup();
      flushSolid();
      test.request.mockImplementationOnce(() => new Promise(() => {}));
      await vi.advanceTimersByTimeAsync(600);
      flushSolid();
      expect(test.pending()).toBe(true);
      if (change === 'draft') test.setDraft('Add a test.');
      flushSolid();
      if (change === 'model') test.setModel('');
      flushSolid();
      if (change === 'scope') test.setScope('other-session');
      flushSolid();
      if (change === 'eligible') test.setEligible(false);
      flushSolid();
      if (change === 'dispose') dispose?.();
      flushSolid();
      if (change === 'dismiss') test.dismiss();
      flushSolid();
      expect(test.pending()).toBe(false);
    }
  );
  it('restarts the full debounce with every keystroke and cancels in-flight generation on resumed typing', async () => {
    const test = setup();
    flushSolid();
    for (const draft of ['Add a t', 'Add a te', 'Add a tes', 'Add a test case']) {
      await vi.advanceTimersByTimeAsync(400);
      flushSolid();
      test.setDraft(draft);
      flushSolid();
      expect(test.request).not.toHaveBeenCalled();
    }
    let resolve!: (result: { suffix: string }) => void;
    test.request.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    await vi.advanceTimersByTimeAsync(599);
    flushSolid();
    expect(test.request).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    flushSolid();
    expect(test.request).toHaveBeenCalledOnce();
    const signal = test.request.mock.calls[0]?.[1];
    test.setDraft('Add a test case for');
    flushSolid();
    expect(signal?.aborted).toBe(true);
    resolve({ suffix: ' obsolete completion' });
    flushSolid();
    await vi.advanceTimersByTimeAsync(599);
    flushSolid();
    expect(test.suggestion()).toBe('');
    expect(test.request).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    flushSolid();
    expect(test.request).toHaveBeenCalledTimes(2);
    expect(test.request.mock.calls[1]?.[0].draft).toBe('Add a test case for');
  });
  it('debounces typing and sends only bounded history after the pause', async () => {
    const test = setup();
    flushSolid();
    test.setDraft('Add a test case');
    flushSolid();
    await vi.advanceTimersByTimeAsync(599);
    flushSolid();
    expect(test.request).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    flushSolid();
    expect(test.request).toHaveBeenCalledOnce();
    expect(test.request).toHaveBeenCalledWith(
      { draft: 'Add a test case', history: ['Previous prompt'] },
      expect.any(AbortSignal)
    );
    expect(test.suggestion()).toBe(' for the new feature');
  });

  it('makes no requests when disabled, ineligible, short, oversized, or a slash command', async () => {
    const test = setup();
    flushSolid();
    test.setModel('');
    flushSolid();
    await vi.advanceTimersByTimeAsync(1_000);
    flushSolid();
    test.setModel('openai/fast');
    flushSolid();
    test.setEligible(false);
    flushSolid();
    await vi.advanceTimersByTimeAsync(1_000);
    flushSolid();
    test.setEligible(true);
    flushSolid();
    for (const draft of ['ab', 'x'.repeat(4_001), '/help']) {
      test.setDraft(draft);
      flushSolid();
      await vi.advanceTimersByTimeAsync(1_000);
      flushSolid();
    }
    expect(test.request).not.toHaveBeenCalled();
  });

  it('aborts stale requests and ignores late responses after session changes', async () => {
    const test = setup();
    flushSolid();
    let resolve!: (result: { suffix: string }) => void;
    test.request.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    await vi.advanceTimersByTimeAsync(600);
    flushSolid();
    const signal = test.request.mock.calls[0]?.[1];
    test.setScope('session-2');
    flushSolid();
    expect(signal?.aborted).toBe(true);
    resolve({ suffix: ' stale suggestion' });
    flushSolid();
    await Promise.resolve();
    flushSolid();
    expect(test.suggestion()).toBe('');
    await vi.advanceTimersByTimeAsync(600);
    flushSolid();
    expect(test.suggestion()).toBe(' for the new feature');
    test.setEligible(false);
    flushSolid();
    expect(test.suggestion()).toBe('');
  });

  it.each(['Add a test.', 'Add a test. ', 'Add a test.\n', 'Add a test...'])(
    'does not request suggestions for a draft ending with a period: %j',
    async (draft) => {
      const test = setup();
      flushSolid();
      test.setDraft(draft);
      flushSolid();
      await vi.advanceTimersByTimeAsync(1_000);
      flushSolid();
      expect(test.request).not.toHaveBeenCalled();
      expect(test.suggestion()).toBe('');
      test.setDraft('Add a test. Then');
      flushSolid();
      await vi.advanceTimersByTimeAsync(600);
      flushSolid();
      expect(test.request).toHaveBeenCalledOnce();
    }
  );

  it('cancels pending suggestions when a period finishes the draft and ignores late responses', async () => {
    const test = setup();
    flushSolid();
    let resolve!: (result: { suffix: string }) => void;
    test.request.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    await vi.advanceTimersByTimeAsync(600);
    flushSolid();
    const signal = test.request.mock.calls[0]![1];
    test.setDraft('Add a test.');
    flushSolid();
    expect(signal.aborted).toBe(true);
    resolve({ suffix: ' obsolete suggestion' });
    flushSolid();
    await vi.advanceTimersByTimeAsync(1_000);
    flushSolid();
    expect(test.suggestion()).toBe('');
    expect(test.request).toHaveBeenCalledOnce();
    test.setDraft('Add a test');
    flushSolid();
    await vi.advanceTimersByTimeAsync(600);
    flushSolid();
    expect(test.request).toHaveBeenCalledTimes(2);
  });

  it('does not redisplay dismissed suggestions until the draft changes', async () => {
    const test = setup();
    flushSolid();
    await vi.advanceTimersByTimeAsync(600);
    flushSolid();
    test.dismiss();
    test.setEligible(false);
    flushSolid();
    test.setEligible(true);
    flushSolid();
    await vi.advanceTimersByTimeAsync(1_000);
    flushSolid();
    expect(test.suggestion()).toBe('');
    expect(test.request).toHaveBeenCalledOnce();
    test.setDraft('Add another test');
    flushSolid();
    await vi.advanceTimersByTimeAsync(600);
    flushSolid();
    expect(test.request).toHaveBeenCalledTimes(2);
  });

  it('reports current generation errors without an in-flight indicator or suggestion', async () => {
    const test = setup();
    flushSolid();
    expect(test.error()).toBe('');
    test.request.mockRejectedValueOnce(new Error('Unavailable'));
    await vi.advanceTimersByTimeAsync(600);
    flushSolid();
    expect(test.suggestion()).toBe('');
    expect(test.error()).toBe('Unavailable');
    test.setEligible(false);
    flushSolid();
    expect(test.error()).toBe('Unavailable');
    test.setEligible(true);
    flushSolid();
    await vi.advanceTimersByTimeAsync(599);
    flushSolid();
    expect(test.error()).toBe('Unavailable');
    await vi.advanceTimersByTimeAsync(1);
    flushSolid();
    expect(test.error()).toBe('');
  });

  it.each([' for the next feature', ''])(
    'retains failures through typing, dismissal and pending retries until a current request succeeds: %j',
    async (suffix) => {
      const test = setup();
      flushSolid();
      test.request.mockRejectedValueOnce(new Error('Unavailable'));
      await vi.advanceTimersByTimeAsync(600);
      flushSolid();
      test.setDraft('Add a test.');
      flushSolid();
      await vi.advanceTimersByTimeAsync(1_000);
      flushSolid();
      expect(test.error()).toBe('Unavailable');
      test.dismiss();
      expect(test.error()).toBe('Unavailable');
      test.setDraft('Add a test. Then');
      flushSolid();
      let resolve!: (result: { suffix: string }) => void;
      test.request.mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done;
          })
      );
      await vi.advanceTimersByTimeAsync(600);
      flushSolid();
      expect(test.error()).toBe('Unavailable');
      resolve({ suffix });
      flushSolid();
      await Promise.resolve();
      flushSolid();
      expect(test.error()).toBe('');
      expect(test.suggestion()).toBe(suffix);
    }
  );

  it('does not clear failures for cancelled or stale successful retries', async () => {
    const test = setup();
    flushSolid();
    test.request.mockRejectedValueOnce(new Error('Unavailable'));
    await vi.advanceTimersByTimeAsync(600);
    flushSolid();
    let resolve!: (result: { suffix: string }) => void;
    test.request.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    test.setDraft('Add another test');
    flushSolid();
    await vi.advanceTimersByTimeAsync(600);
    flushSolid();
    expect(test.error()).toBe('Unavailable');
    test.setDraft('Add another test.');
    flushSolid();
    resolve({ suffix: ' stale suggestion' });
    flushSolid();
    await vi.advanceTimersByTimeAsync(1_000);
    flushSolid();
    expect(test.error()).toBe('Unavailable');
    expect(test.suggestion()).toBe('');
    expect(test.request).toHaveBeenCalledTimes(2);
  });

  it('retains and updates the warning when a retry also fails', async () => {
    const test = setup();
    flushSolid();
    test.request.mockRejectedValueOnce(new Error('Unavailable'));
    await vi.advanceTimersByTimeAsync(600);
    flushSolid();
    test.request.mockRejectedValueOnce(new Error('Still unavailable'));
    test.setDraft('Add another test');
    flushSolid();
    await vi.advanceTimersByTimeAsync(599);
    flushSolid();
    expect(test.error()).toBe('Unavailable');
    await vi.advanceTimersByTimeAsync(1);
    flushSolid();
    expect(test.error()).toBe('Still unavailable');
  });

  it.each(['', ' \n'])(
    'clears completion feedback when the draft is emptied, cancels pending retries and rejects late failures: %j',
    async (draft) => {
      const test = setup();
      flushSolid();
      test.request.mockRejectedValueOnce(new Error('Unavailable'));
      await vi.advanceTimersByTimeAsync(600);
      flushSolid();
      expect(test.error()).toBe('Unavailable');
      let reject!: (error: Error) => void;
      test.request.mockImplementationOnce(
        () =>
          new Promise((_resolve, fail) => {
            reject = fail;
          })
      );
      test.setDraft('Add another test');
      flushSolid();
      await vi.advanceTimersByTimeAsync(600);
      flushSolid();
      const signal = test.request.mock.calls[1]![1];
      test.setDraft(draft);
      flushSolid();
      expect(test.error()).toBe('');
      expect(test.suggestion()).toBe('');
      expect(signal.aborted).toBe(true);
      reject(new Error('Late failure'));
      flushSolid();
      await vi.advanceTimersByTimeAsync(1_000);
      flushSolid();
      expect(test.error()).toBe('');
      expect(test.request).toHaveBeenCalledTimes(2);
      test.setDraft('A new prompt');
      flushSolid();
      test.request.mockRejectedValueOnce(new Error('New failure'));
      await vi.advanceTimersByTimeAsync(600);
      flushSolid();
      expect(test.error()).toBe('New failure');
    }
  );

  it.each(['draft', 'model', 'scope', 'eligible', 'dispose'] as const)(
    'ignores late errors after %s changes or cancellation',
    async (change) => {
      const test = setup();
      flushSolid();
      let reject!: (error: Error) => void;
      test.request.mockImplementationOnce(
        () =>
          new Promise((_resolve, fail) => {
            reject = fail;
          })
      );
      await vi.advanceTimersByTimeAsync(600);
      flushSolid();
      expect(test.error()).toBe('');
      if (change === 'draft') test.setDraft('A different draft');
      flushSolid();
      if (change === 'model') test.setModel('openai/other');
      flushSolid();
      if (change === 'scope') test.setScope('other-session');
      flushSolid();
      if (change === 'eligible') test.setEligible(false);
      flushSolid();
      if (change === 'dispose') dispose?.();
      flushSolid();
      reject(new Error('Stale failure'));
      flushSolid();
      await Promise.resolve();
      flushSolid();
      expect(test.error()).toBe('');
    }
  );

  it.each(['model', 'scope', 'disabled'] as const)(
    'clears failures on %s changes',
    async (change) => {
      const test = setup();
      flushSolid();
      test.request.mockRejectedValueOnce(new Error('Unavailable'));
      await vi.advanceTimersByTimeAsync(600);
      flushSolid();
      expect(test.error()).toBe('Unavailable');
      if (change === 'model') test.setModel('openai/other');
      flushSolid();
      if (change === 'scope') test.setScope('other-session');
      flushSolid();
      if (change === 'disabled') test.setModel('');
      flushSolid();
      expect(test.error()).toBe('');
    }
  );

  it('does not report intentionally empty suggestions as failures', async () => {
    const test = setup();
    flushSolid();
    test.request.mockResolvedValueOnce({ suffix: '' });
    await vi.advanceTimersByTimeAsync(600);
    flushSolid();
    expect(test.error()).toBe('');
    expect(test.suggestion()).toBe('');
  });

  it('clears suggestions on model changes and cancels on disposal', async () => {
    const test = setup();
    flushSolid();
    await vi.advanceTimersByTimeAsync(600);
    flushSolid();
    test.setModel('openai/another');
    flushSolid();
    expect(test.suggestion()).toBe('');
    await vi.advanceTimersByTimeAsync(600);
    flushSolid();
    const signal = test.request.mock.calls.at(-1)?.[1];
    dispose?.();
    flushSolid();
    expect(signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    flushSolid();
    expect(test.request).toHaveBeenCalledTimes(2);
  });
});
