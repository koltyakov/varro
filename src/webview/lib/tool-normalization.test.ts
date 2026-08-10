import { describe, expect, it } from 'vitest';
import {
  getToolKind,
  isApplyPatchTool,
  isStructuredTool,
  normalizeToolName,
} from './tool-normalization';

describe('tool normalization', () => {
  it('normalizes namespaced tool names to their lowercase leaf name', () => {
    expect(normalizeToolName(' Functions.File_Write ')).toBe('file_write');
  });

  it.each([
    ['functions.command', 'terminal'],
    ['functions.codesearch', 'search'],
    ['functions.file_read', 'read'],
    ['functions.file_write', 'edit'],
    ['functions.task', 'task'],
    ['functions.todowrite', 'todo'],
    ['functions.webfetch', 'web'],
    ['mcp.browser_navigate', 'web'],
    ['functions.question', 'question'],
    ['functions.skill', 'skill'],
    ['mcp.custom', 'tools'],
  ] as const)('classifies %s as %s', (toolName, kind) => {
    expect(getToolKind(toolName)).toBe(kind);
  });

  it('identifies specialized tools after namespace normalization', () => {
    expect(isApplyPatchTool('functions.apply_patch')).toBe(true);
    expect(isStructuredTool('functions.apply_patch')).toBe(true);
    expect(isStructuredTool('functions.task')).toBe(true);
  });
});
