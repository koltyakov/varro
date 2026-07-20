import { describe, expect, it } from 'vitest';
import { createStore } from 'solid-js/store';
import type { Permission } from '../types';
import type { SelectedModel } from './app-state-types';
import { toApprovedPermissionReference, toPlainJudgeModel } from './judge-request';

function createStoreState() {
  const [state] = createStore<{ permissions: Permission[]; selectedModel: SelectedModel }>({
    permissions: [
      {
        id: 'per_1',
        type: 'bash',
        pattern: ['opencode *'],
        sessionID: 'ses_1',
        messageID: 'msg_1',
        title: 'bash opencode --version',
        metadata: { command: 'opencode --version', files: [{ path: 'a.ts' }] },
        time: { created: 1 },
      },
    ],
    selectedModel: { providerID: 'openai', modelID: 'gpt-5.6', variant: 'sol' },
  });
  return state;
}

describe('judge-request', () => {
  it('documents why plain copies are needed: store reads cannot be structured-cloned', () => {
    const state = createStoreState();

    expect(() => structuredClone({ metadata: state.permissions[0]!.metadata })).toThrow();
  });

  it('builds approved references that survive structured clone', () => {
    const state = createStoreState();

    const reference = toApprovedPermissionReference(state.permissions[0]!, 'always');

    expect(structuredClone(reference)).toEqual({
      type: 'bash',
      title: 'bash opencode --version',
      response: 'always',
      pattern: ['opencode *'],
      metadata: { command: 'opencode --version', files: [{ path: 'a.ts' }] },
    });
  });

  it('keeps string patterns and omits absent fields on references', () => {
    const state = createStoreState();

    const reference = toApprovedPermissionReference(
      { ...state.permissions[0]!, pattern: 'opencode *', metadata: undefined as never },
      'once'
    );

    expect(reference).toEqual({
      type: 'bash',
      title: 'bash opencode --version',
      response: 'once',
      pattern: 'opencode *',
    });
  });

  it('builds judge models that survive structured clone', () => {
    const state = createStoreState();

    const model = toPlainJudgeModel(state.selectedModel);

    expect(structuredClone(model)).toEqual({
      providerID: 'openai',
      modelID: 'gpt-5.6',
      variant: 'sol',
    });
  });

  it('passes null models through and drops empty variants', () => {
    expect(toPlainJudgeModel(null)).toBeNull();
    expect(toPlainJudgeModel({ providerID: 'openai', modelID: 'gpt-5.6' })).toEqual({
      providerID: 'openai',
      modelID: 'gpt-5.6',
    });
  });
});
