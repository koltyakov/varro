export type ToolKind =
  | 'terminal'
  | 'search'
  | 'read'
  | 'edit'
  | 'task'
  | 'todo'
  | 'web'
  | 'question'
  | 'skill'
  | 'tools';

const TERMINAL_TOOL_NAMES = new Set(['bash', 'shell', 'terminal', 'exec', 'command']);
const SEARCH_TOOL_NAMES = new Set(['grep', 'glob', 'codesearch', 'websearch', 'search']);
const READ_TOOL_NAMES = new Set(['read', 'file_read']);
const EDIT_TOOL_NAMES = new Set([
  'apply_patch',
  'edit',
  'write',
  'create',
  'delete',
  'rename',
  'patch',
  'file_edit',
  'file_write',
  'file_create',
  'update_file',
  'replace',
  'insert',
  'apply_edit',
  'apply_diff',
  'remove',
  'unlink',
  'rm',
  'file_delete',
  'file_remove',
  'move',
  'mv',
  'file_move',
  'file_rename',
]);
const TODO_TOOL_NAMES = new Set(['update_plan', 'updateplan']);
const STRUCTURED_TOOL_NAMES = new Set(['task', 'apply_patch', 'webfetch']);

export function normalizeToolName(toolName: string): string {
  const normalized = toolName.trim().toLowerCase();
  return normalized.split('.').at(-1) || normalized;
}

export function isTodoToolName(toolName: string): boolean {
  const fullName = toolName.trim().toLowerCase();
  const normalized = normalizeToolName(toolName);
  return fullName.includes('todo') || TODO_TOOL_NAMES.has(normalized);
}

export function isTodoToolTitle(title: string | undefined): boolean {
  const normalized = title?.trim().toLowerCase() ?? '';
  return (
    normalized.includes('todo') || normalized === 'update plan' || normalized === 'updating plan'
  );
}

export function getToolKind(toolName: string): ToolKind {
  const normalized = normalizeToolName(toolName);
  if (TERMINAL_TOOL_NAMES.has(normalized)) return 'terminal';
  if (SEARCH_TOOL_NAMES.has(normalized)) return 'search';
  if (READ_TOOL_NAMES.has(normalized)) return 'read';
  if (EDIT_TOOL_NAMES.has(normalized)) return 'edit';
  if (normalized === 'task') return 'task';
  if (isTodoToolName(normalized)) return 'todo';
  if (normalized === 'question') return 'question';
  if (normalized === 'skill') return 'skill';
  if (normalized === 'webfetch' || normalized.includes('browser')) return 'web';
  return 'tools';
}

export function isApplyPatchTool(toolName: string): boolean {
  return normalizeToolName(toolName) === 'apply_patch';
}

export function isStructuredTool(toolName: string): boolean {
  return STRUCTURED_TOOL_NAMES.has(normalizeToolName(toolName));
}
