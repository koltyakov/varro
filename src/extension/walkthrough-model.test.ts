import { describe, expect, it } from 'vitest';
import { parseReviewModel, selectWalkthroughModel } from './walkthrough';

describe('walkthrough model selection', () => {
  const active = { providerID: 'openai', modelID: 'gpt-6-astra', variant: 'max' };

  it('prefers the review model, with its optional reasoning variant', () => {
    expect(selectWalkthroughModel('openai/gpt-6-sol#medium', active)).toEqual({
      providerID: 'openai',
      modelID: 'gpt-6-sol',
      variant: 'medium',
    });
    expect(selectWalkthroughModel('openai/gpt-6-sol', active)).toEqual({
      providerID: 'openai',
      modelID: 'gpt-6-sol',
    });
  });

  it("uses the active chat's exact selection, reasoning included, when no review model is set", () => {
    expect(selectWalkthroughModel('', active)).toEqual(active);
    expect(selectWalkthroughModel('', null)).toBeNull();
  });

  it('treats a malformed review setting as unset', () => {
    for (const value of ['gpt-6-sol', 'openai/', '/gpt', 'openai/gpt 6', 'openai/a#b#c']) {
      expect(parseReviewModel(value)).toBeNull();
    }
  });
});
