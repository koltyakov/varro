import { describe, expect, it, vi } from 'vitest';
import {
  attachTestView,
  createServer,
  createSidebarProviderInstance,
  getVscodeMock,
} from './sidebar-provider.test-support';

const vscodeMock = getVscodeMock();

describe('SidebarProvider local config routing', () => {
  it('reads model routing from project opencode.json', async () => {
    vscodeMock.workspace.fs.readFile.mockResolvedValue(
      new TextEncoder().encode(
        JSON.stringify({
          small_model: 'openai/gpt-5-mini',
          agent: {
            build: { model: 'openai/gpt-5' },
            review: { model: 'anthropic/claude-sonnet-4' },
          },
        })
      )
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
        },
      },
    });
  });

  it('handles local config routes without starting the server', async () => {
    vscodeMock.workspace.fs.readFile.mockResolvedValue(
      new TextEncoder().encode(JSON.stringify({ small_model: 'openai/gpt-5-mini' }))
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
        },
      },
    });
  });

  it('writes small_model routing to project opencode.json', async () => {
    vscodeMock.workspace.fs.readFile.mockRejectedValueOnce({ code: 'FileNotFound' });

    const { provider } = await createSidebarProviderInstance({
      server: createServer({ getWorkspaceCwd: vi.fn(() => '/repo') }),
    });
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
        },
      },
    });
  });

  it('writes agent model routing while preserving existing config keys', async () => {
    vscodeMock.workspace.fs.readFile.mockResolvedValueOnce(
      new TextEncoder().encode(
        JSON.stringify({
          model: 'openai/gpt-5',
          agent: {
            build: { mode: 'primary', model: 'openai/gpt-5' },
          },
        })
      )
    );

    const { provider } = await createSidebarProviderInstance({
      server: createServer({ getWorkspaceCwd: vi.fn(() => '/repo') }),
    });

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
  });
});
