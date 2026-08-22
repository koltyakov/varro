import { asRecord, isString } from '../shared/type-utils';
import { isSameWorkspacePath, normalizeWorkspaceIdentity } from '../shared/workspace-path';
import type { OpenCodeServer } from './server';

export async function assertSessionInCurrentWorkspace(
  server: Pick<OpenCodeServer, 'getWorkspaceCwd' | 'request'>,
  sessionId: string
): Promise<void> {
  const workspacePath = server.getWorkspaceCwd();
  if (!normalizeWorkspaceIdentity(workspacePath)) return;

  const session = asRecord(
    await server.request('GET', `/session/${encodeURIComponent(sessionId)}`)
  );
  const currentWorkspacePath = server.getWorkspaceCwd();
  if (
    !isSameWorkspacePath(currentWorkspacePath, workspacePath) ||
    session?.id !== sessionId ||
    !isString(session.directory) ||
    !isSameWorkspacePath(session.directory, workspacePath)
  ) {
    throw new Error('Session does not belong to the current workspace');
  }
}
