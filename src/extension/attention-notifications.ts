import type { PendingAttentionEntry } from './session-state-manager';

type NotificationKind = PendingAttentionEntry['kind'] | CompletedNotification['kind'];

export interface AttentionNotificationSettings {
  sound: Record<NotificationKind, boolean>;
  native: boolean;
}

export interface AttentionNotificationTransport {
  isEditorVisible(): Promise<boolean>;
  show(notification: AttentionNotification): Promise<void>;
  playSound(): Promise<void>;
  dispose(): void;
}

export interface AttentionNotification {
  projectName: string;
  chatTitle: string;
  message: string;
  sessionID: string;
}

export interface AttentionNotificationHost {
  getPending(): ReadonlyMap<string, PendingAttentionEntry>;
  completionRevisionFor(sessionID: string): number | undefined;
  getSettings(): AttentionNotificationSettings;
  isFocused(): boolean;
  isInScope(sessionID: string): boolean;
  titleFor(sessionID: string): string | undefined;
  projectNameFor(sessionID: string): string | undefined;
  reportError(channel: 'sound' | 'native', error: Error): void;
}

interface CompletedNotification {
  sessionID: string;
  kind: 'completed' | 'plan-ready';
  revision: number;
}

/** Batches actionable requests and live root-turn completions from the extension host. */
export class AttentionNotifications {
  private readonly observed = new Set<string>();
  private readonly queued = new Set<string>();
  private readonly completions = new Map<string, CompletedNotification>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private nextDeliveryAt = 0;
  private disposed = false;
  private checkingVisibility = false;

  constructor(
    private readonly host: AttentionNotificationHost,
    private readonly transport: AttentionNotificationTransport
  ) {}

  complete(sessionID: string, kind: CompletedNotification['kind']): void {
    if (this.disposed) return;
    const settings = this.host.getSettings();
    if (!this.isEventEnabled(kind, settings) || !this.shouldNotify(sessionID)) return;
    const revision = this.host.completionRevisionFor(sessionID);
    if (revision === undefined) return;
    this.completions.set(sessionID, { sessionID, kind, revision });
    this.update();
  }

  update(): void {
    if (this.disposed) return;
    const pending = this.host.getPending();
    const settings = this.host.getSettings();
    for (const id of this.observed) {
      if (!pending.has(id)) this.observed.delete(id);
    }
    for (const id of this.queued) {
      const request = pending.get(id);
      if (
        !request ||
        !this.isEventEnabled(request.kind, settings) ||
        !this.host.isInScope(request.sessionID) ||
        this.host.isFocused()
      ) {
        this.queued.delete(id);
      }
    }
    for (const [id, completion] of this.completions) {
      if (
        !this.isCurrentCompletion(completion) ||
        !this.isEventEnabled(completion.kind, settings)
      ) {
        this.completions.delete(id);
      }
    }

    for (const [id, request] of pending) {
      if (this.observed.has(id)) continue;
      this.observed.add(id);
      if (
        this.isEventEnabled(request.kind, settings) &&
        this.host.isInScope(request.sessionID) &&
        !this.host.isFocused()
      ) {
        this.queued.add(id);
      }
    }

    const hasQueuedNotifications = this.queued.size > 0 || this.completions.size > 0;
    if (!hasQueuedNotifications && this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (hasQueuedNotifications && this.timer === undefined && !this.checkingVisibility) {
      // A fixed batching window avoids starvation during a continuous stream of asks.
      this.timer = setTimeout(
        () => {
          void this.deliver();
        },
        Math.max(300, this.nextDeliveryAt - Date.now())
      );
    }
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.queued.clear();
    this.completions.clear();
    this.observed.clear();
    this.transport.dispose();
  }

  private async deliver(): Promise<void> {
    this.timer = undefined;
    if (this.disposed) return;
    this.checkingVisibility = true;
    try {
      if (this.host.isFocused() || (await this.transport.isEditorVisible())) {
        this.queued.clear();
        this.completions.clear();
        return;
      }
      if (!this.disposed) this.deliverHidden();
    } catch (error: unknown) {
      // Without a visibility result, drop this burst rather than interrupt a potentially visible editor.
      this.queued.clear();
      this.completions.clear();
      if (!this.disposed)
        this.host.reportError('native', error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.checkingVisibility = false;
      if (!this.disposed) this.update();
    }
  }

  private deliverHidden(): void {
    const pending = this.host.getPending();
    const settings = this.host.getSettings();
    const requests = [...this.queued].flatMap((id) => {
      const request = pending.get(id);
      return request &&
        this.isEventEnabled(request.kind, settings) &&
        this.host.isInScope(request.sessionID) &&
        !this.host.isFocused()
        ? [request]
        : [];
    });
    this.queued.clear();
    const completions = [...this.completions.values()].filter(
      (completion) =>
        this.isCurrentCompletion(completion) && this.isEventEnabled(completion.kind, settings)
    );
    this.completions.clear();
    const first = requests[0] ?? completions[0];
    if (!first) return;
    this.nextDeliveryAt = Date.now() + 5_000;

    const sessionTitle = this.host
      .titleFor(first.sessionID)
      ?.replaceAll(/\p{Cc}/gu, ' ')
      .trim()
      .slice(0, 180);
    const labels = {
      permission: 'Permission approval needed',
      question: 'Your answer is needed',
      completed: 'Response ready',
      'plan-ready': 'Plan ready for review',
    };
    const events = [...requests, ...completions];
    const descriptions = [
      ...new Set(
        events
          .filter((event) => event.sessionID === first.sessionID)
          .map((event) => labels[event.kind])
      ),
    ];
    const otherChats = new Set(
      events.filter((event) => event.sessionID !== first.sessionID).map((event) => event.sessionID)
    ).size;
    const message = `${descriptions.join('; ')}${otherChats ? `; Updates in ${otherChats} other ${otherChats === 1 ? 'chat' : 'chats'}` : ''}`;

    if (settings.native) {
      const projectName = this.host
        .projectNameFor(first.sessionID)
        ?.replaceAll(/\p{Cc}/gu, ' ')
        .trim()
        .slice(0, 180);
      void this.deliverChannel(
        'native',
        this.transport.show({
          projectName: `Project: ${projectName || 'Varro'}`,
          chatTitle: sessionTitle || 'Untitled chat',
          message,
          sessionID: first.sessionID,
        })
      );
    }
    if ([...requests, ...completions].some((event) => settings.sound[event.kind])) {
      void this.deliverChannel('sound', this.transport.playSound());
    }
  }

  private shouldNotify(sessionID: string): boolean {
    return this.host.isInScope(sessionID) && !this.host.isFocused();
  }

  private isEventEnabled(kind: NotificationKind, settings: AttentionNotificationSettings): boolean {
    return settings.native || settings.sound[kind];
  }

  private isCurrentCompletion(completion: CompletedNotification): boolean {
    return (
      this.host.completionRevisionFor(completion.sessionID) === completion.revision &&
      this.shouldNotify(completion.sessionID)
    );
  }

  private async deliverChannel(
    channel: 'native' | 'sound',
    operation: Promise<void>
  ): Promise<void> {
    try {
      await operation;
    } catch (error: unknown) {
      if (!this.disposed) {
        this.host.reportError(channel, error instanceof Error ? error : new Error(String(error)));
      }
    }
  }
}
