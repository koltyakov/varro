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
  ignoreTimeout?: boolean;
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
$toast.Tag = 'varro-attention'
$toast.Group = 'varro'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($env:VARRO_NOTIFICATION_APP_ID).Show($toast)
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
    execFile(
      command.file,
      command.args,
      {
        env: { ...process.env, ...command.env },
        signal,
        timeout: command.timeout ?? 10_000,
        maxBuffer: 64 * 1024,
        windowsHide: true,
      },
      (error, stdout) => {
        // A Linux banner may expire without an action. Its bounded action listener can end quietly.
        if (error?.killed && command.ignoreTimeout && !signal.aborted) resolve(stdout);
        else if (error)
          reject(
            new Error(`Notification command ${command.file} failed: ${error.message}`, {
              cause: error,
            })
          );
        else resolve(stdout);
      }
    );
  });
}

function escapeMarkup(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** Desktop-side commands; callers must not invoke this on a remote extension host. */
export class NativeNotifications implements AttentionNotificationTransport {
  private readonly abort = new AbortController();
  private readonly macOSHelper: MacOSNotificationHelper | undefined;

  constructor(
    private readonly soundPath: string,
    private readonly windowsAppId: string,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly run: RunNotificationCommand = runNotificationCommand,
    storageDirectory?: string,
    private readonly notificationUrlFor?: (sessionID: string) => Promise<string>,
    private readonly editorProcessID = process.ppid
  ) {
    if (platform === 'darwin' && storageDirectory) {
      this.macOSHelper = new MacOSNotificationHelper(
        dirname(soundPath),
        storageDirectory,
        (file, args) => this.run({ file, args }, this.abort.signal)
      );
    }
  }

  async isEditorVisible(): Promise<boolean> {
    // VS Code supplies the foreground check on every platform. macOS also exposes occlusion.
    if (this.platform !== 'darwin') return false;
    if (!this.macOSHelper) throw new Error('Varro notification helper storage is unavailable.');
    return this.macOSHelper.isEditorVisible(this.editorProcessID);
  }

  async show(notification: AttentionNotification): Promise<void> {
    const { projectName, chatTitle, message, sessionID } = notification;
    const targetUrl = await this.notificationUrlFor?.(sessionID);
    switch (this.platform) {
      case 'darwin':
        if (!this.macOSHelper) throw new Error('Varro notification helper storage is unavailable.');
        await this.run(
          {
            file: await this.macOSHelper.executable(),
            args: [
              '--notify',
              projectName,
              chatTitle,
              message,
              ...(targetUrl ? [randomUUID(), targetUrl] : []),
            ],
            timeout: 50_000,
          },
          this.abort.signal
        );
        return;
      case 'win32':
        await this.run(
          this.windowsCommand(WINDOWS_NOTIFICATION_SCRIPT, {
            VARRO_NOTIFICATION_TITLE: projectName,
            VARRO_NOTIFICATION_SUBTITLE: chatTitle,
            VARRO_NOTIFICATION_MESSAGE: message,
            VARRO_NOTIFICATION_APP_ID: this.windowsAppId,
            VARRO_NOTIFICATION_URL: targetUrl,
          }),
          this.abort.signal
        );
        return;
      case 'linux': {
        const command: NotificationCommand = {
          file: 'notify-send',
          args: [
            '--app-name=Varro',
            '--icon=dialog-information',
            '--hint=boolean:suppress-sound:true',
            ...(targetUrl ? ['--wait', '--action=default=Open project'] : []),
            '--',
            projectName,
            `${escapeMarkup(chatTitle)}\n${escapeMarkup(message)}`,
          ],
        };
        if (targetUrl) {
          command.timeout = 60_000;
          command.ignoreTimeout = true;
        }
        const action = await this.run(command, this.abort.signal);
        if (targetUrl && action?.trim() === 'default' && !this.abort.signal.aborted) {
          await this.run({ file: 'xdg-open', args: [targetUrl] }, this.abort.signal);
        }
        return;
      }
      default:
        throw new Error(`Desktop notifications are not supported on ${this.platform}`);
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
