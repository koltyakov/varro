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
        ancestorPid: Number(request?.[3] ?? 0),
        hostBirthIdentity: 'win32:100',
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
  it('prepares one helper through slow compilation without reading process identity', async () => {
    vi.useFakeTimers();
    const { inspector, children } = setup();
    const preparation = inspector.prepare();
    expect(inspector.prepare()).toBe(preparation);
    expect(children[0]!.stdin.read()).toBeNull();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(children[0]!.kill).not.toHaveBeenCalled();
    children[0]!.stdout.write('{"ready":');
    children[0]!.stdout.write('true}\r\n');
    await preparation;
    await inspector.prepare();
    const inspection = inspector.read(1234);
    respond(children[0]!);
    await expect(inspection).resolves.toMatchObject({ birthIdentity: 'win32:123' });
    expect(spawnMock).toHaveBeenCalledOnce();
    // SAFETY: The helper launch always provides an encoded script as its final argument.
    const args = spawnMock.mock.calls[0]![1] as string[];
    const script = Buffer.from(args.at(-1)!, 'base64').toString('utf16le');
    expect(script.indexOf('[Console]::Out.WriteLine(\'{"ready":true}\')')).toBeGreaterThan(
      script.indexOf("'@")
    );
    expect(script.indexOf('[Console]::Out.WriteLine(\'{"ready":true}\')')).toBeLessThan(
      script.indexOf('while ($null -ne')
    );
  });

  it('bounds preparation and ignores readiness from a retired helper', async () => {
    vi.useFakeTimers();
    const { inspector, children } = setup();
    const rejected = expect(inspector.prepare()).rejects.toThrow(
      'helper startup timed out after 15000ms'
    );
    await vi.advanceTimersByTimeAsync(14_999);
    expect(children[0]!.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(children[0]!.kill).toHaveBeenCalledOnce();
    const next = inspector.prepare();
    let prepared = false;
    void next.then(() => {
      prepared = true;
    });
    children[0]!.stdout.write('{"ready":true}\n');
    await vi.advanceTimersByTimeAsync(0);
    expect(prepared).toBe(false);
    children[1]!.stdout.write('{"ready":true}\n');
    await next;
    expect(prepared).toBe(true);
  });

  it('retains the five-second inspection deadline after preparation', async () => {
    vi.useFakeTimers();
    const { inspector, children } = setup();
    const preparation = inspector.prepare();
    children[0]!.stdout.write('{"ready":true}\n');
    await preparation;
    const rejected = expect(inspector.read(1234)).rejects.toThrow(
      'native process inspection timed out after 5000ms'
    );
    await vi.advanceTimersByTimeAsync(4999);
    expect(children[0]!.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(children[0]!.kill).toHaveBeenCalledOnce();
  });

  it('does not treat readiness as identity or extend an unprepared production read', async () => {
    vi.useFakeTimers();
    const { inspector, children } = setup();
    const rejected = expect(inspector.read(1234)).rejects.toThrow(
      'native process inspection timed out after 5000ms'
    );
    await vi.advanceTimersByTimeAsync(4000);
    children[0]!.stdout.write('{"ready":true}\n');
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;
    expect(children[0]!.kill).toHaveBeenCalledOnce();
  });

  it('rejects preparation too when a concurrent inspection reaches its deadline', async () => {
    vi.useFakeTimers();
    const { inspector, children } = setup();
    const preparation = expect(inspector.prepare()).rejects.toThrow('inspection timed out');
    const inspection = expect(inspector.read(1234)).rejects.toThrow('inspection timed out');
    await vi.advanceTimersByTimeAsync(5000);
    await Promise.all([preparation, inspection]);
    expect(children[0]!.kill).toHaveBeenCalledOnce();
  });

  it.each(['exit', 'dispose'] as const)('rejects preparation on helper %s', async (action) => {
    const { inspector, children } = setup();
    const rejected = expect(inspector.prepare()).rejects.toThrow(
      action === 'exit' ? 'helper exited' : 'inspector stopped'
    );
    if (action === 'exit') children[0]!.emit('close', 1);
    else inspector.dispose();
    await rejected;
  });

  it('retires a prepared but unused helper and prepares a fresh one next time', async () => {
    vi.useFakeTimers();
    const { inspector, children } = setup();
    const preparation = inspector.prepare();
    children[0]!.stdout.write('{"ready":true}\n');
    await preparation;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(children[0]!.kill).toHaveBeenCalledOnce();
    const next = inspector.prepare();
    children[1]!.stdout.write('{"ready":true}\n');
    await next;
  });

  it('verifies launch ancestry independently of ordinary identity reads', async () => {
    const { inspector, children } = setup();
    const identity = inspector.read(1234);
    respond(children[0]!);
    await identity;
    const ancestry = inspector.read(1234, 5678);
    expect(inspector.read(1234, 5678)).toBe(ancestry);
    respond(children[0]!);
    await expect(ancestry).resolves.toMatchObject({
      ancestorPid: 5678,
      hostBirthIdentity: 'win32:100',
    });
    expect(spawnMock).toHaveBeenCalledOnce();
    // SAFETY: The helper launch always provides an encoded script as its final argument.
    const args = spawnMock.mock.calls[0]![1] as string[];
    const script = Buffer.from(args.at(-1)!, 'base64').toString('utf16le');
    expect(script).toContain('NtQueryInformationProcess');
    expect(script).toContain('parentCreated > childCreated');
    expect(script).toContain('VerifyAlive(ancestors[index], births[index])');
    expect(script).toContain('foreach (IntPtr ancestor in ancestors) CloseHandle(ancestor)');
    expect(script).not.toContain('Get-CimInstance');
  });

  it('does not accept ordinary identity evidence as launch ancestry', async () => {
    const { inspector, children } = setup();
    const rejected = expect(inspector.read(1234, 5678)).rejects.toThrow('ancestry');
    children[0]!.stdin.read();
    children[0]!.stdout.write(
      JSON.stringify({
        id: 1,
        details: {
          executable: 'C:\\opencode.exe',
          birthIdentity: 'win32:123',
          listenerSid: '',
          hostSid: '',
        },
      }) + '\n'
    );
    await rejected;
    expect(children[0]!.kill).toHaveBeenCalledOnce();
  });

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
    const concurrent = expect(inspector.read(5678)).rejects.toThrow('timed out');
    children[0]!.stdout.write('{"id":1');
    await vi.advanceTimersByTimeAsync(4999);
    expect(children[0]!.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await Promise.all([rejected, concurrent]);
    expect(children[0]!.kill).toHaveBeenCalledOnce();
    const next = inspector.read(1234);
    respond(children[1]!, 'win32:456');
    await expect(next).resolves.toMatchObject({ birthIdentity: 'win32:456' });
    expect(spawnMock).toHaveBeenCalledTimes(2);
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

  it('does not retain older idle timers after concurrent inspections settle', async () => {
    vi.useFakeTimers();
    const { inspector, children } = setup();
    const first = inspector.read(1234);
    const second = inspector.read(5678);
    children[0]!.stdin.read();
    for (const id of [1, 2]) {
      children[0]!.stdout.write(
        JSON.stringify({
          id,
          details: {
            executable: 'C:\\OpenCode\\opencode.exe',
            birthIdentity: 'win32:123',
            listenerSid: 'S-1-5-21-1',
            hostSid: 'S-1-5-21-1',
          },
        }) + '\n'
      );
    }
    await Promise.all([first, second]);
    await vi.advanceTimersByTimeAsync(59_000);
    const next = inspector.read(1234);
    respond(children[0]!);
    await next;
    await vi.advanceTimersByTimeAsync(1000);
    expect(children[0]!.kill).not.toHaveBeenCalled();
  });

  it('decodes Unicode paths across fragmented UTF-8 responses', async () => {
    const { inspector, children } = setup();
    const inspection = inspector.read(1234);
    children[0]!.stdin.read();
    const executable = 'C:\\用户\\opencode.exe';
    const bytes = Buffer.from(
      JSON.stringify({
        id: 1,
        details: { executable, birthIdentity: 'win32:123', listenerSid: '', hostSid: '' },
      }) + '\n'
    );
    for (const byte of bytes) children[0]!.stdout.write(Buffer.from([byte]));
    await expect(inspection).resolves.toMatchObject({ executable });
  });

  it.each([0, -1, 1.5, Number.NaN, 0x80000000])('rejects an invalid PID: %s', async (pid) => {
    const { inspector } = setup();
    await expect(inspector.read(pid)).rejects.toThrow('Invalid Windows process ID');
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
