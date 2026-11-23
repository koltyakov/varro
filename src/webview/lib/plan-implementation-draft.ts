import { createSignal } from 'solid-js';

/** A text file the composer attaches ahead of the prompt, such as the plan itself. */
export type PlanImplementationAttachment = { name: string; text: string };

/** A null session targets the new chat composer. */
export type PlanImplementationDraftRequest = {
  id: number;
  sessionId: string | null;
  prompt: string;
  attachment?: PlanImplementationAttachment;
  createdAt: number;
};

// A request waits briefly for its composer to mount, but never applies to a later visit.
const REQUEST_TTL_MS = 5_000;

const [request, setRequest] = createSignal<PlanImplementationDraftRequest | null>(null);
let nextRequestId = 0;

/** The pending request for a composer to switch to Build and hold the prompt. */
export const planImplementationDraftRequest = request;

export function requestPlanImplementationDraft(
  sessionId: string | null,
  prompt: string,
  attachment?: PlanImplementationAttachment
) {
  nextRequestId += 1;
  const next: PlanImplementationDraftRequest = {
    id: nextRequestId,
    sessionId,
    prompt,
    createdAt: Date.now(),
  };
  if (attachment) next.attachment = attachment;
  setRequest(next);
}

export function isPlanImplementationDraftRequestCurrent(
  value: PlanImplementationDraftRequest,
  now = Date.now()
) {
  return now - value.createdAt <= REQUEST_TTL_MS;
}

/** Marks a request handled so a remounted composer cannot apply it again. */
export function consumePlanImplementationDraft(id: number) {
  if (request()?.id === id) setRequest(null);
}
