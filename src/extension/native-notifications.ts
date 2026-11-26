import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { asRecord } from '../shared/type-utils';
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
  /** `close` returns false when the operating system denies signalling the command. */
  onStarted?: (close: () => boolean) => void;
}

interface DeliveredNotification {
  identifier?: string;
  ready: Promise<void>;
  dismissal?: Promise<void>;
  /** Returns false when a waiting notify-send cannot be closed through its own connection. */
  close?: () => boolean;
  completion?: Promise<string | void>;
}

interface DeliveryOptions {
  identifier?: string;
  readIdentifier?: (output: string) => string | undefined;
  /** The command keeps its notification open and owns it until the notification closes. */
  waiting?: boolean;
}

type RunNotificationCommand = (
  command: NotificationCommand,
  signal: AbortSignal
) => Promise<string | void>;

type LinuxNotificationBackend = 'notify-send' | 'gdbus';

const APPARMOR_PROFILES = '/sys/kernel/security/apparmor/policy/profiles';
const NOTIFICATIONS_INTERFACE = 'org.freedesktop.Notifications';
const NOTIFICATIONS_CALL = [
  'call',
  '--session',
  '--dest',
  NOTIFICATIONS_INTERFACE,
  '--object-path',
  '/org/freedesktop/Notifications',
  '--method',
];

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
      if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
        return true;
      }
      // ChildProcess.kill() reports denial as a command failure, which would hide the result
      // of a still-running notify-send.
      try {
        process.kill(child.pid, 'SIGINT');
        return true;
      } catch (error: unknown) {
        return asRecord(error)?.code === 'ESRCH';
      }
    });
  });
}

