import { createHash } from 'node:crypto';
import { asRecord, isString } from '../shared/type-utils';
import { isAbsoluteWorkspacePath, normalizeWorkspaceIdentity } from '../shared/workspace-path';
import type { OpenCodeServer } from './server';

let readEnabled = () => false;

/** The editor owns preferences; standalone adapter consumers stay disabled by default. */
export function configurePromptTrace(reader: () => boolean): void {
  readEnabled = reader;
}

export type PromptTraceContext = {
  purpose:
    | 'followup'
    | 'permission-judge'
    | 'commit-message'
    | 'session-title'
    | 'side-question'
    | 'background-process-judge'
    | 'prompt-completion';
  sessionID?: string;
  requestID?: string;
  helperSessionID?: string;
};

/** Opt-in prompt metadata only. Never changes session state, model selection, or permissions. */
export async function tracePrompt(
  server: Pick<OpenCodeServer, 'request'>,
  input: PromptTraceContext & { prompt: string; directory?: string; signal?: AbortSignal }
): Promise<string> {
  if (!readEnabled()) return input.prompt;
  input.signal?.throwIfAborted();
  const sessionID = traceID(input.sessionID);
  const rootSessionID = sessionID ? await resolveRootSession(server, sessionID, input) : undefined;
  input.signal?.throwIfAborted();
  const workspace =
    !sessionID && input.directory && isAbsoluteWorkspacePath(input.directory)
      ? normalizeWorkspaceIdentity(input.directory)
      : null;
  return `VARRO_TRACE_V1 ${JSON.stringify({
    purpose: input.purpose,
    sessionID,
    rootSessionID,
    workspaceID: workspace ? createHash('sha256').update(workspace).digest('hex') : undefined,
    requestID: traceID(input.requestID),
    helperSessionID: traceID(input.helperSessionID),
  })}\n${input.prompt}`;
}

function traceID(value: string | undefined): string | undefined {
  return value && /^[\w-]{1,200}$/.test(value) ? value : undefined;
}

/** Failed or incomplete ancestry is omitted rather than guessed. No cross-request cache. */
async function resolveRootSession(
  server: Pick<OpenCodeServer, 'request'>,
  sourceSessionID: string,
  input: { directory?: string; signal?: AbortSignal }
): Promise<string | undefined> {
  const timeout = AbortSignal.timeout(2_000);
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
  const visited = new Set<string>();
  let sessionID = sourceSessionID;
  try {
    for (let reads = 0; reads < 16; reads += 1) {
      signal.throwIfAborted();
      if (!traceID(sessionID) || visited.has(sessionID)) return undefined;
      visited.add(sessionID);
      const session = asRecord(
        await server.request('GET', `/session/${encodeURIComponent(sessionID)}`, undefined, {
          directory: input.directory,
          signal,
          maxResponseBytes: 64 * 1024,
        })
      );
      signal.throwIfAborted();
      if (session?.id !== sessionID) return undefined;
      if (session.parentID === undefined) return sessionID;
      if (!isString(session.parentID)) return undefined;
      sessionID = session.parentID;
    }
  } catch {
    // Optional attribution must not fail inference, but preserve the caller's cancellation.
    input.signal?.throwIfAborted();
  }
  return undefined;
}
