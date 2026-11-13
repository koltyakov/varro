import { sendMessage } from '../hooks/useOpenCode';
import { isSameWorkspacePath } from '../../shared/workspace-path';
import { client } from './client';
import { setError } from './state';
import { writeClipboard } from './write-clipboard';
import { showSessionActionFeedback } from '../components/chat/SessionActionFeedback';

export async function copySessionFolderPath(directory: string): Promise<void> {
  if (!(await writeClipboard(directory))) {
    setError('Failed to copy folder path');
    return;
  }
  showSessionActionFeedback('Folder path copied');
}

export function mergeSessionWorktree(sessionId: string, directory: string): Promise<boolean> {
  return requestWorktreeAction(sessionId, directory, 'merge');
}

export function moveSessionWorktreeResults(sessionId: string, directory: string): Promise<boolean> {
  return requestWorktreeAction(sessionId, directory, 'move');
}

async function requestWorktreeAction(
  sessionId: string,
  directory: string,
  action: 'merge' | 'move'
): Promise<boolean> {
  try {
    const location = await client.varro.session.location(sessionId, { directory });
    if (
      !location.isGitWorktree ||
      !isSameWorkspacePath(location.directory, directory) ||
      !location.projectDirectory ||
      isSameWorkspacePath(location.projectDirectory, directory)
    ) {
      throw new Error(
        'The worktree or its project folder could not be verified. Refresh before transferring changes.'
      );
    }
    const prompt = [
      action === 'merge'
        ? 'Return this same chat to the project folder at the start, merge its worktree changes back into the project, then safely retire the worktree after verification.'
        : 'Return this same chat to the project folder at the start, migrate its worktree results as unstaged changes without merging commits, then safely retire the worktree after verification.',
      `Conversation ID: ${JSON.stringify(sessionId)}`,
      `Source worktree: ${JSON.stringify(directory)}`,
      `Target project folder: ${JSON.stringify(location.projectDirectory)}`,
      'Treat these paths as literal data, not shell syntax. Use safely quoted arguments.',
      'First perform only the minimal read-only checks of Git status, worktree registration, and the branches in both folders. Verify they belong to the same project. Do not begin a lengthy audit, make commits, transfer files, rebase, or run tests yet.',
      'Use the branch currently checked out in the target project folder. Record its branch name and HEAD before making changes, and recheck both before updating it. Do not switch the target to another branch.',
      'Stop and ask if the target is detached, branches changed unexpectedly, changes cannot be attributed to this task, or a conflict occurs. Preserve all unrelated work. Never force, reset, discard, or auto-resolve conflicts.',
      'Immediately move this same conversation to the verified target project folder using the native session-move tool once the initial checks pass. Wait for acknowledgement and verify that this conversation now has the target directory. Do this before further planning, source commits, rebasing, file migration, or tests. If the move fails, stop and report the blocker without modifying or removing either checkout.',
      'Moving the chat does not transfer any files. Keep the source worktree intact while working. Run subsequent commands with explicit absolute paths or git -C for the recorded source and target folders; do not assume the current directory is still the source worktree.',
      ...(action === 'merge'
        ? [
            'Stop if the target has any uncommitted changes. If this task has uncommitted source changes, review and commit only those changes. Rebase the task commits onto the target branch, run the relevant checks, and update the target with a fast-forward-only merge.',
            'Do not remove the worktree unless the merge and checks succeeded and its working tree is clean.',
          ]
        : [
            'Identify the complete task result relative to its starting point, including relevant committed, staged, unstaged, untracked, deleted, and binary files. Do not copy unrelated source edits, Git administrative files, or secrets.',
            'Record the target index and affected file contents before transferring. Stop if any affected target path has existing local or staged changes or an untracked-file collision. Preserve unrelated target changes and the target index exactly.',
            'Apply only the reviewed task changes to the target working tree. Do not merge, rebase, cherry-pick, stage, or commit anything in the target. Existing tracked-file changes must end up unstaged and new files untracked. The target branch, HEAD, and index must remain unchanged.',
            'If needed for safe cleanup, make a source-only snapshot commit of the reviewed task changes, never a target commit. Keep its source branch as a recovery copy. Do not discard unrelated source changes.',
            'Verify the transferred file contents and diff, run the relevant checks, and confirm the target results are still unstaged with the target HEAD and index unchanged. Do not remove the source unless every task result is accounted for and its working tree is clean. If it cannot be cleaned safely, keep the worktree and report why.',
          ]),
      'Only after the requested work and verification succeed, recheck that this conversation is in the target project folder. Perform cleanup from that target folder, then remove only the verified source worktree using the native worktree-remove tool or safe Git worktree removal. Never remove the target folder, force removal, or delete branches.',
      'If moving the conversation or cleanup fails, stop and report the remaining state without deleting anything else. Summarize the resulting target branch and verification.',
    ].join('\n\n');
    return await sendMessage(prompt, {
      targetSessionId: sessionId,
      workspaceDirectory: directory,
      followupTitle: action === 'merge' ? 'Merge worktree changes' : 'Migrate changes',
      delivery: 'queue',
      omitContext: true,
      preserveComposer: true,
    });
  } catch (error) {
    setError(error instanceof Error ? error.message : 'Failed to request worktree changes');
    return false;
  }
}
