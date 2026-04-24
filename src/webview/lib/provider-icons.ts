// Provider SVGs sourced from https://lobehub.com
// Provider SVGs sourced from https://github.com/pheralb/svgl
import openaiIcon from '../assets/provider-icons/openai.svg';
import anthropicIcon from '../assets/provider-icons/anthropic.svg';
import openrouterIcon from '../assets/provider-icons/openrouter.svg';
import geminiIcon from '../assets/provider-icons/gemini.svg';
import deepseekIcon from '../assets/provider-icons/deepseek.svg';
import xaiIcon from '../assets/provider-icons/xai.svg';
import qwenIcon from '../assets/provider-icons/qwen.svg';
import kimiIcon from '../assets/provider-icons/kimi.svg';
import opencodeIcon from '../assets/provider-icons/opencode.svg';

// Provider SVGs sourced from https://uxwing.com
import githubCopilotIcon from '../assets/provider-icons/copilot.svg';
import zaiIcon from '../assets/provider-icons/zai.svg';

const PROVIDER_ICON_MAP: Record<string, string> = {
  openai: openaiIcon,
  anthropic: anthropicIcon,
  openrouter: openrouterIcon,
  gemini: geminiIcon,
  google: geminiIcon,
  deepseek: deepseekIcon,
  xai: xaiIcon,
  'github-copilot': githubCopilotIcon,
  zai: zaiIcon,
  'zai-coding-plan': zaiIcon,
  opencode: opencodeIcon,
  'opencode-go': opencodeIcon,
  qwen: qwenIcon,
  kimi: kimiIcon,
};

export function getProviderIcon(providerID: string | null | undefined) {
  if (!providerID) return null;
  return PROVIDER_ICON_MAP[providerID] || null;
}
