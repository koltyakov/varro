import { describe, expect, it } from 'vitest';

import { getSessionPermissionRulesForMode } from './permission-rules';

function resolvePermissionAction(
  rules: ReturnType<typeof getSessionPermissionRulesForMode>,
  permission: string
) {
  return rules.findLast((rule) => rule.permission === '*' || rule.permission === permission)
    ?.action;
}

describe('getSessionPermissionRulesForMode', () => {
  it('returns allow-all rules for full access mode', () => {
    const rules = getSessionPermissionRulesForMode('full', 'create');

    expect(rules.length).toBeGreaterThan(0);
    expect(rules.every((rule) => rule.pattern === '*')).toBe(true);
    expect(rules.every((rule) => rule.action === 'allow')).toBe(true);
    expect(rules.some((rule) => rule.permission === 'bash')).toBe(true);
    expect(rules.some((rule) => rule.permission === 'shell')).toBe(true);
    expect(rules.some((rule) => rule.permission === 'edit')).toBe(true);
    expect(rules.some((rule) => rule.permission === 'skill')).toBe(true);
    expect(rules.at(-1)).toEqual({ permission: '*', pattern: '*', action: 'allow' });
  });

  it('returns read-only defaults for default mode', () => {
    const rules = getSessionPermissionRulesForMode('default', 'create');
    const byPermission = new Map(rules.map((rule) => [rule.permission, rule]));

    expect(byPermission.get('read')).toMatchObject({ pattern: '*', action: 'allow' });
    expect(byPermission.get('glob')).toMatchObject({ pattern: '*', action: 'allow' });
    expect(byPermission.get('grep')).toMatchObject({ pattern: '*', action: 'allow' });
    expect(byPermission.get('list')).toMatchObject({ pattern: '*', action: 'allow' });
    expect(byPermission.get('codesearch')).toMatchObject({ pattern: '*', action: 'allow' });
    expect(byPermission.get('lsp')).toMatchObject({ pattern: '*', action: 'allow' });

    expect(byPermission.get('bash')).toMatchObject({ pattern: '*', action: 'ask' });
    expect(byPermission.get('shell')).toMatchObject({ pattern: '*', action: 'ask' });
    expect(byPermission.get('edit')).toMatchObject({ pattern: '*', action: 'ask' });
    expect(byPermission.get('task')).toMatchObject({ pattern: '*', action: 'ask' });
    expect(byPermission.get('question')).toMatchObject({ pattern: '*', action: 'ask' });
  });

  it('overrides agent allow-all for unknown permissions while preserving read-only allowances', () => {
    const rules = [
      { permission: '*', pattern: '*', action: 'allow' as const },
      ...getSessionPermissionRulesForMode('default', 'create'),
    ];

    expect(rules[1]).toEqual({ permission: '*', pattern: '*', action: 'ask' });
    expect(resolvePermissionAction(rules, 'mcp_dynamic_tool')).toBe('ask');
    expect(resolvePermissionAction(rules, 'read')).toBe('allow');
  });

  it('overrides earlier wildcard restrictions in full mode, including for unknown permissions', () => {
    const rules = [
      { permission: '*', pattern: '*', action: 'ask' as const },
      ...getSessionPermissionRulesForMode('full', 'create'),
    ];

    expect(resolvePermissionAction(rules, 'mcp_dynamic_tool')).toBe('allow');
  });

  it('uses default approval rules for auto mode', () => {
    expect(getSessionPermissionRulesForMode('auto', 'create')).toEqual(
      getSessionPermissionRulesForMode('default', 'create')
    );
  });

  it('returns the same rules for create and update targets', () => {
    expect(getSessionPermissionRulesForMode('default', 'update')).toEqual(
      getSessionPermissionRulesForMode('default', 'create')
    );
    expect(getSessionPermissionRulesForMode('full', 'update')).toEqual(
      getSessionPermissionRulesForMode('full', 'create')
    );
    expect(getSessionPermissionRulesForMode('auto', 'update')).toEqual(
      getSessionPermissionRulesForMode('auto', 'create')
    );
  });
});
