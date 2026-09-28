export function getProviderUsageLink(
  providerID: string | null | undefined
): { label: string; url: string } | null {
  switch (providerID) {
    case 'openai':
      return { label: 'ChatGPT Usage', url: 'https://chatgpt.com/#settings/Usage' };
    case 'anthropic':
      return { label: 'Claude Usage', url: 'https://claude.ai/settings/usage' };
    case 'copilot':
    case 'github-copilot':
      return { label: 'GitHub Copilot Usage', url: 'https://github.com/settings/billing' };
    case 'xai':
      return { label: 'Grok Usage', url: 'https://grok.com/?_s=usage' };
    case 'zai':
    case 'zai-coding-plan':
      return { label: 'Z.ai Usage', url: 'https://z.ai/manage-apikey/coding-plan/personal/usage' };
    default:
      return null;
  }
}