function escapeMarkup(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** Quotes text as a GVariant string literal, which gdbus parses before sending. */
function gvariantString(value: string): string {
  const escaped = value.replaceAll(/[\\']|\p{Cc}/gu, (char) =>
    char === '\\' || char === "'"
      ? `\\${char}`
      : `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
  );
  return `'${escaped}'`;
}

function validNotificationID(value: string | undefined): string | undefined {
  return value && /^[1-9]\d{0,9}$/.test(value) && Number(value) <= 0xffff_ffff ? value : undefined;
}

function readNotifySendID(output: string): string | undefined {
  // Wait for a complete line so chunked stdout cannot turn ID 123 into ID 1.
  if (!output.includes('\n')) return undefined;
  return validNotificationID(output.split(/\r?\n/, 1)[0]);
}

function readGDBusNotificationID(output: string): string | undefined {
  return validNotificationID(/^\(uint32 (\d+),\)$/.exec(output.trim())?.[1]);
}

/**
 * Ubuntu's notify-send AppArmor profile denies signals from VS Code and its own
 * CloseNotification call, so a waiting notify-send could never be closed or report a click.
 */
export async function isNotifySendConfined(profiles = APPARMOR_PROFILES): Promise<boolean> {
  let entries: string[];
  try {
    entries = await readdir(profiles);
  } catch {
    // No readable AppArmor policy means notify-send is not confined by AppArmor.
    return false;
  }
  for (const entry of entries) {
    if (!entry.includes('notify-send')) continue;
    try {
      const [name, mode] = await Promise.all([
        readFile(join(profiles, entry, 'name'), 'utf8'),
        readFile(join(profiles, entry, 'mode'), 'utf8'),
      ]);
      if (
        /(?:^|\/)notify-send$/.test(name.trim()) &&
        !['complain', 'unconfined'].includes(mode.trim())
      ) {
        return true;
      }
    } catch {
      // Profiles can be replaced while listing; a vanished profile cannot confine anything.
    }
  }
  return false;
}

/** Desktop-side commands; callers must not invoke this on a remote extension host. */
export class NativeNotifications implements AttentionNotificationTransport {
  private readonly abort = new AbortController();
  private readonly macOSHelper: MacOSNotificationHelper | undefined;
  private readonly delivered = new Set<DeliveredNotification>();
  private dismissalRevision = 0;
  private linuxBackend: Promise<LinuxNotificationBackend> | undefined;

  constructor(
    private readonly soundPath: string,
    private readonly windowsAppId: string,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly run: RunNotificationCommand = runNotificationCommand,
    storageDirectory?: string,
    private readonly notificationUrlFor?: (sessionID: string) => Promise<string>,
    private readonly notifySendConfined: () => Promise<boolean> = isNotifySendConfined
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
          { identifier }
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
          { identifier }
        );
        return;
      }
      case 'linux': {
        const body = `${escapeMarkup(chatTitle)}\n${escapeMarkup(message)}`;
        const backend = await this.linuxNotificationBackend();
        if (revision !== this.dismissalRevision || this.abort.signal.aborted) return;
        if (backend === 'gdbus') {
          // gdbus exits after Notify, so any sender may close the notification later.
          // Without a live sender there is no click action to wait for.
          await this.deliver(
            {
              file: 'gdbus',
              args: [
                ...NOTIFICATIONS_CALL,
                `${NOTIFICATIONS_INTERFACE}.Notify`,
                gvariantString('Varro'),
                'uint32 0',
                gvariantString('dialog-information'),
                gvariantString(projectName),
                gvariantString(body),
                '@as []',
                "{'suppress-sound': <true>}",
                'int32 -1',
              ],
            },
            { readIdentifier: readGDBusNotificationID }
          );
          return;
        }
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
            body,
          ],
          // Keep the original D-Bus sender alive until the notification closes.
          timeout: 0,
        };
        const result = await this.deliver(command, {
          readIdentifier: readNotifySendID,
          waiting: true,
        });
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
          // GNOME rejects CloseNotification from a different sender while that sender is
          // connected. notify-send's SIGINT handler closes through its original connection,
          // then exits its wait loop. A gdbus sender has already disconnected.
          if (notification.close?.()) await notification.completion;
          else await this.closeLinuxNotification(identifier);
          break;
      }
    }
    this.delivered.delete(notification);
  }

  private linuxNotificationBackend(): Promise<LinuxNotificationBackend> {
    this.linuxBackend ??= this.notifySendConfined().then(
      (confined) => (confined ? 'gdbus' : 'notify-send'),
      () => 'notify-send'
    );
    return this.linuxBackend;
  }

  private async closeLinuxNotification(identifier: string): Promise<void> {
    try {
      await this.run(
        {
          file: 'gdbus',
          args: [
            ...NOTIFICATIONS_CALL,
            `${NOTIFICATIONS_INTERFACE}.CloseNotification`,
            `uint32 ${identifier}`,
          ],
        },
        this.abort.signal
      );
    } catch {
      // Best effort: servers report notifications the user already closed as invalid IDs,
      // and retrying those on every focus return would never succeed.
    }
  }

  private async deliver(
    command: NotificationCommand,
    options: DeliveryOptions
  ): Promise<string | void> {
    let accepted = () => {};
    const notification: DeliveredNotification = {
      identifier: options.identifier,
      ready: new Promise<void>((resolve) => {
        accepted = resolve;
      }),
    };
    this.delivered.add(notification);
    let acceptanceTimer: ReturnType<typeof setTimeout> | undefined;
    let output = '';
    const readIdentifier = (text: string) => {
      if (notification.identifier) return;
      const identifier = options.readIdentifier?.(text);
      if (!identifier) return;
      notification.identifier = identifier;
      clearTimeout(acceptanceTimer);
      accepted();
    };
    if (options.waiting) {
      command.onStdout = (chunk) => {
        output += chunk;
        readIdentifier(output);
      };
      command.onStarted = (signalClose) => {
        notification.close = () => {
          if (signalClose()) return true;
          // A confined notify-send outlives any attempt to close it. Stop tracking it and
          // send later notifications through gdbus, which this window can close.
          this.linuxBackend = Promise.resolve('gdbus');
          this.delivered.delete(notification);
          clearTimeout(acceptanceTimer);
          accepted();
          return false;
        };
      };
      // Waiting for the user is unbounded, but delivery acceptance must remain bounded.
      acceptanceTimer = setTimeout(() => notification.close?.(), 10_000);
    }
    try {
      notification.completion = this.run(command, this.abort.signal);
      const result = await notification.completion;
      if (result) readIdentifier(result);
      return result;
    } finally {
      clearTimeout(acceptanceTimer);
      accepted();
      // A waiting command ends only when its notification closes or delivery fails.
      if (options.waiting) this.delivered.delete(notification);
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
