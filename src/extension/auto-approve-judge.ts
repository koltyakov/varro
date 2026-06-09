import { isAbsolute, relative, resolve } from 'path';
import type {
  AutoApproveJudgeReference,
  AutoApproveJudgeRequest,
  AutoApproveJudgeResponse,
} from '../shared/protocol';
import type { PermissionRule } from '../shared/opencode-types';
import type { OpenCodeServer } from './server';
import type { HiddenSessionManager } from './hidden-session-manager';
import { logger } from './logger';

type OpenCodeRequest = Pick<OpenCodeServer, 'getWorkspaceCwd' | 'request'>;

const JUDGE_TIMEOUT_MS = 30_000;
const JUDGE_TITLE_PREFIX = 'Varro permission judge';
const DENY_ALL_PERMISSION_NAMES = [
  'read',
  'edit',
  'glob',
  'grep',
  'list',
  'bash',
  'shell',
  'task',
  'external_directory',
  'todowrite',
  'question',
  'webfetch',
  'websearch',
  'codesearch',
  'lsp',
  'doom_loop',
  'skill',
] as const;

const DENY_ALL_PERMISSION_RULES: PermissionRule[] = DENY_ALL_PERMISSION_NAMES.map((permission) => ({
  permission,
  pattern: '*',
  action: 'deny',
}));
const SAFE_GIT_INSPECTION_COMMANDS = new Set([
  'diff',
  'log',
  'ls-files',
  'rev-parse',
  'show',
  'status',
]);
const SAFE_GIT_BRANCH_FLAGS = new Set(['--show-current', '--list', '-a', '-r', '-v', '-vv']);

export class AutoApproveJudge {
  constructor(
    private readonly server: OpenCodeRequest,
    private readonly hiddenSessions: HiddenSessionManager
  ) {}

  async judge(request: AutoApproveJudgeRequest): Promise<AutoApproveJudgeResponse> {
    const permission = normalizePermissionRequest(request.permission);
    if (!permission) return { decision: 'ask', reason: 'Missing permission context.' };
    if (!hasUsefulPermissionContext(permission)) {
      return { decision: 'ask', reason: 'Permission request lacks enough detail to judge safely.' };
    }
    const localDecision = this.judgeLocally(permission);
    if (localDecision) return localDecision;

    return this.withTimeout(
      this.runJudge(permission, request.model, request.approvedReferences || []),
      JUDGE_TIMEOUT_MS
    ).catch((err) => {
      logger.warn(`Auto-approve judge failed: ${err instanceof Error ? err.message : String(err)}`);
      return { decision: 'ask', reason: 'Judge failed; asking user.' };
    });
  }

