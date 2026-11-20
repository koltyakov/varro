import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { MacOSNotificationHelper } from './macos-notification-helper';
import type {
  AttentionNotification,
  AttentionNotificationTransport,
} from './attention-notifications';

interface NotificationCommand {
  file: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  timeout?: number;
  onStdout?: (chunk: string) => void;
  onStarted?: (close: () => void) => void;
}

interface DeliveredNotification {
  identifier?: string;
  ready: Promise<void>;
  dismissal?: Promise<void>;
  close?: () => void;
  completion?: Promise<string | void>;
}

type RunNotificationCommand = (
  command: NotificationCommand,
  signal: AbortSignal
) => Promise<string | void>;

// User text travels through the environment and XML text nodes, never PowerShell source.
const WINDOWS_NOTIFICATION_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
[Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml('<toast><visual><binding template="ToastGeneric"><text/><text/><text/></binding></visual><audio silent="true"/></toast>')
if ($env:VARRO_NOTIFICATION_URL) {
  $xml.DocumentElement.SetAttribute('activationType', 'protocol')
  $xml.DocumentElement.SetAttribute('launch', $env:VARRO_NOTIFICATION_URL)
}
$text = $xml.GetElementsByTagName('text')
$null = $text.Item(0).AppendChild($xml.CreateTextNode($env:VARRO_NOTIFICATION_TITLE))
$null = $text.Item(1).AppendChild($xml.CreateTextNode($env:VARRO_NOTIFICATION_SUBTITLE))
$null = $text.Item(2).AppendChild($xml.CreateTextNode($env:VARRO_NOTIFICATION_MESSAGE))
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
$toast.Tag = $env:VARRO_NOTIFICATION_ID
$toast.Group = 'varro'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($env:VARRO_NOTIFICATION_APP_ID).Show($toast)
`;

const WINDOWS_DISMISS_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
[Windows.UI.Notifications.ToastNotificationManager]::History.Remove($env:VARRO_NOTIFICATION_ID, 'varro', $env:VARRO_NOTIFICATION_APP_ID)
`;

const WINDOWS_SOUND_SCRIPT = `
$ErrorActionPreference = 'Stop'
$player = New-Object System.Media.SoundPlayer
try {
  $player.SoundLocation = $env:VARRO_NOTIFICATION_SOUND
  $player.PlaySync()
} finally {
  $player.Dispose()
}
`;

function runNotificationCommand(
  command: NotificationCommand,
  signal: AbortSignal
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command.file,
      command.args,
      {
        env: { ...process.env, ...command.env },
        signal,
        timeout: command.timeout ?? 10_000,
        // A waiting notify-send must close its notification before losing its D-Bus sender.
        killSignal: command.onStarted ? 'SIGINT' : 'SIGTERM',
        maxBuffer: 64 * 1024,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error)
          reject(
            new Error(`Notification command ${command.file} failed: ${error.message}`, {
              cause: error,
            })
          );
        else resolve(stdout);
      }
    );
    if (command.onStdout) {
      child.stdout?.on('data', (chunk: Buffer | string) => command.onStdout?.(chunk.toString()));
    }
    command.onStarted?.(() => {
      child.kill('SIGINT');
    });
  });
}

