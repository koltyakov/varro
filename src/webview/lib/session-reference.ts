import { normalizeSessionTitle } from '../../shared/session-title';
import { state } from './state';

export type SessionReference = {
  id: string;
  title: string;
  href: string;
};

export type SessionReferenceTextSegment =
  | { type: 'text'; content: string }
  | { type: 'session'; reference: SessionReference };

export const SESSION_ID_RE = /\bses_[A-Za-z0-9_-]*[A-Za-z0-9]\b/g;

export function resolveSessionReference(sessionId: string): SessionReference | null {
  const session = state.sessions.find((candidate) => candidate.id === sessionId);
  if (!session) return null;

  return {
    id: session.id,
    title: normalizeSessionTitle(session.title) || 'Untitled',
    href: `#session/${encodeURIComponent(session.id)}`,
  };
}

export function splitSessionReferenceText(content: string): SessionReferenceTextSegment[] {
  const segments: SessionReferenceTextSegment[] = [];
  let lastIndex = 0;

  for (const match of content.matchAll(SESSION_ID_RE)) {
    const index = match.index ?? 0;
    const sessionId = match[0];
    const reference = resolveSessionReference(sessionId);
    if (!reference) continue;

    if (index > lastIndex) {
      segments.push({ type: 'text', content: content.slice(lastIndex, index) });
    }
    segments.push({ type: 'session', reference });
    lastIndex = index + sessionId.length;
  }

  if (lastIndex < content.length) {
    segments.push({ type: 'text', content: content.slice(lastIndex) });
  }
  return segments.length > 0 ? segments : [{ type: 'text', content }];
}

export function getSessionReferenceContextKey(content: string): string {
  const sessionIds = [...new Set(content.match(SESSION_ID_RE) ?? [])];
  return sessionIds
    .map((sessionId) => {
      const reference = resolveSessionReference(sessionId);
      return reference ? `found:${reference.id}:${reference.title}` : `missing:${sessionId}`;
    })
    .join('\u0000');
}