  private async runJudge(
    permission: NormalizedJudgePermission,
    fallbackModel: AutoApproveJudgeRequest['model'],
    approvedReferences: AutoApproveJudgeReference[]
  ): Promise<AutoApproveJudgeResponse> {
    const title = `${JUDGE_TITLE_PREFIX}: ${permission.id}`;
    this.hiddenSessions.registerPendingTitle(title);
    let sessionID: string | null = null;

    try {
      const session = await this.server.request('POST', '/session', {
        title,
        permission: DENY_ALL_PERMISSION_RULES,
      });
      sessionID = getString(asRecord(session)?.id);
      this.hiddenSessions.hide(sessionID);
      if (!sessionID) return { decision: 'ask', reason: 'Judge session was not created.' };

      const model = await this.resolveJudgeModel(fallbackModel);
      const response = await this.server.request(
        'POST',
        `/session/${encodeURIComponent(sessionID)}/message`,
        {
          ...(model ? { model } : {}),
          system: buildJudgeSystemPrompt(),
          parts: [
            {
              type: 'text',
              text: buildJudgeUserPrompt(permission, approvedReferences),
            },
          ],
          format: judgeOutputFormat(),
        }
      );

      return normalizeJudgeResponse(response);
    } finally {
      this.hiddenSessions.forgetPendingTitle(title);
      if (sessionID) {
        try {
          await this.server.request('DELETE', `/session/${encodeURIComponent(sessionID)}`);
        } catch (err) {
          logger.warn(
            `Failed to delete hidden auto-approve judge session: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
      }
    }
  }

  private async resolveJudgeModel(fallbackModel: AutoApproveJudgeRequest['model']) {
    const config = asRecord(await this.server.request('GET', '/config').catch(() => null));
    const smallModel = parseModelRoute(config?.small_model);
    return smallModel || normalizeModel(fallbackModel);
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('Auto-approve judge timed out')), timeoutMs);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private judgeLocally(permission: NormalizedJudgePermission): AutoApproveJudgeResponse | null {
    if (
      isEditPermissionType(permission) &&
      isWorkspaceEditPermission(permission, this.server.getWorkspaceCwd())
    ) {
      return { decision: 'allow', reason: 'Workspace file edit.' };
    }
    if (isSafeLocalBashPermission(permission)) {
      return { decision: 'allow', reason: 'Safe local command.' };
    }
    return null;
  }
}

type NormalizedJudgePermission = {
  id: string;
  type: string;
  title: string;
  sessionID: string;
  messageID?: string;
  callID?: string;
  pattern?: string | string[];
  metadata: Record<string, unknown>;
};

function normalizePermissionRequest(value: unknown): NormalizedJudgePermission | null {
  const record = asRecord(value);
  if (!record) return null;
  const id = getString(record.id) || getString(record.permissionID) || getString(record.requestID);
  const type = getString(record.type) || getString(record.permission);
  const sessionID = getString(record.sessionID);
  if (!id || !type || !sessionID) return null;
  const title = getString(record.title) || type;
  const messageID = getString(record.messageID);
  const callID = getString(record.callID);
  const patternValue = record.pattern ?? record.patterns;
  const pattern = Array.isArray(patternValue)
    ? patternValue.filter((item): item is string => typeof item === 'string')
    : typeof patternValue === 'string'
      ? patternValue
      : undefined;
  return {
    id,
    type,
    title,
    sessionID,
    ...(messageID ? { messageID } : {}),
    ...(callID ? { callID } : {}),
    ...(pattern !== undefined ? { pattern } : {}),
    metadata: asRecord(record.metadata) || {},
  };
}

function hasUsefulPermissionContext(permission: NormalizedJudgePermission) {
  const hasPattern = hasUsefulPattern(permission.pattern);
  const hasMetadata = Object.keys(permission.metadata).length > 0;
  if (permission.type === 'bash' || permission.type === 'shell') {
    if (hasPattern || hasMetadata) return true;
    const title = permission.title.trim();
    if (!title || title.toLowerCase() === permission.type.toLowerCase()) return false;
    return (
      /\b(?:command|cmd|bash|shell)\s*:\s*\S+/i.test(title) ||
      /^(?:run\s+)?(?:bash|shell)\s+\S+/i.test(title) ||
      /\b(npm|git|rm|mv|cp|python|node|bun|pnpm|yarn)\b/i.test(title)
    );
  }
  return permission.title !== permission.type || hasPattern || hasMetadata;
}

function hasUsefulPattern(pattern: NormalizedJudgePermission['pattern']) {
  if (typeof pattern === 'string') return pattern.trim().length > 0;
  return Array.isArray(pattern) && pattern.some((item) => item.trim().length > 0);
}

function isWorkspaceEditPermission(
  permission: NormalizedJudgePermission,
  workspacePath: string | undefined
) {
  if (!isEditPermissionType(permission)) return false;
  if (hasDeletedFileChange(permission.metadata)) return false;

  const paths = collectPermissionPaths(permission);
  return paths.length > 0 && paths.every((item) => isWorkspacePath(item, workspacePath));
}

function isEditPermissionType(permission: NormalizedJudgePermission) {
  const type = permission.type.toLowerCase();
  return type === 'edit' || type === 'apply_patch' || type === 'patch' || type === 'write';
}

function hasDeletedFileChange(metadata: Record<string, unknown>) {
  const files = Array.isArray(metadata.files) ? metadata.files : [];
  return files.some((item) => {
    const record = asRecord(item);
    const kind = getString(record?.type) || getString(record?.status) || getString(record?.action);
    return /^(delete|deleted|remove|removed)$/i.test(kind || '');
  });
}

function collectPermissionPaths(permission: NormalizedJudgePermission) {
  const paths: string[] = [];
  const addPath = (value: unknown) => {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (!trimmed || /[*?[\]{}]/.test(trimmed)) return;
    paths.push(trimmed);
  };
  const addRecordPaths = (record: Record<string, unknown> | null) => {
    addPath(record?.filepath);
    addPath(record?.filePath);
    addPath(record?.path);
    addPath(record?.relativePath);
  };

  addRecordPaths(permission.metadata);
  if (Array.isArray(permission.metadata.files)) {
    for (const item of permission.metadata.files) addRecordPaths(asRecord(item));
  }
  if (Array.isArray(permission.pattern)) {
    for (const item of permission.pattern) addPath(item);
  } else {
    addPath(permission.pattern);
  }
  const titlePath = permission.title.match(/^(?:edit|apply_patch|patch|write)\s+(.+)$/i)?.[1];
  addPath(titlePath);

  return [...new Set(paths)];
}

function isWorkspacePath(filePath: string, workspacePath: string | undefined) {
  if (!isAbsolute(filePath)) {
    const normalized = filePath.replace(/\\/g, '/');
    return Boolean(normalized) && !normalized.startsWith('../') && normalized !== '..';
  }
  if (!workspacePath) return false;
  const relativePath = relative(resolve(workspacePath), resolve(filePath));
  return (
    relativePath === '' ||
    (!!relativePath && !relativePath.startsWith('..') && !isAbsolute(relativePath))
  );
}

function isSafeLocalBashPermission(permission: NormalizedJudgePermission) {
  if (permission.type !== 'bash' && permission.type !== 'shell') return false;
  const command = extractCommand(permission);
  if (!command) return false;
  if (/[;|`<>\r\n]|\$\(/.test(command)) return false;
  const commands = splitSafeCommandSequence(command);
  if (!commands) return false;
  return commands.every(isSafeLocalCommandSegment);
}

function splitSafeCommandSequence(command: string) {
  if (command.includes('&') && !/(?:^|[^&])&&(?:[^&]|$)/.test(command)) return null;
  const commands = command
    .split(/\s+&&\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (commands.length === 0) return null;
  if (commands.some((part) => part.includes('&'))) return null;
  return commands;
}

function isSafeLocalCommandSegment(command: string) {
  return (
    /^(?:rtk\s+)?npm\s+run\s+[\w:.-]+(?:\s|$)/.test(command) ||
    isSafeGitInspectionCommand(command) ||
    /^(?:rtk\s+)?(?:pwd|date|uname|whoami)\s*$/.test(command) ||
    /^(?:rtk\s+)?(?:which\s+\S+|command\s+-v\s+\S+)\s*$/.test(command) ||
    /^(?:rtk\s+)?\S+(?:\s+(?:--version|-v|version))\s*$/.test(command)
  );
}

function isSafeGitInspectionCommand(command: string) {
  const match = command.match(/^(?:rtk\s+)?git(?:\s+-C\s+(?:"[^"]+"|'[^']+'|\S+))?\s+(\S+)(.*)$/);
  if (!match) return false;
  const subcommand = match[1];
  const args = match[2].trim();
  if (/\s--(?:output|ext-diff)\b/.test(` ${args}`)) return false;
  if (SAFE_GIT_INSPECTION_COMMANDS.has(subcommand)) return true;
  if (subcommand !== 'branch') return false;
  if (!args) return true;
  return args
    .split(/\s+/)
    .every((arg) => SAFE_GIT_BRANCH_FLAGS.has(arg) || /^--sort=\S+$/.test(arg));
}

function extractCommand(permission: NormalizedJudgePermission) {
  const metadataCommand =
    getString(permission.metadata.command) ||
    getString(permission.metadata.cmd) ||
    getString(permission.metadata.bash) ||
    getString(permission.metadata.shell);
  if (metadataCommand) return metadataCommand.trim();
  if (typeof permission.pattern === 'string' && permission.pattern.trim()) {
    return permission.pattern.trim();
  }
  return permission.title
    .replace(/^run\s+command:\s*/i, '')
    .replace(/^(?:bash|shell)\s+/i, '')
    .trim();
}

function buildJudgeSystemPrompt() {
  return [
    'You are a conservative permission gate for an AI coding assistant.',
    'Decide whether a pending tool call can run without asking the user.',
    'Return allow when the action is clearly non-destructive and expected for coding work, such as checking versions, inspecting local state, or running local npm scripts/tests/builds.',
    'Prefer allow for simple local read-only commands unless they have destructive flags, unclear paths, or side effects outside the workspace.',
    'Use prior manual approvals as examples of what this user considers acceptable, but do not approve a new request solely because a superficially similar request was approved.',
    'Return ask for destructive commands, secrets/auth changes, network publishing, package installs with scripts, git push/commit/tag/rebase/reset, file deletion, broad chmod/chown, external directory access, unclear intent, or missing details.',
    'Do not use tools. Output only the requested JSON decision.',
  ].join('\n');
}

function buildJudgeUserPrompt(
  permission: NormalizedJudgePermission,
  approvedReferences: AutoApproveJudgeReference[]
) {
  return `Judge this permission request.\n${JSON.stringify(
    {
      permission,
      priorManualApprovals: approvedReferences,
    },
    null,
    2
  )}`;
}

function judgeOutputFormat() {
  return {
    type: 'json_schema',
    retryCount: 1,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        decision: {
          type: 'string',
          enum: ['allow', 'ask'],
          description:
            'allow means approve this exact permission once; ask means show the user the normal approval prompt.',
        },
        reason: { type: 'string' },
      },
      required: ['decision', 'reason'],
    },
  };
}

function normalizeJudgeResponse(value: unknown): AutoApproveJudgeResponse {
  const record = asRecord(value);
  const info = asRecord(record?.info);
  const structured = asRecord(info?.structured_output) || asRecord(info?.structuredOutput);
  const directDecision = parseJudgeDecision(structured);
  if (directDecision) return directDecision;

  const parts = Array.isArray(record?.parts) ? record.parts : [];
  for (const part of parts) {
    const partRecord = asRecord(part);
    if (partRecord?.type !== 'text' || typeof partRecord.text !== 'string') continue;
    const parsed = parseJsonObject(partRecord.text);
    const textDecision = parseJudgeDecision(parsed);
    if (textDecision) return textDecision;
  }

  return { decision: 'ask', reason: 'Judge did not return a valid decision.' };
}

function parseJudgeDecision(value: unknown): AutoApproveJudgeResponse | null {
  const record = asRecord(value);
  if (!record) return null;
  const decision = record?.decision;
  if (decision !== 'allow' && decision !== 'ask') return null;
  return {
    decision,
    reason: typeof record.reason === 'string' ? record.reason : undefined,
  };
}

function parseJsonObject(text: string) {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/i, '')
    .trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function parseModelRoute(value: unknown) {
  if (typeof value !== 'string') return null;
  const separator = value.indexOf('/');
  if (separator <= 0 || separator === value.length - 1) return null;
  return { providerID: value.slice(0, separator), modelID: value.slice(separator + 1) };
}

function normalizeModel(value: AutoApproveJudgeRequest['model']) {
  if (!value?.providerID || !value.modelID) return null;
  return {
    providerID: value.providerID,
    modelID: value.modelID,
    ...(value.variant ? { variant: value.variant } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function getString(value: unknown) {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}