function escapeMarkup(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** Desktop-side commands; callers must not invoke this on a remote extension host. */
export class NativeNotifications implements AttentionNotificationTransport {
  private readonly abort = new AbortController();
  private readonly macOSHelper: MacOSNotificationHelper | undefined;
  private readonly delivered = new Set<DeliveredNotification>();
  private dismissalRevision = 0;

  constructor(
    private readonly soundPath: string,
    private readonly windowsAppId: string,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly run: RunNotificationCommand = runNotificationCommand,
    storageDirectory?: string,
    private readonly notificationUrlFor?: (sessionID: string) => Promise<string>
  ) {
    if (platform === 'darwin' && storageDirectory) {
      this.macOSHelper = new MacOSNotificationHelper(
        dirname(soundPath),
        storageDirectory,
        (file, args, timeout) => this.run({ file, args, timeout }, this.abort.signal)
      );
    }
  }

  async show(notification: AttentionNotification): Promise<void> {
    const revision = this.dismissalRevision;
    const { projectName, chatTitle, message, sessionID } = notification;
    const targetUrl = await this.notificationUrlFor?.(sessionID);
    if (revision !== this.dismissalRevision || this.abort.signal.aborted) return;
    switch (this.platform) {
      case 'darwin': {
        if (!this.macOSHelper) throw new Error('Varro notification helper storage is unavailable.');
        const file = await this.macOSHelper.executable();
        if (revision !== this.dismissalRevision || this.abort.signal.aborted) return;
        const identifier = randomUUID();
        await this.deliver(
          {
            file,
            args: [
              '--notify',
              projectName,
              chatTitle,
              message,
              identifier,
              ...(targetUrl ? [targetUrl] : []),
            ],
            timeout: 50_000,
          },
          identifier
        );
        return;
      }
      case 'win32': {
        // Windows toast tags are limited to 16 characters on older supported versions.
        const identifier = randomUUID().replaceAll('-', '').slice(0, 16);
        await this.deliver(
          this.windowsCommand(WINDOWS_NOTIFICATION_SCRIPT, {
            VARRO_NOTIFICATION_TITLE: projectName,
            VARRO_NOTIFICATION_SUBTITLE: chatTitle,
            VARRO_NOTIFICATION_MESSAGE: message,
            VARRO_NOTIFICATION_APP_ID: this.windowsAppId,
            VARRO_NOTIFICATION_URL: targetUrl,
            VARRO_NOTIFICATION_ID: identifier,
          }),
          identifier
        );
        return;
      }
      case 'linux': {
        const command: NotificationCommand = {
          file: 'notify-send',
          args: [
            '--app-name=Varro',
            '--icon=dialog-information',
            '--hint=boolean:suppress-sound:true',
            '--print-id',
            '--wait',
            ...(targetUrl ? ['--action=default=Open project'] : []),
            '--',
            projectName,
            `${escapeMarkup(chatTitle)}\n${escapeMarkup(message)}`,
          ],
          // Keep the original D-Bus sender alive until the notification closes.
          timeout: 0,
        };
        const result = await this.deliver(command);
        const action = result?.trim().split(/\r?\n/).at(-1);
        if (targetUrl && action === 'default' && !this.abort.signal.aborted) {
          await this.run({ file: 'xdg-open', args: [targetUrl] }, this.abort.signal);
        }
        return;
      }
      default:
        throw new Error(`Desktop notifications are not supported on ${this.platform}`);
    }
  }

  async dismiss(): Promise<void> {
    // Cancel preparation too, before an asynchronous URL lookup or helper install can deliver.
    this.dismissalRevision += 1;
    await Promise.all(
      [...this.delivered].map((notification) => {
        notification.dismissal ??= this.dismissNotification(notification).finally(() => {
          notification.dismissal = undefined;
        });
        return notification.dismissal;
      })
    );
  }

  private async dismissNotification(notification: DeliveredNotification): Promise<void> {
    // macOS/Windows signal acceptance on command exit. Linux prints its ID before waiting for closure.
    await notification.ready;
    const identifier = notification.identifier;
    if (identifier) {
      switch (this.platform) {
        case 'darwin':
          if (!this.macOSHelper)
            throw new Error('Varro notification helper storage is unavailable.');
          await this.run(
            { file: await this.macOSHelper.executable(), args: ['--dismiss', identifier] },
            this.abort.signal
          );
          break;
        case 'win32':
          await this.run(
            this.windowsCommand(WINDOWS_DISMISS_SCRIPT, {
              VARRO_NOTIFICATION_ID: identifier,
              VARRO_NOTIFICATION_APP_ID: this.windowsAppId,
            }),
            this.abort.signal
          );
          break;
        case 'linux':
          // GNOME rejects CloseNotification from a different sender. notify-send's SIGINT
          // handler closes through its original connection, then exits its wait loop.
          notification.close?.();
          await notification.completion;
          break;
      }
    }
    this.delivered.delete(notification);
  }

  private async deliver(command: NotificationCommand, identifier?: string): Promise<string | void> {
    let accepted = () => {};
    const notification: DeliveredNotification = {
      identifier,
      ready: new Promise<void>((resolve) => {
        accepted = resolve;
      }),
    };
    this.delivered.add(notification);
    let acceptanceTimer: ReturnType<typeof setTimeout> | undefined;
    let output = '';
    const readLinuxID = (chunk: string) => {
      if (notification.identifier) return;
      output += chunk;
      const line = output.split(/\r?\n/, 1)[0];
      if (!line || !/^[1-9]\d{0,9}$/.test(line) || Number(line) > 0xffff_ffff) return;
      // Wait for a complete line so chunked stdout cannot turn ID 123 into ID 1.
      if (!output.includes('\n')) return;
      notification.identifier = line;
      clearTimeout(acceptanceTimer);
      accepted();
    };
    if (this.platform === 'linux') {
      command.onStdout = readLinuxID;
      command.onStarted = (close) => {
        notification.close = close;
      };
      // Waiting for the user is unbounded, but delivery acceptance must remain bounded.
      acceptanceTimer = setTimeout(() => notification.close?.(), 10_000);
    }
    try {
      notification.completion = this.run(command, this.abort.signal);
      const result = await notification.completion;
      if (this.platform === 'linux' && result) readLinuxID(result);
      return result;
    } finally {
      clearTimeout(acceptanceTimer);
      accepted();
      // A Linux command ends only when its notification closes or delivery fails.
      if (this.platform === 'linux') this.delivered.delete(notification);
    }
  }

  async playSound(): Promise<void> {
    switch (this.platform) {
      case 'darwin':
        await this.run({ file: '/usr/bin/afplay', args: [this.soundPath] }, this.abort.signal);
        return;
      case 'win32':
        await this.run(
          this.windowsCommand(WINDOWS_SOUND_SCRIPT, {
            VARRO_NOTIFICATION_SOUND: this.soundPath,
          }),
          this.abort.signal
        );
        return;
      case 'linux': {
        const errors: unknown[] = [];
        for (const file of ['paplay', 'aplay']) {
          try {
            await this.run({ file, args: [this.soundPath] }, this.abort.signal);
            return;
          } catch (error: unknown) {
            if (this.abort.signal.aborted) throw error;
            errors.push(error);
          }
        }
        try {
          await this.run(
            { file: 'canberra-gtk-play', args: ['--id=message-new-instant'] },
            this.abort.signal
          );
          return;
        } catch (error: unknown) {
          errors.push(error);
          throw new AggregateError(
            errors,
            'Could not play notification sound. Install paplay, aplay, or canberra-gtk-play and check the desktop audio service.',
            { cause: error }
          );
        }
      }
      default:
        throw new Error(`Notification sounds are not supported on ${this.platform}`);
    }
  }

  dispose(): void {
    this.abort.abort();
    this.delivered.clear();
  }

  private windowsCommand(script: string, env: NodeJS.ProcessEnv): NotificationCommand {
    return {
      file: join(
        process.env.SystemRoot || 'C:\\Windows',
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe'
      ),
      args: [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
      env,
    };
  }
}
