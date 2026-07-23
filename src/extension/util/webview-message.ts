import { Buffer } from 'buffer';
import {
  MAX_DROPPED_CONTENT_FILES,
  MAX_DROPPED_CONTENT_FILE_BYTES,
  MAX_DROPPED_CONTENT_TOTAL_BYTES,
} from '../../shared/dropped-content-policy';
import { isPermissionMode, VARRO_API_ENDPOINTS } from '../../shared/protocol';
import type { DesktopSessionPaneSide, PermissionMode, WebviewMessage } from '../../shared/protocol';
import type {
  RalphConfig,
  RalphIteration,
  RalphIterationTokens,
  RalphRun,
  RalphSelectedModel,
} from '../../shared/ralph';
import { MAX_RALPH_ITERATIONS } from '../../shared/ralph';
import { asRecord } from '../../shared/type-utils';

const MAX_PATH_LENGTH = 4096;
const MAX_QUERY_LENGTH = 2048;
const MAX_LOG_FIELD_LENGTH = 10_000;
const MAX_SEARCH_QUERY_LENGTH = 200;
const MAX_DROPPED_PATHS = 100;
const MAX_DROPPED_CONTENT_NAME_LENGTH = 512;
const MAX_DROPPED_CONTENT_BASE64_LENGTH = Math.ceil(MAX_DROPPED_CONTENT_FILE_BYTES / 3) * 4;
const MAX_RALPH_ID_LENGTH = 512;
const MAX_RALPH_PROMPT_LENGTH = 100_000;
const MAX_RALPH_LEGACY_RUNS = 100;
const MAX_RALPH_LEGACY_ITERATIONS = 5_000;
const MAX_RALPH_ITERATIONS_PER_RUN = MAX_RALPH_ITERATIONS;
const MAX_RALPH_FILES_CHANGED = 500;
const MAX_RALPH_VERIFICATIONS = 100;
const MAX_RALPH_REPAIR_SESSIONS = 100;
const MAX_RALPH_NOTE_LENGTH = 10_000;
const MAX_RALPH_TOTAL_NODES = 100_000;
const MAX_RALPH_TOTAL_STRING_BYTES = 8 * 1024 * 1024;
const MAX_RALPH_TOTAL_PATH_ENTRIES = 20_000;
const MAX_RALPH_DEPTH = 20;
const MAX_API_BODY_DEPTH = 25;
const MAX_API_BODY_NODES = 20_000;
const MAX_API_BODY_STRING_BYTES = 40 * 1024 * 1024;
const MAX_API_BODY_SINGLE_STRING_BYTES = 8 * 1024 * 1024;
const MAX_API_BODY_ARRAY_LENGTH = 5_000;
const MAX_API_BODY_OBJECT_KEYS = 2_000;
const MAX_API_BODY_KEY_BYTES = 512;
const API_BASE = 'http://varro.local';

const INVALID_JSON_VALUE = Symbol('invalid-json-value');

type SanitizedJsonValue =
  | null
  | boolean
  | number
  | string
  | SanitizedJsonValue[]
  | { [key: string]: SanitizedJsonValue };

interface StructuralBudget {
  nodes: number;
  stringBytes: number;
}

interface RalphContentBudget {
  pathEntries: number;
}

const WEBVIEW_MESSAGE_TYPES = {
  'context/request': true,
  'webview/focus': true,
  'providers/watch': true,
  'providers/refresh': true,
  'terminal-selection/clear': true,
  'terminal/run': true,
  'session/export': true,
  'vscode/open-settings': true,
  'vscode/show-output': true,
  'files/drop': true,
  'files/drop-content': true,
  'files/remove': true,
  'files/clear': true,
  'files/pick': true,
  'files/search': true,
  'file/read': true,
  'vscode/open': true,
  'vscode/open-external': true,
  'config/update': true,
  ready: true,
  'api/request': true,
  'ralph/start': true,
  'ralph/stop': true,
  'ralph/pause': true,
  'ralph/resume': true,
  'ralph/update-model': true,
  'ralph/sync': true,
  log: true,
} as const satisfies Record<WebviewMessage['type'], true>;

