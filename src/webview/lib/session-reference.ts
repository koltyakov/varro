import { normalizeSessionTitle } from '../../shared/session-title';
import { getWorkspaceFolderLabel } from '../../shared/workspace-folders';
import type { Session } from '../types';
import { state } from './state';

export type SessionReference = {
  id: string;
  directory: string;
  folderLabel?: string;
  title: string;
  href: string;
  marker: string;
};

export type SessionReferenceTextSegment =
  | { type: 'text'; content: string }
  | { type: 'session'; reference: SessionReference };

export const SESSION_ID_RE = /\bsession:([A-Za-z0-9_-]+)\b|\b(ses_[A-Za-z0-9_-]*[A-Za-z0-9])\b/g;

export function resolveSessionReference(
  sessionId: string,
  marker = sessionId
): SessionReference | null {
  const session = state.sessions.find((candidate) => candidate.id === sessionId);
  return createSessionReference(session, marker);
}

function createSessionReference(
  session: Session | undefined,
  marker: string
): SessionReference | null {
  if (!session) return null;

  const folderLabel =
    (state.editorContext.workspaceFolders?.length ?? 0) > 1
      ? (getWorkspaceFolderLabel(session.directory, state.editorContext.workspaceFolders ?? []) ??
        undefined)
      : undefined;
  const reference: SessionReference = {
    id: session.id,
    directory: session.directory,
    title: normalizeSessionTitle(session.title) || 'Untitled',
    href: `#session/${encodeURIComponent(session.id)}`,
    marker,
  };
  if (folderLabel) reference.folderLabel = folderLabel;
  return reference;
}

export function splitSessionReferenceText(content: string): SessionReferenceTextSegment[] {
  const segments: SessionReferenceTextSegment[] = [];
  let lastIndex = 0;
  const matches = Array.from(content.matchAll(SESSION_ID_RE));
  const sessions = matches.length > 1 ? indexReferencedSessions(matches) : null;

  for (const match of matches) {
    const index = match.index ?? 0;
    const marker = match[0];
    const sessionId = match[1] || match[2]!;
    const reference = sessions
      ? createSessionReference(sessions.get(sessionId), marker)
      : resolveSessionReference(sessionId, marker);
    if (!reference) continue;

    if (index > lastIndex) {
      segments.push({ type: 'text', content: content.slice(lastIndex, index) });
    }
    segments.push({ type: 'session', reference });
    lastIndex = index + marker.length;
  }

  if (lastIndex < content.length) {
    segments.push({ type: 'text', content: content.slice(lastIndex) });
  }
  return segments.length > 0 ? segments : [{ type: 'text', content }];
}

export function getSessionReferenceContextKey(content: string): string {
  const matches = Array.from(content.matchAll(SESSION_ID_RE));
  if (matches.length === 0) return '';
  const sessions = matches.length > 1 ? indexReferencedSessions(matches) : null;
  const markers = new Set<string>();
  const keys: string[] = [];
  for (const match of matches) {
    const marker = match[0];
    if (markers.has(marker)) continue;
    markers.add(marker);
    const sessionId = match[1] || match[2]!;
    const reference = sessions
      ? createSessionReference(sessions.get(sessionId), marker)
      : resolveSessionReference(sessionId, marker);
    keys.push(
      reference
        ? `found:${reference.id}:${reference.directory}:${reference.title}:${reference.folderLabel ?? ''}`
        : `missing:${marker}`
    );
  }
  return keys.join('\u0000');
}

function indexReferencedSessions(matches: readonly RegExpMatchArray[]): Map<string, Session> {
  const remaining = new Set(matches.map((match) => match[1] || match[2]!));
  const sessions = new Map<string, Session>();
  // Keep the first matching session, as Array.find does, and retain only the
  // referenced IDs. This index lives for one calculation so metadata stays live.
  for (const session of state.sessions) {
    const id = session.id;
    if (!remaining.delete(id)) continue;
    sessions.set(id, session);
    if (remaining.size === 0) break;
  }
  return sessions;
}
