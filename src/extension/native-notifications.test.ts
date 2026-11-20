import { afterEach, describe, expect, it, vi } from 'vitest';
import { NativeNotifications } from './native-notifications';
import { MacOSNotificationHelper } from './macos-notification-helper';

type RunCommand = NonNullable<ConstructorParameters<typeof NativeNotifications>[3]>;
const SOUND = '/extension with spaces/notification.wav';
const APP_ID = 'Microsoft.VisualStudioCode';
const NOTIFICATION = {
  projectName: 'Project',
  chatTitle: 'Fix tests',
  message: 'Response ready',
  sessionID: 'session',
};
const TARGET_URL = 'vscode://file/Users/test/Project%20name';

describe('NativeNotifications', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('plays macOS sound without installing the helper or checking editor visibility', async () => {
    const executable = vi.spyOn(MacOSNotificationHelper.prototype, 'executable');
    const visible = vi.spyOn(MacOSNotificationHelper.prototype, 'isEditorVisible');
    const run = vi.fn<RunCommand>(async () => {});
    const notifications = new NativeNotifications(SOUND, APP_ID, 'darwin', run, '/storage');
    await notifications.playSound();
    expect(executable).not.toHaveBeenCalled();
    expect(visible).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledExactlyOnceWith(
      { file: '/usr/bin/afplay', args: [SOUND] },
      expect.any(AbortSignal)
    );
  });

  it.each([
    TARGET_URL,
    'vscode://koltyakov.varro/notification?session=child&root=root&directory=%2Fvarro%2Fscratch&windowId=42',
  ])(
    'passes macOS text and target URL unchanged and plays sound separately: %s',
    async (targetUrl) => {
      const run = vi.fn<RunCommand>(async () => {});
      const executable = '/storage with spaces/Varro.app/Contents/MacOS/varro-notifier';
      vi.spyOn(MacOSNotificationHelper.prototype, 'executable').mockResolvedValue(executable);
      const notifications = new NativeNotifications(
        SOUND,
        APP_ID,
        'darwin',
        run,
        '/storage with spaces',
        async () => targetUrl
      );
      const message = '" & do shell script "touch /bad"\n$HOME';
      await notifications.show({ ...NOTIFICATION, message });
      const command = run.mock.calls[0]?.[0];
      expect(command).toEqual({
        file: executable,
        args: ['--notify', 'Project', 'Fix tests', message, expect.any(String), targetUrl],
        timeout: 50_000,
      });
      await notifications.playSound();
      expect(run.mock.calls[1]?.[0]).toEqual({ file: '/usr/bin/afplay', args: [SOUND] });
    }
  );

  it('reports helper installation failures while allowing macOS sound independently', async () => {
    const run = vi.fn<RunCommand>(async () => {});
    vi.spyOn(MacOSNotificationHelper.prototype, 'executable').mockRejectedValue(
      new Error('checksum mismatch')
    );
    const notifications = new NativeNotifications(SOUND, APP_ID, 'darwin', run, '/storage');
    await expect(notifications.show(NOTIFICATION)).rejects.toThrow('checksum mismatch');
    expect(run).not.toHaveBeenCalled();
    await notifications.playSound();
    expect(run).toHaveBeenCalledOnce();
  });

  it('uses Windows XML text nodes and environment data, with a silent toast', async () => {
    const run = vi.fn<RunCommand>(async () => {});
    const notifications = new NativeNotifications(
      SOUND,
      APP_ID,
      'win32',
      run,
      undefined,
      async () => TARGET_URL
    );
    const message = '<>&"\'; Start-Process calc; #';
    await notifications.show({ ...NOTIFICATION, message });
    const command = run.mock.calls[0]?.[0];
    const encoded = command?.args.at(-1);
    if (!encoded) throw new Error('Missing PowerShell command');
    const script = Buffer.from(encoded, 'base64').toString('utf16le');
    expect(script).not.toContain(message);
    expect(script).toContain('CreateTextNode($env:VARRO_NOTIFICATION_MESSAGE)');
    expect(script).toContain('<audio silent="true"/>');
    expect(script).toContain("SetAttribute('activationType', 'protocol')");
    expect(script).toContain("SetAttribute('launch', $env:VARRO_NOTIFICATION_URL)");
    expect(command?.env).toEqual({
      VARRO_NOTIFICATION_TITLE: 'Project',
      VARRO_NOTIFICATION_SUBTITLE: 'Fix tests',
      VARRO_NOTIFICATION_MESSAGE: message,
      VARRO_NOTIFICATION_APP_ID: APP_ID,
      VARRO_NOTIFICATION_URL: TARGET_URL,
      VARRO_NOTIFICATION_ID: expect.stringMatching(/^[a-f0-9]{16}$/),
    });
    expect(command?.args).toContain('-NonInteractive');
    expect(script).toContain('$toast.Tag = $env:VARRO_NOTIFICATION_ID');
    await notifications.playSound();
    expect(run.mock.calls[1]?.[0].env).toEqual({ VARRO_NOTIFICATION_SOUND: SOUND });
  });

  it('escapes Linux body markup, ends option parsing, and suppresses the banner sound', async () => {
    const run = vi.fn<RunCommand>(async () => {});
    const notifications = new NativeNotifications(SOUND, APP_ID, 'linux', run);
    await notifications.show({
      ...NOTIFICATION,
      projectName: '--title',
      message: '<b>hello</b> & $(touch /bad)',
    });
    expect(run.mock.calls[0]?.[0]).toEqual({
      file: 'notify-send',
      args: [
        '--app-name=Varro',
        '--icon=dialog-information',
        '--hint=boolean:suppress-sound:true',
        '--print-id',
        '--wait',
        '--',
        '--title',
        'Fix tests\n&lt;b&gt;hello&lt;/b&gt; &amp; $(touch /bad)',
      ],
      onStdout: expect.any(Function),
      onStarted: expect.any(Function),
      timeout: 0,
    });
  });

  it.each(['42\ndefault\n', '42\n', '42\ndismissed'])(
    'opens a Linux chat only for its default action: %j',
    async (action) => {
      const run = vi.fn<RunCommand>(async () => action);
      const notifications = new NativeNotifications(
        SOUND,
        APP_ID,
        'linux',
        run,
        undefined,
        async () => TARGET_URL
      );
      await notifications.show(NOTIFICATION);
      expect(run.mock.calls[0]?.[0].args).toContain('--action=default=Open project');
      expect(run).toHaveBeenCalledTimes(action === '42\ndefault\n' ? 2 : 1);
      if (action === '42\ndefault\n')
        expect(run.mock.calls[1]?.[0]).toEqual({ file: 'xdg-open', args: [TARGET_URL] });
    }
  );

  it.each(['darwin', 'win32'] as const)(
    'dismisses only this window-owned set of IDs on %s, even with identical project names',
    async (platform) => {
      vi.spyOn(MacOSNotificationHelper.prototype, 'executable').mockResolvedValue('/notifier');
      const run = vi.fn<RunCommand>(async () => {});
      const first = new NativeNotifications(SOUND, APP_ID, platform, run, '/storage');
      const other = new NativeNotifications(SOUND, APP_ID, platform, run, '/storage');
      await first.show(NOTIFICATION);
      await other.show(NOTIFICATION);
      await first.show(NOTIFICATION);
      const shownIDs = run.mock.calls.map(([command]) =>
        platform === 'darwin' ? command.args[4] : command.env?.VARRO_NOTIFICATION_ID
      );
      expect(new Set(shownIDs).size).toBe(3);
      await first.dismiss();
      expect(run).toHaveBeenCalledTimes(5);
      const removals = run.mock.calls.slice(3).map(([command]) => {
        if (platform === 'darwin') {
          expect(command.args[0]).toBe('--dismiss');
          return command.args[1];
        }
        const script = Buffer.from(command.args.at(-1) ?? '', 'base64').toString('utf16le');
        expect(script).toContain(
          "::History.Remove($env:VARRO_NOTIFICATION_ID, 'varro', $env:VARRO_NOTIFICATION_APP_ID)"
        );
        expect(script).not.toContain('Clear(');
        expect(command.env?.VARRO_NOTIFICATION_APP_ID).toBe(APP_ID);
        return command.env?.VARRO_NOTIFICATION_ID;
      });
      expect(removals).toEqual([shownIDs[0], shownIDs[2]]);
      await first.dismiss();
      expect(run).toHaveBeenCalledTimes(5);
      await other.dismiss();
      expect(run).toHaveBeenCalledTimes(6);
    }
  );

  it.each(['darwin', 'win32'] as const)(
    'waits for in-flight %s delivery before dismissing and leaves later alerts alone',
    async (platform) => {
      vi.spyOn(MacOSNotificationHelper.prototype, 'executable').mockResolvedValue('/notifier');
      let finish = () => {};
      const pending = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const run = vi.fn<RunCommand>(async () => {}).mockReturnValueOnce(pending);
      const notifications = new NativeNotifications(SOUND, APP_ID, platform, run, '/storage');
      const delivery = notifications.show(NOTIFICATION);
      await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
      const dismissal = notifications.dismiss();
      await notifications.show(NOTIFICATION);
      expect(run).toHaveBeenCalledTimes(2);
      finish();
      await Promise.all([delivery, dismissal]);
      expect(run).toHaveBeenCalledTimes(3);
      const first = run.mock.calls[0]?.[0];
      const last = run.mock.calls[2]?.[0];
      if (platform === 'darwin') expect(last?.args).toEqual(['--dismiss', first?.args[4]]);
      else expect(last?.env?.VARRO_NOTIFICATION_ID).toBe(first?.env?.VARRO_NOTIFICATION_ID);
    }
  );

  it('cancels asynchronous URL preparation when the window returns', async () => {
    let finish = (_url: string) => {};
    const url = new Promise<string>((resolve) => {
      finish = resolve;
    });
    const run = vi.fn<RunCommand>(async () => {});
    const notifications = new NativeNotifications(
      SOUND,
      APP_ID,
      'win32',
      run,
      undefined,
      () => url
    );
    const delivery = notifications.show(NOTIFICATION);
    await notifications.dismiss();
    finish(TARGET_URL);
    await delivery;
    expect(run).not.toHaveBeenCalled();
  });

  it('cancels a macOS notification still installing its helper on focus return', async () => {
    let finish = (_path: string) => {};
    const executable = new Promise<string>((resolve) => {
      finish = resolve;
    });
    const helper = vi
      .spyOn(MacOSNotificationHelper.prototype, 'executable')
      .mockReturnValue(executable);
    const run = vi.fn<RunCommand>(async () => {});
    const notifications = new NativeNotifications(SOUND, APP_ID, 'darwin', run, '/storage');
    const delivery = notifications.show(NOTIFICATION);
    await vi.waitFor(() => expect(helper).toHaveBeenCalledOnce());
    await notifications.dismiss();
    finish('/notifier');
    await delivery;
    expect(run).not.toHaveBeenCalled();
  });

  it('closes Linux IDs as soon as printed without waiting for the click listener to finish', async () => {
    let finish = () => {};
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const close = vi.fn(() => finish());
    const run = vi.fn<RunCommand>((command) => {
      command.onStarted?.(close);
      return pending;
    });
    const notifications = new NativeNotifications(
      SOUND,
      APP_ID,
      'linux',
      run,
      undefined,
      async () => TARGET_URL
    );
    const delivery = notifications.show(NOTIFICATION);
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    const dismissal = notifications.dismiss();
    const output = run.mock.calls[0]?.[0].onStdout;
    output?.('12');
    await Promise.resolve();
    expect(run).toHaveBeenCalledOnce();
    output?.('3\n');
    await dismissal;
    expect(close).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledOnce();
    await delivery;
  });

  it('leaves Linux notification IDs from other projects untouched', async () => {
    const closed: string[] = [];
    let nextID = 0;
    const run = vi.fn<RunCommand>(
      (command) =>
        new Promise<string>((resolve) => {
          const identifier = String(++nextID);
          command.onStarted?.(() => {
            closed.push(identifier);
            resolve(`${identifier}\n`);
          });
          command.onStdout?.(`${identifier}\n`);
        })
    );
    const first = new NativeNotifications(SOUND, APP_ID, 'linux', run);
    const other = new NativeNotifications(SOUND, APP_ID, 'linux', run);
    const firstDelivery = first.show(NOTIFICATION);
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    const otherDelivery = other.show(NOTIFICATION);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    await first.dismiss();
    await firstDelivery;
    expect(closed).toEqual(['1']);
    await other.dismiss();
    await otherDelivery;
    expect(closed).toEqual(['1', '2']);
  });

  it('bounds Linux acceptance without timing out an already accepted notification', async () => {
    vi.useFakeTimers();
    const closers: Array<ReturnType<typeof vi.fn>> = [];
    const run = vi.fn<RunCommand>(
      (command) =>
        new Promise<void>((resolve) => {
          const close = vi.fn(() => resolve());
          closers.push(close);
          command.onStarted?.(close);
          if (closers.length === 2) command.onStdout?.('2\n');
        })
    );
    const notifications = new NativeNotifications(SOUND, APP_ID, 'linux', run);
    const stalled = notifications.show(NOTIFICATION);
    const accepted = notifications.show(NOTIFICATION);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(closers[0]).toHaveBeenCalledOnce();
    expect(closers[1]).not.toHaveBeenCalled();
    await stalled;
    await notifications.dismiss();
    await accepted;
    expect(closers[1]).toHaveBeenCalledOnce();
  });

  it.each(['0\n', '4294967296\n', '12; touch /bad\n', 'default\n'])(
    'never closes an invalid Linux notification ID: %j',
    async (output) => {
      const run = vi.fn<RunCommand>(async () => output);
      const notifications = new NativeNotifications(SOUND, APP_ID, 'linux', run);
      await notifications.show(NOTIFICATION);
      await notifications.dismiss();
      expect(run).toHaveBeenCalledOnce();
    }
  );

  it('retains IDs after dismissal failure so a later focus return can retry', async () => {
    const run = vi.fn<RunCommand>(async () => {});
    const notifications = new NativeNotifications(SOUND, APP_ID, 'win32', run);
    await notifications.show(NOTIFICATION);
    run.mockRejectedValueOnce(new Error('Desktop service unavailable'));
    await expect(notifications.dismiss()).rejects.toThrow('Desktop service unavailable');
    await notifications.dismiss();
    expect(run.mock.calls[1]?.[0]).toEqual(run.mock.calls[2]?.[0]);
  });

  it.each(['darwin', 'win32', 'linux'] as const)(
    'does no native work on %s when there are no delivered banners',
    async (platform) => {
      const helper = vi.spyOn(MacOSNotificationHelper.prototype, 'executable');
      const run = vi.fn<RunCommand>(async () => {});
      const notifications = new NativeNotifications(SOUND, APP_ID, platform, run, '/storage');
      await notifications.playSound();
      run.mockClear();
      await notifications.dismiss();
      expect(run).not.toHaveBeenCalled();
      expect(helper).not.toHaveBeenCalled();
    }
  );

  it('falls back to another Linux audio player when PulseAudio is unavailable', async () => {
    const run = vi.fn<RunCommand>(async () => {}).mockRejectedValueOnce(new Error('no PulseAudio'));
    const notifications = new NativeNotifications(SOUND, APP_ID, 'linux', run);
    await notifications.playSound();
    expect(run.mock.calls.map(([command]) => command.file)).toEqual(['paplay', 'aplay']);
    expect(run.mock.calls[1]?.[0].args).toEqual([SOUND]);
  });

  it('reports missing Linux sound support with installation guidance', async () => {
    const run = vi.fn<RunCommand>().mockRejectedValue(new Error('ENOENT'));
    const notifications = new NativeNotifications(SOUND, APP_ID, 'linux', run);
    await expect(notifications.playSound()).rejects.toThrow(
      'Install paplay, aplay, or canberra-gtk-play'
    );
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('aborts in-flight commands and does not start another player after disposal', async () => {
    const run = vi.fn<RunCommand>(async () => {});
    const notifications = new NativeNotifications(SOUND, APP_ID, 'linux', run);
    run.mockImplementation(async (_command, signal) => {
      notifications.dispose();
      expect(signal.aborted).toBe(true);
      throw new Error('aborted');
    });
    await expect(notifications.playSound()).rejects.toThrow('aborted');
    expect(run).toHaveBeenCalledOnce();
  });
});
