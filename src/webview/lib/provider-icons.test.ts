import { describe, expect, it } from 'vitest';
import amazonIcon from '../assets/provider-icons/amazon.svg';
import anthropicIcon from '../assets/provider-icons/anthropic.svg';
import azureIcon from '../assets/provider-icons/azure.svg';
import claudeIcon from '../assets/provider-icons/claude.svg';
import deepseekIcon from '../assets/provider-icons/deepseek.svg';
import geminiIcon from '../assets/provider-icons/gemini.svg';
import githubCopilotIcon from '../assets/provider-icons/copilot.svg';
import kimiIcon from '../assets/provider-icons/kimi.svg';
import ollamaIcon from '../assets/provider-icons/ollama.svg';
import opencodeIcon from '../assets/provider-icons/opencode.svg';
import openaiIcon from '../assets/provider-icons/openai.svg';
import openrouterIcon from '../assets/provider-icons/openrouter.svg';
import qwenIcon from '../assets/provider-icons/qwen.svg';
import xaiIcon from '../assets/provider-icons/xai.svg';
import zaiIcon from '../assets/provider-icons/zai.svg';
import { getProviderIcon } from './provider-icons';

describe('getProviderIcon', () => {
  it.each([
    { label: 'null', provider: null },
    { label: 'undefined', provider: undefined },
    { label: 'empty string', provider: '' },
  ])('returns null for $label input', ({ provider }) => {
    expect(getProviderIcon(provider)).toBeNull();
  });

  it('returns null for an unknown provider', () => {
    expect(getProviderIcon('unknown-provider')).toBeNull();
  });

  it('maps the exact Claude Code custom provider name to its icon', () => {
    expect(getProviderIcon('custom-provider', 'Claude Code')).toBe(claudeIcon);
    expect(getProviderIcon('openai', 'Claude Code')).toBe(claudeIcon);
    expect(getProviderIcon('custom-provider', 'claude code')).toBeNull();
  });

  it.each([
    ['openai', openaiIcon],
    ['anthropic', anthropicIcon],
    ['claude-code', claudeIcon],
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
    ['kimi-for-coding', kimiIcon],
    ['ollama-cloud', ollamaIcon],
    ['azure', azureIcon],
    ['azure-cognitive-services', azureIcon],
    ['amazon-bedrock', amazonIcon],
  ])('maps provider "%s" to the expected icon asset', (provider, icon) => {
    expect(getProviderIcon(provider)).toBe(icon);
  });
});
