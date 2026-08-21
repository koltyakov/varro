/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-object-parameters, anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion -- SAFETY: These tests deliver minimal protocol-shaped server-event fixtures through the provider's private sessionState handle to assert notification side effects on the vscode mock. */
import { describe, expect, it } from 'vitest';
import {
  attachTestView,
  createSidebarProviderInstance,
  getVscodeMock,
} from './sidebar-provider.test-support';

type TestSessionState = {
  handleServerEvent(event: unknown): void;
};

function providerSessionState(provider: object): TestSessionState {
  return (provider as unknown as { sessionState: TestSessionState }).sessionState;
}

const questionEvent = {
  type: 'question.asked',
  properties: {
    id: 'question-1',
    sessionID: 'session-1',
    questions: [{ header: 'Ship it?' }],
  },
};

describe('SidebarProvider desktop notifications', () => {
  it('shows a waiting balloon when the chat view is hidden', async () => {
    const vscodeMock = getVscodeMock();
    const { provider } = await createSidebarProviderInstance();
    const { view } = attachTestView(provider);
    view.visible = false;

    providerSessionState(provider).handleServerEvent(questionEvent);

    expect(vscodeMock.window.showWarningMessage).toHaveBeenCalledWith(
      'Varro is waiting for your input.',
      'Open Chat'
    );
    expect(vscodeMock.window.showErrorMessage).not.toHaveBeenCalled();
  });

  it('shows a plan-ready balloon when the chat view is hidden', async () => {
    const vscodeMock = getVscodeMock();
    const { provider } = await createSidebarProviderInstance();
    const { view } = attachTestView(provider);
    view.visible = false;

    const sessionState = providerSessionState(provider);
    sessionState.handleServerEvent({
      type: 'message.updated',
      properties: { info: { id: 'msg-1', sessionID: 'session-1', role: 'assistant', agent: 'plan' } },
    });
    sessionState.handleServerEvent({
      type: 'session.status',
      properties: { sessionID: 'session-1', status: { type: 'busy' } },
    });
    sessionState.handleServerEvent({
      type: 'session.status',
      properties: { sessionID: 'session-1', status: { type: 'idle' } },
    });

    expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledWith(
      'Varro has a plan ready for review.',
      'Open Chat'
    );
  });

  it('does not show balloons when desktop notifications are disabled', async () => {
    const vscodeMock = getVscodeMock();
    await vscodeMock.workspace
      .getConfiguration('varro')
      .update('chat.showDesktopNotifications', false);

    const { provider } = await createSidebarProviderInstance();
    const { view } = attachTestView(provider);
    view.visible = false;

    const sessionState = providerSessionState(provider);
    sessionState.handleServerEvent(questionEvent);
    sessionState.handleServerEvent({
      type: 'session.error',
      properties: {
        sessionID: 'session-1',
        error: { name: 'Error', data: { message: 'boom' } },
      },
    });

    expect(vscodeMock.window.showWarningMessage).not.toHaveBeenCalled();
    expect(vscodeMock.window.showInformationMessage).not.toHaveBeenCalled();
    expect(vscodeMock.window.showErrorMessage).not.toHaveBeenCalled();
  });

  it('does not show balloons while the chat view is visible', async () => {
    const vscodeMock = getVscodeMock();
    const { provider } = await createSidebarProviderInstance();
    attachTestView(provider);

    providerSessionState(provider).handleServerEvent(questionEvent);

    expect(vscodeMock.window.showWarningMessage).not.toHaveBeenCalled();
    expect(vscodeMock.window.showInformationMessage).not.toHaveBeenCalled();
    expect(vscodeMock.window.showErrorMessage).not.toHaveBeenCalled();
  });
});
