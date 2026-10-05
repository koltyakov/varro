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
  afterEach(() => vi.restoreAllMocks());

  it('checks visibility for the originating macOS editor process', async () => {
    const visible = vi
      .spyOn(MacOSNotificationHelper.prototype, 'isEditorVisible')
      .mockResolvedValue(true);
    const run = vi.fn<RunCommand>(async () => {});
    const notifications = new NativeNotifications(
      SOUND,
      APP_ID,
      'darwin',
      run,
      '/storage',
      undefined,
      1234
    );
    expect(await notifications.isEditorVisible()).toBe(true);
    expect(visible).toHaveBeenCalledExactlyOnceWith(1234);
    expect(run).not.toHaveBeenCalled();
  });

  it('passes macOS notification text as arguments and plays the bundled sound separately', async () => {
    const run = vi.fn<RunCommand>(async () => {});
    const executable = '/storage with spaces/Varro.app/Contents/MacOS/varro-notifier';
    vi.spyOn(MacOSNotificationHelper.prototype, 'executable').mockResolvedValue(executable);
    const notifications = new NativeNotifications(
      SOUND,
      APP_ID,
      'darwin',
      run,
      '/storage with spaces',
      async () => TARGET_URL
    );
    const message = '" & do shell script "touch /bad"\n$HOME';
    await notifications.show({ ...NOTIFICATION, message });
    const command = run.mock.calls[0]?.[0];
    expect(command).toEqual({
      file: executable,
      args: ['--notify', 'Project', 'Fix tests', message, expect.any(String), TARGET_URL],
      timeout: 50_000,
    });
    await notifications.playSound();
    expect(run.mock.calls[1]?.[0]).toEqual({ file: '/usr/bin/afplay', args: [SOUND] });
  });

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
    });
    expect(command?.args).toContain('-NonInteractive');
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
        '--',
        '--title',
        'Fix tests\n&lt;b&gt;hello&lt;/b&gt; &amp; $(touch /bad)',
      ],
    });
  });

  it.each(['default\n', '', 'dismissed'])(
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
      expect(run).toHaveBeenCalledTimes(action === 'default\n' ? 2 : 1);
      if (action === 'default\n')
        expect(run.mock.calls[1]?.[0]).toEqual({ file: 'xdg-open', args: [TARGET_URL] });
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
