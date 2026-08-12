import { createSignal } from 'solid-js';

type ProviderConnectionRequest = {
  id: number;
  providerID: string;
};

const [providerConnectionRequest, setProviderConnectionRequest] =
  createSignal<ProviderConnectionRequest | null>(null);
const [providerAuthFailures, setProviderAuthFailures] = createSignal<Record<string, string>>({});
const resolvedAuthFailureMessageIDs = new Set<string>();
let nextRequestID = 0;

export { providerConnectionRequest, providerAuthFailures };

export function markProviderAuthFailure(providerID: string, messageID: string) {
  const normalizedProviderID = providerID.trim();
  if (!normalizedProviderID || resolvedAuthFailureMessageIDs.has(messageID)) return;
  setProviderAuthFailures((current) => ({ ...current, [normalizedProviderID]: messageID }));
}

export function providerRequiresReconnection(providerID: string) {
  return Boolean(providerAuthFailures()[providerID]);
}

export function providerAuthRestoredForMessage(messageID: string) {
  providerAuthFailures();
  return resolvedAuthFailureMessageIDs.has(messageID);
}

export function resolveProviderAuthFailure(providerID: string) {
  const messageID = providerAuthFailures()[providerID];
  if (messageID) resolvedAuthFailureMessageIDs.add(messageID);
  setProviderAuthFailures((current) => {
    if (!(providerID in current)) return current;
    const next = { ...current };
    delete next[providerID];
    return next;
  });
}

export function requestProviderConnection(providerID: string) {
  const normalizedProviderID = providerID.trim();
  if (!normalizedProviderID) return;
  setProviderConnectionRequest({ id: ++nextRequestID, providerID: normalizedProviderID });
}

export function consumeProviderConnectionRequest(id: number) {
  if (providerConnectionRequest()?.id === id) setProviderConnectionRequest(null);
}

export function clearProviderConnectionRequest() {
  setProviderConnectionRequest(null);
}

export function resetProviderConnectionState() {
  setProviderConnectionRequest(null);
  setProviderAuthFailures({});
  resolvedAuthFailureMessageIDs.clear();
}
