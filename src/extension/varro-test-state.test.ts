import { resolve, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getVarroTestStateDirectory } from './varro-test-state';

afterEach(() => vi.unstubAllEnvs());

describe('Varro test state paths', () => {
  it('leaves ordinary editor builds on their existing shared paths', () => {
    vi.stubEnv('VARRO_TEST_STATE_ROOT', undefined);
    vi.stubEnv('VARRO_TEST_SERVER_URL', undefined);
    expect(getVarroTestStateDirectory('servers')).toBeUndefined();
    expect(getVarroTestStateDirectory('opencode-v2')).toBeUndefined();
    expect(getVarroTestStateDirectory('provider-quota-v2')).toBeUndefined();
  });

  it('uses one explicit test root for ownership and session annotations', () => {
    const root = resolve('artifacts/ai-test-data/path-fixture');
    vi.stubEnv('VARRO_TEST_STATE_ROOT', root);
    expect(getVarroTestStateDirectory('servers')).toBe(join(root, 'servers'));
    expect(getVarroTestStateDirectory('opencode-v2')).toBe(join(root, 'opencode-v2'));
    expect(getVarroTestStateDirectory('provider-quota-v2')).toBe(join(root, 'provider-quota-v2'));
  });

  it.each(['', '  ', 'relative/state'])('refuses invalid test state root %j', (root) => {
    vi.stubEnv('VARRO_TEST_STATE_ROOT', root);
    expect(() => getVarroTestStateDirectory('servers')).toThrow('absolute isolated directory');
  });

  it('fails closed instead of using production state when a test endpoint lacks a scope', () => {
    vi.stubEnv('VARRO_TEST_STATE_ROOT', undefined);
    vi.stubEnv('VARRO_TEST_SERVER_URL', 'http://127.0.0.1:49999');
    expect(() => getVarroTestStateDirectory('servers')).toThrow('state isolation is missing');
    expect(() => getVarroTestStateDirectory('opencode-v2')).toThrow('state isolation is missing');
    expect(() => getVarroTestStateDirectory('provider-quota-v2')).toThrow(
      'state isolation is missing'
    );
  });
});
