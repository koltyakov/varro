import type { CompletionItem, MentionCompletionItem } from './CompletionMenu';
import type { Agent, Session } from '../../types';
import type { DroppedFile, WorkspaceFolderContext } from '../../../shared/protocol';
import { normalizeSessionTitle } from '../../../shared/session-title';
import { getWorkspaceFolderLabel } from '../../../shared/workspace-folders';

export const SKILLS_COMMAND_NAME = 'skills';

export type MentionCompletionMeta = {
  showFileSearchHint: boolean;
};

type AgentMentionCompletionItem = Extract<MentionCompletionItem, { type: 'agent' }>;
type FileMentionCompletionItem = Extract<MentionCompletionItem, { type: 'file' }>;

type MentionAgentEntry = {
  item: AgentMentionCompletionItem;
  normalizedName: string;
  normalizedDescription: string;
};

type MentionFileEntry = {
  item: FileMentionCompletionItem;
  normalizedPath: string;
};

export type MentionCompletionSource = {
  agentEntries: MentionAgentEntry[];
  fileEntries: MentionFileEntry[];
  exactAgentNames: ReadonlySet<string>;
  exactFilePaths: ReadonlySet<string>;
};

export type CompletionSelection =
  | { type: 'set-slash'; value: string }
  | { type: 'run-slash'; value: string }
  | { type: 'apply-mention'; value: string; file?: DroppedFile; session?: Session };

export function getActiveCompletion(text: string, cursor: number) {
  if (cursor < 0 || cursor > text.length) return null;

  const prefix = text.slice(0, cursor);
  const tokenStart = Math.max(prefix.lastIndexOf(' '), prefix.lastIndexOf('\n')) + 1;
  const token = prefix.slice(tokenStart);
  if (token.startsWith('/')) {
    return {
      type: 'slash' as const,
      query: token.slice(1),
      start: tokenStart,
      end: cursor,
    };
  }

  const skillMatch = prefix.match(
    new RegExp(`(?:^|\\s)(/${SKILLS_COMMAND_NAME}(?:\\s+[^\\s]*)?)$`, 'i')
  );
  if (skillMatch) {
    const value = skillMatch[1]!;
    return {
      type: 'slash' as const,
      query: value.slice(1),
      start: cursor - value.length,
      end: cursor,
    };
  }

  if (token.startsWith('&')) {
    return {
      type: 'session' as const,
      query: token.slice(1),
      start: tokenStart,
      end: cursor,
    };
  }
  if (!token.startsWith('@')) return null;

  return {
    type: 'mention' as const,
    query: token.slice(1),
    start: tokenStart,
    end: cursor,
  };
}

export function applySlashCompletion(
  text: string,
  completion: { query: string; start: number; end: number },
  value: string
) {
  if (value === `/${SKILLS_COMMAND_NAME} `) {
    const suffix = text.slice(completion.end).replace(/^[ \t]+/, '');
    const nextValue = `${text.slice(0, completion.start)}${value}${suffix}`;
    return {
      value: nextValue,
      cursor: completion.start + value.length,
    };
  }

  if (completion.query.toLowerCase().startsWith(`${SKILLS_COMMAND_NAME} `)) {
    const before = text.slice(0, completion.start).trimEnd();
    const after = text.slice(completion.end).trimStart();
    const args = before && after ? `${before} ${after}` : before || after;
    const nextValue = args ? `${value} ${args}` : value;
    return { value: nextValue, cursor: nextValue.length };
  }

  return { value, cursor: value.length };
}

export function getSessionCompletionItems(
  sessions: Session[],
  workspaceFolders: readonly WorkspaceFolderContext[] = []
): MentionCompletionItem[] {
  return sessions.slice(0, 10).map((session) => ({
    key: `session:${session.id}`,
    type: 'session',
    label: normalizeSessionTitle(session.title) || 'Untitled',
    detail:
      workspaceFolders.length > 1
        ? session.workspaceScope === 'workspace'
          ? 'Workspace'
          : (getWorkspaceFolderLabel(session.directory, workspaceFolders) ?? '')
        : '',
    value: `session:${session.id} `,
    session,
  }));
}

export function normalizeSessionLookupQuery(query: string) {
  return query
    .trim()
    .replace(/^sessions?:/i, '')
    .toLowerCase();
}

export function getSessionReferenceIds(text: string) {
  return Array.from(text.matchAll(/(?:^|\s)session:([a-z0-9_-]+)/gi), (match) => match[1]!);
}

export function getLeadingSlashCommand(text: string) {
  const trimmed = text.trim();
  const match = trimmed.match(/^\/([^\s]+)(?:\s+(.*))?$/);
  if (!match) return null;

  return {
    name: match[1]!.toLowerCase(),
    args: match[2]?.trim() || '',
  };
}

export function getCompletionSelection(
  completion: ReturnType<typeof getActiveCompletion> | null,
  item: CompletionItem | undefined,
  confirm = false
): CompletionSelection | null {
  if (!completion || !item) return null;

  if (completion.type === 'slash') {
    if (!('name' in item)) return null;
    if (completion.query.toLowerCase().startsWith(`${SKILLS_COMMAND_NAME} `)) {
      return {
        type: 'set-slash',
        value: `/${item.name}`,
      };
    }
    if (item.name === SKILLS_COMMAND_NAME) {
      return { type: 'set-slash', value: `/${SKILLS_COMMAND_NAME} ` };
    }
    const normalizedQuery = completion.query.trim().toLowerCase();
    const selectsExactCommand =
      normalizedQuery === item.name.toLowerCase() ||
      item.aliases.some((alias) => normalizedQuery === alias.toLowerCase());
    return {
      type: confirm || selectsExactCommand ? 'run-slash' : 'set-slash',
      value: `/${item.name}`,
    };
  }

  if (!('value' in item)) return null;

  const file = item.type === 'file' ? item.file : undefined;
  const session = item.type === 'session' ? item.session : undefined;

  return {
    type: 'apply-mention',
    value: item.value,
    file,
    session,
  };
}

