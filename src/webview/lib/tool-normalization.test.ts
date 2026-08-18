import { describe, expect, it } from 'vitest';
import {
  getToolKind,
  isApplyPatchTool,
  isStructuredTool,
  isTodoToolName,
  isTodoToolTitle,
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
    ['functions.update_plan', 'todo'],
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

  it('recognizes todo tool names and display titles consistently', () => {
    expect(isTodoToolName(' Functions.Update_Plan ')).toBe(true);
    expect(isTodoToolName('custom.todo_manager')).toBe(true);
    expect(isTodoToolName('mcp.todo.read')).toBe(true);
    expect(isTodoToolName('functions.read')).toBe(false);
    expect(isTodoToolTitle('Updating Plan')).toBe(true);
    expect(isTodoToolTitle('Todo List')).toBe(true);
    expect(isTodoToolTitle(undefined)).toBe(false);
  });
});
