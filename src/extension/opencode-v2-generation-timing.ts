/* oxlint-disable anti-slop/no-unknown-parameters -- Durable log and live event payloads are validated at this boundary. */
import type { SessionMessageAssistant, SessionMessageInfo } from '@opencode/client';
import { createHash } from 'node:crypto';
import { asRecord, isNumber, isString, type UnknownRecord } from '../shared/type-utils';
import { logger } from './logger';
import { v2PartId, type ProjectedV2Message } from './opencode-v2-projection';
import type { OpenCodeV2SessionState } from './opencode-v2-session-state';

type Boundary = { start?: number; end?: number; textHash?: string; startSequence?: number };
type SessionTiming = {
  parts: Map<string, Boundary>;
  sequence?: number;
  historySequence: number;
  through: number;
  stored?: Promise<void>;
};

/** Server-observed block boundaries support estimates, not provider/token-level TPS. */
export class OpenCodeV2GenerationTiming {
  private readonly sessions = new Map<string, SessionTiming>();
  private readonly loads = new Map<string, Promise<void>>();
  private readonly writes = new Map<string, Promise<void>>();

  constructor(private readonly persistence?: Pick<OpenCodeV2SessionState, 'read' | 'update'>) {}

  reset(): void {
    this.sessions.clear();
    this.loads.clear();
    this.writes.clear();
  }

  observe(type: string, data: UnknownRecord, created: unknown, sequence?: unknown): void {
    if (!isString(data.sessionID)) return;
    if (type === 'session.deleted') {
      this.sessions.delete(data.sessionID);
      return;
    }
    const state = this.state(data.sessionID);
    this.record(state, type, data, created, sequence);
    if (/^session\.(text|reasoning)\.ended$/.test(type)) this.save(data.sessionID, state);
  }

  time(sessionID: string, partID: string, text: string): Boundary | undefined {
    const boundary = this.sessions.get(sessionID)?.parts.get(partID);
    return boundary?.start !== undefined &&
      boundary.end !== undefined &&
      boundary.textHash === hash(text)
      ? { start: boundary.start, end: boundary.end }
      : undefined;
  }

  apply(message: ProjectedV2Message): void {
    if (!isString(message.info.sessionID)) return;
    for (const part of message.parts) {
      if (
        (part.type !== 'text' && part.type !== 'reasoning') ||
        !isString(part.id) ||
        !isString(part.text)
      )
        continue;
      const time = this.time(message.info.sessionID, part.id, part.text);
      if (time) part.time = time;
    }
  }

