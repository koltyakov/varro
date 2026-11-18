import { flush } from 'solid-js';
import { expect, it } from 'vitest';
import {
  clearSelectedAgentForSession,
  clearSelectedModelForSession,
  setSelectedAgent,
  setSelectedModel,
} from './state-model-selection';
import { resetDefaultAppState, state } from './state';

it('persists per-session model and agent clears in the same turn as selection', () => {
  const model = { providerID: 'provider', modelID: 'model' };
  for (const sessionId of ['keep', 'remove']) {
    setSelectedAgent('build', { sessionId, persistGlobal: false, publishHost: false });
    setSelectedModel(model, { sessionId, persistGlobal: false });
  }
  clearSelectedAgentForSession('remove');
  clearSelectedModelForSession('remove');
  flush();
  expect(state.sessionSelectedAgents).toEqual({ keep: 'build' });
  expect(state.sessionSelectedModels).toEqual({ keep: model });
  resetDefaultAppState();
  flush();
  expect(state.sessionSelectedAgents).toEqual({ keep: 'build' });
  expect(state.sessionSelectedModels).toEqual({ keep: model });
});

it('can reselect a cleared session choice before the next render', () => {
  const model = { providerID: 'provider', modelID: 'model' };
  const options = { sessionId: 'chat', persistGlobal: false, publishHost: false };
  setSelectedAgent('build', options);
  setSelectedModel(model, options);
  flush();
  clearSelectedAgentForSession('chat');
  clearSelectedModelForSession('chat');
  setSelectedAgent('build', options);
  setSelectedModel(model, options);
  flush();
  expect(state.sessionSelectedAgents.chat).toBe('build');
  expect(state.sessionSelectedModels.chat).toEqual(model);
  resetDefaultAppState();
  flush();
  expect(state.sessionSelectedAgents.chat).toBe('build');
  expect(state.sessionSelectedModels.chat).toEqual(model);
});
