import { asRecord, isString } from '../shared/type-utils';
import { isSameWorkspacePath, normalizeWorkspaceIdentity } from '../shared/workspace-path';
import type { OpenCodeServer } from './server';

export async function assertSessionInCurrentWorkspace(
  server: Pick<OpenCodeServer, 'getWorkspaceCwd' | 'request'>,
  sessionId: string,
  requestedDirectory?: string
): Promise<string | undefined> {
  const workspacePath = requestedDirectory ?? server.getWorkspaceCwd();
  if (!normalizeWorkspaceIdentity(workspacePath)) return undefined;

  const session = asRecord(
    await server.request('GET', `/session/${encodeURIComponent(sessionId)}`, undefined, {
      directory: workspacePath,
    })
  );
  if (
    (!requestedDirectory && !isSameWorkspacePath(server.getWorkspaceCwd(), workspacePath)) ||
    session?.id !== sessionId ||
    !isString(session.directory) ||
    !isSameWorkspacePath(session.directory, workspacePath)
  ) {
    throw new Error('Session does not belong to the current workspace');
  }
  return session.directory;
}
