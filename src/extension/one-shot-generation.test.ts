import { describe, expect, it, vi } from 'vitest';
import { tryGenerateOneShot } from './one-shot-generation';

const specification = { paths: { '/api/experimental/generate': { post: {} } } };
const input = () => ({
  prompt: 'Return JSON',
  model: { providerID: 'test', modelID: 'small', variant: 'none' },
  directory: '/fixture',
  signal: new AbortController().signal,
});

describe('one-shot generation dispatch', () => {
  it('falls back only for the exact selected model admission error', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(specification)
      .mockRejectedValueOnce(new Error('400 Model unavailable: test/small'));
    expect(await tryGenerateOneShot({ apiVersion: 2, request }, input())).toBeNull();
    expect(request).toHaveBeenCalledTimes(2);
  });
  it('rejects malformed output without offering another generation', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(specification)
      .mockResolvedValueOnce({ data: { text: 42 } });
    await expect(tryGenerateOneShot({ apiVersion: 2, request }, input())).rejects.toThrow(
      'invalid one-shot'
    );
    expect(request).toHaveBeenCalledTimes(2);
  });
  it('does no request on v1 and no generation without the advertised operation', async () => {
    const request = vi.fn(async () => ({ paths: {} }));
    expect(await tryGenerateOneShot({ apiVersion: 1, request }, input())).toBeNull();
    expect(request).not.toHaveBeenCalled();
    expect(await tryGenerateOneShot({ apiVersion: 2, request }, input())).toBeNull();
    expect(request).toHaveBeenCalledOnce();
  });
  it('preserves model, variant, directory and cancellation, without creating sessions', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(specification)
      .mockResolvedValueOnce({ data: { text: '{"title":"Test"}' } });
    const options = input();
    expect(await tryGenerateOneShot({ apiVersion: 2, request }, options)).toEqual({
      text: '{"title":"Test"}',
    });
    expect(request).toHaveBeenLastCalledWith(
      'POST',
      '/api/experimental/generate',
      { prompt: options.prompt, model: { providerID: 'test', id: 'small', variant: 'none' } },
      { directory: '/fixture', signal: options.signal }
    );
    expect(request).toHaveBeenCalledTimes(2);
  });
  it.each(['401 Unauthorized', '503 Unavailable', 'Request timed out', '404 Model not found'])(
    'does not offer a fallback after generation rejects with %s',
    async (message) => {
      const request = vi
        .fn()
        .mockResolvedValueOnce(specification)
        .mockRejectedValueOnce(new Error(message));
      await expect(tryGenerateOneShot({ apiVersion: 2, request }, input())).rejects.toThrow(
        message
      );
      expect(request).toHaveBeenCalledTimes(2);
    }
  );
  it('does not admit generation after cancellation during capability discovery', async () => {
    const controller = new AbortController();
    const request = vi.fn(async () => {
      controller.abort();
      return specification;
    });
    await expect(
      tryGenerateOneShot({ apiVersion: 2, request }, { ...input(), signal: controller.signal })
    ).rejects.toThrow();
    expect(request).toHaveBeenCalledOnce();
  });
});
