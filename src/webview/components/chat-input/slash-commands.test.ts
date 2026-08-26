import { describe, expect, it, vi } from 'vitest';
import { getSlashCommands } from './slash-commands';

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
  it('includes init but hides session actions in new chats', () => {
    const onGenerateStats = vi.fn();
    const commands = getSlashCommands({
      hasCurrentSession: false,
      canInit: true,
      onConnectProvider: () => {},
      onOpenSettings: () => {},
      onExportSession: () => {},
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
    expect(commands.some((command) => command.name === 'mcp')).toBe(false);
    expect(commands.some((command) => command.name === 'models')).toBe(false);
    expect(commands.some((command) => command.name === 'new')).toBe(false);
    expect(commands.some((command) => command.name === 'sessions')).toBe(false);
    expect(commands.some((command) => command.name === 'skills')).toBe(true);
    expect(commands.some((command) => command.name === 'test')).toBe(true);
    expect(commands.some((command) => command.name === 'undo')).toBe(false);
    expect(commands.filter((command) => command.name === 'settings')).toHaveLength(1);

    commands.find((command) => command.name === 'stats')?.action('');
    commands.find((command) => command.name === 'stats')?.action('all');
    expect(onGenerateStats).toHaveBeenNthCalledWith(1, false);
    expect(onGenerateStats).toHaveBeenNthCalledWith(2, true);
  });

  it('shows session actions and hides new-session commands in existing sessions', () => {
    const commands = getSlashCommands({
      hasCurrentSession: true,
      canInit: false,
      onConnectProvider: () => {},
      onOpenSettings: () => {},
      onExportSession: () => {},
      onGenerateStats: () => {},
      customCommands: [],
    });

    expect(commands.some((command) => command.name === 'init')).toBe(false);
    expect(commands.some((command) => command.name === 'ralph')).toBe(false);
    expect(commands.some((command) => command.name === 'export')).toBe(true);
    expect(commands.some((command) => command.name === 'fork')).toBe(false);
    expect(commands.some((command) => command.name === 'abort')).toBe(false);
  });

  it('keeps reserved built-ins hidden when a custom command reuses the name', () => {
    const commands = getSlashCommands({
      hasCurrentSession: true,
      canInit: false,
      onConnectProvider: () => {},
      onOpenSettings: () => {},
      onExportSession: () => {},
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
});
