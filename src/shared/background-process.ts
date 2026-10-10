import { asRecord, isBoolean, isNumber, isString } from './type-utils';

export const BACKGROUND_OUTPUT_CHUNK_BYTES = 64 * 1024;
export const BACKGROUND_COMMAND_SUMMARY_CHARS = 512;

export type BackgroundProcess = {
  id: string;
  status: 'running' | 'exited' | 'timeout' | 'killed';
  command: string;
  cwd: string;
  pid?: number;
  exit?: number;
  signal?: string;
  time: { started: number; completed?: number };
};

export type BackgroundProcessOutput = {
  output: string;
  cursor: number;
  size: number;
  truncated: boolean;
};

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This parser validates untrusted process details at the REST response boundary.
export function parseBackgroundProcess(value: unknown): BackgroundProcess | null {
  const record = asRecord(value);
  const time = asRecord(record?.time);
  if (
    !record ||
    !isString(record.id) ||
    !isString(record.command) ||
    !isString(record.cwd) ||
    !time ||
    !isNumber(time.started) ||
    !Number.isFinite(time.started) ||
    (time.completed !== undefined &&
      (!isNumber(time.completed) || !Number.isFinite(time.completed))) ||
    (record.status !== 'running' &&
      record.status !== 'exited' &&
      record.status !== 'timeout' &&
      record.status !== 'killed') ||
    (record.pid !== undefined && !isNumber(record.pid)) ||
    (record.exit !== undefined && !isNumber(record.exit)) ||
    (record.signal !== undefined && !isString(record.signal))
  )
    return null;
  return {
    id: record.id,
    status: record.status,
    command: record.command,
    cwd: record.cwd,
    pid: record.pid,
    exit: record.exit,
    signal: record.signal,
    time: { started: time.started, completed: time.completed },
  };
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This parser validates untrusted log output at the REST response boundary.
export function parseBackgroundProcessOutput(value: unknown): BackgroundProcessOutput | null {
  const record = asRecord(value);
  if (
    !record ||
    !isString(record.output) ||
    !isNumber(record.cursor) ||
    !Number.isSafeInteger(record.cursor) ||
    record.cursor < 0 ||
    !isNumber(record.size) ||
    !Number.isSafeInteger(record.size) ||
    record.size < record.cursor ||
    !isBoolean(record.truncated)
  )
    return null;
  return {
    output: record.output,
    cursor: record.cursor,
    size: record.size,
    truncated: record.truncated,
  };
}
