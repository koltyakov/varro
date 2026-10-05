import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AttentionNotifications } from './attention-notifications';
import type {
  AttentionNotificationHost,
  AttentionNotificationSettings,
  AttentionNotificationTransport,
} from './attention-notifications';
import type { PendingAttentionEntry } from './session-state-manager';

function allSoundEvents(enabled: boolean): AttentionNotificationSettings['sound'] {
  return { permission: enabled, question: enabled, completed: enabled, 'plan-ready': enabled };
}

function createNotifications() {
  const pending = new Map<string, PendingAttentionEntry>();
  const completionRevisions = new Map<string, number>();
  const settings: AttentionNotificationSettings = {
    sound: allSoundEvents(true),
    native: true,
  };
  const host = {
    getPending: () => pending,
    completionRevisionFor: (sessionID: string) => completionRevisions.get(sessionID),
    getSettings: () => settings,
    isFocused: vi.fn(() => false),
    isInScope: vi.fn(() => true),
    titleFor: vi.fn<AttentionNotificationHost['titleFor']>(() => 'Fix tests'),
    projectNameFor: vi.fn<AttentionNotificationHost['projectNameFor']>(() => 'Project'),
    reportError: vi.fn<AttentionNotificationHost['reportError']>(),
  };
  const transport = {
    isEditorVisible: vi.fn(async () => false),
    show: vi.fn<AttentionNotificationTransport['show']>(async () => {}),
    playSound: vi.fn(async () => {}),
    dispose: vi.fn(),
  };
  const notifications = new AttentionNotifications(host, transport);
  const add = (id: string, kind: PendingAttentionEntry['kind'] = 'permission') => {
    pending.set(id, { kind, sessionID: 'session', label: 'Run command', props: {} });
    notifications.update();
  };
  const complete = (sessionID = 'session', kind: 'completed' | 'plan-ready' = 'completed') => {
    completionRevisions.set(sessionID, (completionRevisions.get(sessionID) ?? 0) + 1);
    notifications.complete(sessionID, kind);
  };
  return { notifications, pending, completionRevisions, settings, host, transport, add, complete };
}

