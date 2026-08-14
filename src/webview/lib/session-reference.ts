import { normalizeSessionTitle } from '../../shared/session-title';
import { state } from './state';

export type SessionReference = {
  id: string;
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
  if (!session) return null;

  return {
    id: session.id,
    title: normalizeSessionTitle(session.title) || 'Untitled',
    href: `#session/${encodeURIComponent(session.id)}`,
    marker,
  };
}

export function splitSessionReferenceText(content: string): SessionReferenceTextSegment[] {
  const segments: SessionReferenceTextSegment[] = [];
  let lastIndex = 0;

  for (const match of content.matchAll(SESSION_ID_RE)) {
    const index = match.index ?? 0;
    const marker = match[0];
    const sessionId = match[1] || match[2]!;
    const reference = resolveSessionReference(sessionId, marker);
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
  const markers = [...new Set(Array.from(content.matchAll(SESSION_ID_RE), (match) => match[0]))];
  return markers
    .map((marker) => {
      const match = Array.from(marker.matchAll(SESSION_ID_RE))[0];
      const sessionId = match?.[1] || match?.[2] || marker;
      const reference = resolveSessionReference(sessionId, marker);
      return reference ? `found:${reference.id}:${reference.title}` : `missing:${marker}`;
    })
    .join('\u0000');
}
