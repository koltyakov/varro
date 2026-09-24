import { describe, expect, it } from 'vitest';
import { sessionSummary } from './session-summary';

describe('paused session duration', () => {
  const metadata = { varro: { pauses: [{ messageId: 'paused', pausedAt: 11_000 }] } };
  const prompt = { info: { id: 'prompt', role: 'user', time: { created: 1_000 } }, parts: [] };
  const paused = { info: { id: 'paused', role: 'assistant', time: { created: 2_000 } }, parts: [] };

  it('retains work before a pause and closes the live duration in local and remote summaries', async () => {
    const messages = [prompt, paused];
    expect(sessionSummary.fromLocal({ messages, descendants: [] }, metadata)).toMatchObject({
      durationMs: 10_000,
      activeStartedAt: null,
    });
    expect(
      await sessionSummary.fromRemote([], messages, [], async () => [], metadata)
    ).toMatchObject({
      durationMs: 10_000,
      activeStartedAt: null,
    });
    expect(paused.info.time).toEqual({ created: 2_000 });
  });

  it.each([true, false])(
    'excludes an hour paused before resuming with a new prompt: %s',
    async (newPrompt) => {
      const messages = [
        prompt,
        paused,
        ...(newPrompt
          ? [{ info: { id: 'resume', role: 'user', time: { created: 3_611_000 } }, parts: [] }]
          : []),
        {
          info: {
            id: 'answer',
            role: 'assistant',
            time: { created: 3_611_000, completed: 3_616_000 },
          },
          parts: [],
        },
      ];
      expect(
        await sessionSummary.fromRemote([], messages, [], async () => [], metadata)
      ).toMatchObject({
        durationMs: 15_000,
        activeStartedAt: null,
      });
    }
  );

  it('starts the resumed live timer at the new work period and clamps late completions', () => {
    const messages = [
      prompt,
      { ...paused, info: { ...paused.info, time: { created: 2_000, completed: 3_600_000 } } },
      { info: { id: 'resume', role: 'user', time: { created: 3_611_000 } }, parts: [] },
      { info: { id: 'answer', role: 'assistant', time: { created: 3_612_000 } }, parts: [] },
    ];
    expect(sessionSummary.fromLocal({ messages, descendants: [] }, metadata)).toMatchObject({
      durationMs: 10_000,
      activeStartedAt: 3_611_000,
    });
  });
});
