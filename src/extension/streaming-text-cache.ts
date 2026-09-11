/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-parameters -- Persisted text, server events, and storage failures are validated at this boundary. */
import type { Persistence } from '../shared/persistence';
import type { ServerEvent } from '../shared/protocol';
import { asRecord } from '../shared/type-utils';
import { logger } from './logger';

const STORAGE_KEY = 'varro.streamingText';
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_CHARACTERS = 4 * 1024 * 1024;
const MAX_PARTS = 128;

type CachedText = {
  sessionID: string;
  messageID: string;
  id: string;
  type: 'text' | 'reasoning';
  text: string;
  updatedAt: number;
};

// Legacy OpenCode deltas are broadcast without updating the saved message part.
// Keep their accumulated text outside the webview so history reads and reloads can restore it.
export class StreamingTextCache {
  private readonly parts = new Map<string, CachedText>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly persistence: Persistence) {
    const stored = persistence.get<unknown>(STORAGE_KEY);
    if (!Array.isArray(stored)) return;
    for (const value of stored) {
      const part = asRecord(value);
      if (
        !part ||
        typeof part.sessionID !== 'string' ||
        typeof part.messageID !== 'string' ||
        typeof part.id !== 'string' ||
        (part.type !== 'text' && part.type !== 'reasoning') ||
        typeof part.text !== 'string' ||
        typeof part.updatedAt !== 'number' ||
        !Number.isFinite(part.updatedAt)
      )
        continue;
      this.remember({
        sessionID: part.sessionID,
        messageID: part.messageID,
        id: part.id,
        type: part.type,
        text: part.text,
        updatedAt: part.updatedAt,
      });
    }
    this.prune();
  }

  observe(event: ServerEvent) {
    const props = asRecord(event.properties);
    if (!props) return;
    const part = asRecord(props.part);
    const info = asRecord(props.info);
    const sessionID = props.sessionID ?? part?.sessionID ?? info?.sessionID ?? info?.id;
    const messageID = props.messageID ?? props.assistantMessageID ?? part?.messageID ?? info?.id;
    const id = props.partID ?? props.textID ?? props.reasoningID ?? part?.id;
    if (typeof sessionID !== 'string') return;

    if (
      event.type === 'session.deleted' ||
      event.type === 'message.removed' ||
      event.type === 'message.part.removed'
    ) {
      for (const [key, cached] of this.parts) {
        if (cached.sessionID !== sessionID) continue;
        if (event.type !== 'session.deleted' && cached.messageID !== messageID) continue;
        if (event.type === 'message.part.removed' && cached.id !== id) continue;
        this.parts.delete(key);
      }
      this.schedule();
      return;
    }
    if (typeof messageID !== 'string' || typeof id !== 'string') return;
    const key = this.key(sessionID, messageID, id);
    if (event.type === 'message.part.updated') {
      if (
        !part ||
        (part.type !== 'text' && part.type !== 'reasoning') ||
        typeof part.text !== 'string'
      )
        return;
      if (typeof asRecord(part.time)?.end === 'number') this.parts.delete(key);
      else {
        const current = this.parts.get(key);
        this.remember({
          sessionID,
          messageID,
          id,
          type: part.type,
          text: current?.text.startsWith(part.text) ? current.text : part.text,
          updatedAt: Date.now(),
        });
      }
    } else if (
      event.type === 'session.next.text.ended' ||
      event.type === 'session.next.reasoning.ended'
    ) {
      this.parts.delete(key);
    } else if (
      (event.type === 'message.part.delta' && props.field === 'text') ||
      event.type === 'session.next.text.delta' ||
      event.type === 'session.next.reasoning.delta'
    ) {
      if (typeof props.delta !== 'string') return;
      const current = this.parts.get(key);
      this.remember({
        sessionID,
        messageID,
        id,
        type:
          current?.type ?? (event.type === 'session.next.reasoning.delta' ? 'reasoning' : 'text'),
        text: (current?.text ?? '') + props.delta,
        updatedAt: Date.now(),
      });
    } else return;
    this.prune();
    this.schedule();
  }

  restore(info: Record<string, unknown>, parts: Record<string, unknown>[]) {
    if (info.role !== 'assistant' || typeof asRecord(info.time)?.completed === 'number')
      return parts;
    this.prune();
    const restored = [...parts];
    for (const cached of this.parts.values()) {
      if (cached.sessionID !== info.sessionID || cached.messageID !== info.id || !cached.text)
        continue;
      const index = restored.findIndex((part) => part.id === cached.id);
      if (index === -1) {
        const { updatedAt: _updatedAt, ...part } = cached;
        restored.push(part);
        continue;
      }
      const part = restored[index]!;
      if (part.type !== cached.type || typeof asRecord(part.time)?.end === 'number') continue;
      if (typeof part.text !== 'string' || !cached.text.startsWith(part.text)) continue;
      restored[index] = { ...part, text: cached.text };
    }
    return restored;
  }

  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.prune();
    const snapshot = [...this.parts.values()];
    this.writing = this.writing
      .then(async () => {
        await this.persistence.set(STORAGE_KEY, snapshot);
      })
      .catch((error: unknown) => {
        logger.warn(
          `Could not persist streaming text: ${error instanceof Error ? error.message : String(error)}`
        );
      });
    return this.writing;
  }

  private schedule() {
    this.timer ??= setTimeout(() => {
      void this.flush();
    }, 250);
  }

  private key(sessionID: string, messageID: string, id: string) {
    return `${sessionID}\0${messageID}\0${id}`;
  }

  private remember(part: CachedText) {
    const key = this.key(part.sessionID, part.messageID, part.id);
    this.parts.delete(key);
    this.parts.set(key, part);
  }

  private prune() {
    let characters = 0;
    for (const [key, part] of [...this.parts].toReversed()) {
      characters += part.text.length;
      if (Date.now() - part.updatedAt > MAX_AGE_MS || characters > MAX_CHARACTERS)
        this.parts.delete(key);
    }
    while (this.parts.size > MAX_PARTS) {
      const key = this.parts.keys().next().value;
      if (key === undefined) break;
      this.parts.delete(key);
    }
  }
}
