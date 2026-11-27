import type { Page } from '@playwright/test';
import type { BackgroundProcess } from '../../src/shared/background-process';
import type { InitialWebviewState, QueuedMessageSnapshot } from '../../src/shared/protocol';
import type { SessionGoal } from '../../src/shared/session-goal';
import type { MessageEntry, Part, Session, SessionStatus } from '../../src/webview/types';
import { waitForHarnessStartup } from './helpers';

export type ComposerBlockFixture = {
  /** Use the grouped tab menu, which is the default setting. */
  grouped?: boolean;
  queue?: number;
  goal?: SessionGoal['status'];
  todos?: { completed: number; total: number };
  background?: number;
  /** Running subagent sessions the composer is waiting for. */
  subagents?: number;
  files?: number;
  rewind?: boolean;
  theme?: 'dark' | 'light';
};

type PlaybackCapture = {
  session: Session;
  initialMessages: MessageEntry[];
  status?: SessionStatus;
  goal?: SessionGoal;
  childSessions?: { session: Session; status: SessionStatus }[];
};
type ToolInput =
  | { todos: { id: string; content: string; status: string; priority: string }[] }
  | { path: string; additions: number; deletions: number };

const SESSION_ID = 'ses_composer_blocks';
const QUEUE_TEXT = [
  'When done, commit the changes. Wait when CI succeeds and report back',
  'Then bump the patch version and update the changelog',
  'Run the e2e suite once more on Windows',
  'Summarize what changed for the release notes',
];
const TODO_TEXT = [
  'Add the grouped composer block setting',
  'Render a tab for each visible block',
  'Keep hidden blocks mounted while another tab is active',
  'Cover tab switching with an e2e test',
  'Capture screenshots for the design review',
  'Update the settings documentation',
];
const FILES = [
  ['src/webview/components/chat-input/ComposerBlockGroup.tsx', 168, 0],
  ['src/webview/components/ChatInput.tsx', 142, 69],
  ['src/webview/styles/composer.css', 109, 1],
  ['src/webview/components/ChangedFilesList.tsx', 22, 2],
  ['src/webview/components/chat-input/SessionGoalRow.tsx', 14, 1],
  ['package.json', 5, 0],
  ['src/shared/protocol.ts', 1, 0],
  ['e2e/tests/composer-block-group.spec.ts', 120, 0],
] as const;
const SUBAGENTS = ['Explore composer styles', 'Review tab overflow', 'Check scroll reserves'];
const SERVICES = [
  'npm run dev -- --port 5173',
  'python3 -m http.server 8080',
  'npm run test:watch',
];

