/* oxlint-disable anti-slop/no-module-mocking -- Socket snapshots exercise OS boundaries without inspecting real users' processes. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./process-inspection', () => ({
  readProcessBirthIdentity: vi.fn(async () => 'same-process'),
  runProcess: vi.fn(),
}));
import { readProcessBirthIdentity, runProcess } from './process-inspection';
import { readLocalServerConnectionInfo } from './server-connection-info';

const platform = process.platform;
const startedAt = new Date(2026, 9, 1, 10, 0, 0).getTime();
const unknown = { startedAt: null, vscodeClients: null, otherClients: null };

function setPlatform(value: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

function socket(pid: number, from: string, to?: string) {
  return `p${pid}\ncfixture\nf1\nn${from}${to ? `->${to}` : ''}\nTST=${to ? 'ESTABLISHED' : 'LISTEN'}\n`;
}

const endpoint = '127.0.0.1:49374';
const peer = (port: number) => `127.0.0.1:${port}`;
const sockets =
  socket(100, endpoint) +
  socket(100, endpoint, peer(50001)) +
  socket(200, peer(50001), endpoint) +
  socket(100, endpoint, peer(50002)) +
  socket(200, peer(50002), endpoint) +
  socket(100, endpoint, peer(50003)) +
  socket(201, peer(50003), endpoint) +
  socket(100, endpoint, peer(50004)) +
  socket(300, peer(50004), endpoint);
const processes = [
  '100 Thu Oct  1 10:00:00 2026 /bin/opencode2',
  '200 Thu Oct  1 10:00:00 2026 /Applications/Visual Studio Code.app/Code Helper (Plugin) --type=extensionHost',
  '201 Thu Oct  1 10:00:00 2026 /bin/node /opt/code/bootstrap-fork --type=extensionHost',
  '300 Thu Oct  1 10:00:00 2026 /bin/opencode2 --tui',
].join('\n');

function mockPosix(socketOutput = sockets, processOutput = processes) {
  vi.mocked(runProcess).mockImplementation(async (command) => ({
    stdout: command === 'lsof' ? socketOutput : processOutput,
    stderr: '',
    code: 0,
  }));
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(readProcessBirthIdentity).mockResolvedValue('same-process');
});

afterEach(() => setPlatform(platform));

describe('local server connection info', () => {
  it.each(['darwin', 'linux'] as const)(
    'counts client processes, not sockets, on %s',
    async (os) => {
      setPlatform(os);
      mockPosix();
      await expect(readLocalServerConnectionInfo(49374, 100)).resolves.toEqual({
        startedAt,
        vscodeClients: 2,
        otherClients: 1,
      });
      expect(runProcess).toHaveBeenCalledWith(
        'lsof',
        expect.arrayContaining(['-iTCP:49374', '-FpfcnT'])
      );
      expect(readProcessBirthIdentity).toHaveBeenCalledTimes(2);
    }
  );

  it('counts a VS Code-compatible macOS plugin host without an extensionHost argument', async () => {
    setPlatform('darwin');
    mockPosix(
      sockets,
      processes
        .replace('--type=extensionHost', '')
        .replace('Code Helper (Plugin)', 'VSCodium Helper (Plugin)')
    );
    await expect(readLocalServerConnectionInfo(49374, 100)).resolves.toMatchObject({
      vscodeClients: 2,
    });
  });

  it('reports zero clients only when a verified listener has no established sockets', async () => {
    setPlatform('linux');
    mockPosix(socket(100, endpoint));
    await expect(readLocalServerConnectionInfo(49374, 100)).resolves.toEqual({
      startedAt,
      vscodeClients: 0,
      otherClients: 0,
    });
  });

  it('preserves the start time but reports unknown counts for remote or hidden peers', async () => {
    setPlatform('darwin');
    mockPosix(sockets + socket(100, endpoint, '192.0.2.1:50005'));
    await expect(readLocalServerConnectionInfo(49374, 100)).resolves.toEqual({
      ...unknown,
      startedAt,
    });
  });

  it('does not classify a client whose command is hidden as an other client', async () => {
    setPlatform('darwin');
    mockPosix(sockets, processes.split('\n').slice(0, -1).join('\n'));
    await expect(readLocalServerConnectionInfo(49374, 100)).resolves.toEqual({
      ...unknown,
      startedAt,
    });
  });

  it.each([socket(999, endpoint), socket(100, endpoint) + socket(999, endpoint)])(
    'does not attribute another or ambiguous listener to the server',
    async (output) => {
      setPlatform('darwin');
      mockPosix(output);
      await expect(readLocalServerConnectionInfo(49374, 100)).resolves.toEqual(unknown);
    }
  );

  it('rejects a PID replaced during inspection', async () => {
    setPlatform('darwin');
    mockPosix();
    vi.mocked(readProcessBirthIdentity)
      .mockResolvedValueOnce('before')
      .mockResolvedValueOnce('after');
    await expect(readLocalServerConnectionInfo(49374, 100)).resolves.toEqual(unknown);
  });

  it.each([0, -1, 1.5, Number.NaN, null])(
    'does not inspect an invalid server PID %s',
    async (pid) => {
      await expect(readLocalServerConnectionInfo(49374, pid)).resolves.toEqual(unknown);
      expect(runProcess).not.toHaveBeenCalled();
    }
  );

  it('preserves unknown data when process inspection is unavailable', async () => {
    setPlatform('linux');
    vi.mocked(runProcess).mockResolvedValue({ stdout: '', stderr: 'not installed', code: 127 });
    await expect(readLocalServerConnectionInfo(49374, 100)).resolves.toEqual(unknown);
    vi.mocked(runProcess).mockRejectedValue(new Error('permission denied'));
    await expect(readLocalServerConnectionInfo(49374, 100)).resolves.toEqual(unknown);
  });

  it('counts Windows connections and reads the process start time', async () => {
    setPlatform('win32');
    const pair = (port: number, pid: number) => [
      { pid: 100, from: endpoint, to: peer(port) },
      { pid, from: peer(port), to: endpoint },
    ];
    vi.mocked(runProcess).mockResolvedValue({
      code: 0,
      stderr: '',
      stdout: JSON.stringify({
        listeners: [100],
        startedAt,
        connections: [...pair(50001, 200), ...pair(50002, 200), ...pair(50003, 300)],
        commands: [
          { pid: 200, command: 'Code.exe --type=extensionHost' },
          { pid: 300, command: 'opencode.exe --tui' },
        ],
      }),
    });
    await expect(readLocalServerConnectionInfo(49374, 100)).resolves.toEqual({
      startedAt,
      vscodeClients: 1,
      otherClients: 1,
    });
    expect(runProcess).toHaveBeenCalledWith('powershell.exe', expect.any(Array), 10_000);
  });

  it.each(['not JSON', '{}', '{"listeners":["100"],"connections":[],"commands":[]}'])(
    'rejects invalid Windows output %s',
    async (stdout) => {
      setPlatform('win32');
      vi.mocked(runProcess).mockResolvedValue({ stdout, stderr: '', code: 0 });
      await expect(readLocalServerConnectionInfo(49374, 100)).resolves.toEqual(unknown);
    }
  );
});
