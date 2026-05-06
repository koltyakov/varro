import { postMessage } from './bridge';
import { client } from './client';

export function openProviderSetup() {
  postMessage({
    type: 'terminal/run',
    payload: { command: 'opencode auth login', title: 'OpenCode Provider Setup' },
  });
}

export async function beginProviderAuthorization(providerID: string, method = 0) {
  const authorization = await client.config.authorizeProvider({ providerID, method });
  postMessage({ type: 'vscode/open-external', payload: { url: authorization.url } });
  return authorization;
}