export function parseWebviewMessage(value: unknown): WebviewMessage | null {
  const message = asRecord(value);
  const type = getString(message?.type);
  if (!type || !hasOwn(WEBVIEW_MESSAGE_TYPES, type)) return null;

  switch (type) {
    case 'ready':
    case 'context/request':
    case 'providers/refresh':
    case 'terminal-selection/clear':
    case 'files/clear':
    case 'files/pick':
    case 'vscode/show-output':
      return { type };

    case 'session/export': {
      const payload = asRecord(message?.payload);
      const sessionId = getBoundedString(payload?.sessionId, 512);
      return sessionId ? { type, payload: { sessionId } } : null;
    }

    case 'vscode/open-settings': {
      const payload = asRecord(message?.payload);
      const query = getOptionalBoundedString(payload?.query, 200);
      return query ? { type, payload: { query } } : { type, payload: {} };
    }

    case 'webview/focus': {
      const payload = asRecord(message?.payload);
      return typeof payload?.focused === 'boolean'
        ? { type, payload: { focused: payload.focused } }
        : null;
    }

    case 'providers/watch': {
      const payload = asRecord(message?.payload);
      return typeof payload?.active === 'boolean'
        ? { type, payload: { active: payload.active } }
        : null;
    }

    case 'terminal/run': {
      const payload = asRecord(message?.payload);
      const command = getBoundedString(payload?.command, 200);
      const title = getOptionalBoundedString(payload?.title, 120);
      if (command !== 'opencode auth login' && command !== 'opencode auth') return null;
      return { type, payload: title ? { command, title } : { command } };
    }

    case 'files/drop': {
      const payload = asRecord(message?.payload);
      if (!Array.isArray(payload?.paths) || payload.paths.length > MAX_DROPPED_PATHS) return null;
      const paths = payload.paths.map((path) => getBoundedString(path, MAX_PATH_LENGTH));
      return paths.every((path): path is string => Boolean(path))
        ? { type, payload: { paths } }
        : null;
    }

    case 'files/drop-content': {
      const payload = asRecord(message?.payload);
      if (!Array.isArray(payload?.files) || payload.files.length === 0) return null;
      if (payload.files.length > MAX_DROPPED_CONTENT_FILES) return null;
      const files: Array<{ name: string; content: string; size: number }> = [];
      let totalSize = 0;
      for (const entry of payload.files) {
        const record = asRecord(entry);
        const name = getBoundedString(record?.name, MAX_DROPPED_CONTENT_NAME_LENGTH);
        const content = getBoundedString(record?.content, MAX_DROPPED_CONTENT_BASE64_LENGTH, true);
        const size = getSafeInteger(record?.size);
        if (
          !name ||
          content === null ||
          size === null ||
          size > MAX_DROPPED_CONTENT_FILE_BYTES ||
          getBase64DecodedSize(content) !== size
        ) {
          return null;
        }
        totalSize += size;
        if (totalSize > MAX_DROPPED_CONTENT_TOTAL_BYTES) return null;
        files.push({ name, content, size });
      }
      return { type, payload: { files } };
    }

    case 'files/remove':
    case 'file/read': {
      const payload = asRecord(message?.payload);
      const path = getBoundedString(payload?.path, MAX_PATH_LENGTH);
      return path ? { type, payload: { path } } : null;
    }

    case 'files/search': {
      const payload = asRecord(message?.payload);
      const requestId = getSafeInteger(payload?.requestId);
      const query = getBoundedString(payload?.query, MAX_SEARCH_QUERY_LENGTH, true);
      const limit = payload?.limit === undefined ? undefined : getSafeInteger(payload.limit);
      if (
        requestId === null ||
        query === null ||
        (payload?.limit !== undefined && limit === null)
      ) {
        return null;
      }
      return {
        type,
        payload: limit == null ? { requestId, query } : { requestId, query, limit },
      };
    }

    case 'vscode/open': {
      const payload = asRecord(message?.payload);
      const path = getBoundedString(payload?.path, MAX_PATH_LENGTH);
      const line = payload?.line === undefined ? undefined : getSafeInteger(payload.line);
      const kind = payload?.kind;
      const view = payload?.view;
      if (!path || (payload?.line !== undefined && line === null)) return null;
      if (kind !== undefined && kind !== 'auto' && kind !== 'file' && kind !== 'directory')
        return null;
      if (view !== undefined && view !== 'diff') return null;
      return {
        type,
        payload: {
          path,
          ...(line !== undefined && line !== null ? { line } : {}),
          ...(kind ? { kind } : {}),
          ...(view ? { view } : {}),
        },
      };
    }

    case 'vscode/open-external': {
      const payload = asRecord(message?.payload);
      const url = getBoundedString(payload?.url, MAX_PATH_LENGTH);
      return url && isAllowedExternalUrl(url) ? { type, payload: { url } } : null;
    }

    case 'config/update': {
      const payload = asRecord(message?.payload);
      const desktopSessionPaneSide = getDesktopSessionPaneSide(payload?.desktopSessionPaneSide);
      const defaultPermissionMode = getPermissionMode(payload?.defaultPermissionMode);
      return typeof payload?.expandThinkingByDefault === 'boolean' &&
        typeof payload?.showStickyUserPrompt === 'boolean' &&
        desktopSessionPaneSide &&
        defaultPermissionMode
        ? {
            type,
            payload: {
              expandThinkingByDefault: payload.expandThinkingByDefault,
              showStickyUserPrompt: payload.showStickyUserPrompt,
              desktopSessionPaneSide,
              defaultPermissionMode,
            },
          }
        : null;
    }

    case 'api/request': {
      const payload = asRecord(message?.payload);
      const id = getSafeInteger(payload?.id);
      const method = getBoundedString(payload?.method, 16)?.toUpperCase() || null;
      const path = getBoundedString(payload?.path, MAX_PATH_LENGTH + MAX_QUERY_LENGTH);
      if (id === null || !method || !path || !isAllowedApiRequest(method, path)) return null;
      if (payload?.body === undefined) return { type, payload: { id, method, path } };
      const body = sanitizeApiRequestBody(payload.body);
      return body === INVALID_JSON_VALUE ? null : { type, payload: { id, method, path, body } };
    }

    case 'ralph/start': {
      const payload = asRecord(message?.payload);
      if (!payload || !isWithinRalphStructuralBudget(payload)) return null;
      const config = parseRalphConfig(payload?.config, MAX_RALPH_ITERATIONS);
      return config ? { type, payload: { config } } : null;
    }

    case 'ralph/stop':
    case 'ralph/pause':
    case 'ralph/resume': {
      const payload = asRecord(message?.payload);
      if (!payload || !isWithinRalphStructuralBudget(payload)) return null;
      const managerSessionId = getSafeRalphId(payload.managerSessionId);
      return managerSessionId ? { type, payload: { managerSessionId } } : null;
    }

    case 'ralph/update-model': {
      const payload = asRecord(message?.payload);
      if (!payload || !isWithinRalphStructuralBudget(payload)) return null;
      const managerSessionId = getSafeRalphId(payload.managerSessionId);
      if (!managerSessionId) return null;
      if (payload?.model === null) {
        return { type, payload: { managerSessionId, model: null } };
      }
      const model = parseRalphSelectedModel(payload?.model);
      return model ? { type, payload: { managerSessionId, model } } : null;
    }

    case 'ralph/sync': {
      const payload = asRecord(message?.payload);
      if (!payload || !isWithinRalphStructuralBudget(payload)) return null;
      if (payload.legacyRuns === undefined) return { type, payload: {} };
      const legacyRuns = parseRalphRuns(payload.legacyRuns, { pathEntries: 0 });
      return legacyRuns ? { type, payload: { legacyRuns } } : null;
    }

    case 'log': {
      const payload = asRecord(message?.payload);
      const msg = getBoundedString(payload?.msg, MAX_LOG_FIELD_LENGTH);
      const data = getOptionalBoundedString(payload?.data, MAX_LOG_FIELD_LENGTH);
      const error = getOptionalBoundedString(payload?.error, MAX_LOG_FIELD_LENGTH);
      const level = payload?.level;
      if (!msg) return null;
      if (level !== undefined && level !== 'info' && level !== 'warn' && level !== 'error')
        return null;
      return {
        type,
        payload: {
          msg,
          ...(data ? { data } : {}),
          ...(error ? { error } : {}),
          ...(level ? { level } : {}),
        },
      };
    }

    default: {
      const exhaustive: never = type;
      return exhaustive;
    }
  }
}

