import { postMessage } from './bridge';

export function openProviderSetup() {
  postMessage({
    type: 'terminal/run',
    payload: { command: 'opencode auth login', title: 'OpenCode Provider Setup' },
  });
}
