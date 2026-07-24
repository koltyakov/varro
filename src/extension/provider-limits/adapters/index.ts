import { createAntigravityAdapter } from './antigravity';
import { createAnthropicAdapter } from './anthropic';
import { createCodexAdapter } from './codex';
import { createCopilotAdapter } from './copilot';
import { createGeminiAdapter } from './gemini';
import { createHeaderProbeAdapter } from './header-probe';
import { createKimiAdapter } from './kimi';
import { createMiniMaxAdapter } from './minimax';
import { createOpenRouterAdapter } from './openrouter';
import { createZaiAdapter } from './zai';

export const providerLimitAdapters = [
  createAntigravityAdapter(),
  createAnthropicAdapter(),
  createCodexAdapter(),
  createCopilotAdapter(),
  createGeminiAdapter(),
  createOpenRouterAdapter(),
  createZaiAdapter(),
  createMiniMaxAdapter(),
  createKimiAdapter(),
  createHeaderProbeAdapter('openai'),
  createHeaderProbeAdapter('github-copilot'),
];
