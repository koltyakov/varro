import type { PermissionMode } from './protocol';
import type { PermissionRule } from './opencode-types';

const FULL_ACCESS_PERMISSION_NAMES = [
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
  ...FULL_ACCESS_PERMISSION_NAMES.map<PermissionRule>((permission) => ({
    permission,
    pattern: '*',
    action: 'allow',
  })),
  // OpenCode uses the last matching rule, so this must override earlier agent restrictions.
  { permission: '*', pattern: '*', action: 'allow' },
];

const READ_ONLY_PERMISSIONS = new Set(['read', 'glob', 'grep', 'list', 'codesearch', 'lsp']);

const DEFAULT_PERMISSION_RULES: PermissionRule[] = [
  // Specific read-only allowances must follow this catch-all under last-match semantics.
  { permission: '*', pattern: '*', action: 'ask' },
  ...FULL_ACCESS_PERMISSION_NAMES.map<PermissionRule>((permission) => ({
    permission,
    pattern: '*',
    action: READ_ONLY_PERMISSIONS.has(permission) ? 'allow' : 'ask',
  })),
];

export function getSessionPermissionRulesForMode(
  mode: PermissionMode,
  _target: 'create' | 'update'
): PermissionRule[] {
  if (mode === 'full') return FULL_ACCESS_PERMISSION_RULES;
  return DEFAULT_PERMISSION_RULES;
}
