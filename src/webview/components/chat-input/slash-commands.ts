import { state, showThinking, toggleThinking } from '../../lib/state';
import { startNewChatDraft } from '../../lib/new-chat-draft';
import {
  abortSession,
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

export function forkActiveSession() {
  const sessionId = state.activeSessionId;
  if (!sessionId) return Promise.resolve();
  return forkSession(sessionId).then(() => undefined);
}

export function getSlashCommands(props: {
  isBusy: boolean;
  canUndo: boolean;
  canRedo: boolean;
  canInit: boolean;
  onConnectProvider: () => void;
  onOpenSessions: () => void;
  onOpenModels: () => void;
  onOpenMcps: () => void;
  onOpenFiles: () => void;
  onOpenSettings: () => void;
  onExportSession: () => void;
  customCommands: Command[];
}): SlashCommand[] {
  const reservedBuiltInNames = new Set([
    'new',
    'agents',
    'models',
    'mcp',
    'mcps',
    'connect',
    'attach',
    'files',
    'settings',
    'export',
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
      action: () => {},
    },
    {
      name: 'new',
      aliases: ['clear'],
      description: 'Start a new chat session',
      action: () => {
        startNewChatDraft();
      },
    },
    {
      name: 'sessions',
      aliases: ['resume'],
      description: 'Open the session list',
      action: () => props.onOpenSessions(),
    },
    {
      name: 'models',
      aliases: [],
      description: 'Open the model picker',
      action: () => props.onOpenModels(),
    },
    {
      name: 'mcp',
      aliases: ['mcps'],
      description: 'Open the MCP picker for this session',
      action: () => props.onOpenMcps(),
    },
    {
      name: 'connect',
      aliases: [],
      description: 'Open provider login in the terminal',
      action: () => props.onConnectProvider(),
    },
    {
      name: 'attach',
      aliases: ['files'],
      description: 'Pick files or folders to attach',
      action: () => props.onOpenFiles(),
    },
    {
      name: 'settings',
      aliases: [],
      description: 'Open VS Code settings for Varro',
      action: () => props.onOpenSettings(),
    },
    {
      name: 'export',
      aliases: [],
      description: 'Export the current session',
      action: () => {
        props.onExportSession();
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
    {
      name: 'fork',
      aliases: [],
      description: 'Fork the current session',
      action: () => {
        void forkActiveSession();
      },
    },
  ];

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

  commands.push({
    name: 'ralph',
    aliases: [],
    description: 'Start a Ralph loop on a plan document',
    action: () => {
      ralphStore.setShowRalphForm(true);
    },
  });

  if (props.isBusy) {
    commands.push({
      name: 'abort',
      aliases: ['stop'],
      description: 'Stop the current run',
      action: () => {
        abortSession();
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
      source: command.source,
      action: (args) => {
        void runSlashCommandByName(command.name, args);
      },
    });
  }

  return commands.toSorted((a, b) => a.name.localeCompare(b.name));
}
