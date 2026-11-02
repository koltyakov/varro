import { watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import type { DictationRecordingState } from '../shared/protocol';

const MAX_READ_BYTES = 64 * 1024;
const EVENT_COALESCE_MS = 100;

interface LogCursor {
  path: string;
  dev: number;
  ino: number;
  position: number;
  mtimeMs: number;
  partial: string;
}

/** Read-only, bounded lifecycle observation. No watcher or timer exists while idle. */
export class HandyRecordingStateReader {
  state: DictationRecordingState = 'unknown';
  revision = 0;
  observation = 0;
  private cursor: LogCursor | undefined;
  private reading: Promise<DictationRecordingState> | undefined;
  private watcher: FSWatcher | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  private disposed = false;
  private listener: ((state: DictationRecordingState) => void) | undefined;

  constructor(private readonly getPath: () => string | undefined) {}

  read(): Promise<DictationRecordingState> {
    // File events and explicit clicks share one ordered reader. A click always
    // takes its own fresh snapshot after an already-running event read finishes.
    const operation = (this.reading ?? Promise.resolve()).then(() => this.readLog());
    this.reading = operation;
    void operation.then(() => {
      if (this.reading === operation) this.reading = undefined;
    });
    return operation;
  }

  watch(listener: (state: DictationRecordingState) => void): boolean {
    if (this.disposed) return false;
    // Logging is optional. Never watch for a log that was not readable during
    // the user's explicit command.
    if (!this.cursor) return false;
    this.listener = listener;
    if (this.watcher) return true;
    let path: string | undefined;
    try {
      path = this.getPath();
    } catch {
      // Invalid optional logging configuration must not fail a mic command.
      return false;
    }
    if (!path) return false;
    const generation = ++this.generation;
    let inFlight = false;
    let dirty = false;
    let published = this.state;
    const schedule = () => {
      if (generation !== this.generation || this.disposed) return;
      if (inFlight) {
        dirty = true;
        return;
      }
      if (this.timer) return;
      this.timer = setTimeout(() => {
        this.timer = undefined;
        inFlight = true;
        void this.read().then((state) => {
          inFlight = false;
          if (generation !== this.generation || this.disposed) return;
          const notify = this.listener;
          if (state === 'idle' || state === 'unknown') this.stopWatching();
          if (state !== published) {
            published = state;
            notify?.(state);
          }
          if (dirty) {
            dirty = false;
            schedule();
          }
        });
      }, EVENT_COALESCE_MS);
      this.timer.unref();
    };
    try {
      // Watching the directory survives log rotation on Windows, Linux and macOS.
      this.watcher = watch(dirname(path), { persistent: false }, (_event, name) => {
        if (name === null || name.toString() === basename(path)) schedule();
      });
      this.watcher.on('error', () => {
        if (generation !== this.generation) return;
        const notify = this.listener;
        this.reset('unknown');
        notify?.('unknown');
      });
      schedule(); // Close the gap between the command acknowledgement and watch registration.
      return true;
    } catch {
      this.reset('unknown');
      return false;
    }
  }

  stopWatching(): void {
    this.generation++;
    this.watcher?.close();
    this.watcher = undefined;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.listener = undefined;
  }

  reset(state: DictationRecordingState): void {
    this.stopWatching();
    this.cursor = undefined;
    this.setState(state);
  }

  assume(state: DictationRecordingState): void {
    // Preserve the byte cursor: old log lines must not undo a newer command
    // when logging is disabled or omits this transition.
    this.setState(state);
  }

  dispose(): void {
    this.disposed = true;
    this.reset('unknown');
  }

  private setState(state: DictationRecordingState): DictationRecordingState {
    if (this.state !== state) {
      this.state = state;
      this.revision++;
    }
    return state;
  }

  private async readLog(): Promise<DictationRecordingState> {
    if (this.disposed) return 'unknown';
    try {
      const path = this.getPath();
      if (!path) return this.setState('unknown');
      const file = await open(path, 'r');
      try {
        const metadata = await file.stat();
        const previous = this.cursor;
        const continuous =
          previous?.path === path &&
          previous.dev === metadata.dev &&
          previous.ino === metadata.ino &&
          metadata.size >= previous.position &&
          !(metadata.size === previous.position && metadata.mtimeMs !== previous.mtimeMs);
        const start = continuous ? previous.position : 0;
        if (continuous && metadata.size === start) return this.state;
        const offset = Math.max(start, metadata.size - MAX_READ_BYTES);
        const buffer = Buffer.alloc(metadata.size - offset);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
        if (this.disposed) return 'unknown';
        const complete = continuous && offset === start;
        const text = (complete ? previous.partial : '') + buffer.toString('utf8', 0, bytesRead);
        const lines = text.split('\n');
        if (!complete && offset > 0) lines.shift();
        const partial = lines.pop() ?? '';
        this.cursor = {
          path,
          dev: metadata.dev,
          ino: metadata.ino,
          position: offset + bytesRead,
          mtimeMs: metadata.mtimeMs,
          partial: partial.slice(0, MAX_READ_BYTES),
        };
        let state: DictationRecordingState = complete ? this.state : 'unknown';
        for (const line of lines) {
          const observed = readLifecycleLine(line.trimEnd());
          if (observed !== undefined) {
            state = observed;
            this.observation++;
          }
        }
        return this.setState(state);
      } finally {
        await file.close();
      }
    } catch {
      // Missing, rotated-away or unreadable logs are not evidence of idle.
      this.cursor = undefined;
      return this.setState('unknown');
    }
  }
}

function readLifecycleLine(line: string): DictationRecordingState | undefined {
  const match = line.match(
    /^\[\d{4}-\d{2}-\d{2}\]\[\d{2}:\d{2}:\d{2}\]\[handy_app_lib::(tray|utils|actions|managers::audio)\]\[(?:DEBUG|INFO|WARN|ERROR)\] (.*)$/
  );
  if (!match) return;
  const [, source, message] = match;
  if (!message) return;
  if (source === 'tray') {
    const icon = message.match(
      /^tray apply: icon=resources\/(?:tray_)?(idle|handy|recording|transcribing)(?:_dark)?\.png /
    );
    if (icon?.[1] === 'recording') return 'recording';
    if (icon?.[1] === 'transcribing') return 'processing';
    if (icon || /^tray apply: .* busy=false /.test(message)) return 'idle';
  } else if (
    source === 'utils' &&
    message === 'Operation cancellation completed - returned to idle state'
  ) {
    return 'idle';
  } else if (
    source === 'actions' &&
    message.startsWith('TranscribeAction::stop called for binding: ')
  ) {
    return 'processing';
  } else if (source === 'actions' && message.startsWith('Text pasted successfully')) {
    return 'idle';
  } else if (source === 'managers::audio' && message.startsWith('Recording started for binding ')) {
    return 'recording';
  }
  return undefined;
}
