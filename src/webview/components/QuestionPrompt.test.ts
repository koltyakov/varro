import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createComponent, render } from 'solid-js/web';
import { setState } from '../lib/state';
import type { QuestionRequest } from '../types';
import { QuestionPrompt } from './QuestionPrompt';

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
});
