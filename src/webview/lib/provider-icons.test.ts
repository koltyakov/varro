import { describe, expect, it } from 'vitest';
import anthropicIcon from '../assets/provider-icons/anthropic.svg';
import deepseekIcon from '../assets/provider-icons/deepseek.svg';
import geminiIcon from '../assets/provider-icons/gemini.svg';
import githubCopilotIcon from '../assets/provider-icons/copilot.svg';
import kimiIcon from '../assets/provider-icons/kimi.svg';
import opencodeIcon from '../assets/provider-icons/opencode.svg';
import openaiIcon from '../assets/provider-icons/openai.svg';
import openrouterIcon from '../assets/provider-icons/openrouter.svg';
import qwenIcon from '../assets/provider-icons/qwen.svg';
import xaiIcon from '../assets/provider-icons/xai.svg';
import zaiIcon from '../assets/provider-icons/zai.svg';
import { getProviderIcon } from './provider-icons';

describe('getProviderIcon', () => {
  it('returns null for null input', () => {
    expect(getProviderIcon(null)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(getProviderIcon(undefined)).toBeNull();
  });

  it('returns null for empty string input', () => {
    expect(getProviderIcon('')).toBeNull();
  });

  it('returns null for an unknown provider', () => {
    expect(getProviderIcon('unknown-provider')).toBeNull();
  });

  it.each([
    ['openai', openaiIcon],
    ['anthropic', anthropicIcon],
    ['openrouter', openrouterIcon],
    ['gemini', geminiIcon],
    ['google', geminiIcon],
    ['deepseek', deepseekIcon],
    ['xai', xaiIcon],
    ['github-copilot', githubCopilotIcon],
    ['zai', zaiIcon],
    ['zai-coding-plan', zaiIcon],
    ['opencode', opencodeIcon],
    ['opencode-go', opencodeIcon],
    ['qwen', qwenIcon],
    ['kimi', kimiIcon],
  ])('maps provider "%s" to the expected icon asset', (provider, icon) => {
    expect(getProviderIcon(provider)).toBe(icon);
  });
});
