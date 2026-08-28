import type { ChatModelSelection, ModelPreferences, WebviewMessage } from '../../shared/protocol';
import type { RalphConfig } from '../../shared/ralph';

const MODEL_SELECTION: ChatModelSelection = { providerID: 'anthropic', modelID: 'claude-opus-5' };

const MODEL_PREFERENCES: ModelPreferences = {
  modelVariantSelections: { 'anthropic/claude-opus-5': 'thinking' },
  hiddenProviders: ['openai'],
  hiddenModels: ['openai/gpt-5'],
  addedModels: ['anthropic/claude-haiku-4-5'],
  pinnedModels: ['anthropic/claude-opus-5'],
  modelDisplayNames: { 'anthropic/claude-opus-5': 'Opus' },
};

const RALPH_CONFIG: RalphConfig = {
  managerSessionId: 'session-1',
  workspaceDirectory: '/workspace',
  planDocPath: 'PLAN.md',
  iterations: 3,
  promptTemplate: 'continue',
  permissionMode: 'auto',
  model: null,
  agent: null,
  createdAt: 1_700_000_000_000,
};

/**
 * One representative valid message per protocol type, keyed so the `Record`
 * fails to typecheck until a newly added `WebviewMessage` type gets a fixture.
 * Shared by the sanitizer round-trip tests and the router dispatch table so
 * both stay exhaustive from a single definition.
 */
