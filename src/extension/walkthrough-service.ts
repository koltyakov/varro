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
import { logger } from './logger';
import { parseJsonObject, tryGenerateOneShot } from './one-shot-generation';
import type { OpenCodeServer } from './server';
import {
  buildWalkthroughDigest,
  buildWalkthroughPrompt,
  normalizeWalkthrough,
  parseUnifiedDiff,
  formatTokens,
  renderWalkthroughMarkdown,
  selectWalkthroughModel,
  walkthroughDigestBudget,
  WalkthroughTooLargeError,
  type WalkthroughDigest,
  type WalkthroughFile,
} from './walkthrough';

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
    /** `varro.review.model`, as `provider/model` or `provider/model#variant`. */
    private readonly readReviewModel: () => string,
    private readonly openReport: (content: string, title: string) => Promise<vscode.Uri>
  ) {}

  async run(sourceControl?: vscode.SourceControl): Promise<void> {
    if (this.active) {
      await vscode.window.showInformationMessage(
        'A changes walkthrough is already being generated.'
      );
      return;
    }
    this.active = true;
    try {
      const source = await this.readGitSource(sourceControl);
      if (!source) return;
      const model = selectWalkthroughModel(this.readReviewModel(), this.getActiveChatModel());
      if (!source.files.some((file) => file.hunks.length > 0)) {
        await vscode.window.showInformationMessage('There are no textual changes to walk through.');
        return;
      }
      // Size the request to the model, and refuse an oversized diff before spending a request.
      const budget = walkthroughDigestBudget(await this.readContextLimit(model, source.directory));
      const { digest, hunkByAlias } = buildWalkthroughDigest(source.files, budget);
      const report = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Generating changes walkthrough (${formatTokens(digest.length)} tokens)`,
          cancellable: true,
        },
        async (_progress, token) => {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), GENERATION_TIMEOUT_MS);
          const cancellation = token.onCancellationRequested(() => controller.abort());
          try {
            return await this.generate(
              source,
              model,
              digest,
              hunkByAlias,
              controller.signal,
              token
            );
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
      if (error instanceof WalkthroughTooLargeError) {
        await vscode.window.showErrorMessage(
          `${message} Stage a subset and walk through the staged changes, or pick a model with a larger context window.`
        );
        return;
      }
      logger.error(`Changes walkthrough failed: ${message}`);
      await vscode.window.showErrorMessage(`Could not generate the walkthrough: ${message}`);
    } finally {
      this.active = false;
    }
  }

  /** The model's context window in tokens, when OpenCode reports it; best effort. */
  private async readContextLimit(
    model: ChatModelSelection | null,
    directory: string | undefined
  ): Promise<number | null> {
    if (!model) return null;
    try {
      await this.ensureServerStarted();
      const config = asRecord(
        await this.server.request('GET', '/config/providers', undefined, { directory })
      );
      const providers = Array.isArray(config?.providers) ? config.providers : [];
      const provider = providers
        .map((value) => asRecord(value))
        .find((value) => value?.id === model.providerID);
      const models = asRecord(provider?.models);
      const entry =
        asRecord(models?.[model.modelID]) ??
        Object.values(models ?? {})
          .map((value) => asRecord(value))
          .find((value) => value?.id === model.modelID);
      const context = asRecord(entry?.limit)?.context;
      return typeof context === 'number' ? context : null;
    } catch {
      return null;
    }
  }

  private async generate(
    source: WalkthroughSource,
    model: ChatModelSelection | null,
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
          ? `${model.providerID}/${model.modelID} is unavailable for one-shot generation. Pick another model, or set one with Use for reviews in the Models view.`
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
      modelLabel: model
        ? `${model.providerID}/${model.modelID}${model.variant ? ` (${model.variant})` : ''}`
        : null,
      generatedAt: new Date(),
      linkFor: (path, line) => {
        if (deleted.has(path)) return null;
        const absolute = isAbsolute(path)
          ? path
          : source.directory
            ? join(source.directory, path)
            : null;
        return absolute ? editorLink(absolute, line) : null;
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
}

/**
 * VS Code's Markdown preview drops `file:` links and renders them as text; it only adds its own
 * `vscode:` scheme to markdown-it's defaults. `vscode://file/<path>:<line>` opens the file at the
 * line, and remote windows need the `vscode-remote` form with the folder's authority.
 */
function editorLink(absolutePath: string, line: number | null): string | null {
  const scheme = vscode.env.uriScheme;
  if (scheme !== 'vscode' && scheme !== 'vscode-insiders') return null;
  const path = vscode.Uri.file(absolutePath).path;
  const authority = vscode.workspace.workspaceFolders?.find(
    (folder) => folder.uri.scheme === 'vscode-remote'
  )?.uri.authority;
  const target = authority ? `vscode-remote/${authority}${path}` : `file${path}`;
  return `${scheme}://${encodeURI(target)}${line && line > 0 ? `:${line}` : ''}`;
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
