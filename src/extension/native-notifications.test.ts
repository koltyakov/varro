import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isNotifySendConfined, NativeNotifications } from './native-notifications';
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
const GDBUS_CALL = [
  'call',
  '--session',
  '--dest',
  'org.freedesktop.Notifications',
  '--object-path',
  '/org/freedesktop/Notifications',
  '--method',
];

function linuxNotifications(
  run: RunCommand,
  { confined = false, targetUrl }: { confined?: boolean; targetUrl?: string } = {}
): NativeNotifications {
  return new NativeNotifications(
    SOUND,
    APP_ID,
    'linux',
    run,
    undefined,
    targetUrl === undefined ? undefined : async () => targetUrl,
    async () => confined
  );
}

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
    const notifications = linuxNotifications(run);
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
      const notifications = linuxNotifications(run, { targetUrl: TARGET_URL });
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
    const close = vi.fn(() => {
      finish();
      return true;
    });
    const run = vi.fn<RunCommand>((command) => {
      command.onStarted?.(close);
      return pending;
    });
    const notifications = linuxNotifications(run, { targetUrl: TARGET_URL });
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
            return true;
          });
          command.onStdout?.(`${identifier}\n`);
        })
    );
    const first = linuxNotifications(run);
    const other = linuxNotifications(run);
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
          const close = vi.fn(() => {
            resolve();
            return true;
          });
          closers.push(close);
          command.onStarted?.(close);
          if (closers.length === 2) command.onStdout?.('2\n');
        })
    );
    const notifications = linuxNotifications(run);
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
      const notifications = linuxNotifications(run);
      await notifications.show(NOTIFICATION);
      await notifications.dismiss();
      expect(run).toHaveBeenCalledOnce();
    }
  );

  it('sends through gdbus when AppArmor confines notify-send, then closes by ID', async () => {
    const run = vi.fn<RunCommand>(async () => '(uint32 7,)\n');
    const notifications = linuxNotifications(run, { confined: true, targetUrl: TARGET_URL });
    await notifications.show({
      ...NOTIFICATION,
      projectName: "--it's \\ project",
      message: '<b>done</b>\u0007',
    });
    expect(run.mock.calls[0]?.[0]).toEqual({
      file: 'gdbus',
      args: [
        ...GDBUS_CALL,
        'org.freedesktop.Notifications.Notify',
        "'Varro'",
        'uint32 0',
        "'dialog-information'",
        "'--it\\'s \\\\ project'",
        "'Fix tests\\u000a&lt;b&gt;done&lt;/b&gt;\\u0007'",
        '@as []',
        "{'suppress-sound': <true>}",
        'int32 -1',
      ],
    });
    await notifications.dismiss();
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]?.[0]).toEqual({
      file: 'gdbus',
      args: [...GDBUS_CALL, 'org.freedesktop.Notifications.CloseNotification', 'uint32 7'],
    });
    await notifications.dismiss();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('does not report or retry gdbus closes for notifications the user already closed', async () => {
    const run = vi
      .fn<RunCommand>(async () => '(uint32 7,)\n')
      .mockResolvedValueOnce('(uint32 7,)\n')
      .mockRejectedValueOnce(new Error('GDBus.Error: Invalid notification ID'));
    const notifications = linuxNotifications(run, { confined: true });
    await notifications.show(NOTIFICATION);
    await expect(notifications.dismiss()).resolves.toBeUndefined();
    await notifications.dismiss();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('switches to gdbus without failing when signalling notify-send is denied', async () => {
    const pending = new Promise<string>(() => {});
    const run = vi
      .fn<RunCommand>(async () => '(uint32 9,)\n')
      .mockImplementationOnce((command) => {
        command.onStarted?.(() => false);
        command.onStdout?.('5\n');
        return pending;
      });
    const notifications = linuxNotifications(run);
    const delivery = notifications.show(NOTIFICATION);
    let failed = false;
    delivery.catch(() => {
      failed = true;
    });
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    await notifications.dismiss();
    expect(run.mock.calls[1]?.[0].args.slice(-2)).toEqual([
      'org.freedesktop.Notifications.CloseNotification',
      'uint32 5',
    ]);
    await notifications.dismiss();
    expect(run).toHaveBeenCalledTimes(2);
    await notifications.show(NOTIFICATION);
    expect(run.mock.calls[2]?.[0].file).toBe('gdbus');
    expect(failed).toBe(false);
  });

  it('stops waiting for a stalled notify-send that cannot be signalled', async () => {
    vi.useFakeTimers();
    const run = vi
      .fn<RunCommand>(async () => '(uint32 9,)\n')
      .mockImplementationOnce((command) => {
        command.onStarted?.(() => false);
        return new Promise<string>(() => {});
      });
    const notifications = linuxNotifications(run);
    void notifications.show(NOTIFICATION);
    await vi.advanceTimersByTimeAsync(10_000);
    await notifications.dismiss();
    expect(run).toHaveBeenCalledOnce();
    await notifications.show(NOTIFICATION);
    expect(run.mock.calls[1]?.[0].file).toBe('gdbus');
  });

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

describe('isNotifySendConfined', () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  async function profiles(entries: Record<string, { name: string; mode: string }>) {
    root = await mkdtemp(join(tmpdir(), 'varro-apparmor-'));
    for (const [entry, profile] of Object.entries(entries)) {
      await mkdir(join(root, entry));
      await writeFile(join(root, entry, 'name'), `${profile.name}\n`);
      await writeFile(join(root, entry, 'mode'), `${profile.mode}\n`);
    }
    return root;
  }

  it.each([
    ['notify-send.69', 'notify-send', 'enforce', true],
    ['usr.bin.notify-send.3', '/usr/bin/notify-send', 'kill', true],
    ['notify-send.69', 'notify-send', 'complain', false],
    ['notify-send.69', 'notify-send', 'unconfined', false],
    ['notify-send-helper.4', 'notify-send-helper', 'enforce', false],
  ])('reads %s (%s, %s) as confined: %s', async (entry, name, mode, confined) => {
    const directory = await profiles({ 'vscode.20': { name: 'vscode', mode: 'unconfined' } });
    await mkdir(join(directory, entry));
    await writeFile(join(directory, entry, 'name'), `${name}\n`);
    await writeFile(join(directory, entry, 'mode'), `${mode}\n`);
    expect(await isNotifySendConfined(directory)).toBe(confined);
  });

  it('treats unreadable AppArmor policy as unconfined', async () => {
    const directory = await profiles({});
    expect(await isNotifySendConfined(join(directory, 'missing'))).toBe(false);
  });
});
