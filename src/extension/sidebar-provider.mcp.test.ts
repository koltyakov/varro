import { describe, expect, it } from 'vitest';
import {
  attachTestView,
  createServer,
  createSidebarProviderInstance,
  getVscodeMock,
} from './sidebar-provider.test-support';
import { getOpenCodeConfigPaths } from './open-code-process';

const vscodeMock = getVscodeMock();
const endpoint = '/varro/mcp-defaults';

function mockConfigFiles(files: Map<string, string>) {
  vscodeMock.workspace.fs.readFile.mockImplementation(async (uri: { fsPath: string }) => {
    const raw = files.get(uri.fsPath);
    if (raw === undefined) throw { code: 'FileNotFound' };
    return new TextEncoder().encode(raw);
  });
  vscodeMock.workspace.fs.writeFile.mockImplementation(async (...args: unknown[]) => {
    // SAFETY: The configuration service writes a file URI and UTF-8 bytes.
    const [uri, bytes] = args as [{ fsPath: string }, Uint8Array];
    files.set(uri.fsPath, new TextDecoder().decode(bytes));
  });
}

describe('MCP defaults configuration', () => {
  it('reads global and project defaults without using runtime connection state', async () => {
    const globalPath = getOpenCodeConfigPaths()[1]!;
    mockConfigFiles(
      new Map([
        [
          globalPath,
          JSON.stringify({
            mcp: {
              servers: {
                docs: { type: 'remote', url: 'https://docs.example/mcp', disabled: true },
                browser: { type: 'local', command: ['browser'] },
              },
            },
          }),
        ],
        [
          '/repo/opencode.json',
          JSON.stringify({
            mcp: {
              timeout: { startup: 1000 },
              servers: { docs: { type: 'remote', url: 'https://project.example/mcp' } },
            },
          }),
        ],
      ])
    );
    const server = createServer({ apiVersion: 2 });
    const { provider } = await createSidebarProviderInstance({ server });
    const { posted } = attachTestView(provider);
    await provider.handleMessage({
      type: 'api/request',
      payload: { id: 1, method: 'GET', path: endpoint },
    });
    expect(posted).toContainEqual({
      type: 'api/response',
      payload: {
        id: 1,
        data: {
          global: { docs: false, browser: true },
          project: { docs: true },
          effective: { docs: true, browser: true },
          editable: true,
        },
      },
    });
    expect(vscodeMock.workspace.fs.writeFile).not.toHaveBeenCalled();
  });

  it('persists global on-demand mode while preserving comments and project overrides', async () => {
    const globalPath = getOpenCodeConfigPaths()[1]!;
    const files = new Map([
      [
        globalPath,
        '{ "mcp": { "servers": { "docs": { /* keep connection */ "type": "remote", "url": "https://docs.example/mcp", "headers": { "X-Key": "{env:DOCS_KEY}" } } } } }',
      ],
      [
        '/repo/opencode.json',
        JSON.stringify({
          mcp: { servers: { docs: { type: 'remote', url: 'https://project.example/mcp' } } },
        }),
      ],
    ]);
    mockConfigFiles(files);
    const { provider } = await createSidebarProviderInstance({
      server: createServer({ apiVersion: 2 }),
    });
    const { posted } = attachTestView(provider);
    await provider.handleMessage({
      type: 'api/request',
      payload: {
        id: 2,
        method: 'POST',
        path: endpoint,
        body: { name: 'docs', scope: 'global', enabled: false },
      },
    });
    expect(files.get(globalPath)).toContain('/* keep connection */');
    expect(files.get(globalPath)).toContain('"disabled": true');
    expect(files.get(globalPath)).toContain('{env:DOCS_KEY}');
    expect(vscodeMock.workspace.fs.writeFile).toHaveBeenCalledTimes(1);
    expect(posted).toContainEqual({
      type: 'api/response',
      payload: {
        id: 2,
        data: {
          global: { docs: false },
          project: { docs: true },
          effective: { docs: true },
          editable: true,
        },
      },
    });
  });

  it('copies the full inherited server when opting a project into an on-demand global MCP', async () => {
    const globalPath = getOpenCodeConfigPaths()[1]!;
    const server = {
      type: 'local',
      command: ['node', 'docs.js'],
      environment: { KEY: '{env:DOCS_KEY}' },
      cwd: '/shared',
      disabled: true,
      codemode: false,
    };
    const files = new Map([[globalPath, JSON.stringify({ mcp: { servers: { docs: server } } })]]);
    mockConfigFiles(files);
    vscodeMock.workspace.fs.stat.mockRejectedValue({ code: 'FileNotFound' });
    const { provider } = await createSidebarProviderInstance({
      server: createServer({ apiVersion: 2 }),
    });
    const { posted } = attachTestView(provider);
    await provider.handleMessage({
      type: 'api/request',
      payload: {
        id: 3,
        method: 'POST',
        path: endpoint,
        body: { name: 'docs', scope: 'project', enabled: true },
      },
    });
    expect(JSON.parse(files.get('/repo/opencode.json')!)).toEqual({
      $schema: 'https://opencode.ai/config.json',
      mcp: { servers: { docs: { ...server, disabled: false } } },
    });
    expect(JSON.parse(files.get(globalPath)!)).toEqual({ mcp: { servers: { docs: server } } });
    expect(posted).toContainEqual({
      type: 'api/response',
      payload: {
        id: 3,
        data: {
          global: { docs: false },
          project: { docs: true },
          effective: { docs: true },
          editable: true,
        },
      },
    });
  });

  describe('project overrides', () => {
    const docs = { type: 'local', command: ['docs'] };

    async function postUpdate(
      files: Map<string, string>,
      body: { name: string; scope: string; enabled: boolean | null },
      apiVersion: 1 | 2 = 2
    ) {
      mockConfigFiles(files);
      const { provider } = await createSidebarProviderInstance({
        server: createServer({ apiVersion }),
      });
      const { posted } = attachTestView(provider);
      await provider.handleMessage({
        type: 'api/request',
        payload: { id: 20, method: 'POST', path: endpoint, body },
      });
      return posted;
    }

    it('removes a copied override when using the global setting and keeps file comments', async () => {
      const globalPath = getOpenCodeConfigPaths()[1]!;
      const files = new Map([
        [globalPath, JSON.stringify({ mcp: { servers: { docs: { ...docs, disabled: true } } } })],
        [
          '/repo/opencode.jsonc',
          `{ // keep me
  "mcp": { "servers": { "docs": { "type": "local", "command": ["docs"], "disabled": false } } } }`,
        ],
      ]);
      const posted = await postUpdate(files, { name: 'docs', scope: 'project', enabled: null });
      expect(files.get('/repo/opencode.jsonc')).toContain('// keep me');
      expect(files.get('/repo/opencode.jsonc')).not.toContain('"docs"');
      expect(posted).toContainEqual({
        type: 'api/response',
        payload: {
          id: 20,
          data: {
            global: { docs: false },
            project: {},
            effective: { docs: false },
            editable: true,
          },
        },
      });
    });

    it('lets a later global change apply after the override is removed', async () => {
      const globalPath = getOpenCodeConfigPaths()[1]!;
      const files = new Map([
        [globalPath, JSON.stringify({ mcp: { servers: { docs } } })],
        ['/repo/opencode.json', JSON.stringify({ mcp: { servers: { docs } } })],
      ]);
      await postUpdate(files, { name: 'docs', scope: 'project', enabled: null });
      const posted = await postUpdate(files, { name: 'docs', scope: 'global', enabled: false });
      expect(posted).toContainEqual({
        type: 'api/response',
        payload: {
          id: 20,
          data: {
            global: { docs: false },
            project: {},
            effective: { docs: false },
            editable: true,
          },
        },
      });
    });

    it('writes nothing when a project chooses the value it already inherits', async () => {
      const globalPath = getOpenCodeConfigPaths()[1]!;
      const files = new Map([[globalPath, JSON.stringify({ mcp: { servers: { docs } } })]]);
      await postUpdate(files, { name: 'docs', scope: 'project', enabled: true });
      expect(vscodeMock.workspace.fs.writeFile).not.toHaveBeenCalled();
      expect(files.has('/repo/opencode.json')).toBe(false);
    });

    it('removes a copied override when a project chooses the global value', async () => {
      const globalPath = getOpenCodeConfigPaths()[1]!;
      const files = new Map([
        [globalPath, JSON.stringify({ mcp: { servers: { docs } } })],
        [
          '/repo/opencode.json',
          JSON.stringify({ mcp: { servers: { docs: { ...docs, disabled: true } } } }),
        ],
      ]);
      await postUpdate(files, { name: 'docs', scope: 'project', enabled: true });
      expect(files.get('/repo/opencode.json')).not.toContain('docs');
    });

    it('keeps a project entry with its own connection settings', async () => {
      const globalPath = getOpenCodeConfigPaths()[1]!;
      const own = JSON.stringify({
        mcp: { servers: { docs: { type: 'local', command: ['project-docs'] } } },
      });
      const files = new Map([
        [globalPath, JSON.stringify({ mcp: { servers: { docs } } })],
        ['/repo/opencode.json', own],
      ]);
      const posted = await postUpdate(files, { name: 'docs', scope: 'project', enabled: null });
      expect(files.get('/repo/opencode.json')).toBe(own);
      expect(posted).toContainEqual({
        type: 'api/response',
        payload: { id: 20, error: expect.stringContaining('own connection settings') },
      });
      await postUpdate(files, { name: 'docs', scope: 'project', enabled: true });
      expect(files.get('/repo/opencode.json')).toContain('project-docs');
    });

    it('refuses to clear a project-only server', async () => {
      const own = JSON.stringify({ mcp: { servers: { docs } } });
      const files = new Map([['/repo/opencode.json', own]]);
      const posted = await postUpdate(files, { name: 'docs', scope: 'project', enabled: null });
      expect(files.get('/repo/opencode.json')).toBe(own);
      expect(posted).toContainEqual({
        type: 'api/response',
        payload: { id: 20, error: expect.stringContaining('no global configuration') },
      });
    });

    it('rejects clearing a global setting', async () => {
      const globalPath = getOpenCodeConfigPaths()[1]!;
      const global = JSON.stringify({ mcp: { servers: { docs } } });
      const files = new Map([[globalPath, global]]);
      const posted = await postUpdate(files, { name: 'docs', scope: 'global', enabled: null });
      expect(files.get(globalPath)).toBe(global);
      expect(posted).toContainEqual({
        type: 'api/response',
        payload: { id: 20, error: expect.stringContaining('Invalid MCP default update') },
      });
    });

    it('removes a legacy partial override', async () => {
      const globalPath = getOpenCodeConfigPaths()[1]!;
      const files = new Map([
        [globalPath, JSON.stringify({ mcp: { docs: { ...docs, enabled: true } } })],
        ['/repo/opencode.json', JSON.stringify({ mcp: { docs: { enabled: false } } })],
      ]);
      await postUpdate(files, { name: 'docs', scope: 'project', enabled: null }, 1);
      expect(files.get('/repo/opencode.json')).not.toContain('docs');
    });
  });

  it('keeps legacy servers compatible when changing their default', async () => {
    const globalPath = getOpenCodeConfigPaths()[1]!;
    const files = new Map([
      [
        globalPath,
        JSON.stringify({ mcp: { docs: { type: 'local', command: ['docs'], enabled: true } } }),
      ],
    ]);
    mockConfigFiles(files);
    const { provider } = await createSidebarProviderInstance({
      server: createServer({ apiVersion: 1 }),
    });
    attachTestView(provider);
    await provider.handleMessage({
      type: 'api/request',
      payload: {
        id: 4,
        method: 'POST',
        path: endpoint,
        body: { name: 'docs', scope: 'global', enabled: false },
      },
    });
    expect(JSON.parse(files.get(globalPath)!)).toMatchObject({
      mcp: { docs: { type: 'local', command: ['docs'], enabled: false } },
    });
  });

  it('does not promote a project-only connection into global configuration', async () => {
    mockConfigFiles(
      new Map([
        [
          '/repo/opencode.json',
          JSON.stringify({
            mcp: { servers: { docs: { type: 'remote', url: 'https://project.example/mcp' } } },
          }),
        ],
      ])
    );
    const { provider } = await createSidebarProviderInstance({
      server: createServer({ apiVersion: 2 }),
    });
    const { posted } = attachTestView(provider);
    await provider.handleMessage({
      type: 'api/request',
      payload: {
        id: 8,
        method: 'POST',
        path: endpoint,
        body: { name: 'docs', scope: 'global', enabled: false },
      },
    });
    expect(vscodeMock.workspace.fs.writeFile).not.toHaveBeenCalled();
    expect(posted).toContainEqual({
      type: 'api/response',
      payload: { id: 8, error: expect.stringContaining('only configured in the project') },
    });
  });

  it('removes a conflicting legacy flag when enabling a native V2 server', async () => {
    const globalPath = getOpenCodeConfigPaths()[1]!;
    const files = new Map([
      [
        globalPath,
        JSON.stringify({
          mcp: { servers: { docs: { type: 'local', command: ['docs'], enabled: false } } },
        }),
      ],
    ]);
    mockConfigFiles(files);
    const { provider } = await createSidebarProviderInstance({
      server: createServer({ apiVersion: 2 }),
    });
    const { posted } = attachTestView(provider);
    await provider.handleMessage({
      type: 'api/request',
      payload: {
        id: 10,
        method: 'POST',
        path: endpoint,
        body: { name: 'docs', scope: 'global', enabled: true },
      },
    });
    expect(JSON.parse(files.get(globalPath)!)).toMatchObject({
      mcp: { servers: { docs: { disabled: false } } },
    });
    expect(files.get(globalPath)).not.toContain('enabled');
    expect(posted).toContainEqual({
      type: 'api/response',
      payload: {
        id: 10,
        data: { global: { docs: true }, project: {}, effective: { docs: true }, editable: true },
      },
    });
  });

  it('refuses to overwrite a concurrent external configuration edit', async () => {
    const globalPath = getOpenCodeConfigPaths()[1]!;
    mockConfigFiles(
      new Map([
        [
          globalPath,
          JSON.stringify({ mcp: { servers: { docs: { type: 'local', command: ['docs'] } } } }),
        ],
      ])
    );
    vscodeMock.workspace.fs.stat
      .mockResolvedValueOnce({ mtime: 1, size: 10 })
      .mockResolvedValueOnce({ mtime: 2, size: 20 });
    const { provider } = await createSidebarProviderInstance({
      server: createServer({ apiVersion: 2 }),
    });
    const { posted } = attachTestView(provider);
    await provider.handleMessage({
      type: 'api/request',
      payload: {
        id: 9,
        method: 'POST',
        path: endpoint,
        body: { name: 'docs', scope: 'global', enabled: false },
      },
    });
    expect(vscodeMock.workspace.fs.writeFile).not.toHaveBeenCalled();
    expect(posted).toContainEqual({
      type: 'api/response',
      payload: { id: 9, error: expect.stringContaining('changed while updating MCP defaults') },
    });
  });

  it('refuses to overwrite an unsaved MCP configuration', async () => {
    const globalPath = getOpenCodeConfigPaths()[1]!;
    mockConfigFiles(
      new Map([
        [
          globalPath,
          JSON.stringify({ mcp: { servers: { docs: { type: 'local', command: ['docs'] } } } }),
        ],
      ])
    );
    vscodeMock.workspace.textDocuments = [
      { isDirty: true, uri: { fsPath: globalPath, toString: () => globalPath } },
    ];
    const { provider } = await createSidebarProviderInstance({
      server: createServer({ apiVersion: 2 }),
    });
    const { posted } = attachTestView(provider);
    await provider.handleMessage({
      type: 'api/request',
      payload: {
        id: 5,
        method: 'POST',
        path: endpoint,
        body: { name: 'docs', scope: 'global', enabled: false },
      },
    });
    expect(vscodeMock.workspace.fs.writeFile).not.toHaveBeenCalled();
    expect(posted).toContainEqual({
      type: 'api/response',
      payload: { id: 5, error: expect.stringContaining('unsaved changes') },
    });
  });

  it('reads attached-server defaults but never edits local configuration for that server', async () => {
    const server = createServer({ apiVersion: 2, isAttachOnly: true });
    server.request.mockResolvedValue({
      mcp: {
        servers: { docs: { type: 'remote', url: 'https://docs.example/mcp', disabled: true } },
      },
    });
    const { provider } = await createSidebarProviderInstance({ server });
    const { posted } = attachTestView(provider);
    await provider.handleMessage({
      type: 'api/request',
      payload: { id: 6, method: 'GET', path: endpoint },
    });
    expect(posted).toContainEqual({
      type: 'api/response',
      payload: {
        id: 6,
        data: { global: {}, project: {}, effective: { docs: false }, editable: false },
      },
    });
    await provider.handleMessage({
      type: 'api/request',
      payload: {
        id: 7,
        method: 'POST',
        path: endpoint,
        body: { name: 'docs', scope: 'project', enabled: true },
      },
    });
    expect(vscodeMock.workspace.fs.writeFile).not.toHaveBeenCalled();
    expect(posted).toContainEqual({
      type: 'api/response',
      payload: { id: 7, error: expect.stringContaining('attach-only') },
    });
  });
});
