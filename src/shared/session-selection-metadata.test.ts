import { describe, expect, it } from 'vitest';
import { readSessionAgentMetadata, readSessionModelMetadata } from './session-selection-metadata';

describe('session selection metadata', () => {
  it('rejects malformed selections without affecting independent fields', () => {
    for (const metadata of [
      undefined,
      null,
      {},
      { varroModel: 'model' },
      { varroModel: { providerID: '', modelID: 'model' } },
      { varroModel: { providerID: 'provider', modelID: ' ' } },
      { varroModel: { providerID: 'provider', modelID: 'model', variant: 5 } },
    ]) {
      expect(readSessionModelMetadata(metadata)).toBeUndefined();
    }
    for (const agent of [undefined, null, '', ' ', 5, {}]) {
      expect(readSessionAgentMetadata({ varroAgent: agent })).toBeUndefined();
    }
    expect(readSessionAgentMetadata({ varroModel: 'invalid', varroAgent: 'custom-agent' })).toBe(
      'custom-agent'
    );
    expect(
      readSessionModelMetadata({
        varroModel: { providerID: 'provider', modelID: 'model', variant: 'low' },
      })
    ).toEqual({ providerID: 'provider', modelID: 'model', variant: 'low' });
    expect(
      readSessionModelMetadata({ varroModel: { providerID: 'provider', modelID: 'model' } })
    ).toEqual({ providerID: 'provider', modelID: 'model' });
  });
});
