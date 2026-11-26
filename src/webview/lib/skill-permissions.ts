import type { PermissionRule } from '../../shared/opencode-types';

const SKILL_PERMISSION = 'skill';

// Mirrors OpenCode's Wildcard.match: `*` and `?` are wildcards, and a trailing ` *`
// also matches the bare prefix.
function matchesWildcard(value: string, pattern: string) {
  let source = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  source = source.replace(/\?/g, '.');
  if (source.endsWith(' .*')) source = `${source.slice(0, -3)}( .*)?`;
  return new RegExp(`^${source}$`, 's').test(value);
}

/** OpenCode uses the last matching rule; skills are available unless a rule denies them. */
export function isSkillEnabled(rules: readonly PermissionRule[], id: string) {
  const match = rules.findLast(
    (rule) =>
      matchesWildcard(SKILL_PERMISSION, rule.permission) && matchesWildcard(id, rule.pattern)
  );
  return match?.action !== 'deny';
}

function isExactSkillRule(rule: PermissionRule, id: string) {
  return rule.permission === SKILL_PERMISSION && rule.pattern === id;
}

export function hasSkillRule(rules: readonly PermissionRule[], id: string) {
  return rules.some((rule) => isExactSkillRule(rule, id));
}

/**
 * Returns `rules` with the skill's own rule removed, or appended last when the remaining
 * rules would not produce `enabled`. `enabled: null` only removes the rule.
 * `evaluate` receives the edited rules and returns every rule OpenCode applies, in order.
 */
export function setSkillRule(
  rules: readonly PermissionRule[],
  id: string,
  enabled: boolean | null,
  evaluate: (rules: PermissionRule[]) => PermissionRule[] = (next) => next
): PermissionRule[] {
  const next = rules.filter((rule) => !isExactSkillRule(rule, id));
  if (enabled === null || isSkillEnabled(evaluate(next), id) === enabled) return next;
  next.push({ permission: SKILL_PERMISSION, pattern: id, action: enabled ? 'allow' : 'deny' });
  if (isSkillEnabled(evaluate(next), id) !== enabled)
    throw new Error(
      `Another OpenCode config rule still ${enabled ? 'denies' : 'allows'} ${id}. Open the config file to edit it.`
    );
  return next;
}
