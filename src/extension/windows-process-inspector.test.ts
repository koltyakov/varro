/* oxlint-disable anti-slop/no-module-mocking -- Exercise the native helper protocol without starting OS processes. */
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock('child_process', () => ({ spawn: spawnMock, default: { spawn: spawnMock } }));
import { WindowsProcessInspector } from './windows-process-inspector';

const inspectors: WindowsProcessInspector[] = [];

function setup() {
  const children: Array<ReturnType<typeof child>> = [];
  function child() {
    return Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
    });
  }
  spawnMock.mockImplementation(() => {
    const worker = child();
    children.push(worker);
    return worker;
  });
  const inspector = new WindowsProcessInspector();
  inspectors.push(inspector);
  return { inspector, children };
}

function respond(worker: ReturnType<typeof setup>['children'][number], birth = 'win32:123') {
  const request = worker.stdin.read()?.toString().trim().split(' ');
  worker.stdout.write(
    JSON.stringify({
      id: Number(request?.[0]),
      details: {
        executable: 'C:\\OpenCode\\opencode.exe',
        birthIdentity: birth,
        listenerSid: 'S-1-5-21-1',
        hostSid: 'S-1-5-21-1',
      },
    }) + '\n'
  );
}

afterEach(() => {
  for (const inspector of inspectors.splice(0)) inspector.dispose();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('Windows native process inspector', () => {
  it('shares in-flight identity/account reads but obtains a fresh identity on the next read', async () => {
    const { inspector, children } = setup();
    const first = inspector.read(1234);
    const shared = inspector.read(1234);
    expect(shared).toBe(first);
    respond(children[0]!);
    await expect(first).resolves.toMatchObject({ birthIdentity: 'win32:123' });
    const next = inspector.read(1234);
    respond(children[0]!, 'win32:456');
    await expect(next).resolves.toMatchObject({ birthIdentity: 'win32:456' });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    // SAFETY: This captured spawn call is created above with a string argument array.
    const args = spawnMock.mock.calls[0]![1] as string[];
    const script = Buffer.from(args.at(-1)!, 'base64').toString('utf16le');
    expect(script).toContain('GetProcessTimes');
    expect(script).toContain('GetExitCodeProcess');
    expect(script).toContain('CloseHandle(process)');
    expect(script).not.toContain('Get-CimInstance');
  });

  it('bounds a stalled helper and restarts it without reusing partial output', async () => {
    vi.useFakeTimers();
    const { inspector, children } = setup();
    const first = inspector.read(1234);
    const rejected = expect(first).rejects.toThrow('timed out');
    children[0]!.stdout.write('{"id":1');
    await vi.advanceTimersByTimeAsync(5000);
    await rejected;
    expect(children[0]!.kill).toHaveBeenCalledOnce();
    const next = inspector.read(1234);
    respond(children[1]!, 'win32:456');
    await expect(next).resolves.toMatchObject({ birthIdentity: 'win32:456' });
  });

  it('rejects every pending inspection when its helper exits', async () => {
    const { inspector, children } = setup();
    const first = expect(inspector.read(1234)).rejects.toThrow('helper exited');
    const second = expect(inspector.read(5678)).rejects.toThrow('helper exited');
    children[0]!.emit('close', 1);
    await Promise.all([first, second]);
  });

  it.each(['not json\n', '{"id":1,"details":{"birthIdentity":"win32:123"}}\n'])(
    'rejects malformed or incomplete output: %s',
    async (output) => {
      const { inspector, children } = setup();
      const rejected = expect(inspector.read(1234)).rejects.toThrow();
      children[0]!.stdout.write(output);
      await rejected;
      expect(children[0]!.kill).toHaveBeenCalledOnce();
    }
  );

  it('rejects a missing process without stopping a healthy helper', async () => {
    const { inspector, children } = setup();
    const rejected = expect(inspector.read(1234)).rejects.toThrow('Access denied');
    children[0]!.stdin.read();
    children[0]!.stdout.write('{"id":1,"error":"Access denied"}\n');
    await rejected;
    const next = inspector.read(5678);
    respond(children[0]!);
    await next;
    expect(spawnMock).toHaveBeenCalledOnce();
  });

  it('releases an idle helper and starts a new one for the next inspection', async () => {
    vi.useFakeTimers();
    const { inspector, children } = setup();
    const first = inspector.read(1234);
    respond(children[0]!);
    await first;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(children[0]!.kill).toHaveBeenCalledOnce();
    const next = inspector.read(1234);
    respond(children[1]!);
    await next;
  });

  it.each([0, -1, 1.5, Number.NaN, 0x80000000])('rejects an invalid PID: %s', async (pid) => {
    const { inspector } = setup();
    await expect(inspector.read(pid)).rejects.toThrow('Invalid Windows process ID');
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
