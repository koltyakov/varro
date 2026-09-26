import { createSignal } from 'solid-js';
import type { Message } from '../types';

type ProviderConnectionRequest = {
  id: number;
  providerID: string | null;
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

/** Successful history and live completions supersede earlier authentication failures. */
export function recordProviderAuthSuccess(info: Message) {
  if (info.role !== 'assistant' || info.error || !info.time.completed) return;
  const providerID = info.providerID.trim();
  if (!providerID) return;
  const restoredThrough = Math.max(
    providerAuthRestoredThrough.get(providerID) ?? -Infinity,
    info.time.created
  );
  providerAuthRestoredThrough.set(providerID, restoredThrough);
  setProviderAuthFailures((current) => {
    const failures = current[providerID];
    if (!failures) return current;
    const remaining = failures.filter((id) => {
      const createdAt = providerAuthFailureCreatedAt.get(id);
      if (createdAt === undefined || createdAt > restoredThrough) return true;
      resolvedAuthFailureMessageIDs.add(id);
      return false;
    });
    if (remaining.length === failures.length) return current;
    const next = { ...current };
    if (remaining.length) next[providerID] = remaining;
    else delete next[providerID];
    return next;
  });
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

export function requestProviderConnection(providerID?: string) {
  const normalizedProviderID = providerID?.trim() || null;
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
