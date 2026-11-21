/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- Parse native permission entries at the OpenCode config boundary before matching them. */
import { asRecord } from '../shared/type-utils';

type NativePermissionRule = {
  action: string;
  resource: string;
  effect: 'allow' | 'ask' | 'deny';
};

function parseRule(value: unknown): NativePermissionRule | null {
  const rule = asRecord(value);
  if (
    typeof rule?.action !== 'string' ||
    typeof rule.resource !== 'string' ||
    (rule.effect !== 'allow' && rule.effect !== 'ask' && rule.effect !== 'deny')
  )
    return null;
  return { action: rule.action, resource: rule.resource, effect: rule.effect };
}

function matches(value: string, pattern: string): boolean {
  let source = pattern
    .replaceAll('\\', '/')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  if (source.endsWith(' .*')) source = source.slice(0, -3) + '( .*)?';
  return new RegExp(`^${source}$`, process.platform === 'win32' ? 'si' : 's').test(
    value.replaceAll('\\', '/')
  );
}

function normalizePattern(pattern: string): string {
  const normalized = pattern.replaceAll('\\', '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/** Evaluate concrete server resources, never the broader suggested save patterns. */
export function resolveNativePermissionEffect(
  rules: readonly unknown[],
  action: string,
  resource: string
): NativePermissionRule['effect'] | undefined {
  let effect: NativePermissionRule['effect'] | undefined;
  for (const value of rules) {
    const rule = parseRule(value);
    // An unfamiliar entry must not leave an earlier allowance authoritative.
    if (!rule) return undefined;
    if (matches(action, rule.action) && matches(resource, rule.resource)) {
      effect = rule.effect;
    }
  }
  return effect;
}

function covers(existing: string, proposed: string): boolean {
  existing = normalizePattern(existing);
  proposed = normalizePattern(proposed);
  if (existing === proposed || existing === '*') return true;
  if (!/[*?]/.test(proposed)) return matches(proposed, existing);
  // Prove containment only for a literal prefix followed by a single wildcard.
  if (!existing.endsWith('*') || /[*?]/.test(existing.slice(0, -1))) return false;
  const prefix = existing.slice(0, -1);
  return proposed.startsWith(prefix);
}

function mayOverlap(left: string, right: string): boolean {
  left = normalizePattern(left);
  right = normalizePattern(right);
  if (!/[*?]/.test(left)) return matches(left, right);
  if (!/[*?]/.test(right)) return matches(right, left);
  const leftPrefix = left.split(/[*?]/, 1)[0]!;
  const rightPrefix = right.split(/[*?]/, 1)[0]!;
  return leftPrefix.startsWith(rightPrefix) || rightPrefix.startsWith(leftPrefix);
}

/** Skip proven redundant grants without moving rules across later exceptions. */
export function appendNativePermissionAllows(
  existing: readonly unknown[],
  action: string,
  patterns: readonly string[]
): unknown[] {
  const result = [...existing];
  for (const resource of new Set(patterns)) {
    const covered = result.some((value, index) => {
      const rule = parseRule(value);
      return (
        rule?.effect === 'allow' &&
        matches(action, rule.action) &&
        covers(rule.resource, resource) &&
        result.slice(index + 1).every((laterValue) => {
          const later = parseRule(laterValue);
          return (
            later !== null &&
            (later.effect === 'allow' ||
              !matches(action, later.action) ||
              !mayOverlap(resource, later.resource))
          );
        })
      );
    });
    if (!covered) result.push({ action, resource, effect: 'allow' });
  }
  return result;
}
