import { createAntigravityAdapter } from './antigravity';
import { createAnthropicAdapter } from './anthropic';
import { createCodexAdapter } from './codex';
import { createCopilotAdapter } from './copilot';
import { createGeminiAdapter } from './gemini';
import { createHeaderProbeAdapter } from './header-probe';
import { createKimiAdapter } from './kimi';
import { createMiniMaxAdapter } from './minimax';
import { createOllamaCloudAdapter } from './ollama-cloud';
import { createOpenCodeGoAdapter } from './opencode-go';
import { createOpenCodeClaudeAdapter } from './opencode-claude';
import { createOpenRouterAdapter } from './openrouter';
import { createXaiAdapter } from './xai';
import { createZaiAdapter } from './zai';

export const providerLimitAdapters = [
  createOpenCodeClaudeAdapter(),
  createAntigravityAdapter(),
  createAnthropicAdapter(),
  createCodexAdapter(),
  createCopilotAdapter(),
  createGeminiAdapter(),
  createOllamaCloudAdapter(),
  createOpenCodeGoAdapter(),
  createOpenRouterAdapter(),
  createZaiAdapter(),
  createMiniMaxAdapter(),
  createKimiAdapter(),
  createXaiAdapter(),
  createHeaderProbeAdapter('openai'),
  createHeaderProbeAdapter('github-copilot'),
  createHeaderProbeAdapter('xai'),
];
