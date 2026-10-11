/* oxlint-disable anti-slop/no-unknown-parameters -- This parser validates webview requests and untrusted model output at the I/O boundary. */
import { asRecord, isString } from './type-utils';
import type { OpenCodeModelRoute, Provider } from './opencode-types';
import { normalizeModelVariant } from './model-variant';

export const MAX_COMPLETION_DRAFT_LENGTH = 4_000;
export const MAX_COMPLETION_HISTORY = 10;
export const MAX_COMPLETION_HISTORY_LENGTH = 1_000;
export const MAX_COMPLETION_RESPONSE_LENGTH = 6_000;
export const MAX_COMPLETION_SUFFIX_LENGTH = 240;

export type PromptCompletionRequest = {
  draft: string;
  history: string[];
  lastAssistantResponse?: string;
  variant?: string;
};
export type PromptCompletionAvailability = Record<string, { available: boolean; reason?: string }>;
export type PromptCompletionTestResult = { success: boolean; elapsedMs: number; error?: string };

export function parsePromptCompletionTestRequest(value: unknown): OpenCodeModelRoute {
  const record = asRecord(value);
  if (
    !isString(record?.providerID) ||
    !record.providerID.trim() ||
    record.providerID.length > 256 ||
    record.providerID.includes('/') ||
    !isString(record.modelID) ||
    !record.modelID.trim() ||
    record.modelID.length > 500
  )
    throw new Error('Invalid prompt completion test model');
  return { providerID: record.providerID, modelID: record.modelID };
}

/** Only use variants advertised by this model; do not inherit the chat's reasoning level. */
export function getPromptCompletionVariant(
  modelRoute: string,
  providers: readonly Provider[]
): string | undefined {
  const separator = modelRoute.indexOf('/');
  if (separator < 1) return undefined;
  const provider = providers.find((item) => item.id === modelRoute.slice(0, separator));
  const modelID = modelRoute.slice(separator + 1);
  const model = provider?.models[modelID];
  let lowest: { name: string; rank: number } | undefined;
  for (const [name, variant] of Object.entries(model?.variants ?? {})) {
    if (variant.disabled === true) continue;
    const options = asRecord(variant.options);
    const settings = asRecord(variant.settings);
    const body = asRecord(variant.body);
    const reasoning =
      asRecord(variant.reasoning) ??
      asRecord(options?.reasoning) ??
      asRecord(settings?.reasoning) ??
      asRecord(body?.reasoning);
    const thinking =
      asRecord(settings?.thinking) ??
      asRecord(options?.thinking) ??
      asRecord(variant.thinking) ??
      asRecord(body?.thinking);
    const effort =
      (reasoning?.enabled === false || thinking?.type === 'disabled' ? 'none' : undefined) ??
      variant.reasoningEffort ??
      variant.reasoning_effort ??
      options?.reasoningEffort ??
      options?.reasoning_effort ??
      settings?.reasoningEffort ??
      settings?.reasoning_effort ??
      body?.reasoning_effort ??
      reasoning?.effort;
    const rank = reasoningRank(isString(effort) ? effort : name);
    if (rank !== undefined && (!lowest || rank < lowest.rank)) lowest = { name, rank };
  }
  return normalizeModelVariant(modelID, lowest?.name) ?? undefined;
}

function reasoningRank(value: string): number | undefined {
  const normalized = value.toLowerCase().replace(/[-_]+/g, ' ').trim();
  if (['none', 'off', 'disabled', 'no reasoning', 'no thinking'].includes(normalized)) return 0;
  if (/\bminimal\b/.test(normalized)) return 1;
  if (/\b(low|light)\b/.test(normalized)) return 2;
  if (/\b(medium|normal)\b/.test(normalized)) return 3;
  if (/\b(xhigh|extra high)\b/.test(normalized)) return 5;
  if (/\bhigh\b/.test(normalized)) return 4;
  if (/\b(max|maximum)\b/.test(normalized)) return 6;
  return undefined;
}

export function recentCompletionPrompts(history: readonly string[]): string[] {
  return history
    .filter((text) => text.trim())
    .slice(-MAX_COMPLETION_HISTORY)
    .map((text) => text.slice(0, MAX_COMPLETION_HISTORY_LENGTH));
}

export function parsePromptCompletionRequest(value: unknown): PromptCompletionRequest {
  const record = asRecord(value);
  if (
    !isString(record?.draft) ||
    record.draft.trim().length < 3 ||
    record.draft.length > MAX_COMPLETION_DRAFT_LENGTH ||
    !Array.isArray(record.history) ||
    record.history.length > MAX_COMPLETION_HISTORY ||
    (record.lastAssistantResponse !== undefined &&
      (!isString(record.lastAssistantResponse) ||
        record.lastAssistantResponse.length > MAX_COMPLETION_RESPONSE_LENGTH)) ||
    (record.variant !== undefined &&
      (!isString(record.variant) || !record.variant.trim() || record.variant.length > 100)) ||
    !record.history.every(
      (text: unknown) => isString(text) && text.length <= MAX_COMPLETION_HISTORY_LENGTH
    )
  ) {
    throw new Error('Invalid prompt completion request');
  }
  const request: PromptCompletionRequest = {
    draft: record.draft,
    history: record.history.filter(isString),
  };
  if (isString(record.variant)) request.variant = record.variant;
  if (isString(record.lastAssistantResponse))
    request.lastAssistantResponse = record.lastAssistantResponse;
  return request;
}

export function normalizePromptSuffix(value: unknown, draft: string): string {
  if (!isString(value)) return '';
  const suffix = value.startsWith(draft) ? value.slice(draft.length) : value;
  if (
    !suffix.trim() ||
    suffix.length > MAX_COMPLETION_SUFFIX_LENGTH ||
    // oxlint-disable-next-line no-control-regex -- Reject non-printing model output while allowing tabs and newlines.
    /[\u0000-\u0008\u000B-\u001F\u007F]/u.test(suffix)
  )
    return '';
  return suffix.trimEnd();
}
