import { createSignal } from 'solid-js';

/** Asks the chat shell to show a session tree's sub-agents, or the child when no list exists. */
type SubagentSessionsRequest = { rootSessionID: string; childSessionID?: string };

const [subagentSessionsRequest, setSubagentSessionsRequest] =
  createSignal<SubagentSessionsRequest | null>(null);

export { subagentSessionsRequest };

export function openSubagentSessionsView(rootSessionID: string, childSessionID?: string) {
  setSubagentSessionsRequest({ rootSessionID, childSessionID });
}

export function clearSubagentSessionsRequest() {
  setSubagentSessionsRequest(null);
}