export async function openComposerBlocks(page: Page, options: ComposerBlockFixture) {
  const created = Date.now() - 60_000;
  const session: Session = {
    id: SESSION_ID,
    projectID: 'project-test',
    directory: '/workspace',
    title: 'Group composer blocks',
    version: '1.0.0',
    time: { created, updated: created },
  };
  if (options.rewind) session.revert = { messageID: 'msg_blocks_3_rewound' };
  const toolParts: Part[] = [];
  if (options.todos) {
    const { completed, total } = options.todos;
    const todos = TODO_TEXT.slice(0, total).map((content, index) => ({
      id: `todo-${index + 1}`,
      content,
      status: index < completed ? 'completed' : index === completed ? 'in_progress' : 'pending',
      priority: 'medium',
    }));
    toolParts.push(toolPart('todo', 'todowrite', { todos }, JSON.stringify(todos)));
  }
  for (const [index, [path, additions, deletions]] of FILES.slice(
    0,
    options.files ?? 0
  ).entries()) {
    toolParts.push(toolPart(`edit-${index}`, 'edit', { path, additions, deletions }, 'Edited'));
  }
  const messages: MessageEntry[] = [
    userMessage('msg_blocks_1_user', 'Group the blocks above the composer behind tabs.', created),
    {
      info: {
        id: 'msg_blocks_2_assistant',
        sessionID: SESSION_ID,
        role: 'assistant',
        parentID: 'msg_blocks_1_user',
        time: { created: created + 1_000, completed: created + 5_000 },
        providerID: 'anthropic',
        modelID: 'claude-opus-5-5',
        mode: 'build',
        agent: 'build',
        path: { cwd: '/workspace', root: '/workspace' },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        finish: 'stop',
      },
      parts: [
        ...toolParts,
        textPart(
          'msg_blocks_2_assistant',
          'Grouped the composer blocks and kept each one mounted.'
        ),
      ],
    },
  ];
  if (options.rewind) {
    messages.push(userMessage('msg_blocks_3_rewound', 'Also rename the setting.', created + 6_000));
  }
  const goal: SessionGoal | undefined = options.goal
    ? {
        id: 'goal-blocks',
        objective: 'Ship grouped composer blocks behind an opt-in setting',
        status: options.goal,
        rounds: 3,
        maxRounds: 50,
        updatedAt: created,
      }
    : undefined;
  const processes: BackgroundProcess[] = SERVICES.slice(0, options.background ?? 0).map(
    (command, index) => ({
      id: `service-${index + 1}`,
      status: 'running',
      service: true,
      command,
      cwd: '/workspace',
      pid: 4100 + index,
      time: { started: created + index },
    })
  );
  const queuedMessages: QueuedMessageSnapshot[] = QUEUE_TEXT.slice(0, options.queue ?? 0).map(
    (text, index) => ({
      id: `queued-${index + 1}`,
      sessionId: SESSION_ID,
      text,
      paused: index === 0,
      droppedFiles: [],
      clipboardImages: [],
      terminalSelection: null,
    })
  );
  const capture: PlaybackCapture = { session, initialMessages: messages };
  // Keep queued messages waiting instead of dispatching them to an idle session.
  if ((options.queue ?? 0) > 0) capture.status = { type: 'busy' };
  if (goal) capture.goal = goal;
  if ((options.subagents ?? 0) > 0) {
    capture.childSessions = SUBAGENTS.slice(0, options.subagents).map((title, index) => ({
      session: {
        id: `ses_composer_blocks_child_${index + 1}`,
        projectID: 'project-test',
        directory: '/workspace',
        parentID: SESSION_ID,
        title,
        version: '1.0.0',
        time: { created: created + index, updated: created + index },
      },
      status: { type: 'busy' },
    }));
  }
  const overrides: Partial<InitialWebviewState> = {
    groupComposerBlocks: options.grouped ?? true,
    showChangedFiles: true,
    queuedMessages,
  };
  await page.addInitScript(
    ({ capture: playback, processes: fixtureProcesses, overrides: stateOverrides }) => {
      // SAFETY: The isolated harness reads these fixtures before it mounts the webview.
      const host = window as Window & {
        varroPlaybackCapture?: unknown;
        varroBackgroundProcessFixture?: unknown;
        varroInitialStateOverrides?: unknown;
      };
      host.varroPlaybackCapture = playback;
      host.varroInitialStateOverrides = stateOverrides;
      if (fixtureProcesses.length > 0) {
        host.varroBackgroundProcessFixture = {
          sessionID: playback.session.id,
          processes: fixtureProcesses,
          output: {},
        };
      }
    },
    {
      capture,
      processes,
      overrides,
    }
  );
  await page.goto(
    `/e2e/harness/index.html?scenario=session-playback&theme=${options.theme ?? 'dark'}`
  );
  await waitForHarnessStartup(page);
}

function userMessage(id: string, text: string, created: number): MessageEntry {
  return {
    info: {
      id,
      sessionID: SESSION_ID,
      role: 'user',
      time: { created },
      agent: 'build',
      model: { providerID: 'anthropic', modelID: 'claude-opus-5-5' },
    },
    parts: [textPart(id, text)],
  };
}

function textPart(messageID: string, text: string): Part {
  return { id: `${messageID}-text`, messageID, sessionID: SESSION_ID, type: 'text', text };
}

function toolPart(id: string, tool: string, input: ToolInput, output: string): Part {
  return {
    id: `part-${id}`,
    messageID: 'msg_blocks_2_assistant',
    sessionID: SESSION_ID,
    type: 'tool',
    callID: `call-${id}`,
    tool,
    state: {
      status: 'completed',
      input,
      output,
      title: 'path' in input ? input.path : 'Track tasks',
      metadata: {},
      time: { start: 0, end: 1 },
    },
  };
}
