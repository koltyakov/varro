import type { Session } from '../types';
import { client } from './client';
import {
  beginSessionShareUpdate,
  cancelSessionShareUpdate,
  completeSessionShareUpdate,
  markSessionShared,
  markSessionUnshared,
} from './session-share-overrides';
import { setError, setState } from './state';
import { writeClipboard } from './write-clipboard';

function updateSessionShare(sessionID: string, share: Session['share'], updatedAt: number) {
  setState(
    'sessions',
    (session) => session.id === sessionID,
    (current) => ({
      ...current,
      share,
      time: { ...current.time, updated: updatedAt },
    })
  );
}

export async function shareSession(session: Session): Promise<boolean> {
  let shareUpdatePending = false;
  try {
    let url = session.share?.url;
    if (!url) {
      beginSessionShareUpdate(session.id, session.time.updated);
      shareUpdatePending = true;
      const updated = await client.session.share(session.id, { directory: session.directory });
      completeSessionShareUpdate(session.id, Math.max(updated.time.updated, Date.now()));
      shareUpdatePending = false;
      markSessionShared(updated.id);
      updateSessionShare(updated.id, updated.share, session.time.updated);
      url = updated.share?.url;
    }
    if (!url) throw new Error('OpenCode did not return a session share link');
    if (!(await writeClipboard(url))) {
      setError('Failed to copy session share link');
      return false;
    }
    return true;
  } catch (error) {
    if (shareUpdatePending) cancelSessionShareUpdate(session.id);
    setError(error instanceof Error ? error.message : String(error));
    return false;
  }
}

export async function unshareSession(session: Session): Promise<boolean> {
  beginSessionShareUpdate(session.id, session.time.updated);
  try {
    const updated = await client.session.unshare(session.id, { directory: session.directory });
    completeSessionShareUpdate(session.id, Math.max(updated.time.updated, Date.now()));
    markSessionUnshared(session.id);
    updateSessionShare(session.id, undefined, session.time.updated);
    return true;
  } catch (error) {
    cancelSessionShareUpdate(session.id);
    setError(error instanceof Error ? error.message : String(error));
    return false;
  }
}
