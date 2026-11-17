import { untrack } from 'solid-js';
import { reconcile } from 'solid-js/store';
import type { SessionLookup } from '../../shared/protocol';
import { client } from './client';
import { SESSION_ID_RE } from './session-reference';
import { setState, state } from './state';

const CACHE_LIMIT = 256;
const CACHE_TTL_MS = 60_000;
const CONCURRENCY = 4;
const pending = new Map<string, Promise<SessionLookup | null>>();
const settled = new Map<string, { expiresAt: number; found: boolean }>();
const waiting: Array<() => void> = [];
let active = 0;
let scope = '';
let generation = 0;

export function lookupSessionReferences(content: string): void {
  untrack(() => {
    if (state.serverStatus.state !== 'running') return;
    for (const match of content.matchAll(SESSION_ID_RE)) {
      void lookupSessionReference(match[1] || match[2]!);
    }
  });
}

export function lookupSessionReference(id: string): Promise<SessionLookup | null> {
  const server = state.serverStatus;
  if (server.state !== 'running') return Promise.resolve(null);
  const nextScope = `${server.url}\u0000${state.editorContext.workspacePath ?? ''}`;
  if (scope !== nextScope) {
    scope = nextScope;
    generation += 1;
    pending.clear();
    settled.clear();
    setState('sessionLookups', reconcile({}));
  }
  const loaded = state.sessions.find((session) => session.id === id);
  if (loaded) return Promise.resolve({ ...loaded, external: false });
  const existing = pending.get(id);
  if (existing) return existing;
  const cached = settled.get(id);
  if (cached && cached.expiresAt > Date.now() && (!cached.found || state.sessionLookups[id])) {
    return Promise.resolve(state.sessionLookups[id] ?? null);
  }
  // Bound queued work as well as cached metadata for arbitrary pasted transcripts.
  if (pending.size >= CACHE_LIMIT) return Promise.resolve(null);
  const currentGeneration = generation;
  const isCurrent = () =>
    generation === currentGeneration &&
    state.serverStatus.state === 'running' &&
    `${state.serverStatus.url}\u0000${state.editorContext.workspacePath ?? ''}` === nextScope;
  const request = (async () => {
    // Let the pending map own the request even if a transport throws synchronously.
    await Promise.resolve();
    if (active >= CONCURRENCY) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    } else {
      active += 1;
    }
    try {
      if (!isCurrent()) return null;
      const session = await client.varro.session.reference(id);
      if (!isCurrent()) return null;
      setState('sessionLookups', id, session);
      const ids = Object.keys(state.sessionLookups);
      if (ids.length > CACHE_LIMIT) {
        const { [ids[0]!]: _oldest, ...remaining } = state.sessionLookups;
        setState('sessionLookups', reconcile(remaining));
      }
      return session;
    } catch {
      // Unknown IDs and unavailable hosts leave the original text intact.
      return null;
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active -= 1;
      if (generation === currentGeneration) {
        pending.delete(id);
        settled.delete(id);
        settled.set(id, {
          expiresAt: Date.now() + CACHE_TTL_MS,
          found: state.sessionLookups[id] !== undefined,
        });
        if (settled.size > CACHE_LIMIT) settled.delete(settled.keys().next().value!);
      }
    }
  })();
  pending.set(id, request);
  return request;
}