export const VALID_WEBVIEW_MESSAGES = {
  ready: { type: 'ready' },
  'context/request': { type: 'context/request' },
  'providers/refresh': { type: 'providers/refresh' },
  'providers/auth-changed': { type: 'providers/auth-changed' },
  'terminal-selection/clear': { type: 'terminal-selection/clear' },
  'files/clear': { type: 'files/clear' },
  'files/pick': { type: 'files/pick' },
  'webview/reload': { type: 'webview/reload' },
  'vscode/open-folder': { type: 'vscode/open-folder' },
  'vscode/show-output': { type: 'vscode/show-output' },
  'chat/new-editor': { type: 'chat/new-editor' },
  'workspace/select': { type: 'workspace/select', payload: { path: '/workspace' } },
  'commands/state': {
    type: 'commands/state',
    payload: {
      canAbort: true,
      canSwitchSessions: false,
      model: MODEL_SELECTION,
      sessionId: 'session-1',
    },
  },
  'session/seen': { type: 'session/seen', payload: { sessionId: 'session-1' } },
  'webview/focus': { type: 'webview/focus', payload: { focused: true } },
  'permission/reveal': { type: 'permission/reveal', payload: { permissionId: 'permission-1' } },
  'providers/watch': { type: 'providers/watch', payload: { active: true } },
  'terminal/run': {
    type: 'terminal/run',
    payload: { command: 'opencode auth login', title: 'OpenCode' },
  },
  'session/open-in-editor': {
    type: 'session/open-in-editor',
    payload: {
      sessionId: 'session-1',
      title: 'Session',
      model: MODEL_SELECTION,
      rootSessionId: 'root-1',
    },
  },
  'session/open-in-sidebar': {
    type: 'session/open-in-sidebar',
    payload: { sessionId: 'session-1' },
  },
  'session/open-in-opencode': {
    type: 'session/open-in-opencode',
    payload: { sessionId: 'session-1' },
  },
  'editor/route-changed': {
    type: 'editor/route-changed',
    payload: { route: { type: 'session', sessionId: 'session-1' } },
  },
  'session-model/update': {
    type: 'session-model/update',
    payload: { sessionId: 'session-1', model: MODEL_SELECTION },
  },
  'session-models/migrate': {
    type: 'session-models/migrate',
    payload: { models: { 'session-1': MODEL_SELECTION } },
  },
  'session-plan-state/update': {
    type: 'session-plan-state/update',
    payload: { sessionId: 'session-1', skippedAt: 1_700_000_000_000, agent: 'plan' },
  },
  'session-unread-state/update': {
    type: 'session-unread-state/update',
    payload: { sessionId: 'session-1', kind: 'completed', unread: true },
  },
  'model-preferences/update': {
    type: 'model-preferences/update',
    payload: { base: MODEL_PREFERENCES, preferences: MODEL_PREFERENCES },
  },
  'model-preferences/migrate': { type: 'model-preferences/migrate', payload: MODEL_PREFERENCES },
  'session/export': { type: 'session/export', payload: { sessionId: 'session-1' } },
  'usage/report': { type: 'usage/report', payload: { includeAllTime: true } },
  'vscode/open-settings': { type: 'vscode/open-settings', payload: { query: 'varro.server' } },
  'vscode/mermaid-preview': { type: 'vscode/mermaid-preview', payload: { open: true } },
  'server/restart': { type: 'server/restart', payload: { force: true } },
  'server/restart/check': { type: 'server/restart/check', payload: { checkId: 3 } },
  'files/drop': { type: 'files/drop', payload: { paths: ['/workspace/a.ts'] } },
  'files/drop-content': {
    type: 'files/drop-content',
    payload: { files: [{ name: 'a.txt', content: 'YQ==', size: 1 }] },
  },
  'pdfs/store': {
    type: 'pdfs/store',
    payload: { id: 'pdf-1', name: 'a.pdf', content: 'YQ==', size: 1 },
  },
  'images/store': {
    type: 'images/store',
    payload: { id: 'image-1', name: 'a.png', content: 'YQ==', size: 1 },
  },
  'images/release': {
    type: 'images/release',
    payload: { paths: ['/tmp/a.png'], deferred: false, sessionId: 'session-1' },
  },
  'composer/images-update': { type: 'composer/images-update', payload: { images: [] } },
  'files/remove': { type: 'files/remove', payload: { path: '/workspace/a.ts' } },
  'queued-messages/update': {
    type: 'queued-messages/update',
    payload: {
      messages: [
        {
          id: 'queued-1',
          sessionId: 'session-1',
          text: 'follow up',
          droppedFiles: [],
          clipboardImages: [],
          nativePdfs: [],
          terminalSelection: null,
        },
      ],
    },
  },
  'queued-messages/claim': {
    type: 'queued-messages/claim',
    payload: { requestId: 7, itemId: 'queued-1', sessionId: 'session-1', mode: 'steer' },
  },
  'queued-messages/release': {
    type: 'queued-messages/release',
    payload: { itemId: 'queued-1', sessionId: 'session-1', lease: 4 },
  },
  'recovery/interrupted-sessions-ack': {
    type: 'recovery/interrupted-sessions-ack',
    payload: { claimId: 2, consumedSessionIds: ['session-1'] },
  },
  'permission-mode/update': {
    type: 'permission-mode/update',
    payload: { sessionId: 'session-1', mode: 'edits' },
  },
  'permission-modes/migrate': {
    type: 'permission-modes/migrate',
    payload: { modes: { 'session-1': 'full' } },
  },
  'files/search': { type: 'files/search', payload: { requestId: 5, query: 'src', limit: 20 } },
  'file/read': { type: 'file/read', payload: { path: '/workspace/a.ts' } },
  'vscode/open': { type: 'vscode/open', payload: { path: '/workspace/a.ts', line: 12 } },
  'vscode/open-text': {
    type: 'vscode/open-text',
    payload: { content: 'output', title: 'Tool output', language: 'plaintext' },
  },
  'vscode/open-external': {
    type: 'vscode/open-external',
    payload: { url: 'https://example.com' },
  },
  'config/update': {
    type: 'config/update',
    payload: { desktopSessionPaneSide: 'right', defaultPermissionMode: 'auto' },
  },
  'api/request': { type: 'api/request', payload: { id: 1, method: 'GET', path: '/session' } },
  'api/cancel': { type: 'api/cancel', payload: { id: 1, cancelKey: 'session-1' } },
  'ralph/start': { type: 'ralph/start', payload: { config: RALPH_CONFIG } },
  'ralph/stop': { type: 'ralph/stop', payload: { managerSessionId: 'session-1' } },
  'ralph/pause': { type: 'ralph/pause', payload: { managerSessionId: 'session-1' } },
  'ralph/resume': { type: 'ralph/resume', payload: { managerSessionId: 'session-1' } },
  'ralph/update-model': {
    type: 'ralph/update-model',
    payload: { managerSessionId: 'session-1', model: null },
  },
  'ralph/sync': { type: 'ralph/sync', payload: {} },
  log: { type: 'log', payload: { msg: 'hello', level: 'warn' } },
} as const satisfies Record<WebviewMessage['type'], WebviewMessage>;