function parseRalphConfig(value: unknown, maxIterations: number): RalphConfig | null {
  const record = asRecord(value);
  const managerSessionId = getSafeRalphId(record?.managerSessionId);
  const planDocPath = getBoundedString(record?.planDocPath, MAX_PATH_LENGTH);
  const iterations = getBoundedInteger(record?.iterations, 1, maxIterations);
  const promptTemplate = getBoundedString(record?.promptTemplate, MAX_RALPH_PROMPT_LENGTH);
  const permissionMode = getPermissionMode(record?.permissionMode);
  const createdAt = getSafeInteger(record?.createdAt);
  if (
    !record ||
    !managerSessionId ||
    !planDocPath ||
    iterations === null ||
    !promptTemplate ||
    !permissionMode ||
    createdAt === null
  ) {
    return null;
  }

  let model: RalphSelectedModel | null;
  if (record.model === null) {
    model = null;
  } else {
    model = parseRalphSelectedModel(record.model);
    if (!model) return null;
  }

  let agent: string | null;
  if (record.agent === null) {
    agent = null;
  } else {
    agent = getBoundedString(record.agent, MAX_RALPH_ID_LENGTH);
    if (!agent) return null;
  }

  return {
    managerSessionId,
    planDocPath,
    iterations,
    promptTemplate,
    permissionMode,
    model,
    agent,
    createdAt,
  };
}

