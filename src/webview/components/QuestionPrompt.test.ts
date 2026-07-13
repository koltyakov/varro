import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createComponent, render } from 'solid-js/web';
import type * as UseOpenCodeModule from '../hooks/useOpenCode';
import { setState } from '../lib/state';
import type { QuestionRequest } from '../types';
import { QuestionPrompt } from './QuestionPrompt';

const { rejectQuestionMock, respondQuestionMock } = vi.hoisted(() => ({
  rejectQuestionMock: vi.fn(async () => {}),
  respondQuestionMock: vi.fn(async () => {}),
}));

vi.mock('../hooks/useOpenCode', async () => {
  const actual = await vi.importActual<typeof UseOpenCodeModule>('../hooks/useOpenCode');
  return {
    ...actual,
    rejectQuestion: rejectQuestionMock,
    respondQuestion: respondQuestionMock,
  };
});

let container: HTMLDivElement | null = null;
let cleanup: (() => void) | undefined;

function request(id = 'question-1'): QuestionRequest {
  return {
    id,
    sessionID: 'session-1',
    questions: [
      {
        question: 'How should this proceed?',
        header: 'Follow-up',
        options: [{ label: 'Option A', description: 'Use the default path' }],
      },
    ],
  };
}

function renderQuestionPrompt(activeRequest: QuestionRequest) {
  cleanup = render(() => createComponent(QuestionPrompt, { request: activeRequest }), container!);
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  setState('questions', []);
  rejectQuestionMock.mockReset();
  rejectQuestionMock.mockResolvedValue(undefined);
  respondQuestionMock.mockReset();
  respondQuestionMock.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  container?.remove();
  container = null;
  setState('questions', []);
});

describe('QuestionPrompt draft retention', () => {
  it('keeps drafts while the question is still active', async () => {
    const activeRequest = request();
    setState('questions', [activeRequest]);

    renderQuestionPrompt(activeRequest);

    const input = container?.querySelector<HTMLInputElement>('.question-custom-input');
    expect(input).not.toBeNull();

    input!.value = 'Keep this draft';
    input!.dispatchEvent(new Event('input', { bubbles: true }));

    cleanup?.();
    cleanup = undefined;
    await Promise.resolve();

    renderQuestionPrompt(activeRequest);

    expect(container?.querySelector<HTMLInputElement>('.question-custom-input')?.value).toBe(
      'Keep this draft'
    );
  });

  it('drops drafts once the question is no longer present', async () => {
    const activeRequest = request();
    setState('questions', [activeRequest]);

    renderQuestionPrompt(activeRequest);

    const input = container?.querySelector<HTMLInputElement>('.question-custom-input');
    expect(input).not.toBeNull();

    input!.value = 'Discard this draft';
    input!.dispatchEvent(new Event('input', { bubbles: true }));

    setState('questions', []);
    cleanup?.();
    cleanup = undefined;
    await Promise.resolve();

    renderQuestionPrompt(activeRequest);

    expect(container?.querySelector<HTMLInputElement>('.question-custom-input')?.value).toBe('');
  });

  it('keeps the answer draft and restores controls when answering fails', async () => {
    const activeRequest = request('failed-answer');
    setState('questions', [activeRequest]);
    respondQuestionMock.mockRejectedValueOnce(new Error('answer failed'));
    renderQuestionPrompt(activeRequest);

    const input = container?.querySelector<HTMLInputElement>('.question-custom-input');
    input!.value = 'Retry this answer';
    input!.dispatchEvent(new Event('input', { bubbles: true }));
    container
      ?.querySelector<HTMLButtonElement>('.question-btn-primary')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();

    expect(respondQuestionMock).toHaveBeenCalledWith(activeRequest.id, [['Retry this answer']], {
      rethrow: true,
    });
    expect(input?.value).toBe('Retry this answer');
    expect(container?.querySelector<HTMLButtonElement>('.question-btn-primary')?.disabled).toBe(
      false
    );
    expect(container?.querySelector<HTMLButtonElement>('.question-btn-tertiary')?.disabled).toBe(
      false
    );

    cleanup?.();
    cleanup = undefined;
    await Promise.resolve();
    renderQuestionPrompt(activeRequest);
    expect(container?.querySelector<HTMLInputElement>('.question-custom-input')?.value).toBe(
      'Retry this answer'
    );
  });

  it('keeps the draft and restores controls when skipping fails', async () => {
    const activeRequest = request('failed-skip');
    setState('questions', [activeRequest]);
    rejectQuestionMock.mockRejectedValueOnce(new Error('skip failed'));
    renderQuestionPrompt(activeRequest);

    const input = container?.querySelector<HTMLInputElement>('.question-custom-input');
    input!.value = 'Do not discard this';
    input!.dispatchEvent(new Event('input', { bubbles: true }));
    container
      ?.querySelector<HTMLButtonElement>('.question-btn-tertiary')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();

    expect(rejectQuestionMock).toHaveBeenCalledWith(activeRequest.id, { rethrow: true });
    expect(input?.value).toBe('Do not discard this');
    expect(container?.querySelector<HTMLButtonElement>('.question-btn-primary')?.disabled).toBe(
      false
    );
    expect(container?.querySelector<HTMLButtonElement>('.question-btn-tertiary')?.disabled).toBe(
      false
    );
  });
});
