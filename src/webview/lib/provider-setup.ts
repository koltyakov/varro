import { postMessage } from './bridge';

export function openProviderSetup(providerID?: string | null) {
  const claudeAgent = providerID === 'claude-agent';
  postMessage({
    type: 'terminal/run',
    payload: {
      command: claudeAgent ? 'claude auth login' : 'opencode auth login',
      title: claudeAgent ? 'Claude Code Login' : 'OpenCode Provider Setup',
    },
  });
}

export function openProviderLogout() {
  postMessage({
    type: 'terminal/run',
    payload: { command: 'opencode auth logout', title: 'OpenCode Provider Logout' },
  });
}