function parseRalphSelectedModel(value: unknown): RalphSelectedModel | null {
  const record = asRecord(value);
  const providerID = getBoundedString(record?.providerID, MAX_RALPH_ID_LENGTH);
  const modelID = getBoundedString(record?.modelID, MAX_RALPH_ID_LENGTH);
  if (!providerID || !modelID) return null;

  if (record?.variant === undefined) return { providerID, modelID };
  const variant = getBoundedString(record.variant, MAX_RALPH_ID_LENGTH);
  return variant ? { providerID, modelID, variant } : null;
}

function parseRalphRuns(
  value: unknown,
  contentBudget: RalphContentBudget
): Record<string, RalphRun> | null {
  const record = asRecord(value);
  if (!record) return null;
  const entries = Object.entries(record);
  if (entries.length > MAX_RALPH_LEGACY_RUNS) return null;

  let totalIterations = 0;
  const runs: Record<string, RalphRun> = {};
  for (const [managerSessionId, rawRun] of entries) {
    if (!isSafeRalphRecordKey(managerSessionId)) return null;
    const rawIterations = asRecord(rawRun)?.iterations;
    if (!Array.isArray(rawIterations)) return null;
    totalIterations += rawIterations.length;
    if (totalIterations > MAX_RALPH_LEGACY_ITERATIONS) return null;

    const run = parseRalphRun(rawRun, contentBudget);
    if (!run || run.config.managerSessionId !== managerSessionId) return null;
    runs[managerSessionId] = run;
  }
  return runs;
}

function parseRalphRun(value: unknown, contentBudget: RalphContentBudget): RalphRun | null {
  const record = asRecord(value);
  const config = parseRalphConfig(record?.config, MAX_RALPH_ITERATIONS);
  const status = getRalphStatus(record?.status);
  const currentIteration = getBoundedInteger(
    record?.currentIteration,
    0,
    config?.iterations ?? MAX_RALPH_ITERATIONS
  );
  const updatedAt = getSafeInteger(record?.updatedAt);
  if (
    !record ||
    !config ||
    !status ||
    currentIteration === null ||
    updatedAt === null ||
    !Array.isArray(record.iterations) ||
    record.iterations.length > MAX_RALPH_ITERATIONS_PER_RUN
  ) {
    return null;
  }

  const iterations: RalphIteration[] = [];
  const indexes = new Set<number>();
  for (const rawIteration of record.iterations) {
    const iteration = parseRalphIteration(rawIteration, config.iterations, contentBudget);
    if (!iteration || indexes.has(iteration.index)) return null;
    indexes.add(iteration.index);
    iterations.push(iteration);
  }

  if (record.stopReason === undefined) {
    return { config, status, currentIteration, iterations, updatedAt };
  }
  const stopReason = getRalphStopReason(record.stopReason);
  return stopReason
    ? { config, status, currentIteration, iterations, updatedAt, stopReason }
    : null;
}

function parseRalphIteration(
  value: unknown,
  maxIndex: number,
  contentBudget: RalphContentBudget
): RalphIteration | null {
  const record = asRecord(value);
  const index = getBoundedInteger(record?.index, 1, maxIndex);
  const status = getRalphIterationStatus(record?.status);
  const childSessionId = getNullableSafeRalphId(record?.childSessionId);
  const startedAt = getNullableSafeInteger(record?.startedAt);
  const endedAt = getNullableSafeInteger(record?.endedAt);
  if (
    !record ||
    index === null ||
    !status ||
    childSessionId === undefined ||
    startedAt === undefined ||
    endedAt === undefined ||
    !Array.isArray(record.filesChanged) ||
    record.filesChanged.length > MAX_RALPH_FILES_CHANGED
  ) {
    return null;
  }

  const filesChanged = record.filesChanged.map((path) => getBoundedString(path, MAX_PATH_LENGTH));
  if (!filesChanged.every((path): path is string => Boolean(path))) return null;
  contentBudget.pathEntries += filesChanged.length;
  if (contentBudget.pathEntries > MAX_RALPH_TOTAL_PATH_ENTRIES) return null;

  const verification = parseRalphVerification(record.verification);
  if (!verification) return null;
  const phase = getRalphIterationPhase(record.phase);
  if (record.phase !== undefined && !phase) return null;

  const iteration: RalphIteration = {
    index,
    childSessionId,
    status,
    startedAt,
    endedAt,
    filesChanged,
    verification,
    ...(phase ? { phase } : {}),
  };

  if (record.tokens !== undefined) {
    const tokens = parseRalphIterationTokens(record.tokens);
    if (!tokens) return null;
    iteration.tokens = tokens;
  }
  if (record.cost !== undefined) {
    const cost = getBoundedNumber(record.cost, 0, Number.MAX_SAFE_INTEGER);
    if (cost === null) return null;
    iteration.cost = cost;
  }
  if (record.note !== undefined) {
    const note = getBoundedString(record.note, MAX_RALPH_NOTE_LENGTH);
    if (!note) return null;
    iteration.note = note;
  }
  if (record.repairSessionIds !== undefined) {
    if (
      !Array.isArray(record.repairSessionIds) ||
      record.repairSessionIds.length > MAX_RALPH_REPAIR_SESSIONS
    ) {
      return null;
    }
    const repairSessionIds = record.repairSessionIds.map(getSafeRalphId);
    if (!repairSessionIds.every((id): id is string => Boolean(id))) return null;
    iteration.repairSessionIds = repairSessionIds;
  }

  return iteration;
}

