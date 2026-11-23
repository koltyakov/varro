import { storePath } from '@solidjs/signals';
import { flush } from 'solid-js';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Agent, Provider } from '../types';
import {
  getAgentConfiguredModel,
  rememberAgentModel,
  resolveAgentSwitchModel,
  resolveNewChatAgentModel,
} from './agent-model-selection';
import { setState } from './app-state';
import { STORAGE_KEYS, writeStored } from './state-storage';
import { writeStoredSelectedModelForWorkspace } from './state-stored-values';

const SOL = { providerID: 'openai', modelID: 'gpt-6-sol' };
const LUNA = { providerID: 'openai', modelID: 'gpt-6-luna-fast' };
const OTHER = { providerID: 'anthropic', modelID: 'claude' };

function provider(id: string, modelIDs: string[], variants?: string[]): Provider {
  const models: Provider['models'] = {};
  for (const modelID of modelIDs) {
    const model: Provider['models'][string] = {
      id: modelID,
      name: modelID.toUpperCase(),
      capabilities: { toolcall: true },
      cost: { input: 0, output: 0 },
    };
    if (variants) model.variants = Object.fromEntries(variants.map((variant) => [variant, {}]));
    models[modelID] = model;
  }
  return { id, name: id, source: 'api', models };
}

function agent(name: string, model?: { providerID: string; modelID: string; variant?: string }) {
  const result: Agent = { name, mode: 'primary', permission: [] };
  if (model) result.model = model;
  return result;
}

beforeEach(() => {
  setState(
    storePath('providers', [
      provider('openai', [SOL.modelID, LUNA.modelID], ['low', 'high']),
      provider('anthropic', [OTHER.modelID]),
    ])
  );
  setState(storePath('providerDefaults', {}));
  setState(storePath('hiddenModels', []));
  setState(storePath('modelVariantSelections', {}));
  setState(storePath('lastSelectedModel', null));
  setState(
    storePath('agents', [
      agent('build'),
      agent('plan', LUNA),
      agent('review', { ...SOL, variant: 'high' }),
      agent('missing', { providerID: 'gone', modelID: 'nope' }),
    ])
  );
  setState(storePath('allAgents', []));
  writeStoredSelectedModelForWorkspace(null, null);
  flush();
});

describe('getAgentConfiguredModel', () => {
  it('returns the configured model with its default variant', () => {
    expect(getAgentConfiguredModel('plan')).toEqual(LUNA);
    expect(getAgentConfiguredModel('review')).toEqual({ ...SOL, variant: 'high' });
  });

  it('prefers a remembered reasoning choice over the agent variant', () => {
    setState(storePath('modelVariantSelections', { 'openai:gpt-6-sol': 'low' }));
    flush();
    expect(getAgentConfiguredModel('review')).toEqual({ ...SOL, variant: 'low' });
    setState(storePath('modelVariantSelections', { 'openai:gpt-6-sol': null }));
    flush();
    expect(getAgentConfiguredModel('review')).toEqual(SOL);
  });

  it('ignores agents without a model or with an unavailable model', () => {
    expect(getAgentConfiguredModel('build')).toBeNull();
    expect(getAgentConfiguredModel('missing')).toBeNull();
    expect(getAgentConfiguredModel(null)).toBeNull();
  });

  it('accepts a configured model hidden from the picker', () => {
    setState(storePath('hiddenModels', ['openai:gpt-6-luna-fast']));
    flush();
    expect(getAgentConfiguredModel('plan')).toEqual(LUNA);
  });
});