describe('AttentionNotifications', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('suppresses visible unfocused windows without consuming cooldown or replaying old events', async () => {
    const test = createNotifications();
    test.transport.isEditorVisible.mockResolvedValue(true);
    test.add('visible-request');
    test.complete();
    await vi.advanceTimersByTimeAsync(300);
    expect(test.transport.show).not.toHaveBeenCalled();
    expect(test.transport.playSound).not.toHaveBeenCalled();
    test.transport.isEditorVisible.mockResolvedValue(false);
    test.notifications.update();
    await vi.advanceTimersByTimeAsync(300);
    expect(test.transport.show).not.toHaveBeenCalled();
    test.add('new-request');
    await vi.advanceTimersByTimeAsync(300);
    expect(test.transport.show).toHaveBeenCalledOnce();
    expect(test.transport.playSound).toHaveBeenCalledOnce();
  });

  it.each(['focused', 'resolved', 'disposed'] as const)(
    'rechecks events after an asynchronous visibility read: %s',
    async (change) => {
      const test = createNotifications();
      let resolve!: (visible: boolean) => void;
      test.transport.isEditorVisible.mockReturnValue(
        new Promise<boolean>((accept) => {
          resolve = accept;
        })
      );
      test.add('request');
      await vi.advanceTimersByTimeAsync(300);
      if (change === 'focused') test.host.isFocused.mockReturnValue(true);
      if (change === 'resolved') test.pending.delete('request');
      if (change === 'disposed') test.notifications.dispose();
      resolve(false);
      await vi.advanceTimersByTimeAsync(0);
      expect(test.transport.show).not.toHaveBeenCalled();
      expect(test.transport.playSound).not.toHaveBeenCalled();
    }
  );

  it('coalesces events arriving while visibility is being checked', async () => {
    const test = createNotifications();
    let resolve!: (visible: boolean) => void;
    test.transport.isEditorVisible.mockReturnValue(
      new Promise<boolean>((accept) => {
        resolve = accept;
      })
    );
    test.add('first');
    await vi.advanceTimersByTimeAsync(300);
    test.add('second', 'question');
    await vi.advanceTimersByTimeAsync(300);
    expect(test.transport.isEditorVisible).toHaveBeenCalledOnce();
    resolve(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(test.transport.show).toHaveBeenCalledOnce();
    expect(test.transport.playSound).toHaveBeenCalledOnce();
  });

  it('drops an uncertain-visibility burst and retries visibility for the next event', async () => {
    const test = createNotifications();
    const error = new Error('Window list unavailable');
    test.transport.isEditorVisible.mockRejectedValueOnce(error);
    test.add('uncertain');
    await vi.advanceTimersByTimeAsync(300);
    expect(test.host.reportError).toHaveBeenCalledWith('native', error);
    expect(test.transport.show).not.toHaveBeenCalled();
    expect(test.transport.playSound).not.toHaveBeenCalled();
    test.add('next');
    await vi.advanceTimersByTimeAsync(300);
    expect(test.transport.show).toHaveBeenCalledOnce();
  });

  it('keeps the three display fields single-line and supplies missing-name fallbacks', async () => {
    const test = createNotifications();
    test.host.projectNameFor.mockReturnValue(' Project\nname ');
    test.host.titleFor.mockReturnValue(' Chat\ttitle ');
    test.complete();
    await vi.advanceTimersByTimeAsync(300);
    expect(test.transport.show).toHaveBeenLastCalledWith({
      projectName: 'Project: Project name',
      chatTitle: 'Chat title',
      message: 'Response ready',
      sessionID: 'session',
    });
    test.host.projectNameFor.mockReturnValue(undefined);
    test.host.titleFor.mockReturnValue('  ');
    test.complete();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(test.transport.show).toHaveBeenLastCalledWith({
      projectName: 'Project: Varro',
      chatTitle: 'Untitled chat',
      message: 'Response ready',
      sessionID: 'session',
    });
  });

  it.each([
    { sound: false, native: false },
    { sound: true, native: false },
    { sound: false, native: true },
    { sound: true, native: true },
  ])('honors independent opt-ins: %o', async (settings) => {
    const test = createNotifications();
    test.settings.native = settings.native;
    test.settings.sound = allSoundEvents(settings.sound);
    test.add('request');
    await vi.advanceTimersByTimeAsync(300);
    expect(test.transport.show).toHaveBeenCalledTimes(Number(settings.native));
    expect(test.transport.playSound).toHaveBeenCalledTimes(Number(settings.sound));
  });

  it('batches a burst and does not repeat notifications for pending IDs', async () => {
    const test = createNotifications();
    test.add('permission');
    test.add('question', 'question');
    await vi.advanceTimersByTimeAsync(300);
    expect(test.transport.show).toHaveBeenCalledWith({
      projectName: 'Project: Project',
      chatTitle: 'Fix tests',
      sessionID: 'session',
      message: 'Permission approval needed; Your answer is needed',
    });
    test.notifications.update();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(test.transport.playSound).toHaveBeenCalledTimes(1);
    expect(test.transport.show).toHaveBeenCalledTimes(1);
  });

  describe.each([true, false])('event choices with native notifications=%s', (native) => {
    it.each(['permission', 'question', 'completed', 'plan-ready'] as const)(
      'mutes only the selected %s sound',
      async (kind) => {
        const test = createNotifications();
        test.settings.native = native;
        test.settings.sound[kind] = false;
        if (kind === 'permission' || kind === 'question') test.add('request', kind);
        else test.complete('session', kind);
        await vi.advanceTimersByTimeAsync(300);
        expect(test.transport.playSound).not.toHaveBeenCalled();
        expect(test.transport.show).toHaveBeenCalledTimes(Number(native));
      }
    );
  });

  it('does not let a disabled sound-only event consume the cooldown', async () => {
    const test = createNotifications();
    test.settings.native = false;
    test.settings.sound.permission = false;
    test.add('muted-permission');
    await vi.advanceTimersByTimeAsync(300);
    test.complete();
    await vi.advanceTimersByTimeAsync(300);
    expect(test.transport.playSound).toHaveBeenCalledOnce();
  });

  it('plays one sound for a mixed burst when any event has its sound enabled', async () => {
    const test = createNotifications();
    test.settings.sound.completed = false;
    test.complete();
    test.add('permission');
    await vi.advanceTimersByTimeAsync(300);
    expect(test.transport.show).toHaveBeenCalledOnce();
    expect(test.transport.playSound).toHaveBeenCalledOnce();
  });

  it.each(['permission', 'question', 'completed', 'plan-ready'] as const)(
    'rechecks the %s checkbox before playing a queued sound',
    async (kind) => {
      const test = createNotifications();
      if (kind === 'permission' || kind === 'question') test.add('request', kind);
      else test.complete('session', kind);
      test.settings.sound[kind] = false;
      await vi.advanceTimersByTimeAsync(300);
      expect(test.transport.playSound).not.toHaveBeenCalled();
      expect(test.transport.show).toHaveBeenCalledOnce();
    }
  );

  it.each([
    { sound: false, native: false },
    { sound: true, native: false },
    { sound: false, native: true },
    { sound: true, native: true },
  ])('uses the same opt-ins for completions: %o', async (settings) => {
    const test = createNotifications();
    test.settings.native = settings.native;
    test.settings.sound = allSoundEvents(settings.sound);
    test.complete();
    await vi.advanceTimersByTimeAsync(300);
    expect(test.transport.show).toHaveBeenCalledTimes(Number(settings.native));
    expect(test.transport.playSound).toHaveBeenCalledTimes(Number(settings.sound));
    if (settings.native)
      expect(test.transport.show).toHaveBeenCalledWith({
        projectName: 'Project: Project',
        chatTitle: 'Fix tests',
        message: 'Response ready',
        sessionID: 'session',
      });
  });

  it.each(['focused', 'new-turn', 'disabled', 'out-of-scope'] as const)(
    'rechecks queued completion after %s',
    async (change) => {
      const test = createNotifications();
      test.complete();
      if (change === 'focused') test.host.isFocused.mockReturnValue(true);
      if (change === 'new-turn') test.completionRevisions.set('session', 2);
      if (change === 'disabled')
        Object.assign(test.settings, { sound: allSoundEvents(false), native: false });
      if (change === 'out-of-scope') test.host.isInScope.mockReturnValue(false);
      await vi.advanceTimersByTimeAsync(300);
      expect(test.transport.show).not.toHaveBeenCalled();
      expect(test.transport.playSound).not.toHaveBeenCalled();
    }
  );

  it('coalesces permissions and completions into one sound and banner', async () => {
    const test = createNotifications();
    test.add('permission');
    test.complete('another-session');
    await vi.advanceTimersByTimeAsync(300);
    expect(test.transport.show).toHaveBeenCalledWith({
      projectName: 'Project: Project',
      chatTitle: 'Fix tests',
      sessionID: 'session',
      message: 'Permission approval needed; Updates in 1 other chat',
    });
    expect(test.transport.playSound).toHaveBeenCalledOnce();
  });

  it('applies the cooldown to completions and keeps the latest turn for each session', async () => {
    const test = createNotifications();
    test.complete();
    await vi.advanceTimersByTimeAsync(300);
    test.complete();
    test.complete();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(test.transport.show).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(test.transport.show).toHaveBeenCalledTimes(2);
    expect(test.transport.playSound).toHaveBeenCalledTimes(2);
  });

  it('delivers new requests after the cooldown without postponing them on each update', async () => {
    const test = createNotifications();
    test.add('first');
    await vi.advanceTimersByTimeAsync(300);
    test.add('second');
    await vi.advanceTimersByTimeAsync(4_800);
    test.add('third');
    await vi.advanceTimersByTimeAsync(199);
    expect(test.transport.show).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(test.transport.show).toHaveBeenCalledTimes(2);
    expect(test.transport.playSound).toHaveBeenCalledTimes(2);
  });

  it.each(['focused', 'resolved', 'out-of-scope', 'disabled'] as const)(
    'rechecks %s before delivery even without another update',
    async (change) => {
      const test = createNotifications();
      test.add('request');
      if (change === 'focused') test.host.isFocused.mockReturnValue(true);
      if (change === 'resolved') test.pending.clear();
      if (change === 'out-of-scope') test.host.isInScope.mockReturnValue(false);
      if (change === 'disabled')
        Object.assign(test.settings, { sound: allSoundEvents(false), native: false });
      await vi.advanceTimersByTimeAsync(300);
      expect(test.transport.show).not.toHaveBeenCalled();
      expect(test.transport.playSound).not.toHaveBeenCalled();
    }
  );

  it('does not alert retroactively when leaving a conversation already seen', async () => {
    const test = createNotifications();
    test.host.isFocused.mockReturnValue(true);
    test.add('seen');
    test.host.isFocused.mockReturnValue(false);
    test.notifications.update();
    await vi.advanceTimersByTimeAsync(300);
    expect(test.transport.show).not.toHaveBeenCalled();
    test.add('new', 'question');
    await vi.advanceTimersByTimeAsync(300);
    expect(test.transport.show).toHaveBeenCalledWith({
      projectName: 'Project: Project',
      chatTitle: 'Fix tests',
      message: 'Your answer is needed',
      sessionID: 'session',
    });
  });

  it('cancels a queued alert after a brief return to the conversation', async () => {
    const test = createNotifications();
    test.add('request');
    test.host.isFocused.mockReturnValue(true);
    test.notifications.update();
    test.host.isFocused.mockReturnValue(false);
    test.notifications.update();
    await vi.advanceTimersByTimeAsync(300);
    expect(test.transport.show).not.toHaveBeenCalled();
    expect(test.transport.playSound).not.toHaveBeenCalled();
  });

  it('keeps sound independent of native delivery failure and reports the failure', async () => {
    const test = createNotifications();
    const error = new Error('notification service unavailable');
    test.transport.show.mockRejectedValue(error);
    test.add('request');
    await vi.advanceTimersByTimeAsync(300);
    expect(test.transport.playSound).toHaveBeenCalledOnce();
    expect(test.host.reportError).toHaveBeenCalledWith('native', error);
  });

  it('cancels scheduled delivery and disposes the transport', async () => {
    const test = createNotifications();
    test.add('request');
    test.complete();
    test.notifications.dispose();
    test.add('late');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(test.transport.show).not.toHaveBeenCalled();
    expect(test.transport.playSound).not.toHaveBeenCalled();
    expect(test.transport.dispose).toHaveBeenCalledOnce();
  });
});
