import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getSlashCommands } from './slash-commands';
import { resetDefaultAppState, setState } from '../../lib/state';

/* oxlint-disable anti-slop/no-module-mocking -- These tests exercise slash-command integration with useOpenCode actions. */
vi.mock('../../hooks/useOpenCode', () => ({
  abortSession: vi.fn(async () => {}),
  compactSession: vi.fn(async () => {}),
  forkSession: vi.fn(async () => 'forked-session'),
  initSession: vi.fn(async () => {}),
  reviewSession: vi.fn(async () => {}),
  runSlashCommandByName: vi.fn(async () => true),
}));

describe('getSlashCommands', () => {
  beforeEach(() => resetDefaultAppState());

  it('registers both MCP command names and passes a server search to the picker', () => {
    const onOpenMcps = vi.fn();
    const commands = getSlashCommands({
      hasCurrentSession: false,
      canInit: false,
      onConnectProvider: () => {},
      onOpenMcps,
      onOpenSettings: () => {},
      onExportSession: () => {},
      onPauseSession: vi.fn(async () => {}),
      onGenerateStats: () => {},
      customCommands: [
        { name: 'mcp', template: 'Do not send' },
        { name: 'mcps', template: 'Do not send' },
      ],
    });
    const mcp = commands.find((command) => command.name === 'mcp');
    expect(mcp?.aliases).toEqual(['mcps']);
    expect(mcp?.acceptsArguments).toBe(true);
    expect(commands.filter((command) => ['mcp', 'mcps'].includes(command.name))).toHaveLength(1);
    void mcp?.action(' at ');
    expect(onOpenMcps).toHaveBeenCalledWith('at');
  });

  it.each([1, 2] as const)(
    'reserves /btw and offers it only for an existing V2 conversation on API %s',
    (apiVersion) => {
      setState('serverStatus', { state: 'running', url: 'http://localhost:4096', apiVersion });
      const onSideQuestion = vi.fn();
      const commands = getSlashCommands({
        hasCurrentSession: true,
        canInit: false,
        onConnectProvider: () => {},
        onOpenMcps: () => {},
        onOpenSettings: () => {},
        onExportSession: () => {},
        onPauseSession: vi.fn(async () => {}),
        onGenerateStats: () => {},
        onSideQuestion,
        customCommands: [{ name: 'btw', template: 'Do not run' }],
      });
      const aside = commands.filter((command) => command.name === 'btw');
      expect(aside).toHaveLength(apiVersion === 2 ? 1 : 0);
      if (apiVersion === 2) {
        void aside[0]!.action('Why?');
        expect(onSideQuestion).toHaveBeenCalledWith('Why?');
        expect(aside[0]!.acceptsArguments).toBe(true);
      }
    }
  );

  it('includes init but hides session actions in new chats', () => {
    const onGenerateStats = vi.fn();
    const commands = getSlashCommands({
      hasCurrentSession: false,
      canInit: true,
      onConnectProvider: () => {},
      onOpenMcps: () => {},
      onOpenSettings: () => {},
      onExportSession: () => {},
      onPauseSession: vi.fn(async () => {}),
      onGenerateStats,
      customCommands: [
        {
          name: 'test',
          description: 'Run tests',
          template: 'Run tests',
        },
        {
          name: 'settings',
          description: 'Override built-in',
          template: 'ignored',
        },
      ],
    });

    expect(commands.map((command) => command.name)).toEqual([
      'compact',
      'connect',
      'init',
      'mcp',
      'problems',
      'ralph',
      'review',
      'settings',
      'skills',
      'stats',
      'test',
      'thinking',
    ]);
    expect(commands.some((command) => command.name === 'init')).toBe(true);
    expect(commands.some((command) => command.name === 'export')).toBe(false);
    expect(commands.some((command) => command.name === 'fork')).toBe(false);
    expect(commands.some((command) => command.name === 'redo')).toBe(false);
    expect(commands.some((command) => command.name === 'diagnostics')).toBe(false);
    expect(commands.some((command) => command.name === 'attach')).toBe(false);
    expect(commands.some((command) => command.name === 'mcp')).toBe(true);
    expect(commands.some((command) => command.name === 'models')).toBe(false);
    expect(commands.some((command) => command.name === 'new')).toBe(false);
    expect(commands.some((command) => command.name === 'sessions')).toBe(false);
    expect(commands.some((command) => command.name === 'skills')).toBe(true);
    expect(commands.some((command) => command.name === 'test')).toBe(true);
    expect(commands.some((command) => command.name === 'undo')).toBe(false);
    expect(commands.filter((command) => command.name === 'settings')).toHaveLength(1);

    void commands.find((command) => command.name === 'stats')?.action('');
    void commands.find((command) => command.name === 'stats')?.action('all');
    expect(onGenerateStats).toHaveBeenNthCalledWith(1, false);
    expect(onGenerateStats).toHaveBeenNthCalledWith(2, true);
  });

  it('shows session actions and hides new-session commands in existing sessions', () => {
    const commands = getSlashCommands({
      hasCurrentSession: true,
      canInit: false,
      onConnectProvider: () => {},
      onOpenMcps: () => {},
      onOpenSettings: () => {},
      onExportSession: () => {},
      onPauseSession: vi.fn(async () => {}),
      onGenerateStats: () => {},
      customCommands: [],
    });

    expect(commands.some((command) => command.name === 'init')).toBe(false);
    expect(commands.some((command) => command.name === 'ralph')).toBe(false);
    expect(commands.some((command) => command.name === 'export')).toBe(true);
    expect(commands.some((command) => command.name === 'fork')).toBe(false);
    expect(commands.some((command) => command.name === 'abort')).toBe(false);
  });

  it.each([1, 2] as const)('keeps command presentation neutral on API %s', (apiVersion) => {
    setState('serverStatus', { state: 'running', url: 'http://localhost:4096', apiVersion });
    const commands = getSlashCommands({
      hasCurrentSession: true,
      canInit: false,
      onConnectProvider: () => {},
      onOpenMcps: () => {},
      onOpenSettings: () => {},
      onExportSession: () => {},
      onPauseSession: vi.fn(async () => {}),
      onGenerateStats: () => {},
      customCommands: [
        {
          name: 'audit-background',
          source: 'command',
          template: 'Private prompt',
          agent: 'general',
          subtask: true,
        },
        { name: 'ordinary', source: 'command', template: '', description: 'Review code' },
      ],
    });
    const audit = commands.find((command) => command.name === 'audit-background');
    expect(audit?.description).toBe('Runs according to its OpenCode definition');
    expect(audit?.acceptsArguments).toBe(true);
    expect(audit?.help).toEqual(
      apiVersion === 2 ? expect.stringContaining('OpenCode decides') : undefined
    );
    expect(commands.find((command) => command.name === 'ordinary')?.description).toBe(
      'Review code'
    );
    expect(JSON.stringify(commands)).not.toContain('Private prompt');
  });

  it('keeps reserved built-ins hidden when a custom command reuses the name', () => {
    const commands = getSlashCommands({
      hasCurrentSession: true,
      canInit: false,
      onConnectProvider: () => {},
      onOpenMcps: () => {},
      onOpenSettings: () => {},
      onExportSession: () => {},
      onPauseSession: vi.fn(async () => {}),
      onGenerateStats: () => {},
      customCommands: [
        {
          name: 'init',
          description: 'Should stay hidden',
          template: 'ignored',
        },
      ],
    });

    expect(commands.some((command) => command.name === 'init')).toBe(false);
  });

  it.each([
    [2, true, true],
    [1, true, false],
    [undefined, true, false],
    [2, false, false],
  ] as const)(
    'gates /pause on API %s and current session %s',
    (apiVersion, hasCurrentSession, visible) => {
      setState('serverStatus', { state: 'running', url: 'http://localhost:4096', apiVersion });
      const commands = getSlashCommands({
        hasCurrentSession,
        canInit: false,
        onConnectProvider: () => {},
        onOpenMcps: () => {},
        onOpenSettings: () => {},
        onExportSession: () => {},
        onPauseSession: vi.fn(async () => {}),
        onGenerateStats: () => {},
        customCommands: [{ name: 'pause', template: 'Do not send pause to the model' }],
      });
      expect(commands.some((command) => command.name === 'pause')).toBe(visible);
    }
  );
});
