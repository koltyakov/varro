import { describe, expect, it } from 'vitest';
import { assistantMessage, getClientMocks, loadModules, session } from './useOpenCode.test-support';

const clientMocks = getClientMocks();

describe('session control loading ownership', () => {
  for (const control of ['undo', 'redo', 'compact'] as const) {
    for (const outcome of ['success', 'failure'] as const) {
      it.each(['other session', 'round trip', 'newer loading'] as const)(
        `${control} ${outcome} preserves %s state`,
        async (transition) => {
          const { stateModule, hookModule } = await loadModules();
          stateModule.setSessions([session('session-a'), session('session-b')]);
          stateModule.setState('activeSessionId', 'session-a');
          stateModule.setState('providers', [
            {
              id: 'openai',
              name: 'OpenAI',
              source: 'api',
              models: {
                model: {
                  id: 'model',
                  name: 'Model',
                  capabilities: {},
                  cost: { input: 0, output: 0 },
                },
              },
            },
          ]);
          stateModule.setState('selectedModel', { providerID: 'openai', modelID: 'model' });
          stateModule.setState('messages', [
            {
              info: { ...assistantMessage('assistant-a', 'user-a'), sessionID: 'session-a' },
              parts: [],
            },
          ]);
          clientMocks.sessionGet.mockImplementation(async (id: string) => session(id));
          clientMocks.sessionMessages.mockResolvedValue([]);
          clientMocks.sessionStatus.mockResolvedValue({});
          clientMocks.questionList.mockResolvedValue([]);
          let resolve!: (value: ReturnType<typeof session>) => void;
          let reject!: (error: Error) => void;
          const pending = new Promise<ReturnType<typeof session>>((res, rej) => {
            resolve = res;
            reject = rej;
          });
          const remote =
            control === 'undo'
              ? clientMocks.sessionRevert
              : control === 'redo'
                ? clientMocks.sessionUnrevert
                : clientMocks.sessionCompact;
          remote.mockReturnValue(pending);
          const operation =
            control === 'undo'
              ? hookModule.undoSession()
              : control === 'redo'
                ? hookModule.redoSession()
                : hookModule.compactSession();
          expect(remote).toHaveBeenCalledOnce();
          if (transition !== 'newer loading') {
            await hookModule.selectSession('session-b');
            if (transition === 'round trip') await hookModule.selectSession('session-a');
          }
          stateModule.startLoading(200);
          stateModule.setError('newer error');
          const startedAt = stateModule.loadingStartedAt();
          if (outcome === 'success') resolve(session('session-a'));
          else reject(new Error('old control failed'));
          await operation;
          expect(stateModule.state.activeSessionId).toBe(
            transition === 'other session' ? 'session-b' : 'session-a'
          );
          expect(stateModule.isLoading()).toBe(true);
          expect(stateModule.loadingStartedAt()).toBe(startedAt);
          expect(stateModule.error()).toBe('newer error');
        }
      );
    }
  }
});
