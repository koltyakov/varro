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
  it('includes init for blank sessions alongside built-ins and custom commands', () => {
    const onGenerateStats = vi.fn();
    const commands = getSlashCommands({
      isBusy: false,
      canUndo: true,
      canRedo: true,
      canInit: true,
      onConnectProvider: () => {},
      onOpenSessions: () => {},
      onOpenModels: () => {},
      onOpenMcps: () => {},
      onOpenFiles: () => {},
      onAttachDiagnostics: () => {},
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
      'attach',
      'compact',
      'connect',
      'diagnostics',
      'export',
      'fork',
      'init',
      'mcp',
      'models',
      'new',
      'ralph',
      'review',
      'sessions',
      'settings',
      'skills',
      'stats',
      'test',
      'thinking',
    ]);
    expect(commands.some((command) => command.name === 'init')).toBe(true);
    expect(commands.some((command) => command.name === 'export')).toBe(true);
    expect(commands.some((command) => command.name === 'redo')).toBe(false);
    expect(commands.find((command) => command.name === 'diagnostics')?.aliases).toEqual([]);
    expect(commands.some((command) => command.name === 'skills')).toBe(true);
    expect(commands.some((command) => command.name === 'test')).toBe(true);
    expect(commands.some((command) => command.name === 'undo')).toBe(false);
    expect(commands.filter((command) => command.name === 'settings')).toHaveLength(1);

    commands.find((command) => command.name === 'stats')?.action('');
    commands.find((command) => command.name === 'stats')?.action('all');
    expect(onGenerateStats).toHaveBeenNthCalledWith(1, false);
    expect(onGenerateStats).toHaveBeenNthCalledWith(2, true);
  });

  it('hides init outside blank sessions', () => {
    const commands = getSlashCommands({
      isBusy: false,
      canUndo: false,
      canRedo: false,
      canInit: false,
      onConnectProvider: () => {},
      onOpenSessions: () => {},
      onOpenModels: () => {},
      onOpenMcps: () => {},
      onOpenFiles: () => {},
      onAttachDiagnostics: () => {},
      onOpenSettings: () => {},
      onExportSession: () => {},
      onGenerateStats: () => {},
      customCommands: [],
    });

    expect(commands.some((command) => command.name === 'init')).toBe(false);
  });

  it('keeps reserved built-ins hidden when a custom command reuses the name', () => {
    const commands = getSlashCommands({
      isBusy: false,
      canUndo: false,
      canRedo: false,
      canInit: false,
      onConnectProvider: () => {},
      onOpenSessions: () => {},
      onOpenModels: () => {},
      onOpenMcps: () => {},
      onOpenFiles: () => {},
      onAttachDiagnostics: () => {},
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
