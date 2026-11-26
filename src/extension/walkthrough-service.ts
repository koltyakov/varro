/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-returns -- OpenCode session diffs are validated at this I/O boundary; server startup has no result. */
import { isAbsolute, join } from 'node:path';
import * as vscode from 'vscode';
import type { ChatModelSelection } from '../shared/protocol';
import { asRecord } from '../shared/type-utils';
import {
  captureRepositoryChanges,
  resolveGitApi,
  resolveRepository,
  type GitRepository,
} from './commit-message-service';
import { resolveHelperModel } from './helper-model-selection';
import { logger } from './logger';
import { parseJsonObject, tryGenerateOneShot } from './one-shot-generation';
import type { OpenCodeServer } from './server';
import {
  buildWalkthroughDigest,
  buildWalkthroughPrompt,
  normalizeWalkthrough,
  parseUnifiedDiff,
  renderWalkthroughMarkdown,
  WalkthroughTooLargeError,
  type WalkthroughDigest,
  type WalkthroughFile,
} from './walkthrough';

export type WalkthroughRequest =
  | { kind: 'git'; sourceControl?: vscode.SourceControl }
  | { kind: 'session'; sessionId: string; directory?: string; messageId?: string };

type WalkthroughSource = {
  files: WalkthroughFile[];
  scopeLabel: string;
  /** Directory the request runs in and relative paths resolve against. */
  directory: string | undefined;
};

type GitScopeItem = vscode.QuickPickItem & { scope: 'staged' | 'unstaged' | 'all' };

const GENERATION_TIMEOUT_MS = 5 * 60_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

class WalkthroughCancelledError extends Error {
  constructor() {
    super('Walkthrough generation was cancelled');
  }
}

/**
 * Generates an AI-guided reading order through a diff and opens it as a Markdown report. It only
 * runs when asked, because every walkthrough spends tokens on the helper model.
 */
export class WalkthroughService {
  private active = false;

  constructor(
    private readonly server: Pick<OpenCodeServer, 'request' | 'apiVersion'>,
    private readonly ensureServerStarted: () => Promise<unknown>,
    private readonly getWorkspacePath: () => string | undefined,
    private readonly getActiveChatModel: () => ChatModelSelection | null,
    private readonly isOpenAIPro: () => Promise<boolean>,
    private readonly openReport: (content: string, title: string) => Promise<vscode.Uri>
  ) {}

