/* oxlint-disable anti-slop/no-module-mocking -- The action is tested at its chat-send, clipboard, and feedback boundaries without executing Git operations. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sendMessage } from '../hooks/useOpenCode';
import { client } from './client';
import { error, setError } from './state';
import { writeClipboard } from './write-clipboard';
import { showSessionActionFeedback } from '../components/chat/SessionActionFeedback';
import {
  copySessionFolderPath,
  mergeSessionWorktree,
  moveSessionWorktreeResults,
} from './session-location-actions';

vi.mock('../hooks/useOpenCode', () => ({ sendMessage: vi.fn() }));
vi.mock('./write-clipboard', () => ({ writeClipboard: vi.fn() }));
vi.mock('../components/chat/SessionActionFeedback', () => ({ showSessionActionFeedback: vi.fn() }));

beforeEach(() => {
  vi.mocked(sendMessage).mockReset().mockResolvedValue(true);
  vi.mocked(writeClipboard).mockReset().mockResolvedValue(true);
  vi.mocked(showSessionActionFeedback).mockClear();
  vi.spyOn(client.varro.session, 'location').mockResolvedValue({
    directory: '/worktrees/feature',
    isGitWorktree: true,
    projectDirectory: '/repo',
  });
  setError(null);
});
afterEach(() => {
  vi.restoreAllMocks();
  setError(null);
});

describe('worktree location actions', () => {
  it.each([
    { action: 'merge', request: mergeSessionWorktree, work: 'Rebase the task commits' },
    {
      action: 'migrate',
      request: moveSessionWorktreeResults,
      work: 'Identify the complete task result',
    },
  ])(
    'moves the chat before $action work but delays worktree cleanup until success',
    async ({ request, work }) => {
      expect(await request('session-1', '/worktrees/feature')).toBe(true);
      const prompt = vi.mocked(sendMessage).mock.calls[0]![0];
      const checks = prompt.indexOf('First perform only the minimal read-only checks');
      const move = prompt.indexOf('Immediately move this same conversation');
      const transfer = prompt.indexOf(work);
      const cleanup = prompt.indexOf('Only after the requested work and verification succeed');
      expect(checks).toBeGreaterThanOrEqual(0);
      expect(move).toBeGreaterThan(checks);
      expect(transfer).toBeGreaterThan(move);
      expect(cleanup).toBeGreaterThan(transfer);
      expect(prompt).toContain('Wait for acknowledgement');
      expect(prompt).toContain('If the move fails, stop');
      expect(prompt).toContain('explicit absolute paths or git -C');
      expect(prompt).toContain('Never remove the target folder');
    }
  );

  it('sends a follow-up-style merge prompt to the owning session without consuming the composer', async () => {
    expect(await mergeSessionWorktree('session-1', '/worktrees/feature')).toBe(true);
    expect(client.varro.session.location).toHaveBeenCalledWith('session-1', {
      directory: '/worktrees/feature',
    });
    expect(sendMessage).toHaveBeenCalledWith(expect.any(String), {
      targetSessionId: 'session-1',
      workspaceDirectory: '/worktrees/feature',
      followupTitle: 'Merge worktree changes',
      delivery: 'queue',
      omitContext: true,
      preserveComposer: true,
    });
    const prompt = vi.mocked(sendMessage).mock.calls[0]![0];
    expect(prompt).toContain('"/worktrees/feature"');
    expect(prompt).toContain('"/repo"');
    expect(prompt).toContain('branch currently checked out');
    expect(prompt).toContain('fast-forward-only');
    expect(prompt).toContain('Stop and ask');
    expect(prompt).toContain('Never force, reset, discard');
    expect(prompt).toContain('move this same conversation');
    expect(prompt).toContain('remove only the verified source worktree');
  });

  it.each([
    { directory: '/worktrees/feature', isGitWorktree: false, projectDirectory: '/repo' },
    { directory: '/elsewhere', isGitWorktree: true, projectDirectory: '/repo' },
    { directory: '/worktrees/feature', isGitWorktree: true },
    {
      directory: '/worktrees/feature',
      isGitWorktree: true,
      projectDirectory: '/worktrees/feature',
    },
  ])('does not send for unverified or stale locations: %j', async (location) => {
    vi.mocked(client.varro.session.location).mockResolvedValue(location);
    expect(await mergeSessionWorktree('session-1', '/worktrees/feature')).toBe(false);
    expect(await moveSessionWorktreeResults('session-1', '/worktrees/feature')).toBe(false);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(error()).toContain('could not be verified');
  });

  it('moves results as unstaged files rather than integrating commits into the target', async () => {
    expect(await moveSessionWorktreeResults('session-1', '/worktrees/feature')).toBe(true);
    expect(sendMessage).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        targetSessionId: 'session-1',
        workspaceDirectory: '/worktrees/feature',
        followupTitle: 'Migrate changes',
        preserveComposer: true,
        omitContext: true,
      })
    );
    const prompt = vi.mocked(sendMessage).mock.calls[0]![0];
    expect(prompt).toContain('as unstaged changes');
    expect(prompt).toContain(
      'Do not merge, rebase, cherry-pick, stage, or commit anything in the target'
    );
    expect(prompt).toContain('target branch, HEAD, and index must remain unchanged');
    expect(prompt).toContain('new files untracked');
    expect(prompt).toContain('source-only snapshot commit');
    expect(prompt).toContain('move this same conversation');
    expect(prompt).not.toContain('fast-forward-only merge');
  });

  it('copies full paths for moved folders as well as worktrees', async () => {
    await copySessionFolderPath('/outside/moved folder');
    expect(writeClipboard).toHaveBeenCalledWith('/outside/moved folder');
    expect(showSessionActionFeedback).toHaveBeenCalledWith('Folder path copied');
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('reports clipboard failure without opening or merging anything', async () => {
    vi.mocked(writeClipboard).mockResolvedValue(false);
    await copySessionFolderPath('/repo');
    expect(error()).toBe('Failed to copy folder path');
    expect(showSessionActionFeedback).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
