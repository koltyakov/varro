import type { PermissionMode } from './protocol';
import type { PermissionRule } from './opencode-types';

export const KNOWN_PERMISSION_NAMES = [
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

const FULL_ACCESS_PERMISSION_RULES: PermissionRule[] = [
  ...KNOWN_PERMISSION_NAMES.map<PermissionRule>((permission) => ({
    permission,
    pattern: '*',
    action: 'allow',
  })),
  // OpenCode uses the last matching rule, so this must override earlier agent restrictions.
  { permission: '*', pattern: '*', action: 'allow' },
];

const READ_ONLY_PERMISSIONS = new Set(['read', 'glob', 'grep', 'list', 'codesearch', 'lsp']);

const SHARED_DIRECT_PERMISSION_RULES: PermissionRule[] = [
  { permission: 'todowrite', pattern: '*', action: 'allow' },
  { permission: 'question', pattern: '*', action: 'allow' },
];

export function isSharedDirectPermission(permission: string): boolean {
  const normalized = permission.toLowerCase();
  return normalized === 'todowrite' || normalized === 'question';
}

export function getSharedDirectPermissionRules(): PermissionRule[] {
  return SHARED_DIRECT_PERMISSION_RULES;
}

export function isKnownReadOnlyPermission(permission: string): boolean {
  return READ_ONLY_PERMISSIONS.has(permission.toLowerCase());
}

function isAutoApprovedPermission(permission: string): boolean {
  const normalized = permission.toLowerCase();
  return (
    normalized === 'task' ||
    normalized === 'todowrite' ||
    normalized === 'question' ||
    isKnownReadOnlyPermission(normalized)
  );
}

export function isEditPermission(permission: string): boolean {
  const normalized = permission.toLowerCase();
  return (
    normalized === 'edit' ||
    normalized === 'apply_patch' ||
    normalized === 'patch' ||
    normalized === 'write'
  );
}

const AUTO_APPROVE_PERMISSION_RULES: PermissionRule[] = [
  // Specific safe allowances must follow this catch-all under last-match semantics.
  { permission: '*', pattern: '*', action: 'ask' },
  ...KNOWN_PERMISSION_NAMES.map<PermissionRule>((permission) => ({
    permission,
    pattern: '*',
    action: isAutoApprovedPermission(permission) ? 'allow' : 'ask',
  })),
];

const AUTO_ACCEPT_EDITS_PERMISSION_RULES: PermissionRule[] = [
  // Preserve routine read-only work while asking before commands and other actions.
  { permission: '*', pattern: '*', action: 'ask' },
  ...KNOWN_PERMISSION_NAMES.map<PermissionRule>((permission) => ({
    permission,
    pattern: '*',
    action: isAutoApprovedPermission(permission) || isEditPermission(permission) ? 'allow' : 'ask',
  })),
];

export function getSessionPermissionRulesForMode(
  mode: PermissionMode,
  _target: 'create' | 'update'
): PermissionRule[] {
  if (mode === 'full') return FULL_ACCESS_PERMISSION_RULES;
  if (mode === 'edits') return AUTO_ACCEPT_EDITS_PERMISSION_RULES;
  if (mode === 'auto') return AUTO_APPROVE_PERMISSION_RULES;
  return [];
}
