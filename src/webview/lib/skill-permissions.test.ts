import { describe, expect, it } from 'vitest';
import type { PermissionRule } from '../../shared/opencode-types';
import { hasSkillRule, isSkillEnabled, setSkillRule } from './skill-permissions';

const rule = (
  permission: string,
  pattern: string,
  action: PermissionRule['action']
): PermissionRule => ({ permission, pattern, action });

describe('skill permissions', () => {
  it('treats skills without a denying rule as enabled', () => {
    expect(isSkillEnabled([], 'review')).toBe(true);
    expect(isSkillEnabled([rule('skill', 'review', 'ask')], 'review')).toBe(true);
    expect(isSkillEnabled([rule('bash', '*', 'deny')], 'review')).toBe(true);
  });

  it('uses the last matching rule, including wildcards', () => {
    expect(
      isSkillEnabled([rule('skill', 'review', 'deny'), rule('skill', '*', 'allow')], 'review')
    ).toBe(true);
    expect(
      isSkillEnabled([rule('skill', '*', 'allow'), rule('skill', 'rev*', 'deny')], 'review')
    ).toBe(false);
    expect(isSkillEnabled([rule('*', '*', 'deny')], 'review')).toBe(false);
    expect(isSkillEnabled([rule('skill', 'rev?ew', 'deny')], 'review')).toBe(false);
    expect(isSkillEnabled([rule('skill', 'rev.ew', 'deny')], 'review')).toBe(true);
  });

  it('appends a deny rule last and removes it again when enabling', () => {
    const base = [rule('skill', 'review', 'allow'), rule('skill', '*', 'allow')];
    const disabled = setSkillRule(base, 'review', false);
    expect(disabled).toEqual([rule('skill', '*', 'allow'), rule('skill', 'review', 'deny')]);
    expect(hasSkillRule(disabled, 'review')).toBe(true);
    expect(setSkillRule(disabled, 'review', true)).toEqual([rule('skill', '*', 'allow')]);
  });

  it('writes an allow rule when inherited rules deny the skill', () => {
    const inherited = [rule('skill', 'review', 'deny')];
    const next = setSkillRule([], 'review', true, (rules) => [...inherited, ...rules]);
    expect(next).toEqual([rule('skill', 'review', 'allow')]);
    expect(setSkillRule(next, 'review', null)).toEqual([]);
  });

  it('rejects changes that a later rule would override', () => {
    expect(() =>
      setSkillRule([], 'review', false, (rules) => [...rules, rule('skill', '*', 'allow')])
    ).toThrow('Another OpenCode config rule still allows review');
  });
});
