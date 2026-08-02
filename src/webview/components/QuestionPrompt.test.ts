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

function multiQuestionRequest(): QuestionRequest {
  return {
    id: 'question-multi',
    sessionID: 'session-1',
    questions: [
      {
        question: 'Which languages?',
        header: 'Languages',
        multiple: true,
        options: [
          { label: 'TypeScript', description: '' },
          { label: 'Rust', description: '' },
          { label: 'Go', description: '' },
        ],
      },
      {
        question: 'Which runtime?',
        header: 'Runtime',
        options: [
          { label: 'Node', description: '' },
          { label: 'Bun', description: '' },
        ],
      },
    ],
  };
}

function options() {
  return Array.from(
    container!.querySelectorAll<HTMLElement>('.question-option:not(.question-option-custom)')
  );
}

function optionByLabel(label: string) {
  const match = options().find(
    (option) => option.querySelector('.question-option-label')?.textContent === label
  );
  if (!match) throw new Error(`No option labelled ${label}`);
  return match;
}

function customOption() {
  return container!.querySelector<HTMLElement>('.question-option-custom')!;
}

function customInput() {
  return container!.querySelector<HTMLInputElement>('.question-custom-input')!;
}

function primaryButton() {
  return container!.querySelector<HTMLButtonElement>('.question-btn-primary')!;
}

function backButton() {
  return container!.querySelector<HTMLButtonElement>('.question-btn-secondary');
}

function stepIndicator() {
  return container!.querySelector('.question-prompt-step')?.textContent;
}