function getRalphIterationPhase(value: unknown): RalphIteration['phase'] | null {
  return value === 'primary' || value === 'verification' || value === 'repair' ? value : null;
}

function parseRalphVerification(value: unknown): RalphIteration['verification'] | null {
  const record = asRecord(value);
  if (!record) return null;
  const entries = Object.entries(record);
  if (entries.length > MAX_RALPH_VERIFICATIONS) return null;

  const verification: RalphIteration['verification'] = {};
  for (const [name, rawVerdict] of entries) {
    if (!isSafeRalphRecordKey(name, 100)) return null;
    const verdict = getRalphVerificationVerdict(rawVerdict);
    if (!verdict) return null;
    verification[name] = verdict;
  }
  return verification;
}

function parseRalphIterationTokens(value: unknown): RalphIterationTokens | null {
  const record = asRecord(value);
  if (!record) return null;
  const input = getSafeInteger(record.input);
  const output = getSafeInteger(record.output);
  const reasoning = getSafeInteger(record.reasoning);
  const cacheRead = getSafeInteger(record.cacheRead);
  const cacheWrite = getSafeInteger(record.cacheWrite);
  const total = getSafeInteger(record.total);
  return input !== null &&
    output !== null &&
    reasoning !== null &&
    cacheRead !== null &&
    cacheWrite !== null &&
    total !== null
    ? { input, output, reasoning, cacheRead, cacheWrite, total }
    : null;
}

function getRalphStatus(value: unknown): RalphRun['status'] | null {
  return value === 'running' ||
    value === 'paused' ||
    value === 'stopped' ||
    value === 'done' ||
    value === 'incomplete' ||
    value === 'failed'
    ? value
    : null;
}

function getRalphStopReason(value: unknown): RalphRun['stopReason'] | null {
  return value === 'iteration_limit' ||
    value === 'iteration_limit_with_gap' ||
    value === 'consecutive_passes' ||
    value === 'done_marker' ||
    value === 'manual_stop' ||
    value === 'iteration_error'
    ? value
    : null;
}

function getRalphIterationStatus(value: unknown): RalphIteration['status'] | null {
  return value === 'pending' ||
    value === 'running' ||
    value === 'passed' ||
    value === 'failed' ||
    value === 'aborted'
    ? value
    : null;
}

function getRalphVerificationVerdict(
  value: unknown
): RalphIteration['verification'][string] | null {
  return value === 'pass' || value === 'fail' || value === 'skipped' ? value : null;
}

function getSafeRalphId(value: unknown): string | null {
  const id = getBoundedString(value, MAX_RALPH_ID_LENGTH);
  return id && isSafeRalphRecordKey(id) ? id : null;
}

function getNullableSafeRalphId(value: unknown): string | null | undefined {
  if (value === null) return null;
  return getSafeRalphId(value) ?? undefined;
}

function isSafeRalphRecordKey(value: string, maxLength = MAX_RALPH_ID_LENGTH) {
  return (
    value.length > 0 &&
    value.length <= maxLength &&
    value !== '__proto__' &&
    value !== 'prototype' &&
    value !== 'constructor'
  );
}

function isWithinRalphStructuralBudget(value: unknown): boolean {
  try {
    return visitRalphValue(value, { nodes: 0, stringBytes: 0 }, 0, new WeakSet<object>());
  } catch {
    return false;
  }
}

