import { state, showThinking, toggleThinking } from '../../lib/state';
// import { startNewChatDraft } from '../../lib/new-chat-draft';
import {
  // abortSession,
  compactSession,
  forkSession,
  initSession,
  reviewSession,
  runSlashCommandByName,
} from '../../hooks/useOpenCode';
import { ralphStore } from '../../lib/stores/ralph-store';
import { SKILLS_COMMAND_NAME } from './completion';
import type { SlashCommand } from './CompletionMenu';
import type { Command } from '../../types';

export async function forkActiveSession(): Promise<void> {
  const sessionId = state.activeSessionId;
  if (!sessionId) return;
  await forkSession(sessionId);
}

export function getSlashCommands(props: {
  hasCurrentSession: boolean;
  canInit: boolean;
  onConnectProvider: () => void;
  onOpenSettings: () => void;
  onExportSession: () => void;
  onGenerateStats: (includeAllTime: boolean) => void;
  customCommands: Command[];
}): SlashCommand[] {
  const reservedBuiltInNames = new Set([
    'new',
    'clear',
    'sessions',
    'resume',
    'agents',
    'models',
    'mcp',
    'mcps',
    'connect',
    'attach',
    'files',
    'diagnostics',
    'settings',
    'export',
    'stats',
    'fork',
    'thinking',
    'reasoning',
    'compact',
    'summarize',
    'init',
    'undo',
    'revert',
    'redo',
    'review',
    'abort',
    'stop',
    'ralph',
  ]);

  const commands: SlashCommand[] = [
    {
      name: SKILLS_COMMAND_NAME,
      aliases: [],
      description: 'Browse available skills',
      acceptsArguments: true,
      action: () => {},
    },
    /*
     * Keep these registrations handy, but do not expose `/new`, `/clear`,
     * `/sessions`, or `/resume` in slash-command completion for now.
     *
     * {
     *   name: 'new',
     *   aliases: ['clear'],
     *   description: 'Start a new chat session',
     *   action: () => {
     *     startNewChatDraft();
     *   },
     * },
     * {
     *   name: 'sessions',
     *   aliases: ['resume'],
     *   description: 'Open the session list',
     *   action: () => props.onOpenSessions(),
     * },
     */
    /*
     * Keep these registrations handy, but do not expose `/models`, `/mcp`, or
     * `/mcps` in slash-command completion for now.
     *
     * {
     *   name: 'models',
     *   aliases: [],
     *   description: 'Open the model picker',
     *   action: () => props.onOpenModels(),
     * },
     * {
     *   name: 'mcp',
     *   aliases: ['mcps'],
     *   description: 'Open the MCP picker for this session',
     *   action: () => props.onOpenMcps(),
     * },
     */
    {
      name: 'connect',
      aliases: [],
      description: 'Connect a provider',
      action: () => props.onConnectProvider(),
    },
    /*
     * Keep this registration handy, but do not expose `/attach` or `/files`
     * in slash-command completion for now.
     *
     * {
     *   name: 'attach',
     *   aliases: ['files'],
     *   description: 'Pick files or folders to attach',
     *   action: () => props.onOpenFiles(),
     * },
     */
    /*
     * Keep this registration handy, but do not expose `/diagnostics` for now.
     *
     * {
     *   name: 'diagnostics',
     *   aliases: [],
     *   description: 'Attach active-file problems to your next message',
     *   action: () => props.onAttachDiagnostics(),
     * },
     */
    {
      name: 'settings',
      aliases: [],
      description: 'Open VS Code settings for Varro',
      action: () => props.onOpenSettings(),
    },
    {
      name: 'stats',
      aliases: [],
      description: 'Generate a usage report; add all for all time',
      action: (args) => {
        props.onGenerateStats(args.trim().toLowerCase() === 'all');
      },
    },
    {
      name: 'thinking',
      aliases: ['reasoning'],
      description: showThinking() ? 'Hide thinking blocks' : 'Show thinking blocks',
      action: () => {
        toggleThinking();
      },
    },
    {
      name: 'compact',
      aliases: ['summarize'],
      description: 'Compact conversation context',
      action: () => {
        compactSession();
      },
    },
  ];

  if (props.hasCurrentSession) {
    commands.push({
      name: 'export',
      aliases: [],
      description: 'Export the current session',
      action: () => {
        props.onExportSession();
      },
    });

    /*
     * Keep this registration handy, but do not expose `/fork` in
     * slash-command completion for now. Direct submission still works
     * through the built-in handling in `runSlashCommand`.
     *
     * commands.push({
     *   name: 'fork',
     *   aliases: [],
     *   description: 'Fork the current session',
     *   action: () => {
     *     void forkActiveSession();
     *   },
     * });
     */
  }

  if (props.canInit) {
    commands.push({
      name: 'init',
      aliases: [],
      description: 'Analyze the project and create AGENTS.md',
      action: () => {
        initSession();
      },
    });
  }

  /*
   * Keep these registrations handy, but do not expose `/undo`, `/revert`, or
   * `/redo` in slash-command completion for now. Direct submission still works
   * through the built-in handling in `handleSubmit`.
   *
   * if (props.canUndo) {
   *   commands.push({
   *     name: 'undo',
   *     aliases: ['revert'],
   *     description: 'Undo the last assistant response',
   *     action: () => {
   *       undoSession();
   *     },
   *   });
   * }
   *
   * if (props.canRedo) {
   *   commands.push({
   *     name: 'redo',
   *     aliases: [],
   *     description: 'Redo the last undone response',
   *     action: () => {
   *       redoSession();
   *     },
   *   });
   * }
   */

  commands.push({
    name: 'review',
    aliases: [],
    description: 'Review current code changes',
    action: () => {
      reviewSession();
    },
  });

  if (!props.hasCurrentSession) {
    commands.push({
      name: 'ralph',
      aliases: [],
      description: 'Start a Ralph loop on a plan document',
      action: () => {
        ralphStore.setShowRalphForm(true);
      },
    });
  }

  for (const command of props.customCommands) {
    if (command.source === 'skill') continue;
    if (reservedBuiltInNames.has(command.name)) continue;
    commands.push({
      name: command.name,
      aliases: [],
      description: command.description || command.template,
      acceptsArguments: (command.hints?.length ?? 0) > 0,
      source: command.source,
      action: (args) => {
        void runSlashCommandByName(command.name, args);
      },
    });
  }

  return commands.toSorted((a, b) => a.name.localeCompare(b.name));
}
