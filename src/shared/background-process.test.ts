import { describe, expect, it } from 'vitest';
import { parseBackgroundProcess, parseBackgroundProcessOutput } from './background-process';

describe('background process protocol', () => {
  it('validates details and strips unrelated fields', () => {
    const process = {
      id: 'shell-1',
      status: 'exited',
      command: 'npm test',
      cwd: '/repo',
      pid: 42,
      exit: 0,
      time: { started: 100, completed: 200 },
    };
    expect(parseBackgroundProcess({ ...process, metadata: { secret: true } })).toEqual(process);
    expect(parseBackgroundProcess({ ...process, status: 'unknown' })).toBeNull();
    expect(parseBackgroundProcess({ ...process, time: { started: NaN } })).toBeNull();
    expect(parseBackgroundProcess({ ...process, pid: '42' })).toBeNull();
    expect(parseBackgroundProcess(null)).toBeNull();
  });

  it('requires non-negative byte cursors and a consistent output size', () => {
    const output = { output: 'hello', cursor: 5, size: 5, truncated: false };
    expect(parseBackgroundProcessOutput(output)).toEqual(output);
    expect(parseBackgroundProcessOutput({ ...output, cursor: -1 })).toBeNull();
    expect(parseBackgroundProcessOutput({ ...output, cursor: 6 })).toBeNull();
    expect(parseBackgroundProcessOutput({ ...output, size: Infinity })).toBeNull();
    expect(parseBackgroundProcessOutput({ ...output, truncated: 'false' })).toBeNull();
  });
});