function visitRalphValue(
  value: unknown,
  budget: StructuralBudget,
  depth: number,
  ancestors: WeakSet<object>
): boolean {
  budget.nodes += 1;
  if (budget.nodes > MAX_RALPH_TOTAL_NODES || depth > MAX_RALPH_DEPTH) return false;
  if (typeof value === 'string') {
    budget.stringBytes += Buffer.byteLength(value, 'utf8');
    return budget.stringBytes <= MAX_RALPH_TOTAL_STRING_BYTES;
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return true;
  if (typeof value !== 'object') return false;
  if (ancestors.has(value)) return false;

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items = getArrayDataValues(value);
      if (!items || items.length > MAX_RALPH_TOTAL_NODES) return false;
      for (const item of items) {
        if (!visitRalphValue(item, budget, depth + 1, ancestors)) return false;
      }
      return true;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const entries = getObjectDataEntries(value);
    if (!entries) return false;
    budget.nodes += entries.length;
    if (budget.nodes > MAX_RALPH_TOTAL_NODES) return false;
    for (const [key, entry] of entries) {
      if (!isSafeRalphRecordKey(key, MAX_RALPH_TOTAL_STRING_BYTES)) return false;
      budget.stringBytes += Buffer.byteLength(key, 'utf8');
      if (budget.stringBytes > MAX_RALPH_TOTAL_STRING_BYTES) return false;
      if (!visitRalphValue(entry, budget, depth + 1, ancestors)) return false;
    }
    return true;
  } finally {
    ancestors.delete(value);
  }
}

function sanitizeApiRequestBody(value: unknown): SanitizedJsonValue | typeof INVALID_JSON_VALUE {
  try {
    return sanitizeJsonValue(value, { nodes: 0, stringBytes: 0 }, 0, new WeakSet<object>());
  } catch {
    return INVALID_JSON_VALUE;
  }
}

function sanitizeJsonValue(
  value: unknown,
  budget: StructuralBudget,
  depth: number,
  ancestors: WeakSet<object>
): SanitizedJsonValue | typeof INVALID_JSON_VALUE {
  budget.nodes += 1;
  if (budget.nodes > MAX_API_BODY_NODES || depth > MAX_API_BODY_DEPTH) {
    return INVALID_JSON_VALUE;
  }
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : INVALID_JSON_VALUE;
  if (typeof value === 'string') {
    const bytes = Buffer.byteLength(value, 'utf8');
    if (bytes > MAX_API_BODY_SINGLE_STRING_BYTES) return INVALID_JSON_VALUE;
    budget.stringBytes += bytes;
    return budget.stringBytes <= MAX_API_BODY_STRING_BYTES ? value : INVALID_JSON_VALUE;
  }
  if (typeof value !== 'object' || ancestors.has(value)) return INVALID_JSON_VALUE;

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items = getArrayDataValues(value);
      if (!items || items.length > MAX_API_BODY_ARRAY_LENGTH) {
        return INVALID_JSON_VALUE;
      }
      const output: SanitizedJsonValue[] = [];
      for (const item of items) {
        const sanitized = sanitizeJsonValue(item, budget, depth + 1, ancestors);
        if (sanitized === INVALID_JSON_VALUE) return INVALID_JSON_VALUE;
        output.push(sanitized);
      }
      return output;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return INVALID_JSON_VALUE;
    const entries = getObjectDataEntries(value);
    if (!entries || entries.length > MAX_API_BODY_OBJECT_KEYS) {
      return INVALID_JSON_VALUE;
    }

    const output: { [key: string]: SanitizedJsonValue } = {};
    budget.nodes += entries.length;
    if (budget.nodes > MAX_API_BODY_NODES) return INVALID_JSON_VALUE;
    for (const [key, entry] of entries) {
      const keyBytes = Buffer.byteLength(key, 'utf8');
      if (!isSafeRalphRecordKey(key, MAX_API_BODY_KEY_BYTES) || keyBytes > MAX_API_BODY_KEY_BYTES) {
        return INVALID_JSON_VALUE;
      }
      budget.stringBytes += keyBytes;
      if (budget.stringBytes > MAX_API_BODY_STRING_BYTES) return INVALID_JSON_VALUE;
      if (entry === undefined) continue;
      const sanitized = sanitizeJsonValue(entry, budget, depth + 1, ancestors);
      if (sanitized === INVALID_JSON_VALUE) return INVALID_JSON_VALUE;
      output[key] = sanitized;
    }
    return output;
  } finally {
    ancestors.delete(value);
  }
}

function getArrayDataValues(value: unknown[]): unknown[] | null {
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || keys.some((key) => typeof key === 'symbol')) return null;
  const output: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (!descriptor?.enumerable || !('value' in descriptor)) return null;
    output.push(descriptor.value);
  }
  return output;
}

