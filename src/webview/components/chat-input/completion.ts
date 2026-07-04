import type { CompletionItem, MentionCompletionItem } from './CompletionMenu';
import type { Agent } from '../../types';
import type { DroppedFile } from '../../../shared/protocol';

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
  | { type: 'apply-mention'; value: string; file?: DroppedFile };

export function getActiveCompletion(text: string, cursor: number) {
  if (cursor < 0 || cursor > text.length) return null;

  const prefix = text.slice(0, cursor);
  const slashMatch = prefix.match(/^\/([^\s]*)$/);
  if (slashMatch) {
    return {
      type: 'slash' as const,
      query: slashMatch[1] || '',
      start: 0,
      end: cursor,
    };
  }

  const skillMatch = prefix.match(new RegExp(`^/${SKILLS_COMMAND_NAME}(?:\\s+([^\\s]*))?$`, 'i'));
  if (skillMatch) {
    return {
      type: 'slash' as const,
      query: prefix.slice(1),
      start: 0,
      end: cursor,
    };
  }

  const tokenStart = Math.max(prefix.lastIndexOf(' '), prefix.lastIndexOf('\n')) + 1;
  const token = prefix.slice(tokenStart);
  if (!token.startsWith('@')) return null;

  return {
    type: 'mention' as const,
    query: token.slice(1),
    start: tokenStart,
    end: cursor,
  };
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
    return {
      type: confirm ? 'run-slash' : 'set-slash',
      value: `/${item.name}`,
    };
  }

  if (!('value' in item)) return null;

  const file = item.type === 'file' ? item.file : undefined;

  return {
    type: 'apply-mention',
    value: item.value,
    file,
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

  return [...fileItems, ...agentItems].slice(0, 10);
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
        label: `@${agent.name}`,
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
        label: `@${file.relativePath}`,
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
