export const CURRENT_OPENCODE_ENDPOINTS = {
  health: '/global/health',
  eventStream: '/global/event',
  sessionPromptAsync(sessionID: string) {
    return `/session/${encodeURIComponent(sessionID)}/prompt_async`;
  },
} as const;

export function parseSessionPromptEndpoint(path: string): string | null {
  const match = new URL(path, 'http://localhost').pathname.match(
    /^\/session\/([^/]+)\/prompt(?:_async)?$/
  );
  return match ? decodeURIComponent(match[1]!) : null;
}
