import { describe, expect, it } from 'vitest';
import {
  mergeVarroSessionMetadata,
  readSessionAgentMetadata,
  readSessionModelMetadata,
} from './session-selection-metadata';

describe('session selection metadata', () => {
  it('rejects malformed selections without affecting independent fields', () => {
    for (const metadata of [
      undefined,
      null,
      {},
      { varro: { model: 'model' } },
      { varro: { model: { provider: '', model: 'model' } } },
      { varro: { model: { provider: 'provider', model: ' ' } } },
      { varro: { model: { provider: 'provider', model: 'model', variant: 5 } } },
    ]) {
      expect(readSessionModelMetadata(metadata)).toBeUndefined();
    }
    for (const agent of [undefined, null, '', ' ', 5, {}]) {
      expect(readSessionAgentMetadata({ varro: { agent } })).toBeUndefined();
    }
    expect(readSessionAgentMetadata({ varro: { model: 'invalid', agent: 'custom-agent' } })).toBe(
      'custom-agent'
    );
    expect(
      readSessionModelMetadata({
        varro: { model: { provider: 'provider', model: 'model', variant: 'low' } },
      })
    ).toEqual({ providerID: 'provider', modelID: 'model', variant: 'low' });
    expect(
      readSessionModelMetadata({ varro: { model: { provider: 'provider', model: 'model' } } })
    ).toEqual({ providerID: 'provider', modelID: 'model' });
  });

  it('merges nested selections while preserving workspace scope and unrelated metadata', () => {
    const metadata = {
      other: { enabled: true },
      varro: {
        schemaVersion: 1,
        workspaceScope: 'folder',
        custom: 'kept',
        permissionMode: 'auto',
        model: { provider: 'old', model: 'old-model', variant: 'high' },
      },
    };
    const next = mergeVarroSessionMetadata(metadata, {
      model: { providerID: 'openai', modelID: 'new-model' },
      agent: 'build',
    });
    expect(next).toEqual({
      other: { enabled: true },
      varro: {
        schemaVersion: 1,
        workspaceScope: 'folder',
        custom: 'kept',
        permissionMode: 'auto',
        model: { provider: 'openai', model: 'new-model' },
        agent: 'build',
      },
    });
    expect(metadata.varro.model.variant).toBe('high');
    expect(mergeVarroSessionMetadata(undefined, { permissionMode: 'full' })).toEqual({
      varro: { schemaVersion: 1, permissionMode: 'full' },
    });
  });
});