describe('resolveAgentSwitchModel', () => {
  it('applies the next agent model', () => {
    expect(
      resolveAgentSwitchModel({
        sessionId: 'switch-apply',
        previousAgent: 'build',
        nextAgent: 'plan',
        currentModel: OTHER,
      })
    ).toEqual(LUNA);
  });

  it('keeps the current model when no agent has a model', () => {
    setState(storePath('agents', [agent('build'), agent('ask')]));
    flush();
    expect(
      resolveAgentSwitchModel({
        sessionId: 'switch-plain',
        previousAgent: 'build',
        nextAgent: 'ask',
        currentModel: OTHER,
      })
    ).toBeNull();
  });

  it('keeps the current model when the next agent model is unavailable', () => {
    expect(
      resolveAgentSwitchModel({
        sessionId: 'switch-missing',
        previousAgent: 'build',
        nextAgent: 'missing',
        currentModel: OTHER,
      })
    ).toBeNull();
  });

  it('restores the model a session used with an agent before switching away', () => {
    const sessionId = 'switch-restore';
    expect(
      resolveAgentSwitchModel({
        sessionId,
        previousAgent: 'build',
        nextAgent: 'plan',
        currentModel: OTHER,
      })
    ).toEqual(LUNA);
    expect(
      resolveAgentSwitchModel({
        sessionId,
        previousAgent: 'plan',
        nextAgent: 'build',
        currentModel: LUNA,
      })
    ).toEqual(OTHER);
  });

  it('restores a manual choice made with an agent in the same session', () => {
    const sessionId = 'switch-manual';
    rememberAgentModel(sessionId, 'plan', SOL);
    expect(
      resolveAgentSwitchModel({
        sessionId,
        previousAgent: 'build',
        nextAgent: 'plan',
        currentModel: OTHER,
      })
    ).toEqual(SOL);
  });

  it('does not share one session agent memory with another session', () => {
    rememberAgentModel('switch-a', 'plan', SOL);
    expect(
      resolveAgentSwitchModel({
        sessionId: 'switch-b',
        previousAgent: 'build',
        nextAgent: 'plan',
        currentModel: OTHER,
      })
    ).toEqual(LUNA);
  });

  it('returns a new chat to the folder model after leaving a configured agent', () => {
    writeStoredSelectedModelForWorkspace(null, OTHER);
    expect(
      resolveAgentSwitchModel({
        sessionId: null,
        previousAgent: 'plan',
        nextAgent: 'build',
        currentModel: LUNA,
      })
    ).toEqual(OTHER);
  });

  it('falls back to the last manual model when the folder has none', () => {
    setState(storePath('lastSelectedModel', OTHER));
    writeStored(STORAGE_KEYS.lastSelectedModel, OTHER);
    flush();
    expect(
      resolveAgentSwitchModel({
        sessionId: null,
        previousAgent: 'plan',
        nextAgent: 'build',
        currentModel: LUNA,
      })
    ).toEqual(OTHER);
  });

  it('keeps a manual model when leaving a configured agent', () => {
    writeStoredSelectedModelForWorkspace(null, OTHER);
    expect(
      resolveAgentSwitchModel({
        sessionId: null,
        previousAgent: 'plan',
        nextAgent: 'build',
        currentModel: SOL,
      })
    ).toBeNull();
  });

  it('ignores reselecting the current agent', () => {
    expect(
      resolveAgentSwitchModel({
        sessionId: 'switch-same',
        previousAgent: 'plan',
        nextAgent: 'plan',
        currentModel: OTHER,
      })
    ).toBeNull();
  });
});

describe('resolveNewChatAgentModel', () => {
  it('starts with the agent model unless the user chose one for that agent', () => {
    expect(resolveNewChatAgentModel('plan')).toEqual(LUNA);
    expect(resolveNewChatAgentModel('build')).toBeNull();
    rememberAgentModel(null, 'plan', SOL);
    rememberAgentModel(null, 'build', OTHER);
    expect(resolveNewChatAgentModel('plan')).toEqual(SOL);
    expect(resolveNewChatAgentModel('build')).toEqual(OTHER);
  });

  it('keeps new chat memory separate per workspace', () => {
    setState(storePath('editorContext', 'workspacePath', '/workspace/other'));
    flush();
    expect(resolveNewChatAgentModel('plan')).toEqual(LUNA);
    setState(storePath('editorContext', 'workspacePath', null));
    flush();
  });
});
