import { storePath } from '@solidjs/signals';
import { untrack } from 'solid-js';
import type { SessionLookup } from '../../shared/protocol';
import { isMissingWorkspaceDirectoryMessage } from '../../shared/workspace-directory-error';
import { normalizeWorkspaceIdentity } from '../../shared/workspace-path';
import { client } from './client';
import { SESSION_ID_RE } from './session-reference';
import { setState, state } from './state';
import { reconcileStoreField } from './store-reconcile';

const CACHE_LIMIT = 256;
const CACHE_TTL_MS = 60_000;
const CONCURRENCY = 4;
const pending = new Map<string, Promise<SessionLookup | null>>();
const settled = new Map<
  string,
  { expiresAt: number; outcome: 'found' | 'missing' | 'unavailable' }
>();
const waiting: Array<() => void> = [];
let active = 0;
let scope = '';
let generation = 0;

export function getSessionReferenceLookupScope(): string | null {
  const server = state.serverStatus;
  if (server.state !== 'running') return null;
  const roots = (state.editorContext.workspaceFolders ?? []).map((folder) =>
    normalizeWorkspaceIdentity(folder.path)
  );
  return JSON.stringify([
    server.url,
    normalizeWorkspaceIdentity(state.editorContext.workspacePath),
    [...new Set(roots.filter((root) => root !== null))].toSorted(),
  ]);
}

function syncLookupScope(nextScope: string | null) {
  if (scope === (nextScope ?? '')) return;
  scope = nextScope ?? '';
  generation += 1;
  pending.clear();
  settled.clear();
  setState((draft) => reconcileStoreField(draft, 'sessionLookups', {}));
}

export function lookupSessionReferences(
  content: string,
  nextScope = getSessionReferenceLookupScope()
): void {
  const matches = content.matchAll(SESSION_ID_RE);
  const first = matches.next();
  if (first.done) return;
  untrack(() => {
    syncLookupScope(nextScope);
    if (nextScope === null) return;
    void lookupSessionReferenceInScope(first.value[1] || first.value[2]!, nextScope);
    for (const match of matches) {
      void lookupSessionReferenceInScope(match[1] || match[2]!, nextScope);
    }
  });
}

export function lookupSessionReference(id: string): Promise<SessionLookup | null> {
  const nextScope = getSessionReferenceLookupScope();
  syncLookupScope(nextScope);
  return nextScope === null ? Promise.resolve(null) : lookupSessionReferenceInScope(id, nextScope);
}

function lookupSessionReferenceInScope(
  id: string,
  nextScope: string
): Promise<SessionLookup | null> {
  const loaded = state.sessions.find((session) => session.id === id);
  if (loaded) return Promise.resolve({ ...loaded, external: false });
  const existing = pending.get(id);
  if (existing) return existing;
  const cached = settled.get(id);
  if (cached && cached.expiresAt > Date.now()) {
    if (cached.outcome === 'missing') return Promise.resolve(null);
    const metadata = state.sessionLookups[id];
    if (metadata || cached.outcome === 'unavailable') return Promise.resolve(metadata ?? null);
  }
  // Bound queued work as well as cached metadata for arbitrary pasted transcripts.
  if (pending.size >= CACHE_LIMIT) return Promise.resolve(null);
  const currentGeneration = generation;
  const isCurrent = () =>
    generation === currentGeneration && getSessionReferenceLookupScope() === nextScope;
  const request = (async () => {
    // Let the pending map own the request even if a transport throws synchronously.
    await Promise.resolve();
    if (active >= CONCURRENCY) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    } else {
      active += 1;
    }
    let outcome: 'found' | 'missing' | 'unavailable' = 'unavailable';
    try {
      if (!isCurrent()) return null;
      const session = await client.varro.session.reference(id);
      if (!isCurrent()) return null;
      setState((draft) => {
        draft.sessionLookups[id] = session;
        const ids = Object.keys(draft.sessionLookups);
        if (ids.length > CACHE_LIMIT) delete draft.sessionLookups[ids[0]!];
      });
      outcome = 'found';
      return session;
    } catch (error) {
      if (!isCurrent()) return null;
      if (
        error instanceof Error &&
        /^404\b/.test(error.message) &&
        !isMissingWorkspaceDirectoryMessage(error.message)
      ) {
        outcome = 'missing';
        setState(
          storePath('sessionLookups', (lookups) => {
            delete lookups[id];

            return lookups;
          })
        );
        return null;
      }
      // A transient failure is not evidence that the session disappeared.
      return state.sessionLookups[id] ?? null;
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active -= 1;
      if (generation === currentGeneration) pending.delete(id);
      if (isCurrent()) {
        settled.delete(id);
        settled.set(id, {
          expiresAt: Date.now() + CACHE_TTL_MS,
          outcome,
        });
        if (settled.size > CACHE_LIMIT) settled.delete(settled.keys().next().value!);
      }
    }
  })();
  pending.set(id, request);
  return request;
}