  async run(request: WalkthroughRequest): Promise<void> {
    if (this.active) {
      await vscode.window.showInformationMessage(
        'A changes walkthrough is already being generated.'
      );
      return;
    }
    this.active = true;
    try {
      const source =
        request.kind === 'git'
          ? await this.readGitSource(request.sourceControl)
          : await this.readSessionSource(request);
      if (!source) return;
      if (!source.files.some((file) => file.hunks.length > 0)) {
        await vscode.window.showInformationMessage('There are no textual changes to walk through.');
        return;
      }
      // Refuse an oversized diff before spending a request on it.
      const { digest, hunkByAlias } = buildWalkthroughDigest(source.files);
      const report = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Generating changes walkthrough',
          cancellable: true,
        },
        async (_progress, token) => {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), GENERATION_TIMEOUT_MS);
          const cancellation = token.onCancellationRequested(() => controller.abort());
          try {
            return await this.generate(source, digest, hunkByAlias, controller.signal, token);
          } finally {
            clearTimeout(timeout);
            cancellation.dispose();
          }
        }
      );
      const uri = await this.openReport(report.content, `Walkthrough: ${report.title}`);
      await vscode.commands.executeCommand('markdown.showPreview', uri);
    } catch (error) {
      if (error instanceof WalkthroughCancelledError) return;
      const message = error instanceof Error ? error.message : String(error);
      if (!(error instanceof WalkthroughTooLargeError)) {
        logger.error(`Changes walkthrough failed: ${message}`);
      }
      await vscode.window.showErrorMessage(`Could not generate the walkthrough: ${message}`);
    } finally {
      this.active = false;
    }
  }

  private async generate(
    source: WalkthroughSource,
    digest: string,
    hunkByAlias: WalkthroughDigest['hunkByAlias'],
    signal: AbortSignal,
    token: vscode.CancellationToken
  ): Promise<{ content: string; title: string }> {
    await this.ensureServerStarted();
    if (token.isCancellationRequested) throw new WalkthroughCancelledError();
    if (this.server.apiVersion !== 2) {
      throw new Error('Changes walkthroughs require OpenCode v2.');
    }
    const model = await resolveHelperModel({
      configuredModel: null,
      loadSmallModel: async () =>
        asRecord(
          await this.server.request('GET', '/config', undefined, { directory: source.directory })
        )?.small_model,
      loadProviderConfig: () =>
        this.server.request('GET', '/config/providers', undefined, { directory: source.directory }),
      fallbackModel: this.getActiveChatModel(),
      isOpenAIPro: this.isOpenAIPro,
    });
    let generated: { text: string } | null;
    try {
      generated = await tryGenerateOneShot(this.server, {
        prompt: buildWalkthroughPrompt(digest, source.scopeLabel),
        model,
        directory: source.directory,
        signal,
        maxResponseBytes: MAX_RESPONSE_BYTES,
        trace: { purpose: 'walkthrough' },
      });
    } catch (error) {
      if (token.isCancellationRequested) throw new WalkthroughCancelledError();
      if (signal.aborted) throw new Error('The model took too long to answer.', { cause: error });
      throw error;
    }
    if (!generated) {
      throw new Error(
        model
          ? `${model.providerID}/${model.modelID} is unavailable for one-shot generation. Set a small model in OpenCode or pick another chat model.`
          : 'This OpenCode server has no one-shot generation API. Update OpenCode to use walkthroughs.'
      );
    }
    const walkthrough = normalizeWalkthrough(
      parseJsonObject(generated.text),
      source.files,
      hunkByAlias
    );
    const deleted = new Set(
      source.files.filter((file) => file.status === 'deleted').map((file) => file.path)
    );
    const content = renderWalkthroughMarkdown(walkthrough, source.files, {
      scopeLabel: source.scopeLabel,
      modelLabel: model ? `${model.providerID}/${model.modelID}` : null,
      generatedAt: new Date(),
      linkFor: (path, line) => {
        if (deleted.has(path)) return null;
        const absolute = isAbsolute(path)
          ? path
          : source.directory
            ? join(source.directory, path)
            : null;
        if (!absolute) return null;
        const uri = vscode.Uri.file(absolute);
        return (line && line > 0 ? uri.with({ fragment: `L${line}` }) : uri).toString();
      },
    });
    return { content, title: walkthrough.title };
  }

  private async readGitSource(
    sourceControl: vscode.SourceControl | undefined
  ): Promise<WalkthroughSource | null> {
    const api = await resolveGitApi('walk through changes');
    if (!api) return null;
    const repository = await resolveRepository(
      api,
      sourceControl,
      this.getWorkspacePath(),
      'Select a repository to walk through'
    );
    if (!repository) return null;
    await repository.status();
    const staged = await repository.diff(true);
    const unstaged = await captureRepositoryChanges(repository, 'unstaged');
    const scope = await pickGitScope(repository, staged, unstaged.patch);
    if (!scope) return null;
    const files = [
      ...(scope === 'unstaged' ? [] : parseUnifiedDiff(staged, 'staged')),
      ...(scope === 'staged' ? [] : parseUnifiedDiff(unstaged.patch, 'unstaged')),
    ];
    return {
      files,
      scopeLabel:
        scope === 'staged'
          ? 'Staged changes'
          : scope === 'unstaged'
            ? 'Unstaged changes'
            : 'All uncommitted changes',
      directory: repository.rootUri.fsPath,
    };
  }

  private async readSessionSource(
    request: Extract<WalkthroughRequest, { kind: 'session' }>
  ): Promise<WalkthroughSource | null> {
    await this.ensureServerStarted();
    const query = request.messageId ? `?messageID=${encodeURIComponent(request.messageId)}` : '';
    const value = await this.server.request(
      'GET',
      `/session/${encodeURIComponent(request.sessionId)}/diff${query}`,
      undefined,
      request.directory ? { directory: request.directory } : undefined
    );
    if (!Array.isArray(value)) throw new Error('OpenCode returned an invalid session diff.');
    const files: WalkthroughFile[] = [];
    for (const entry of value) {
      const diff = asRecord(entry);
      const path = typeof diff?.file === 'string' ? diff.file : null;
      if (!path) continue;
      if (typeof diff?.patch !== 'string') {
        throw new Error('Session walkthroughs require OpenCode v2 session diffs.');
      }
      const parsed = parseUnifiedDiff(diff.patch, 'session', path);
      // A session diff names its file outside the patch; the patch headers may be relative.
      for (const file of parsed) file.path = path;
      for (const file of parsed) for (const hunk of file.hunks) hunk.path = path;
      if (parsed.length === 0) {
        files.push({
          path,
          section: 'session',
          status: diff.status === 'added' || diff.status === 'deleted' ? diff.status : 'modified',
          additions: typeof diff.additions === 'number' ? diff.additions : 0,
          deletions: typeof diff.deletions === 'number' ? diff.deletions : 0,
          hunks: [],
          generated: false,
          note: 'No textual changes',
        });
      } else files.push(...parsed);
    }
    if (files.length === 0) {
      await vscode.window.showInformationMessage(
        request.messageId
          ? 'This reply did not change any files.'
          : 'This session has not changed any files.'
      );
      return null;
    }
    return {
      files,
      scopeLabel: request.messageId ? 'Changes in this reply' : 'Session changes',
      directory: request.directory ?? this.getWorkspacePath(),
    };
  }
}

async function pickGitScope(
  repository: GitRepository,
  staged: string,
  unstaged: string
): Promise<GitScopeItem['scope'] | null> {
  const hasStaged = staged.trim().length > 0;
  const hasUnstaged = unstaged.trim().length > 0;
  if (!hasStaged && !hasUnstaged) {
    await vscode.window.showInformationMessage(
      `There are no uncommitted changes in ${repository.rootUri.fsPath}.`
    );
    return null;
  }
  if (!hasStaged) return 'unstaged';
  if (!hasUnstaged) return 'staged';
  const picked = await vscode.window.showQuickPick<GitScopeItem>(
    [
      { label: 'Staged changes', description: 'What the next commit contains', scope: 'staged' },
      {
        label: 'Unstaged changes',
        description: 'Working tree edits and new files',
        scope: 'unstaged',
      },
      { label: 'All uncommitted changes', scope: 'all' },
    ],
    { placeHolder: 'Which changes should the walkthrough explain?' }
  );
  return picked?.scope ?? null;
}