function click(element: HTMLElement) {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

function type(input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function pressKey(element: HTMLElement, key: string) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  element.dispatchEvent(event);
  return event;
}

describe('QuestionPrompt single-select', () => {
  it('disables the primary action until an option is chosen', () => {
    renderQuestionPrompt(request());

    expect(primaryButton().disabled).toBe(true);

    click(optionByLabel('Option A'));

    expect(primaryButton().disabled).toBe(false);
  });

  it('submits the chosen option', async () => {
    renderQuestionPrompt(request());

    click(optionByLabel('Option A'));
    click(primaryButton());
    await Promise.resolve();

    expect(respondQuestionMock).toHaveBeenCalledWith('question-1', [['Option A']], {
      rethrow: true,
    });
  });

  it('deselects an option when it is clicked twice', () => {
    renderQuestionPrompt(request());

    click(optionByLabel('Option A'));
    click(optionByLabel('Option A'));

    expect(optionByLabel('Option A').getAttribute('aria-checked')).toBe('false');
    expect(primaryButton().disabled).toBe(true);
  });

  it('toggles an option with the keyboard', () => {
    renderQuestionPrompt(request());

    const event = pressKey(optionByLabel('Option A'), 'Enter');

    expect(event.defaultPrevented).toBe(true);
    expect(optionByLabel('Option A').getAttribute('aria-checked')).toBe('true');
  });

  it('ignores keys other than Enter and Space on an option', () => {
    renderQuestionPrompt(request());

    pressKey(optionByLabel('Option A'), 'Tab');

    expect(optionByLabel('Option A').getAttribute('aria-checked')).toBe('false');
  });

  it('renders options as radios when only one answer is allowed', () => {
    renderQuestionPrompt(request());

    expect(optionByLabel('Option A').getAttribute('role')).toBe('radio');
    expect(container!.querySelector('.question-prompt-options')?.getAttribute('role')).toBe(
      'radiogroup'
    );
  });
});

describe('QuestionPrompt custom answers', () => {
  it('submits a typed answer in place of the listed options', async () => {
    renderQuestionPrompt(request());

    type(customInput(), 'Something else');
    click(primaryButton());
    await Promise.resolve();

    expect(respondQuestionMock).toHaveBeenCalledWith('question-1', [['Something else']], {
      rethrow: true,
    });
  });

  it('clears a typed answer when a listed option is picked instead', () => {
    renderQuestionPrompt(request());

    type(customInput(), 'Something else');
    click(optionByLabel('Option A'));

    expect(customInput().value).toBe('');
  });

  it('clears the selected option when a custom answer is typed', () => {
    renderQuestionPrompt(request());

    click(optionByLabel('Option A'));
    type(customInput(), 'Something else');

    expect(optionByLabel('Option A').getAttribute('aria-checked')).toBe('false');
  });

  it('ignores a whitespace-only custom answer', () => {
    renderQuestionPrompt(request());

    type(customInput(), '   ');

    expect(primaryButton().disabled).toBe(true);
  });

  it('marks the custom row as checked once it holds text', () => {
    renderQuestionPrompt(request());

    expect(customOption().getAttribute('aria-checked')).toBe('false');

    type(customInput(), 'Something else');

    expect(customOption().getAttribute('aria-checked')).toBe('true');
  });

  it('submits from the custom input with Enter', async () => {
    renderQuestionPrompt(request());

    type(customInput(), 'Something else');
    const event = pressKey(customInput(), 'Enter');
    await Promise.resolve();

    expect(event.defaultPrevented).toBe(true);
    expect(respondQuestionMock).toHaveBeenCalledOnce();
  });

  it('hides the custom row when the question opts out', () => {
    renderQuestionPrompt({
      id: 'question-no-custom',
      sessionID: 'session-1',
      questions: [
        {
          question: 'Pick one',
          header: 'Choice',
          custom: false,
          options: [{ label: 'Only', description: '' }],
        },
      ],
    });

    expect(container!.querySelector('.question-option-custom')).toBeNull();
  });
});

describe('QuestionPrompt multi-step flow', () => {
  it('shows a step indicator and advances instead of submitting', () => {
    renderQuestionPrompt(multiQuestionRequest());

    expect(stepIndicator()).toBe('1 / 2');
    expect(primaryButton().textContent).toBe('Next');

    click(optionByLabel('TypeScript'));
    click(primaryButton());

    expect(stepIndicator()).toBe('2 / 2');
    expect(primaryButton().textContent).toBe('Submit');
    expect(respondQuestionMock).not.toHaveBeenCalled();
  });

  it('accumulates several picks on a multi-select question', () => {
    renderQuestionPrompt(multiQuestionRequest());

    click(optionByLabel('TypeScript'));
    click(optionByLabel('Rust'));

    expect(optionByLabel('TypeScript').getAttribute('aria-checked')).toBe('true');
    expect(optionByLabel('Rust').getAttribute('aria-checked')).toBe('true');
    expect(optionByLabel('Go').getAttribute('aria-checked')).toBe('false');
  });

  it('renders multi-select options as checkboxes in a group', () => {
    renderQuestionPrompt(multiQuestionRequest());

    expect(optionByLabel('TypeScript').getAttribute('role')).toBe('checkbox');
    expect(container!.querySelector('.question-prompt-options')?.getAttribute('role')).toBe(
      'group'
    );
  });

  it('keeps a custom answer alongside listed picks when multiple are allowed', async () => {
    renderQuestionPrompt(multiQuestionRequest());

    click(optionByLabel('TypeScript'));
    type(customInput(), 'Zig');
    click(primaryButton());
    click(optionByLabel('Node'));
    click(primaryButton());
    await Promise.resolve();

    expect(respondQuestionMock).toHaveBeenCalledWith(
      'question-multi',
      [['TypeScript', 'Zig'], ['Node']],
      { rethrow: true }
    );
  });

  it('offers Back only after the first step and restores the earlier answer', () => {
    renderQuestionPrompt(multiQuestionRequest());

    expect(backButton()).toBeNull();

    click(optionByLabel('TypeScript'));
    click(primaryButton());
    expect(backButton()).not.toBeNull();

    click(backButton()!);

    expect(stepIndicator()).toBe('1 / 2');
    expect(optionByLabel('TypeScript').getAttribute('aria-checked')).toBe('true');
  });

  it('does not advance while the current step has no answer', () => {
    renderQuestionPrompt(multiQuestionRequest());

    expect(primaryButton().disabled).toBe(true);
    click(primaryButton());

    expect(stepIndicator()).toBe('1 / 2');
  });

  it('omits the step indicator for a single question', () => {
    renderQuestionPrompt(request());

    expect(container!.querySelector('.question-prompt-step')).toBeNull();
  });
});