function getObjectDataEntries(value: object): Array<[string, unknown]> | null {
  const output: Array<[string, unknown]> = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) return null;
    output.push([key, descriptor.value]);
  }
  return output;
}

function getBase64DecodedSize(value: string): number | null {
  if (value.length === 0) return 0;
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

export function isAllowedExternalUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Single source of truth for the webview -> OpenCode proxy security boundary.
 *
 * Each incoming `(method, path)` is matched against `API_ROUTES` top to bottom;
 * the first route whose path pattern matches decides the result (mirroring the
 * early-return semantics of the previous imperative cascade). A miss means the
 * request is rejected. Keep more specific patterns above the param/catch-all
 * patterns that could also match them (e.g. `/session/status` before
 * `/session/:id`, and `/session/:id/diff` before `/session/:id/:action`).
 */
export function isAllowedApiRequest(method: string, path: string) {
  const url = parseRelativeApiUrl(path);
  if (!url) return false;
  const segments = url.pathname.split('/').filter(Boolean);
  if (!segments.every(isSafePathSegment)) return false;

  for (const route of API_ROUTES) {
    const params = matchRouteSegments(route.segments, segments);
    if (params) return route.allow({ method, url, params });
  }
  return false;
}

interface RouteContext {
  method: string;
  url: URL;
  params: Record<string, string>;
}

interface ApiRoute {
  segments: string[];
  allow: (ctx: RouteContext) => boolean;
}

const SESSION_ACTIONS = new Set([
  'abort',
  'fork',
  'prompt_async',
  'revert',
  'summarize',
  'unrevert',
  'init',
  'command',
]);

const noQuery = (url: URL) => !url.search;

const onlyQuery = (url: URL, ...keys: string[]) => {
  for (const key of url.searchParams.keys()) {
    if (!keys.includes(key)) return false;
  }
  return true;
};

const requiredQuery = (url: URL, key: string) => Boolean(url.searchParams.get(key)?.trim());

const methodsNoQuery =
  (...methods: string[]) =>
  ({ method, url }: RouteContext) =>
    methods.includes(method) && noQuery(url);

const route = (pattern: string, allow: (ctx: RouteContext) => boolean): ApiRoute => ({
  segments: pattern.split('/').filter(Boolean),
  allow,
});

/**
 * Match a request's path segments against a route pattern. Pattern segments
 * prefixed with `:` capture any single (already validated) segment by name;
 * all other segments must match literally. Returns the captured params on a
 * match, or `null` when the shapes differ.
 */
function matchRouteSegments(pattern: string[], segments: string[]): Record<string, string> | null {
  if (pattern.length !== segments.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i += 1) {
    const patternSegment = pattern[i]!;
    if (patternSegment.startsWith(':')) {
      params[patternSegment.slice(1)] = segments[i]!;
      continue;
    }
    if (patternSegment !== segments[i]) return null;
  }
  return params;
}

const API_ROUTES: ApiRoute[] = [
  route('/global/health', methodsNoQuery('GET')),
  route('/global/config', methodsNoQuery('GET')),
  route('/config/providers', methodsNoQuery('GET')),
  route('/provider/auth', methodsNoQuery('GET')),
  route('/command', methodsNoQuery('GET')),
  route('/mcp', methodsNoQuery('GET')),
  route('/file/status', methodsNoQuery('GET')),
  route('/agent', methodsNoQuery('GET')),
  route('/question', methodsNoQuery('GET')),
  route('/permission', methodsNoQuery('GET')),
  route('/permission/:id/reply', methodsNoQuery('POST')),
  route('/session', methodsNoQuery('GET', 'POST')),
  route('/session/status', methodsNoQuery('GET')),
  route('/experimental/workspace/status', methodsNoQuery('GET')),
  route(
    VARRO_API_ENDPOINTS.providerLimit,
    ({ method, url }) =>
      method === 'GET' &&
      onlyQuery(url, 'providerID', 'modelID') &&
      requiredQuery(url, 'providerID')
  ),
  route(
    VARRO_API_ENDPOINTS.workspaceFile,
    ({ method, url }) => method === 'GET' && onlyQuery(url, 'path') && requiredQuery(url, 'path')
  ),
  route(
    VARRO_API_ENDPOINTS.workspacePathResolve,
    ({ method, url }) => method === 'GET' && onlyQuery(url, 'path') && requiredQuery(url, 'path')
  ),
  route(VARRO_API_ENDPOINTS.workspaceFilePick, methodsNoQuery('GET')),
  route(VARRO_API_ENDPOINTS.openCodeConfig, methodsNoQuery('GET')),
  route(VARRO_API_ENDPOINTS.openCodeConfigModelRouting, methodsNoQuery('POST')),
  route(VARRO_API_ENDPOINTS.permissionJudge, methodsNoQuery('POST')),
  route(`${VARRO_API_ENDPOINTS.session}/:id/diff-summary`, methodsNoQuery('GET')),
  route(`${VARRO_API_ENDPOINTS.session}/:id/pin`, methodsNoQuery('POST')),
  route(`${VARRO_API_ENDPOINTS.session}/:id/rename-if-untitled`, methodsNoQuery('POST')),
  route(`${VARRO_API_ENDPOINTS.session}/:id/delete`, methodsNoQuery('DELETE')),
  route(VARRO_API_ENDPOINTS.sessionTrash, methodsNoQuery('GET', 'DELETE')),
  route(VARRO_API_ENDPOINTS.planOpen, methodsNoQuery('POST')),
  route(
    `${VARRO_API_ENDPOINTS.sessionTrash}/:id/:action`,
    ({ method, url, params }) =>
      noQuery(url) &&
      ((method === 'POST' && params.action === 'restore') ||
        (method === 'DELETE' && params.action === 'delete'))
  ),
  route(
    '/question/:id/:action',
    ({ method, url, params }) =>
      method === 'POST' && noQuery(url) && (params.action === 'reply' || params.action === 'reject')
  ),
  route(
    '/mcp/:id/:action',
    ({ method, url, params }) =>
      method === 'POST' &&
      noQuery(url) &&
      (params.action === 'connect' || params.action === 'disconnect')
  ),
  route('/mcp/:id/auth/authenticate', methodsNoQuery('POST')),
  route(
    '/provider/:id/oauth/:action',
    ({ method, url, params }) =>
      method === 'POST' &&
      noQuery(url) &&
      (params.action === 'authorize' || params.action === 'callback')
  ),
  route('/experimental/workspace/warp', methodsNoQuery('POST')),
  route('/session/:id/diff', ({ method, url }) => method === 'GET' && onlyQuery(url, 'messageID')),
  route(
    '/session/:id/message',
    ({ method, url }) =>
      method === 'GET' &&
      onlyQuery(url, 'limit', 'before') &&
      (!url.searchParams.has('before') || requiredQuery(url, 'limit'))
  ),
  route('/session/:id/message/:messageId', methodsNoQuery('DELETE')),
  route('/session/:id/todo', methodsNoQuery('GET')),
  route(
    '/session/:id/:action',
    ({ method, url, params }) =>
      method === 'POST' && noQuery(url) && SESSION_ACTIONS.has(params.action!)
  ),
  route('/session/:id', methodsNoQuery('GET', 'PATCH', 'DELETE')),
];

function parseRelativeApiUrl(path: string): URL | null {
  if (!path.startsWith('/') || path.startsWith('//')) return null;
  try {
    const url = new URL(path, API_BASE);
    if (url.origin !== API_BASE) return null;
    if (url.pathname.length > MAX_PATH_LENGTH || url.search.length > MAX_QUERY_LENGTH) return null;
    return url;
  } catch {
    return null;
  }
}

function isSafePathSegment(segment: string) {
  if (!segment || segment === '.' || segment === '..') return false;
  if (segment.length > 512) return false;
  return !/%2f|%5c/i.test(segment);
}

function getString(value: unknown) {
  return typeof value === 'string' ? value : null;
}

function getBoundedString(value: unknown, maxLength: number, allowEmpty = false) {
  if (typeof value !== 'string') return null;
  if ((!allowEmpty && value.length === 0) || value.length > maxLength) return null;
  return value;
}

function getOptionalBoundedString(value: unknown, maxLength: number) {
  if (value === undefined || value === null) return undefined;
  return getBoundedString(value, maxLength) || undefined;
}

function getSafeInteger(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function getBoundedInteger(value: unknown, min: number, max: number) {
  const number = getSafeInteger(value);
  return number !== null && number >= min && number <= max ? number : null;
}

function getBoundedNumber(value: unknown, min: number, max: number) {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
    ? value
    : null;
}

function getNullableSafeInteger(value: unknown) {
  if (value === null) return null;
  return getSafeInteger(value) ?? undefined;
}

function hasOwn<T extends object>(object: T, key: PropertyKey): key is keyof T {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function getDesktopSessionPaneSide(value: unknown): DesktopSessionPaneSide | null {
  return value === 'left' || value === 'right' ? value : null;
}

function getPermissionMode(value: unknown): PermissionMode | null {
  return isPermissionMode(value) ? value : null;
}
