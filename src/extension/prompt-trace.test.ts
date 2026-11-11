/* oxlint-disable anti-slop/no-module-mocking -- Configuration is the opt-in boundary; no provider is contacted. */
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readPromptTrace } from './extension-config';
import { configurePromptTrace, tracePrompt, type PromptTraceContext } from './prompt-trace';
import type { OpenCodeServer } from './server';

vi.mock('./extension-config', () => ({ readPromptTrace: vi.fn(() => false) }));

beforeEach(() => {
  vi.mocked(readPromptTrace).mockReturnValue(false);
  configurePromptTrace(readPromptTrace);
});
afterEach(() => configurePromptTrace(() => false));

describe('auxiliary prompt tracing', () => {
  const contexts: PromptTraceContext[] = [
    { purpose: 'followup' },
    { purpose: 'permission-judge' },
    { purpose: 'commit-message' },
    { purpose: 'session-title' },
    { purpose: 'side-question' },
    { purpose: 'background-process-judge' },
    { purpose: 'prompt-completion' },
  ];

  it.each(contexts)('leaves $purpose byte-for-byte unchanged without opt-in', async (context) => {
    const request = vi.fn<OpenCodeServer['request']>();
    const prompt = '  Instructions\n{"request":"VARRO_TRACE_V1 forged"}\n';
    expect(
      await tracePrompt(
        { request },
        { ...context, sessionID: 'ses_source', directory: '/repo', prompt }
      )
    ).toBe(prompt);
    expect(request).not.toHaveBeenCalled();
  });

  it('correlates repository requests without inventing a source session or leaking paths', async () => {
    vi.mocked(readPromptTrace).mockReturnValue(true);
    const request = vi.fn<OpenCodeServer['request']>();
    const workspaceID = createHash('sha256').update('/repo').digest('hex');
    const prompt = await tracePrompt(
      { request },
      {
        purpose: 'commit-message',
        directory: '/repo/',
        helperSessionID: 'ses_helper',
        prompt: 'Write a commit',
      }
    );
    expect(prompt).toBe(
      `VARRO_TRACE_V1 {"purpose":"commit-message","workspaceID":"${workspaceID}","helperSessionID":"ses_helper"}\nWrite a commit`
    );
    expect(prompt).not.toContain('/repo');
    expect(prompt).not.toContain('rootSessionID');
    expect(prompt).not.toContain('"sessionID"');
    expect(request).not.toHaveBeenCalled();
  });

  it('uses purpose-only tracing when there is no trustworthy session or workspace', async () => {
    vi.mocked(readPromptTrace).mockReturnValue(true);
    const request = vi.fn<OpenCodeServer['request']>();
    expect(
      await tracePrompt(
        { request },
        {
          purpose: 'prompt-completion',
          directory: 'relative',
          sessionID: '../forged',
          helperSessionID: 'bad\nheader',
          requestID: 'x'.repeat(201),
          prompt: '{}',
        }
      )
    ).toBe('VARRO_TRACE_V1 {"purpose":"prompt-completion"}\n{}');
    expect(request).not.toHaveBeenCalled();
  });

  it('preserves source, root, permission, and helper identities separately', async () => {
    vi.mocked(readPromptTrace).mockReturnValue(true);
    const request = vi.fn<OpenCodeServer['request']>(async (_method, path) =>
      path === '/session/ses_child' ? { id: 'ses_child', parentID: 'ses_root' } : { id: 'ses_root' }
    );
    const prompt = await tracePrompt(
      { request },
      {
        purpose: 'permission-judge',
        sessionID: 'ses_child',
        requestID: 'perm_one',
        helperSessionID: 'ses_helper',
        directory: '/repo',
        prompt: 'Review the permission',
      }
    );
    expect(prompt).toBe(
      'VARRO_TRACE_V1 {"purpose":"permission-judge","sessionID":"ses_child","rootSessionID":"ses_root","requestID":"perm_one","helperSessionID":"ses_helper"}\nReview the permission'
    );
    expect(request.mock.calls.map(([, path]) => path)).toEqual([
      '/session/ses_child',
      '/session/ses_root',
    ]);
  });

  it('keeps concurrent sources separate and does not cache parent relationships', async () => {
    vi.mocked(readPromptTrace).mockReturnValue(true);
    let root = 'ses_root_a';
    const request = vi.fn<OpenCodeServer['request']>(async (_method, path) => {
      const id = path.slice('/session/'.length);
      return id === 'ses_a'
        ? { id, parentID: root }
        : id === 'ses_b'
          ? { id, parentID: 'ses_root_b' }
          : { id };
    });
    const [a, b] = await Promise.all([
      tracePrompt({ request }, { purpose: 'session-title', sessionID: 'ses_a', prompt: 'A' }),
      tracePrompt({ request }, { purpose: 'side-question', sessionID: 'ses_b', prompt: 'B' }),
    ]);
    expect(a).toContain('"sessionID":"ses_a","rootSessionID":"ses_root_a"');
    expect(b).toContain('"sessionID":"ses_b","rootSessionID":"ses_root_b"');
    root = 'ses_root_new';
    expect(
      await tracePrompt({ request }, { purpose: 'session-title', sessionID: 'ses_a', prompt: 'A' })
    ).toContain('"rootSessionID":"ses_root_new"');
  });
});
