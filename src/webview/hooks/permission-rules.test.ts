import { describe, expect, it } from 'vitest';

import {
  getResolvedAgentPermissionRules,
  getSessionPermissionRulesForMode,
} from './permission-rules';

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

  it('leaves default mode to OpenCode configuration', () => {
    expect(getSessionPermissionRulesForMode('default', 'create')).toEqual([]);
  });

  it('returns conservative ask rules for auto mode', () => {
    const rules = getSessionPermissionRulesForMode('auto', 'create');
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
    expect(byPermission.get('task')).toMatchObject({ pattern: '*', action: 'allow' });
    expect(byPermission.get('todowrite')).toMatchObject({ pattern: '*', action: 'allow' });
    expect(byPermission.get('question')).toMatchObject({ pattern: '*', action: 'allow' });
    expect(byPermission.get('webfetch')).toMatchObject({ pattern: '*', action: 'ask' });
    expect(byPermission.get('websearch')).toMatchObject({ pattern: '*', action: 'ask' });
  });

  it('makes auto mode override agent allow-all while preserving read-only allowances', () => {
    const rules = [
      { permission: '*', pattern: '*', action: 'allow' as const },
      ...getSessionPermissionRulesForMode('auto', 'create'),
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

describe('getResolvedAgentPermissionRules', () => {
  it('normalizes legacy agent permission objects for default-mode restoration', () => {
    expect(
      getResolvedAgentPermissionRules({
        edit: 'deny',
        bash: { '*': 'ask', 'git status': 'allow' },
      })
    ).toEqual([
      { permission: 'edit', pattern: '*', action: 'deny' },
      { permission: 'bash', pattern: '*', action: 'ask' },
      { permission: 'bash', pattern: 'git status', action: 'allow' },
    ]);
  });
});
