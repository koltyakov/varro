import type { Session } from '../types';
import { client } from './client';
import { markSessionShared, markSessionUnshared } from './session-share-overrides';
import { setError, setState } from './state';
import { writeClipboard } from './write-clipboard';

function updateSessionShare(sessionID: string, share: Session['share']) {
  setState('sessions', (session) => session.id === sessionID, 'share', share);
}

export async function shareSession(session: Session): Promise<boolean> {
  try {
    let url = session.share?.url;
    if (!url) {
      const updated = await client.session.share(session.id, { directory: session.directory });
      markSessionShared(updated.id);
      updateSessionShare(updated.id, updated.share);
      url = updated.share?.url;
    }
    if (!url) throw new Error('OpenCode did not return a session share link');
    if (!(await writeClipboard(url))) {
      setError('Failed to copy session share link');
      return false;
    }
    return true;
  } catch (error) {
    setError(error instanceof Error ? error.message : String(error));
    return false;
  }
}

export async function unshareSession(session: Session): Promise<boolean> {
  try {
    await client.session.unshare(session.id, { directory: session.directory });
    markSessionUnshared(session.id);
    updateSessionShare(session.id, undefined);
    return true;
  } catch (error) {
    setError(error instanceof Error ? error.message : String(error));
    return false;
  }
}
