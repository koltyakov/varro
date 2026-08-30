/* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion -- SAFETY: These tests inspect controlled private configuration state on the provider fixture. */
import { describe, expect, it, vi } from 'vitest';
import {
  attachTestView,
  createServer,
  createSidebarProviderInstance,
  getConfigurationValue,
  getVscodeMock,
} from './sidebar-provider.test-support';

const vscodeMock = getVscodeMock();

describe('SidebarProvider local config routing', () => {
  it.each(['varro.chat.fontSize', 'chat.fontSize', 'chat.editor.fontSize', 'chat.fontFamily'])(
    'broadcasts font configuration when %s changes',
    async (changedKey) => {
      const { provider } = await createSidebarProviderInstance();
      const { posted } = attachTestView(provider);
      const listener = vscodeMock.workspace.onDidChangeConfiguration.mock.calls.at(-1)?.[0];
      expect(listener).toBeTypeOf('function');

      await vscodeMock.workspace.getConfiguration('varro').update('chat.fontSize', 15);
      await vscodeMock.workspace.getConfiguration('chat').update('fontSize', 14);
      await vscodeMock.workspace.getConfiguration('chat.editor').update('fontSize', 16);
      await vscodeMock.workspace
        .getConfiguration('chat')
        .update('fontFamily', 'Iosevka, monospace');
      listener?.({ affectsConfiguration: (key: string) => key === changedKey });

      expect(posted).toContainEqual({
        type: 'config/update',
        payload: expect.objectContaining({
          chatFontSize: 15,
          chatEditorFontSize: 16,
          chatFontFamily: 'Iosevka, monospace',
        }),
      });
    }
  );

  it('invalidates the session catalog when its scope changes', async () => {
    const { provider } = await createSidebarProviderInstance();
    const { posted } = attachTestView(provider);
    const listener = vscodeMock.workspace.onDidChangeConfiguration.mock.calls.at(-1)?.[0];

    listener?.({
      affectsConfiguration: (key: string) => key === 'varro.chat.sessionHistoryScope',
    });

    expect(posted).toContainEqual({ type: 'session/catalog-invalidated' });
  });

  it('reads model routing from project opencode.json', async () => {
    vscodeMock.workspace.fs.readFile.mockImplementation((uri: { fsPath: string }) =>
      uri.fsPath === '/repo/opencode.json'
        ? Promise.resolve(
            new TextEncoder().encode(
              JSON.stringify({
                small_model: 'openai/gpt-5-mini',
                agent: {
                  build: { model: 'openai/gpt-5' },
                  review: { model: 'anthropic/claude-sonnet-4' },
                },
                provider: {
                  anthropic: { options: { baseURL: 'http://127.0.0.1:3456' } },
                },
              })
            )
          )
        : Promise.reject({ code: 'FileNotFound' })
    );

    const { provider } = await createSidebarProviderInstance({
      server: createServer({ getWorkspaceCwd: vi.fn(() => '/repo') }),
    });
    const { posted } = attachTestView(provider);

    await provider.handleMessage({
      type: 'api/request',
      payload: { id: 1, method: 'GET', path: '/varro/opencode-config' },
    });

    expect(posted).toContainEqual({
      type: 'api/response',
      payload: {
        id: 1,
        data: {
          smallModel: { providerID: 'openai', modelID: 'gpt-5-mini' },
          agentModels: {
            build: { providerID: 'openai', modelID: 'gpt-5' },
            review: { providerID: 'anthropic', modelID: 'claude-sonnet-4' },
          },
          commitMessageModel: null,
          autoApproveModel: null,
          providerConfigPaths: { anthropic: ['/repo/opencode.json'] },
        },
      },
    });
  });

  it('handles local config routes without starting the server', async () => {
    vscodeMock.workspace.fs.readFile.mockImplementation((uri: { fsPath: string }) =>
      uri.fsPath === '/repo/opencode.json'
        ? Promise.resolve(
            new TextEncoder().encode(JSON.stringify({ small_model: 'openai/gpt-5-mini' }))
          )
        : Promise.reject({ code: 'FileNotFound' })
    );

    const server = createServer({
      status: { state: 'error', message: 'offline' },
      start: vi.fn(() => Promise.reject(new Error('should not start'))),
    });
    const { provider } = await createSidebarProviderInstance({ server });
    const { posted } = attachTestView(provider);

    await provider.handleMessage({
      type: 'api/request',
      payload: { id: 7, method: 'GET', path: '/varro/opencode-config' },
    });

    expect(server.start).not.toHaveBeenCalled();
    expect(posted).toContainEqual({
      type: 'api/response',
      payload: {
        id: 7,
        data: {
          smallModel: { providerID: 'openai', modelID: 'gpt-5-mini' },
          agentModels: {},
          commitMessageModel: null,
          autoApproveModel: null,
        },
      },
    });
  });

  it('writes small_model routing to project opencode.json', async () => {
    vscodeMock.workspace.fs.readFile.mockRejectedValue({ code: 'FileNotFound' });
    vscodeMock.workspace.fs.stat.mockRejectedValueOnce({ code: 'FileNotFound' });
    vscodeMock.workspace.fs.stat.mockRejectedValueOnce({ code: 'FileNotFound' });

    const server = createServer({
      getWorkspaceCwd: vi.fn(() => '/repo'),
      request: vi.fn(async (_method: string, path: string) =>
        path === '/session/status' ? {} : []
      ),
    });
    const { provider } = await createSidebarProviderInstance({ server });
    const { posted } = attachTestView(provider);

    await provider.handleMessage({
      type: 'api/request',
      payload: {
        id: 2,
        method: 'POST',
        path: '/varro/opencode-config/model-routing',
        body: { target: 'small_model', providerID: 'openai', modelID: 'gpt-5-mini' },
      },
    });

    expect(vscodeMock.workspace.fs.writeFile).toHaveBeenCalledTimes(1);
    const firstWriteCall = vscodeMock.workspace.fs.writeFile.mock.calls[0];
    expect(firstWriteCall).toBeTruthy();
    const firstWriteArgs = firstWriteCall as unknown[] | undefined;
    expect(firstWriteArgs?.[0]).toEqual(expect.objectContaining({ fsPath: '/repo/opencode.json' }));
    const encoded = firstWriteArgs?.[1];
    expect(encoded).toBeTruthy();
    const written = JSON.parse(new TextDecoder().decode(encoded as Uint8Array<ArrayBuffer>));
    expect(written).toEqual({
      $schema: 'https://opencode.ai/config.json',
      small_model: 'openai/gpt-5-mini',
    });
    expect(posted).toContainEqual({
      type: 'api/response',
      payload: {
        id: 2,
        data: {
          smallModel: { providerID: 'openai', modelID: 'gpt-5-mini' },
          agentModels: {},
          commitMessageModel: null,
          autoApproveModel: null,
        },
      },
    });
    expect(server.request).toHaveBeenCalledWith('POST', '/instance/dispose', undefined, {
      directory: '/repo',
    });
    expect(server.restart).not.toHaveBeenCalled();
  });

  it('removes small_model routing from project opencode.json', async () => {
    vscodeMock.workspace.fs.readFile.mockImplementation((uri: { fsPath: string }) =>
      uri.fsPath === '/repo/opencode.json'
        ? Promise.resolve(
            new TextEncoder().encode(
              JSON.stringify({ small_model: 'openai/gpt-5-mini', theme: 'system' })
            )
          )
        : Promise.reject({ code: 'FileNotFound' })
    );

    const { provider } = await createSidebarProviderInstance();
    const { posted } = attachTestView(provider);
    await provider.handleMessage({
      type: 'api/request',
      payload: {
        id: 21,
        method: 'POST',
        path: '/varro/opencode-config/model-routing',
        body: {
          target: 'small_model',
          providerID: 'openai',
          modelID: 'gpt-5-mini',
          unset: true,
        },
      },
    });

    const writeCall = vscodeMock.workspace.fs.writeFile.mock.lastCall as unknown[] | undefined;
    const encoded = writeCall?.[1] as Uint8Array;
    expect(JSON.parse(new TextDecoder().decode(encoded))).toEqual({ theme: 'system' });
    expect(posted).toContainEqual({
      type: 'api/response',
      payload: {
        id: 21,
        data: expect.objectContaining({ smallModel: null }),
      },
    });
  });

  it.each([
    ['commit_message', 'commitMessage.model', 'commitMessageModel'],
    ['auto_approve', 'chat.autoApproveModel', 'autoApproveModel'],
  ] as const)('writes %s routing to VS Code user settings', async (target, key, responseKey) => {
    vscodeMock.workspace.fs.readFile.mockRejectedValue({ code: 'FileNotFound' });
    const { provider } = await createSidebarProviderInstance();
    const { posted } = attachTestView(provider);

    await provider.handleMessage({
      type: 'api/request',
      payload: {
        id: 20,
        method: 'POST',
        path: '/varro/opencode-config/model-routing',
        body: { target, providerID: 'openai', modelID: 'gpt-5-mini' },
      },
    });

    expect(getConfigurationValue(key)).toBe('openai/gpt-5-mini');
    expect(vscodeMock.workspace.fs.writeFile).not.toHaveBeenCalled();
    expect(posted).toContainEqual({
      type: 'api/response',
      payload: {
        id: 20,
        data: expect.objectContaining({
          [responseKey]: { providerID: 'openai', modelID: 'gpt-5-mini' },
        }),
      },
    });
  });

  it.each([
    ['commit_message', 'commitMessage.model', 'commitMessageModel'],
    ['auto_approve', 'chat.autoApproveModel', 'autoApproveModel'],
  ] as const)('clears %s routing from VS Code user settings', async (target, key, responseKey) => {
    const config = vscodeMock.workspace.getConfiguration('varro');
    await config.update(key, 'openai/gpt-5-mini', vscodeMock.ConfigurationTarget.Global);
    vscodeMock.workspace.fs.readFile.mockRejectedValue({ code: 'FileNotFound' });
    const { provider } = await createSidebarProviderInstance();
    const { posted } = attachTestView(provider);

    await provider.handleMessage({
      type: 'api/request',
      payload: {
        id: 22,
        method: 'POST',
        path: '/varro/opencode-config/model-routing',
        body: { target, providerID: 'openai', modelID: 'gpt-5-mini', unset: true },
      },
    });

    expect(getConfigurationValue(key)).toBeUndefined();
    expect(posted).toContainEqual({
      type: 'api/response',
      payload: {
        id: 22,
        data: expect.objectContaining({ [responseKey]: null }),
      },
    });
  });

  it('writes agent model routing while preserving existing config keys', async () => {
    vscodeMock.workspace.fs.readFile.mockImplementation((uri: { fsPath: string }) =>
      uri.fsPath === '/repo/opencode.json'
        ? Promise.resolve(
            new TextEncoder().encode(
              JSON.stringify({
                model: 'openai/gpt-5',
                agent: {
                  build: { mode: 'primary', model: 'openai/gpt-5' },
                },
              })
            )
          )
        : Promise.reject({ code: 'FileNotFound' })
    );
    vscodeMock.workspace.fs.stat.mockResolvedValueOnce({ mtime: 1, size: 10, type: 0, ctime: 0 });
    vscodeMock.workspace.fs.stat.mockResolvedValueOnce({ mtime: 1, size: 10, type: 0, ctime: 0 });

    const server = createServer({
      getWorkspaceCwd: vi.fn(() => '/repo'),
      request: vi.fn(async (_method: string, path: string) =>
        path === '/session/status' ? {} : []
      ),
    });
    const { provider } = await createSidebarProviderInstance({ server });

    await provider.handleMessage({
      type: 'api/request',
      payload: {
        id: 3,
        method: 'POST',
        path: '/varro/opencode-config/model-routing',
        body: {
          target: 'agent',
          agentName: 'review',
          providerID: 'anthropic',
          modelID: 'claude-sonnet-4',
        },
      },
    });

    const lastWriteCall = vscodeMock.workspace.fs.writeFile.mock.calls.at(-1);
    expect(lastWriteCall).toBeTruthy();
    const lastWriteArgs = lastWriteCall as unknown[] | undefined;
    const encoded = lastWriteArgs?.[1];
    expect(encoded).toBeTruthy();
    const written = JSON.parse(new TextDecoder().decode(encoded as Uint8Array<ArrayBuffer>));
    expect(written).toEqual({
      $schema: 'https://opencode.ai/config.json',
      model: 'openai/gpt-5',
      agent: {
        build: { mode: 'primary', model: 'openai/gpt-5' },
        review: { model: 'anthropic/claude-sonnet-4' },
      },
    });
    expect(server.request).toHaveBeenCalledWith('POST', '/instance/dispose', undefined, {
      directory: '/repo',
    });
    expect(server.restart).not.toHaveBeenCalled();
  });

  it('removes an agent model assignment and its empty config objects', async () => {
    vscodeMock.workspace.fs.readFile.mockImplementation((uri: { fsPath: string }) =>
      uri.fsPath === '/repo/opencode.json'
        ? Promise.resolve(
            new TextEncoder().encode(
              JSON.stringify({ agent: { review: { model: 'openai/gpt-5-mini' } } })
            )
          )
        : Promise.reject({ code: 'FileNotFound' })
    );

    const { provider } = await createSidebarProviderInstance();
    await provider.handleMessage({
      type: 'api/request',
      payload: {
        id: 23,
        method: 'POST',
        path: '/varro/opencode-config/model-routing',
        body: {
          target: 'agent',
          agentName: 'review',
          providerID: 'openai',
          modelID: 'gpt-5-mini',
          unset: true,
        },
      },
    });

    const writeCall = vscodeMock.workspace.fs.writeFile.mock.lastCall as unknown[] | undefined;
    const encoded = writeCall?.[1] as Uint8Array;
    expect(JSON.parse(new TextDecoder().decode(encoded))).toEqual({});
  });

  it('rejects config updates when opencode.json changes concurrently', async () => {
    vscodeMock.workspace.fs.readFile.mockImplementation((uri: { fsPath: string }) =>
      uri.fsPath === '/repo/opencode.json'
        ? Promise.resolve(
            new TextEncoder().encode(JSON.stringify({ small_model: 'openai/gpt-5-mini' }))
          )
        : Promise.reject({ code: 'FileNotFound' })
    );
    vscodeMock.workspace.fs.stat.mockResolvedValueOnce({ mtime: 1, size: 10, type: 0, ctime: 0 });
    vscodeMock.workspace.fs.stat.mockResolvedValueOnce({ mtime: 2, size: 12, type: 0, ctime: 0 });

    const { provider } = await createSidebarProviderInstance({
      server: createServer({ getWorkspaceCwd: vi.fn(() => '/repo') }),
    });
    const { posted } = attachTestView(provider);

    await provider.handleMessage({
      type: 'api/request',
      payload: {
        id: 4,
        method: 'POST',
        path: '/varro/opencode-config/model-routing',
        body: { target: 'small_model', providerID: 'openai', modelID: 'gpt-5' },
      },
    });

    expect(vscodeMock.workspace.fs.writeFile).not.toHaveBeenCalled();
    expect(posted).toContainEqual({
      type: 'api/response',
      payload: {
        id: 4,
        error: 'Project opencode.json changed while updating model routing; please retry',
      },
    });
  });

  it('rejects config updates while the matching config document has unsaved changes', async () => {
    vscodeMock.workspace.fs.readFile.mockImplementation((uri: { fsPath: string }) =>
      uri.fsPath === '/repo/opencode.json'
        ? Promise.resolve(
            new TextEncoder().encode(JSON.stringify({ small_model: 'openai/gpt-5-mini' }))
          )
        : Promise.reject({ code: 'FileNotFound' })
    );
    vscodeMock.workspace.textDocuments = [
      {
        isDirty: true,
        uri: { fsPath: '/repo/opencode.json', toString: () => '/repo/opencode.json' },
      },
    ];

    const { provider } = await createSidebarProviderInstance();
    const { posted } = attachTestView(provider);
    await provider.handleMessage({
      type: 'api/request',
      payload: {
        id: 10,
        method: 'POST',
        path: '/varro/opencode-config/model-routing',
        body: { target: 'small_model', providerID: 'openai', modelID: 'gpt-5' },
      },
    });

    expect(vscodeMock.workspace.fs.writeFile).not.toHaveBeenCalled();
    expect(posted).toContainEqual({
      type: 'api/response',
      payload: {
        id: 10,
        error:
          'Project opencode.json has unsaved changes; save or revert the document before updating model routing',
      },
    });
  });

  it('reads inherited JSONC routing through the worktree boundary', async () => {
    vscodeMock.workspace.fs.readFile.mockImplementation((uri: { fsPath: string }) => {
      if (uri.fsPath === '/repo/opencode.jsonc') {
        return Promise.resolve(
          new TextEncoder().encode('{\n  // inherited\n  "small_model": "openai/gpt-5-mini",\n}\n')
        );
      }
      if (uri.fsPath === '/repo/packages/app/opencode.json') {
        return Promise.resolve(
          new TextEncoder().encode(JSON.stringify({ agent: { build: { model: 'openai/gpt-5' } } }))
        );
      }
      return Promise.reject({ code: 'FileNotFound' });
    });
    const contextProvider = {
      context: {
        workspacePath: '/repo/packages/app',
        activeFile: null,
        selection: null,
        diagnostics: [],
      },
      getOpenWorkspaceRoot: vi.fn(() => '/repo'),
      readFile: vi.fn(),
      resolvePath: vi.fn(),
      terminalSelection: null,
      clearTerminalSelection: vi.fn(),
      openPath: vi.fn(),
      selectWorkspace: vi.fn(() => Promise.resolve()),
    };

    const { provider } = await createSidebarProviderInstance({ contextProvider });
    const { posted } = attachTestView(provider);
    await provider.handleMessage({
      type: 'api/request',
      payload: { id: 8, method: 'GET', path: '/varro/opencode-config' },
    });

    expect(posted).toContainEqual({
      type: 'api/response',
      payload: {
        id: 8,
        data: {
          smallModel: { providerID: 'openai', modelID: 'gpt-5-mini' },
          agentModels: { build: { providerID: 'openai', modelID: 'gpt-5' } },
          commitMessageModel: null,
          autoApproveModel: null,
        },
      },
    });
  });

  it('updates opencode.jsonc without removing comments', async () => {
    vscodeMock.workspace.fs.readFile.mockImplementation((uri: { fsPath: string }) =>
      uri.fsPath === '/repo/opencode.jsonc'
        ? Promise.resolve(
            new TextEncoder().encode(
              '{\n  // Keep this model note.\n  "small_model": "openai/gpt-5-mini",\n}\n'
            )
          )
        : Promise.reject({ code: 'FileNotFound' })
    );
    vscodeMock.workspace.fs.stat.mockResolvedValue({ mtime: 1, size: 10, type: 0, ctime: 0 });

    const { provider } = await createSidebarProviderInstance();
    await provider.handleMessage({
      type: 'api/request',
      payload: {
        id: 9,
        method: 'POST',
        path: '/varro/opencode-config/model-routing',
        body: { target: 'small_model', providerID: 'openai', modelID: 'gpt-5' },
      },
    });

    const [uri, encoded] = vscodeMock.workspace.fs.writeFile.mock.lastCall as unknown as [
      { fsPath: string },
      Uint8Array,
    ];
    const written = new TextDecoder().decode(encoded);
    expect(uri.fsPath).toBe('/repo/opencode.jsonc');
    expect(written).toContain('// Keep this model note.');
    expect(written).toContain('"small_model": "openai/gpt-5"');
  });
});
