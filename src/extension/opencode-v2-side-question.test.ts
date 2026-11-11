/* oxlint-disable anti-slop/no-module-mocking -- The native adapter imports the VS Code logger. */
import type { SessionGenerateResponse } from '@opencode/client';
import { describe, expect, it, vi } from 'vitest';
import {
  MAX_SIDE_QUESTION_ANSWER_LENGTH,
  MAX_SIDE_QUESTION_LENGTH,
  MAX_SIDE_QUESTION_TURNS,
  MAX_SIDE_QUESTION_CONTEXT_LENGTH,
} from '../shared/side-question';
import { OpenCodeV2Adapter } from './opencode-v2-adapter';
import * as extensionConfig from './extension-config';
import { configurePromptTrace } from './prompt-trace';

vi.mock('./logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

type FixtureValue =
  | { text: string }
  | SessionGenerateResponse['data']
  | { ses_side: { type: string } }
  | { id: string; location: { directory: string } }
  | Array<{ id: string }>
  | null;

function fixtureWire(overrides: Record<string, FixtureValue> = {}) {
  return vi.fn<ConstructorParameters<typeof OpenCodeV2Adapter>[0]>(async (_method, path) => ({
    data:
      path in overrides
        ? overrides[path]
        : path === '/api/session/ses_side'
          ? { id: 'ses_side', location: { directory: '/repo' } }
          : path === '/api/session/active'
            ? {}
            : path.endsWith('/generate')
              ? { text: '**Because** the default was missing.' }
              : [],
  }));
}

describe('native V2 side questions', () => {
  it('adds purpose metadata while keeping the existing session-scoped generation route', async () => {
    const trace = vi.spyOn(extensionConfig, 'readPromptTrace').mockReturnValue(true);
    configurePromptTrace(extensionConfig.readPromptTrace);
    const wire = fixtureWire();
    try {
      expect(
        await new OpenCodeV2Adapter(wire).request('POST', '/session/ses_side/side-question', {
          question: 'Why?',
        })
      ).toEqual({ text: '**Because** the default was missing.' });
      expect(wire).toHaveBeenLastCalledWith(
        'POST',
        '/api/session/ses_side/generate',
        {
          prompt: expect.stringMatching(
            /^VARRO_TRACE_V1 \{"purpose":"side-question","sessionID":"ses_side","rootSessionID":"ses_side"\}\nThe user is asking/
          ),
        },
        expect.any(Object)
      );
      expect(wire.mock.calls.filter(([method]) => method !== 'GET')).toHaveLength(1);
    } finally {
      trace.mockRestore();
      configurePromptTrace(() => false);
    }
  });

  it('accepts 2.2.7 generation usage without exposing it as answer text or adding history', async () => {
    const generated: SessionGenerateResponse['data'] = {
      text: '  The default was missing.  ',
      tokens: { input: 12, output: 6, reasoning: 2, cache: { read: 10, write: 0 } },
      cost: 0.001,
    };
    const wire = fixtureWire({ '/api/session/ses_side/generate': generated });
    await expect(
      new OpenCodeV2Adapter(wire).request('POST', '/session/ses_side/side-question', {
        question: 'Why?',
      })
    ).resolves.toEqual({ text: 'The default was missing.' });
    expect(wire.mock.calls.map(([method, route]) => [method, route])).toEqual([
      ['GET', '/api/session/ses_side'],
      ['POST', '/api/session/ses_side/generate'],
    ]);
  });

  it('includes local side-conversation context in follow-ups without appending it to native history', async () => {
    const wire = fixtureWire();
    const history = [{ question: 'Choose a name', answer: 'Maple 29' }];
    await new OpenCodeV2Adapter(wire).request('POST', '/session/ses_side/side-question', {
      question: 'What name did you choose?',
      history,
    });
    expect(wire).toHaveBeenLastCalledWith(
      'POST',
      '/api/session/ses_side/generate',
      {
        prompt: expect.stringContaining(JSON.stringify(history)),
      },
      expect.anything()
    );
    expect(wire.mock.calls.filter(([method]) => method !== 'GET')).toHaveLength(1);
  });

  it.each([
    null,
    'not a thread',
    [{ question: 'Why?' }],
    [{ question: 'Why?', answer: '', model: 'other' }],
    Array.from({ length: MAX_SIDE_QUESTION_TURNS }, () => ({
      question: 'Why?',
      answer: 'Because',
    })),
  ])('rejects malformed or excessive side-conversation history', async (history) => {
    const wire = fixtureWire();
    await expect(
      new OpenCodeV2Adapter(wire).request('POST', '/session/ses_side/side-question', {
        question: 'Why?',
        history,
      })
    ).rejects.toThrow('history');
    expect(wire).not.toHaveBeenCalled();
  });

  it('bounds the total follow-up context instead of silently dropping earlier exchanges', async () => {
    const wire = fixtureWire();
    const history = Array.from({ length: 3 }, () => ({
      question: 'Why?',
      answer: 'x'.repeat(MAX_SIDE_QUESTION_CONTEXT_LENGTH / 3),
    }));
    await expect(
      new OpenCodeV2Adapter(wire).request('POST', '/session/ses_side/side-question', {
        question: 'Why?',
        history,
      })
    ).rejects.toThrow('full');
    expect(wire).not.toHaveBeenCalled();
  });
  it('uses current context without changing model, agent, instructions, history, or inbox', async () => {
    const wire = fixtureWire();
    const adapter = new OpenCodeV2Adapter(wire);
    const controller = new AbortController();
    await expect(
      adapter.request(
        'POST',
        '/session/ses_side/side-question',
        { question: ' Why did it fail? ' },
        { signal: controller.signal }
      )
    ).resolves.toEqual({ text: '**Because** the default was missing.' });
    expect(wire.mock.calls.filter(([method]) => method !== 'GET')).toEqual([
      [
        'POST',
        '/api/session/ses_side/generate',
        expect.objectContaining({
          prompt: expect.stringContaining('Do not call any tools and do not take any actions.'),
        }),
        expect.objectContaining({ signal: controller.signal }),
      ],
    ]);
    expect(wire).toHaveBeenLastCalledWith(
      'POST',
      '/api/session/ses_side/generate',
      { prompt: expect.stringContaining('\n\nWhy did it fail?') },
      expect.anything()
    );
  });

  it.each<[string, FixtureValue]>([
    ['/api/session/active', { ses_side: { type: 'running' } }],
    ['/api/session/ses_side/inbox', [{ id: 'pending' }]],
    ['/api/session/ses_side/permission', [{ id: 'permission' }]],
    ['/api/session/ses_side/form', [{ id: 'form' }]],
  ])('generates independently of active work or pending input from %s', async (path, value) => {
    const wire = fixtureWire({ [path]: value });
    await expect(
      new OpenCodeV2Adapter(wire).request('POST', '/session/ses_side/side-question', {
        question: 'Why?',
      })
    ).resolves.toEqual({ text: '**Because** the default was missing.' });
    expect(wire.mock.calls.map(([method, route]) => [method, route])).toEqual([
      ['GET', '/api/session/ses_side'],
      ['POST', '/api/session/ses_side/generate'],
    ]);
  });

  it.each([
    {},
    { question: '' },
    { question: ' ' },
    { question: 'x'.repeat(MAX_SIDE_QUESTION_LENGTH + 1) },
    { question: 'Why?', model: 'other' },
  ])('rejects invalid or extra input before any wire request', async (body) => {
    const wire = fixtureWire();
    await expect(
      new OpenCodeV2Adapter(wire).request('POST', '/session/ses_side/side-question', body)
    ).rejects.toThrow('Invalid side question');
    expect(wire).not.toHaveBeenCalled();
  });

  it('rechecks the canonical session location before using its context', async () => {
    const wire = fixtureWire({
      '/api/session/ses_side': { id: 'ses_side', location: { directory: '/foreign' } },
    });
    await expect(
      new OpenCodeV2Adapter(wire).request(
        'POST',
        '/session/ses_side/side-question?directory=%2Frepo',
        { question: 'Why?' }
      )
    ).rejects.toThrow('location changed');
    expect(wire.mock.calls.every(([method]) => method === 'GET')).toBe(true);
  });

  it('fails closed when the canonical session is unavailable', async () => {
    const wire = fixtureWire({ '/api/session/ses_side': null });
    await expect(
      new OpenCodeV2Adapter(wire).request('POST', '/session/ses_side/side-question', {
        question: 'Why?',
      })
    ).rejects.toThrow('location changed');
    expect(wire.mock.calls.every(([method]) => method === 'GET')).toBe(true);
  });

  it.each(['', '  ', 'x'.repeat(MAX_SIDE_QUESTION_ANSWER_LENGTH + 1)])(
    'rejects empty or oversized answers without a fallback prompt',
    async (text) => {
      const wire = fixtureWire({ '/api/session/ses_side/generate': { text } });
      await expect(
        new OpenCodeV2Adapter(wire).request('POST', '/session/ses_side/side-question', {
          question: 'Why?',
        })
      ).rejects.toThrow();
      expect(wire.mock.calls.filter(([method]) => method === 'POST')).toHaveLength(1);
    }
  );

  it('does not retry generation or create a helper session when the endpoint is unavailable', async () => {
    const wire = fixtureWire();
    wire.mockImplementation(async (_method, path) => {
      if (path.endsWith('/generate')) throw new Error('404 Unsupported endpoint');
      return {
        data:
          path === '/api/session/ses_side'
            ? { id: 'ses_side', location: { directory: '/repo' } }
            : path === '/api/session/active'
              ? {}
              : [],
      };
    });
    await expect(
      new OpenCodeV2Adapter(wire).request('POST', '/session/ses_side/side-question', {
        question: 'Why?',
      })
    ).rejects.toThrow('404');
    expect(wire.mock.calls.filter(([method]) => method === 'POST')).toHaveLength(1);
  });

  it('cancels only the HTTP request and never interrupts the task', async () => {
    const controller = new AbortController();
    const wire = fixtureWire();
    const adapter = new OpenCodeV2Adapter(wire);
    controller.abort(new Error('Dialog closed'));
    await expect(
      adapter.request(
        'POST',
        '/session/ses_side/side-question',
        { question: 'Why?' },
        { signal: controller.signal }
      )
    ).rejects.toThrow('Dialog closed');
    expect(wire).not.toHaveBeenCalled();
  });
});