export function getAgentBadgeLine(agent: Agent) {
  const badges: string[] = [];
  badges.push(agent.mode === 'subagent' ? 'Subagent' : 'Primary');
  const editMode = getAgentPermissionMode(agent, 'edit', 'deny');
  if (editMode === 'allow') badges.push('Can edit');
  else if (editMode === 'ask') badges.push('Edits ask');
  else badges.push('No edits');

  const bashMode = getAgentPermissionMode(agent, 'bash', 'allow');
  if (bashMode === 'deny') badges.push('No bash');
  else if (bashMode === 'ask') badges.push('Bash asks');
  else badges.push('Bash allowed');

  return badges.join(' · ');
}

function getAgentPermissionMode(
  agent: Agent,
  permission: string,
  fallback: 'ask' | 'allow' | 'deny'
) {
  if (Array.isArray(agent.permission)) {
    return (
      agent.permission.find((rule) => rule.permission === permission && rule.pattern === '*')
        ?.action ??
      agent.permission.find((rule) => rule.permission === permission)?.action ??
      fallback
    );
  }
  if (permission === 'edit') return agent.permission.edit ?? fallback;
  if (permission === 'bash') return agent.permission.bash?.['*'] ?? fallback;
  return fallback;
}

export function getMentionCompletionItems({
  rawQuery,
  agents,
  files,
  source,
  meta,
}: {
  rawQuery: string;
  agents?: Agent[];
  files?: DroppedFile[];
  source?: MentionCompletionSource;
  meta?: MentionCompletionMeta;
}): MentionCompletionItem[] {
  const mentionSource =
    source ?? createMentionCompletionSource({ agents: agents ?? [], files: files ?? [] });
  const query = rawQuery.toLowerCase();
  const exactAgentMatch = mentionSource.exactAgentNames.has(query);
  const exactFileMatch = mentionSource.exactFilePaths.has(normalizeMentionPath(rawQuery));
  if (query && (exactAgentMatch || exactFileMatch)) return [];

  const agentItems = mentionSource.agentEntries
    .filter((agent) => {
      if (!query) return true;
      return agent.normalizedName.includes(query) || agent.normalizedDescription.includes(query);
    })
    .map((agent) => agent.item);

  const fileItems = (rawQuery ? mentionSource.fileEntries : []).map((file) => file.item);

  if (!rawQuery && !meta?.showFileSearchHint) {
    return agentItems.slice(0, 10);
  }

  return [...agentItems, ...fileItems].slice(0, 10);
}

export function createMentionCompletionSource({
  agents,
  files,
}: {
  agents: Agent[];
  files: DroppedFile[];
}): MentionCompletionSource {
  const exactAgentNames = new Set<string>();
  const exactFilePaths = new Set<string>();

  const agentEntries = agents.map((agent) => {
    const normalizedName = agent.name.toLowerCase();
    exactAgentNames.add(normalizedName);

    return {
      item: {
        key: `agent:${agent.name}`,
        type: 'agent',
        label: agent.name,
        detail: agent.description || getAgentBadgeLine(agent),
        value: `@${agent.name} `,
      },
      normalizedName,
      normalizedDescription: agent.description?.toLowerCase() || '',
    } satisfies MentionAgentEntry;
  });

  const fileEntries = files.map((file) => {
    const normalizedPath = normalizeMentionPath(file.relativePath);
    exactFilePaths.add(normalizedPath);

    return {
      item: {
        key: `file:${file.path}`,
        type: 'file',
        label: file.relativePath,
        detail: file.type === 'directory' ? 'Folder' : 'Workspace file',
        value:
          file.type === 'directory'
            ? `@${formatMentionPath(file.relativePath)}/`
            : `@${formatMentionPath(file.relativePath)} `,
        file,
      },
      normalizedPath,
    } satisfies MentionFileEntry;
  });

  return {
    agentEntries,
    fileEntries,
    exactAgentNames,
    exactFilePaths,
  };
}

export function shouldRequestMentionFileSearch(previousQuery: string, nextQuery: string) {
  return previousQuery !== nextQuery;
}

function normalizeMentionPath(value: string) {
  return value.replace(/^@/, '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function formatMentionPath(value: string) {
  return value.replace(/^@/, '').replace(/\\/g, '/').replace(/\/+$/, '');
}

export function shouldPadInlineInsertion(value: string | undefined) {
  return !!value && !/\s/.test(value);
}

export function getInlineInsertionSuffix(text: string, selectionEnd: number) {
  return selectionEnd >= text.length || shouldPadInlineInsertion(text[selectionEnd]) ? ' ' : '';
}

export function getMentionInsertionTrailingSpace(value: string, after: string | undefined) {
  if (value.endsWith(' ') || value.endsWith('\n')) return '';
  return !after || (after !== ' ' && after !== '\n') ? ' ' : '';
}
