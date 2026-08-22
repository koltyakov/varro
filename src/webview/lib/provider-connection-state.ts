import { createSignal } from 'solid-js';

type ProviderConnectionRequest = {
  id: number;
  providerID: string;
};

const [providerConnectionRequest, setProviderConnectionRequest] =
  createSignal<ProviderConnectionRequest | null>(null);
const [providerAuthFailures, setProviderAuthFailures] = createSignal<Record<string, string[]>>({});
const resolvedAuthFailureMessageIDs = new Set<string>();
const providerAuthFailureCreatedAt = new Map<string, number>();
const providerAuthRestoredThrough = new Map<string, number>();
let nextRequestID = 0;

export { providerConnectionRequest, providerAuthFailures };

export function markProviderAuthFailure(
  providerID: string,
  messageID: string,
  messageCreatedAt?: number
) {
  const normalizedProviderID = providerID.trim();
  if (!normalizedProviderID || resolvedAuthFailureMessageIDs.has(messageID)) return;
  const restoredAt = providerAuthRestoredThrough.get(normalizedProviderID);
  if (
    restoredAt !== undefined &&
    messageCreatedAt !== undefined &&
    messageCreatedAt <= restoredAt
  ) {
    resolvedAuthFailureMessageIDs.add(messageID);
    return;
  }
  if (messageCreatedAt !== undefined) providerAuthFailureCreatedAt.set(messageID, messageCreatedAt);
  setProviderAuthFailures((current) => {
    const messageIDs = current[normalizedProviderID] ?? [];
    if (messageIDs.includes(messageID)) return current;
    return { ...current, [normalizedProviderID]: [...messageIDs, messageID] };
  });
}

export function providerRequiresReconnection(providerID: string) {
  return Boolean(providerAuthFailures()[providerID]);
}

export function providerAuthRestoredForMessage(messageID: string) {
  providerAuthFailures();
  return resolvedAuthFailureMessageIDs.has(messageID);
}

export function resolveProviderAuthFailure(providerID: string) {
  let restoredThrough = providerAuthRestoredThrough.get(providerID);
  for (const messageID of providerAuthFailures()[providerID] ?? []) {
    resolvedAuthFailureMessageIDs.add(messageID);
    const createdAt = providerAuthFailureCreatedAt.get(messageID);
    if (createdAt !== undefined)
      restoredThrough = Math.max(restoredThrough ?? createdAt, createdAt);
  }
  if (restoredThrough !== undefined) providerAuthRestoredThrough.set(providerID, restoredThrough);
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
  providerAuthFailureCreatedAt.clear();
  providerAuthRestoredThrough.clear();
}
