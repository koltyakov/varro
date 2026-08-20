import { afterEach, describe, expect, it } from 'vitest';
import { trapModalFocus } from './modal-focus';

// Entry focus is deferred to a microtask so the dialog is attached before it is focused.
function flushEntryFocus() {
  return Promise.resolve();
}

function pressTab(target: HTMLElement, shiftKey = false) {
  const event = new KeyboardEvent('keydown', {
    key: 'Tab',
    shiftKey,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event;
}

function buildDialog(buttonLabels: string[]) {
  const dialog = document.createElement('div');
  dialog.setAttribute('role', 'dialog');
  for (const label of buttonLabels) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    dialog.appendChild(button);
  }
  document.body.appendChild(dialog);
  return {
    dialog,
    buttons: Array.from(dialog.querySelectorAll('button')),
  };
}

describe('trapModalFocus', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('moves focus to the first focusable control once the dialog is attached', async () => {
    const { dialog, buttons } = buildDialog(['Close', 'Next']);

    const release = trapModalFocus(dialog);
    await flushEntryFocus();

    expect(document.activeElement).toBe(buttons[0]);
    release();
  });

  it('does not focus a dialog that was torn down before it attached', async () => {
    const dialog = document.createElement('div');
    const button = document.createElement('button');
    button.type = 'button';
    dialog.appendChild(button);
    // Never appended to the document, mirroring a ref callback whose element is discarded.

    const release = trapModalFocus(dialog);
    await flushEntryFocus();

    expect(document.activeElement).toBe(document.body);
    release();
  });

  it('falls back to the dialog itself when it holds no focusable controls', async () => {
    const dialog = document.createElement('div');
    dialog.textContent = 'Nothing to focus';
    document.body.appendChild(dialog);

    const release = trapModalFocus(dialog);
    expect(dialog.getAttribute('tabindex')).toBe('-1');
    await flushEntryFocus();

    expect(document.activeElement).toBe(dialog);
    release();
  });

  it('does not overwrite an explicit tabindex on the dialog', () => {
    const dialog = document.createElement('div');
    dialog.setAttribute('tabindex', '0');
    document.body.appendChild(dialog);

    const release = trapModalFocus(dialog);

    expect(dialog.getAttribute('tabindex')).toBe('0');
    release();
  });

  it('wraps Tab from the last control back to the first', () => {
    const { dialog, buttons } = buildDialog(['Close', 'Previous', 'Next']);
    const release = trapModalFocus(dialog);

    buttons[2]!.focus();
    const event = pressTab(buttons[2]!);

    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(buttons[0]);
    release();
  });

  it('wraps Shift+Tab from the first control back to the last', () => {
    const { dialog, buttons } = buildDialog(['Close', 'Previous', 'Next']);
    const release = trapModalFocus(dialog);

    buttons[0]!.focus();
    const event = pressTab(buttons[0]!, true);

    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(buttons[2]);
    release();
  });

  it('leaves Tab alone in the middle of the control list so native order still applies', () => {
    const { dialog, buttons } = buildDialog(['Close', 'Previous', 'Next']);
    const release = trapModalFocus(dialog);

    buttons[1]!.focus();
    const event = pressTab(buttons[1]!);

    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(buttons[1]);
    release();
  });

  it('wraps Shift+Tab from the dialog container to the last control', () => {
    const { dialog, buttons } = buildDialog(['Close', 'Next']);
    const release = trapModalFocus(dialog);

    dialog.focus();
    pressTab(dialog, true);

    expect(document.activeElement).toBe(buttons[1]);
    release();
  });

  it('pins focus to the dialog when Tab is pressed and nothing inside is focusable', () => {
    const dialog = document.createElement('div');
    document.body.appendChild(dialog);
    const release = trapModalFocus(dialog);

    const event = pressTab(dialog);

    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(dialog);
    release();
  });

  it('ignores keys other than Tab', () => {
    const { dialog, buttons } = buildDialog(['Close', 'Next']);
    const release = trapModalFocus(dialog);

    buttons[1]!.focus();
    const event = new KeyboardEvent('keydown', {
      key: 'ArrowRight',
      bubbles: true,
      cancelable: true,
    });
    buttons[1]!.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(buttons[1]);
    release();
  });

  it('pulls focus back when something outside the dialog takes it', () => {
    const outside = document.createElement('button');
    outside.type = 'button';
    document.body.appendChild(outside);
    const { dialog, buttons } = buildDialog(['Close']);
    const release = trapModalFocus(dialog);

    outside.focus();
    outside.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));

    expect(document.activeElement).toBe(buttons[0]);
    release();
  });

  it('allows focus to move freely between controls inside the dialog', () => {
    const { dialog, buttons } = buildDialog(['Close', 'Next']);
    const release = trapModalFocus(dialog);

    buttons[1]!.focus();
    buttons[1]!.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));

    expect(document.activeElement).toBe(buttons[1]);
    release();
  });

  it('restores focus to the opener on release', async () => {
    const opener = document.createElement('button');
    opener.type = 'button';
    document.body.appendChild(opener);
    opener.focus();

    const { dialog } = buildDialog(['Close']);
    const release = trapModalFocus(dialog);
    await flushEntryFocus();
    expect(document.activeElement).not.toBe(opener);

    release();

    expect(document.activeElement).toBe(opener);
  });

  it('does not restore focus when the opener has been removed from the document', async () => {
    const opener = document.createElement('button');
    opener.type = 'button';
    document.body.appendChild(opener);
    opener.focus();

    const { dialog, buttons } = buildDialog(['Close']);
    const release = trapModalFocus(dialog);
    await flushEntryFocus();
    opener.remove();

    release();

    expect(document.activeElement).toBe(buttons[0]);
  });

  it('leaves focus alone on release when it already moved outside the dialog', async () => {
    const opener = document.createElement('button');
    opener.type = 'button';
    document.body.appendChild(opener);
    opener.focus();

    const { dialog } = buildDialog(['Close']);
    const release = trapModalFocus(dialog);
    await flushEntryFocus();

    // Mirror a portal teardown that detaches the dialog and parks focus elsewhere before the
    // trap is released.
    const elsewhere = document.createElement('button');
    elsewhere.type = 'button';
    document.body.appendChild(elsewhere);
    dialog.remove();
    elsewhere.focus();

    release();

    expect(document.activeElement).toBe(elsewhere);
  });

  it('lets the most recently opened dialog own focus when overlays stack', async () => {
    const outer = buildDialog(['Outer close']);
    const releaseOuter = trapModalFocus(outer.dialog);
    await flushEntryFocus();

    const inner = buildDialog(['Inner close']);
    const releaseInner = trapModalFocus(inner.dialog);
    await flushEntryFocus();

    expect(document.activeElement).toBe(inner.buttons[0]);

    // The outer backstop must stay quiet, otherwise the two traps fight over every focus event.
    inner.buttons[0]!.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(document.activeElement).toBe(inner.buttons[0]);

    releaseInner();
    releaseOuter();
  });

  it('hands enforcement back to the outer dialog when the inner one closes', async () => {
    const outer = buildDialog(['Outer close']);
    const releaseOuter = trapModalFocus(outer.dialog);
    await flushEntryFocus();

    const inner = buildDialog(['Inner close']);
    const releaseInner = trapModalFocus(inner.dialog);
    await flushEntryFocus();
    inner.dialog.remove();
    releaseInner();

    const outside = document.createElement('button');
    outside.type = 'button';
    document.body.appendChild(outside);
    outside.focus();
    outside.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));

    expect(document.activeElement).toBe(outer.buttons[0]);
    releaseOuter();
  });

  it('tolerates being released more than once', async () => {
    const { dialog, buttons } = buildDialog(['Close']);
    const release = trapModalFocus(dialog);
    await flushEntryFocus();

    release();
    release();

    const outside = document.createElement('button');
    outside.type = 'button';
    document.body.appendChild(outside);
    outside.focus();
    outside.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));

    expect(document.activeElement).toBe(outside);
    expect(buttons[0]).toBeDefined();
  });

  it('stops enforcing the trap after release', () => {
    const outside = document.createElement('button');
    outside.type = 'button';
    document.body.appendChild(outside);
    const { dialog } = buildDialog(['Close']);

    trapModalFocus(dialog)();

    outside.focus();
    outside.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));

    expect(document.activeElement).toBe(outside);
  });

  it('skips disabled and aria-hidden controls when choosing focus targets', async () => {
    const dialog = document.createElement('div');
    dialog.innerHTML = `
      <button type="button" disabled>Disabled</button>
      <button type="button" aria-hidden="true">Hidden</button>
      <button type="button">Real</button>
    `;
    document.body.appendChild(dialog);

    const release = trapModalFocus(dialog);
    await flushEntryFocus();

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    expect((document.activeElement as HTMLElement).textContent).toBe('Real');
    release();
  });
});
