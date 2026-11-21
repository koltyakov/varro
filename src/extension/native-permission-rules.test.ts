import { describe, expect, it } from 'vitest';
import {
  appendNativePermissionAllows,
  resolveNativePermissionEffect,
} from './native-permission-rules';

const gitRules = [
  { action: 'shell', resource: 'git *', effect: 'allow' },
  { action: 'shell', resource: 'git push*', effect: 'deny' },
  { action: 'shell', resource: 'git reset --hard*', effect: 'ask' },
];

describe('resolveNativePermissionEffect', () => {
  it.each([
    ['git fetch origin', 'allow'],
    ['git', 'allow'],
    ['git push origin main', 'deny'],
    ['git reset --hard HEAD~1', 'ask'],
    ['npm test', undefined],
  ])('uses the last matching rule for %s', (resource, effect) => {
    expect(resolveNativePermissionEffect(gitRules, 'shell', resource!)).toBe(effect);
  });

  it('matches whole values with simple wildcards and literal regex characters', () => {
    const rules = [{ action: 'sh?ll', resource: 'echo [a].?*', effect: 'allow' }];
    expect(resolveNativePermissionEffect(rules, 'shell', 'echo [a].x')).toBe('allow');
    expect(resolveNativePermissionEffect(rules, 'shell', 'echo a.x')).toBeUndefined();
    expect(resolveNativePermissionEffect(rules, 'shell', 'prefix echo [a].x')).toBeUndefined();
    expect(resolveNativePermissionEffect(rules, 'edit', 'echo [a].x')).toBeUndefined();
  });

  it('does not reuse an allowance from a malformed rule set', () => {
    expect(
      resolveNativePermissionEffect([...gitRules, { action: 'shell' }], 'shell', 'git fetch')
    ).toBeUndefined();
  });

  it('normalizes backslashes like native permission matching', () => {
    const rules = [
      { action: 'shell', resource: 'git *', effect: 'allow' },
      { action: 'shell', resource: 'git show private\\*', effect: 'deny' },
    ];
    expect(resolveNativePermissionEffect(rules, 'shell', 'git show private/secret')).toBe('deny');
    expect(appendNativePermissionAllows(rules, 'shell', ['git show private/*'])).toHaveLength(3);
  });
});

describe('appendNativePermissionAllows', () => {
  it('skips narrower scopes covered by an allowance with unrelated exceptions', () => {
    expect(
      appendNativePermissionAllows(gitRules, 'shell', ['git fetch *', 'git fetch origin'])
    ).toEqual(gitRules);
  });

  it('does not skip grants overridden by a later ask or deny', () => {
    expect(
      appendNativePermissionAllows(gitRules, 'shell', ['git *', 'git push*', 'git reset --hard*'])
    ).toEqual([...gitRules, { action: 'shell', resource: 'git *', effect: 'allow' }]);
    expect(
      appendNativePermissionAllows(gitRules, 'shell', ['git push*', 'git reset --hard*'])
    ).toEqual([
      ...gitRules,
      { action: 'shell', resource: 'git push*', effect: 'allow' },
      { action: 'shell', resource: 'git reset --hard*', effect: 'allow' },
    ]);
  });

  it('deduplicates composed requests and newly appended scopes', () => {
    expect(
      appendNativePermissionAllows([], 'shell', [
        'git fetch *',
        'git fetch *',
        'git fetch origin',
        'head *',
      ])
    ).toEqual([
      { action: 'shell', resource: 'git fetch *', effect: 'allow' },
      { action: 'shell', resource: 'head *', effect: 'allow' },
    ]);
  });

  it('retains rule order, effects, unknown fields, and other actions', () => {
    const rules = [{ action: 'edit', resource: '*', effect: 'allow', note: 'keep' }, ...gitRules];
    expect(appendNativePermissionAllows(rules, 'shell', ['head *'])).toEqual([
      ...rules,
      { action: 'shell', resource: 'head *', effect: 'allow' },
    ]);
    expect(rules).toHaveLength(4);
  });

  it('conservatively preserves potentially overlapping exceptions', () => {
    const rules = [
      { action: '*', resource: '*', effect: 'allow' },
      { action: 'shell', resource: 'git * --force', effect: 'ask' },
    ];
    expect(appendNativePermissionAllows(rules, 'shell', ['git fetch *'])).toHaveLength(3);
    expect(appendNativePermissionAllows(rules, 'shell', ['head *'])).toEqual(rules);
  });

  it('handles no-argument shell commands and does not broaden wildcard syntax', () => {
    const rules = [{ action: 'shell', resource: 'git fetch *', effect: 'allow' }];
    expect(appendNativePermissionAllows(rules, 'shell', ['git fetch'])).toEqual(rules);
    expect(appendNativePermissionAllows(rules, 'shell', ['git fetch*'])).toHaveLength(2);
    expect(appendNativePermissionAllows(rules, 'shell', ['git ?etch *'])).toHaveLength(2);
  });

  it('does not deduplicate across malformed rules', () => {
    const rules = [...gitRules, { action: 'shell', effect: 'unknown' }];
    expect(appendNativePermissionAllows(rules, 'shell', ['git fetch *'])).toHaveLength(5);
  });
});
