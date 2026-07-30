import { postMessage } from './bridge';

export function openProviderSetup() {
  postMessage({
    type: 'terminal/run',
    payload: { command: 'opencode auth login', title: 'OpenCode Provider Setup' },
  });
}

export function openProviderLogout() {
  postMessage({
    type: 'terminal/run',
    payload: { command: 'opencode providers logout', title: 'OpenCode Provider Logout' },
  });
}