  async restore(
    sessionID: string,
    messages: readonly SessionMessageInfo[],
    read: (after: number) => Promise<string>,
    signal?: AbortSignal
  ): Promise<void> {
    const candidates = messages.filter(
      (message): message is SessionMessageAssistant =>
        message.type === 'assistant' &&
        !!message.time.completed &&
        !message.error &&
        !!message.tokens &&
        message.tokens.output + message.tokens.reasoning > 0 &&
        !message.content.some((content) => content.type === 'tool')
    );
    if (!candidates.length) return;
    const through = Math.max(...candidates.map((message) => message.time.completed ?? 0));
    const state = this.state(sessionID);
    await this.loadStored(sessionID, state);
    await this.writes.get(sessionID);
    signal?.throwIfAborted();
    if (
      candidates.every((message) => {
        const ordinals = { text: 0, reasoning: 0 };
        return message.content.every(
          (content) =>
            content.type !== 'tool' &&
            !!this.time(
              sessionID,
              v2PartId(message.id, content.type, ordinals[content.type]++),
              content.text
            )
        );
      })
    ) {
      state.through = Math.max(state.through, through);
      return;
    }
    if (state.through >= through) return;
    const pending = this.loads.get(sessionID);
    if (pending) {
      await pending;
      signal?.throwIfAborted();
      if (state.through >= through) return;
    }
    const load = (async () => {
      try {
        const value = await read(state.historySequence);
        signal?.throwIfAborted();
        const events = parseLog(value, sessionID);
        // Replay into a fresh state: never trust a partial live stream as history coverage.
        const restored: SessionTiming = {
          ...state,
          sequence: state.historySequence || undefined,
          parts: new Map(state.parts),
        };
        for (const event of events) {
          const data = asRecord(event.data);
          const durable = asRecord(event.durable);
          const seq = durable?.seq;
          if (
            data?.sessionID !== sessionID ||
            durable?.aggregateID !== sessionID ||
            !isString(event.type) ||
            !isNumber(seq) ||
            !Number.isSafeInteger(seq) ||
            seq <= (restored.sequence ?? 0)
          )
            throw new Error('Invalid OpenCode generation timing log event');
          this.record(restored, event.type, data, event.created, seq);
          restored.historySequence = seq;
        }
        if (this.sessions.get(sessionID) !== state) return;
        state.parts = restored.parts;
        state.historySequence = restored.historySequence;
        state.sequence = Math.max(state.sequence ?? 0, restored.sequence ?? 0);
        state.through = through;
        this.save(sessionID, state);
      } catch (error) {
        signal?.throwIfAborted();
        // Timing is optional. A missing/bounded log must not prevent transcript loading.
        state.through = through;
        logger.warn(
          `Could not restore OpenCode generation timing: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    })();
    this.loads.set(sessionID, load);
    try {
      await load;
      await this.writes.get(sessionID);
      signal?.throwIfAborted();
    } finally {
      if (this.loads.get(sessionID) === load) this.loads.delete(sessionID);
    }
  }

  private state(sessionID: string): SessionTiming {
    const existing = this.sessions.get(sessionID);
    if (existing) return existing;
    const state: SessionTiming = { parts: new Map(), historySequence: 0, through: 0 };
    this.sessions.set(sessionID, state);
    while (this.sessions.size > 64) this.sessions.delete(this.sessions.keys().next().value!);
    return state;
  }

  private loadStored(sessionID: string, state: SessionTiming): Promise<void> {
    state.stored ??= (async () => {
      if (!this.persistence) return;
      try {
        const stored = asRecord((await this.persistence.read(sessionID)).generationTiming);
        for (const [id, value] of Object.entries(stored ?? {}).slice(-512)) {
          const boundary = asRecord(value);
          if (
            state.parts.has(id) ||
            !isNumber(boundary?.start) ||
            !isNumber(boundary.end) ||
            !Number.isFinite(boundary.start) ||
            !Number.isFinite(boundary.end) ||
            boundary.end <= boundary.start ||
            !isString(boundary.textHash) ||
            !/^[a-f0-9]{64}$/.test(boundary.textHash)
          )
            continue;
          state.parts.set(id, {
            start: boundary.start,
            end: boundary.end,
            textHash: boundary.textHash,
            startSequence: isNumber(boundary.startSequence) ? boundary.startSequence : undefined,
          });
        }
      } catch (error) {
        logger.warn(
          `Could not read Varro generation timing: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    })();
    return state.stored;
  }

  private save(sessionID: string, state: SessionTiming): void {
    if (!this.persistence) return;
    const write = (async () => {
      await this.writes.get(sessionID);
      await this.loadStored(sessionID, state);
      if (this.sessions.get(sessionID) !== state) return;
      const completed = [...state.parts]
        .filter(([, boundary]) => boundary.end !== undefined)
        .slice(-512);
      if (completed.length)
        await this.persistence?.update(sessionID, {
          generationTiming: Object.fromEntries(completed),
        });
    })().catch((error: unknown) => {
      logger.warn(
        `Could not save Varro generation timing: ${error instanceof Error ? error.message : String(error)}`
      );
    });
    this.writes.set(sessionID, write);
    void write.then(() => {
      if (this.writes.get(sessionID) === write) this.writes.delete(sessionID);
    });
  }

  private record(
    state: SessionTiming,
    type: string,
    data: UnknownRecord,
    created: unknown,
    sequence: unknown
  ): void {
    if (isNumber(sequence) && Number.isSafeInteger(sequence)) {
      if (state.sequence !== undefined && sequence <= state.sequence) return;
      if (state.sequence !== undefined && sequence !== state.sequence + 1) {
        for (const [id, boundary] of state.parts) {
          if (boundary.end === undefined) state.parts.delete(id);
        }
      }
      state.sequence = sequence;
    }
    const match = /^session\.(text|reasoning)\.(started|ended)$/.exec(type);
    if (
      !match ||
      !isNumber(sequence) ||
      !Number.isSafeInteger(sequence) ||
      !isString(data.assistantMessageID) ||
      !isNumber(data.ordinal) ||
      !Number.isSafeInteger(data.ordinal) ||
      data.ordinal < 0 ||
      !isNumber(created) ||
      !Number.isFinite(created)
    )
      return;
    const id = v2PartId(data.assistantMessageID, match[1]!, data.ordinal);
    const existing = state.parts.get(id);
    if (match[2] === 'started') {
      // A second distinct start is ambiguous; do not turn it into a fresh valid interval.
      if (existing?.startSequence === sequence && existing.start === created) return;
      state.parts.set(id, existing ? {} : { start: created, startSequence: sequence });
    } else if (existing?.start !== undefined && created > existing.start && isString(data.text)) {
      state.parts.set(id, {
        start: existing.start,
        startSequence: existing.startSequence,
        end: created,
        textHash: hash(data.text),
      });
    }
    while (state.parts.size > 4096) state.parts.delete(state.parts.keys().next().value!);
  }
}

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function parseLog(value: unknown, sessionID: string): UnknownRecord[] {
  if (!isString(value)) throw new Error('Invalid OpenCode generation timing log');
  const events: UnknownRecord[] = [];
  let synced = false;
  // Finite /log?follow=false replies are bounded by the authenticated transport.
  for (const frame of value.replaceAll('\r\n', '\n').split('\n\n')) {
    const data = frame
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data) continue;
    const event = asRecord(JSON.parse(data));
    if (!event || synced) throw new Error('Invalid OpenCode generation timing log frame');
    if (event.type === 'log.synced') {
      if (event.aggregateID !== sessionID)
        throw new Error('OpenCode timing log belongs to another session');
      synced = true;
    } else events.push(event);
  }
  if (!synced) throw new Error('Incomplete OpenCode generation timing log');
  return events;
}
