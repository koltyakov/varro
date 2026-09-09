import { describe, expect, it } from 'vitest';
import {
  formatSkillAttachment,
  formatSkillReference,
  getSkillReferences,
  parseSkillAttachment,
} from './skill-reference';

describe('skill references', () => {
  it('distinguishes selected skills from currency, shell variables, and dollar queries', () => {
    expect(getSkillReferences('Cost $5, $HOME, $browser and $[unslop] $[unslop]')).toEqual([
      'unslop',
    ]);
    expect(getSkillReferences('$[%ZZ] $[]')).toEqual([]);
  });

  it('round trips names with spaces, punctuation, and unicode', () => {
    const name = 'review [日本語]';
    expect(getSkillReferences(`Use ${formatSkillReference(name)}.`)).toEqual([name]);
    expect(parseSkillAttachment(formatSkillAttachment(name))).toBe(name);
    expect(parseSkillAttachment(`Example: ${formatSkillAttachment(name)}`)).toBeNull();
  });
});
