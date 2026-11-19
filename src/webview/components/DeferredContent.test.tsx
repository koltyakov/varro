import { flush as flushSolid, createSignal, createStore } from 'solid-js';
import { storePath } from '@solidjs/signals';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render } from '@solidjs/web';
import type { ServerEvent, WebviewMessage } from '../../shared/protocol';
import type { UnknownRecord } from '../../shared/type-utils';
import type { AssistantMessage, ReasoningPart, ToolPart } from '../types';
import { createDeferredPart } from '../lib/deferred-content';
import { StreamingToolContent } from '../../extension/streaming-tool-content';
import { createProjectedSessionEventHandler } from '../hooks/session/session-projected-events';
import { cleanupBridge, initializeBridge } from '../lib/bridge';
import {
  getMessageById,
  getMessagePartById,
  resetDefaultAppState,
  setShowFileDiffs,
  setShowThinking,
  setState,
  state,
} from '../lib/state';
import { editingMessage, resetMessageEditState } from '../lib/message-edit-state';
import { resetToolCallExpansionState } from '../lib/tool-call-expansion-state';
import { fixture } from '../test-fixtures';
import { InlineMessageImage } from './InlineMessageImage';
import { ImagePreviewOverlay } from './ImagePreview';
import { MessagePart } from './MessagePart';
import { ToolCall } from './ToolCall';
import { Message } from './Message';

let container: HTMLDivElement;
let dispose: (() => void) | undefined;
let requests: ApiRequestPayload[];
type ApiRequestPayload = Extract<WebviewMessage, { type: 'api/request' }>['payload'];
const path = '/session/s1/message/m1/part/p1';

beforeEach(() => {
  initializeBridge();
  resetDefaultAppState();
  flushSolid();
  resetToolCallExpansionState();
  flushSolid();
  resetMessageEditState();
  flushSolid();
  setShowThinking(true);
  flushSolid();
  requests = [];
  window.__sendToExtension = (message) => {
    const request = fixture<WebviewMessage>(message);
    if (request.type === 'api/request') requests.push(request.payload);
  };
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  dispose?.();
  flushSolid();
  dispose = undefined;
  cleanupBridge();
  flushSolid();
  resetMessageEditState();
  flushSolid();
  delete window.__sendToExtension;
  document.body.replaceChildren();
  flushSolid();
  vi.unstubAllGlobals();
});

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- The bridge fixture deliberately exercises its untrusted response boundary.
function respond(request: ApiRequestPayload, data: unknown, error?: string) {
  window.dispatchEvent(
    new MessageEvent('message', {
      data: { type: 'api/response', payload: { id: request.id, data, error } },
    })
  );
}

it('requests only a thumbnail near the viewport and the original only when the preview opens', async () => {
  let intersect: IntersectionObserverCallback | undefined;
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(callback: IntersectionObserverCallback) {
        intersect = callback;
      }
      observe() {}
      disconnect() {}
    }
  );
  const [open, setOpen] = createSignal(false);
  const image = { url: `varro-content:${path}`, alt: 'Shot', title: 'shot.png' };
  dispose = render(
    () => (
      <>
        <InlineMessageImage src={image.url} alt={image.alt} />
        <ImagePreviewOverlay image={open() ? image : null} onClose={() => setOpen(false)} />
      </>
    ),
    container
  );
  flushSolid();
  await Promise.resolve();
  flushSolid();
  expect(requests).toHaveLength(0);
  intersect!(
    [fixture<IntersectionObserverEntry>({ isIntersecting: true })],
    fixture<IntersectionObserver>({})
  );
  await vi.waitFor(() => expect(requests).toHaveLength(1));
  flushSolid();
  expect(requests[0]?.path).toBe(`${path}?view=thumbnail`);
  respond(requests[0]!, { url: 'data:image/png;base64,THUMBNAIL' });
  await vi.waitFor(() =>
    expect(container.querySelector('img')?.getAttribute('src')).toBe(
      'data:image/png;base64,THUMBNAIL'
    )
  );
  flushSolid();
  setOpen(true);
  flushSolid();
  await vi.waitFor(() => expect(requests).toHaveLength(2));
  flushSolid();
  expect(requests[1]?.path).toBe(path);
  respond(requests[1]!, { type: 'file', url: 'data:image/png;base64,ORIGINAL' });
  await vi.waitFor(() =>
    expect(document.querySelector('.chat-image-preview-img')?.getAttribute('src')).toBe(
      'data:image/png;base64,ORIGINAL'
    )
  );
  flushSolid();
  expect(container.querySelector('.chat-image-img')?.getAttribute('src')).toBe(
    'data:image/png;base64,THUMBNAIL'
  );
});

it('loads thinking only when expanded, reports failures, and retries without showing a partial transcript', async () => {
  const part: ReasoningPart = {
    id: 'p1',
    sessionID: 's1',
    messageID: 'm1',
    type: 'reasoning',
    text: '**Checking**\n\nSummary',
    time: { start: 1, end: 2 },
    deferred: path,
  };
  dispose = render(() => <MessagePart part={part} />, container);
  flushSolid();
  expect(requests).toHaveLength(0);
  container.querySelector<HTMLButtonElement>('.thinking-header')!.click();
  flushSolid();
  expect(requests).toHaveLength(1);
  expect(container.textContent).toContain('Loading thinking');
  respond(requests[0]!, undefined, 'Detail request failed');
  await vi.waitFor(() => expect(container.querySelector('[role="alert"]')).not.toBeNull());
  flushSolid();
  container.querySelector<HTMLButtonElement>('[role="alert"] button')!.click();
  flushSolid();
  expect(requests).toHaveLength(2);
  respond(requests[1]!, {
    ...part,
    deferred: undefined,
    text: '**Checking**\n\nThe complete thinking transcript.',
  });
  await vi.waitFor(() =>
    expect(container.textContent).toContain('The complete thinking transcript.')
  );
  flushSolid();
  container.querySelector<HTMLButtonElement>('.thinking-header')!.click();
  flushSolid();
  expect(container.querySelector('.thinking-content')).toBeNull();
  expect(part.text).toBe('**Checking**\n\nSummary');
});

it('requests the completed path once when a running tool becomes deferred with no further update', async () => {
  const running: ToolPart = {
    id: 'p1',
    messageID: 'm1',
    sessionID: 's1',
    type: 'tool',
    tool: 'bash',
    callID: 'c1',
    state: { status: 'running', input: {}, time: { start: 1 } },
  };
  const [part, setPart] = createSignal<ToolPart>(running);
  let readPart: (() => ToolPart) | undefined;
  dispose = render(() => {
    const details = createDeferredPart(part, () => true);
    readPart = details.part;
    return null;
  }, container);
  flushSolid();
  const summary: ToolPart = {
    ...running,
    deferred: path,
    state: {
      status: 'completed',
      input: {},
      title: 'done',
      metadata: {},
      output: 'summary',
      time: { start: 1, end: 2 },
    },
  };
  setPart(summary);
  flushSolid();
  await Promise.resolve();
  expect(requests.map((r) => r.path)).toEqual([path]);
  respond(requests[0]!, { ...summary, state: { ...summary.state, output: 'full' } });
  await vi.waitFor(() => expect(readPart?.().state).toMatchObject({ output: 'full' }));
  expect(requests.map((r) => r.path)).toEqual([path]);
});

it.each(['replace', 'disable', 'dispose'] as const)(
  'does not start a stale deferred fetch after %s before its first microtask',
  async (mode) => {
    const original: ReasoningPart = {
      id: 'p1',
      messageID: 'm1',
      sessionID: 's1',
      type: 'reasoning',
      text: '',
      time: { start: 1, end: 2 },
    };
    const [part, setPart] = createSignal<ReasoningPart>(original);
    const [enabled, setEnabled] = createSignal(true);
    dispose = render(() => {
      createDeferredPart(part, enabled);
      return null;
    }, container);
    flushSolid();
    setPart({ ...original, deferred: path });
    flushSolid();
    const before = requests.length;
    expect(before).toBe(0);
    if (mode === 'replace') setPart({ ...original, deferred: path + '-new' });
    else if (mode === 'disable') setEnabled(false);
    else {
      dispose();
      dispose = undefined;
    }
    await Promise.resolve();
    await Promise.resolve();
    flushSolid();
    expect(requests.slice(before).map((r) => r.path)).toEqual(
      mode === 'replace' ? [path + '-new'] : []
    );
  }
);

it('fetches full tool input and output on expansion', async () => {
  const part: ToolPart = {
    id: 'p1',
    sessionID: 's1',
    messageID: 'm1',
    type: 'tool',
    tool: 'bash',
    callID: 'call-1',
    deferred: path,
    state: {
      status: 'completed',
      input: { command: 'npm test' },
      title: 'Run tests',
      output: 'Summary',
      metadata: {},
      time: { start: 1, end: 2 },
    },
  };
  dispose = render(() => <ToolCall part={part} />, container);
  flushSolid();
  expect(requests).toHaveLength(0);
  container.querySelector<HTMLButtonElement>('[aria-expanded="false"]')!.click();
  flushSolid();
  expect(requests).toHaveLength(1);
  expect(container.textContent).toContain('Loading tool details');
  respond(requests[0]!, {
    ...part,
    deferred: undefined,
    state: { ...part.state, output: 'Full test output, including the final result.' },
  });
  await vi.waitFor(() => expect(container.textContent).toContain('including the final result.'));
  flushSolid();
});

it('acquires the selected completed edit detail while the projected stream is paused', async () => {
  const messageID = 'msg_1e6a277b9001WB6ZwmZ102jLTi';
  const callID = 'call_1f47779630b847e79792e307';
  const directory = '/replay';
  const files = ['bom', 'base64', 'encode'].map((name) => ({
    id: name === 'bom' ? callID : `call_${name}`,
    path: `packages/util/src/${name}.test.ts`,
  }));
  const currentPath = (id: string) =>
    `/session/s1/message/${messageID}/part/${id}?directory=%2Freplay`;
  setState(
    storePath('messages', [
      {
        info: fixture<AssistantMessage>({
          id: messageID,
          sessionID: 's1',
          role: 'assistant',
          time: { created: 1 },
          path: { cwd: directory, root: directory },
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
        parts: [],
      },
    ])
  );
  setShowFileDiffs(false);
  flushSolid();
  const entry = () => state.messages[0]!;
  const projection = new StreamingToolContent();
  const handle = createProjectedSessionEventHandler({
    isSessionInActiveTree: () => true,
    getMessages: () => state.messages,
    findAssistantMessage: (_, id) => (id ? getMessageById(id) : null),
    findPart: getMessagePartById,
    scheduleActiveMessageSync: () => {
      throw new Error('Unexpected message sync');
    },
    syncTodosFromMessages: () => {},
  });
  const emit = (stage: string, id: string, fields: UnknownRecord) => {
    const projected = projection.project(
      fixture<ServerEvent>({
        type: `session.next.tool.${stage}`,
        workspaceDirectory: directory,
        properties: { sessionID: 's1', assistantMessageID: messageID, callID: id, ...fields },
      })
    );
    expect(handle(projected.type, projected.properties!)).toBe(true);
  };
  for (const { id } of files) emit('input.started', id, { name: 'edit' });
  flushSolid();
  dispose = render(() => <Message info={entry().info} parts={entry().parts} />, container);
  flushSolid();
  const summaryFields = (id: string, filePath: string) => ({
    deferred: `/session/original/message/${messageID}/part/${id}?directory=original`,
    deferredFiles: [{ kind: 'edited', path: filePath, dedupeKey: `edited:${filePath}` }],
  });
  const fullPatch = (filePath: string) =>
    `Index: ${filePath}\n${'='.repeat(67)}\n--- ${filePath}\n+++ ${filePath}\n@@ -39,4 +39,12 @@\n` +
    [
      '   expect(Bom.has(Uint8Array.of(0xef, 0xbb, 0xbf))).toBe(true)',
      '   expect(Bom.has(Uint8Array.of(0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf))).toBe(true)',
      '   expect(Bom.has(Uint8Array.of(0x61, 0xef, 0xbb, 0xbf))).toBe(false)',
      ' })',
      '+',
      '+test("decodeBytes decodes UTF-8 including astral characters and reports BOM presence", () => {',
      '+  const encoder = new TextEncoder()',
      '+  const text = "a\\u{1F600}\\u00e9"',
      '+  expect(Bom.decodeBytes(encoder.encode("\\uFEFF" + text))).toEqual({ bom: true, text })',
      '+  expect(Bom.decodeBytes(encoder.encode(text))).toEqual({ bom: false, text })',
      '+  expect(Bom.join(text, true)).toBe("\\uFEFF" + text)',
      '+})',
      '',
    ].join('\r\n');
  expect(fullPatch(files[0]!.path)).toHaveLength(818);
  for (const { id, path: filePath } of files) {
    const input = { path: filePath, newString: 'x'.repeat(512), oldString: 'before' };
    emit('input.ended', id, { ...summaryFields(id, filePath), text: JSON.stringify(input) });
    emit('called', id, { ...summaryFields(id, filePath), input });
  }
  flushSolid();
  for (const { id, path: filePath } of [files[1]!, files[0]!, files[2]!]) {
    emit('success', id, {
      ...summaryFields(id, filePath),
      content: [{ type: 'text', text: 'Edited' }],
      structured: {
        files: [
          {
            file: filePath,
            patch: fullPatch(filePath).slice(0, 512),
            status: 'modified',
            additions: 8,
            deletions: 0,
          },
        ],
      },
    });
  }
  flushSolid();
  const part = entry().parts.find((p) => p.id === callID);
  if (part?.type !== 'tool' || part.state.status !== 'completed')
    throw new Error('Missing completed edit');
  expect(requests).toHaveLength(0);
  setShowFileDiffs(true);
  flushSolid();
  await Promise.resolve();
  const toggle = container.querySelector<HTMLButtonElement>(
    '[aria-label="Expand changes in bom.test.ts"]'
  );
  expect(toggle).not.toBeNull();
  toggle!.click();
  flushSolid();
  const viewport = () =>
    document.querySelector('[aria-label="All changes in packages/util/src/bom.test.ts"]');
  const overlay = viewport();
  const lines = () =>
    Array.from(viewport()!.querySelectorAll('.diff-view-line-number'), (n) => n.textContent);
  expect(lines()).toEqual(['39', '40', '41', '42', '43', '44']);
  expect({
    mountedRoute: part.deferred,
    reads: requests.map(({ method, path: requestPath }) => `${method} ${requestPath}`).toSorted(),
  }).toEqual({
    mountedRoute: currentPath(callID),
    reads: files.map(({ id }) => `GET ${currentPath(id)}`).toSorted(),
  });
  const selected = requests.find((r) => r.path === currentPath(callID))!;
  respond(selected, {
    ...part,
    deferred: undefined,
    state: {
      ...part.state,
      deferredFiles: undefined,
      metadata: {
        files: [{ file: files[0]!.path, patch: fullPatch(files[0]!.path), status: 'modified' }],
      },
    },
  });
  await vi.waitFor(() =>
    expect(lines()).toEqual(Array.from({ length: 12 }, (_, i) => String(39 + i)))
  );
  expect(viewport()).toBe(overlay);
  expect(container.querySelector('[aria-label="Collapse changes in bom.test.ts"]')).toBe(toggle);
  // A completed response must not invalidate its own owner on the next refresh interval.
  await new Promise((resolve) => setTimeout(resolve, 125));
  expect(requests).toHaveLength(3);
});

it('retains loaded inline diffs across lightweight core transitions', async () => {
  setShowFileDiffs(true);
  flushSolid();
  const [lightweight, setLightweight] = createSignal(false);
  const part: ToolPart = {
    id: 'p1',
    sessionID: 's1',
    messageID: 'm1',
    type: 'tool',
    tool: 'edit',
    callID: 'call-1',
    deferred: path,
    state: {
      status: 'completed',
      input: { filePath: 'src/example.ts' },
      output: 'Edited',
      title: 'Edit',
      metadata: {},
      time: { start: 1, end: 2 },
    },
  };
  dispose = render(() => <ToolCall part={part} lightweight={lightweight()} />, container);
  flushSolid();
  expect(requests).toHaveLength(1);
  respond(requests[0]!, {
    ...part,
    deferred: undefined,
    state: {
      ...part.state,
      input: {
        filePath: 'src/example.ts',
        oldString: 'const oldValue = 1;',
        newString: 'const newValue = 2;',
      },
    },
  });
  await vi.waitFor(() => expect(container.querySelector('.diff-view-widget')).not.toBeNull());
  flushSolid();
  const diff = container.querySelector('.diff-view-widget');
  for (const value of [true, false, true, false]) {
    setLightweight(value);
    flushSolid();
    await Promise.resolve();
    flushSolid();
    expect(container.querySelector('.diff-view-widget')).toBe(diff);
    expect(container.textContent).toContain('newValue');
    expect(requests).toHaveLength(1);
  }
  setShowFileDiffs(false);
  flushSolid();
  expect(container.querySelector('.diff-view-widget')).toBeNull();
});

it('keeps streaming summaries local, coalesces open-detail reads, and releases them on collapse', async () => {
  const [part, setPart] = createStore<ToolPart>({
    id: 'p1',
    sessionID: 's1',
    messageID: 'm1',
    type: 'tool',
    tool: 'bash',
    callID: 'call-1',
    deferred: path,
    state: {
      status: 'running',
      input: { command: 'npm test' },
      metadata: { output: 'Summary' },
      time: { start: 1 },
    },
  });
  dispose = render(() => <ToolCall part={part} />, container);
  flushSolid();
  for (let index = 0; index < 100; index++) {
    setPart(
      storePath('state', {
        status: 'running',
        input: { command: 'npm test' },
        metadata: { output: `Summary ${index}` },
        time: { start: 1 },
      })
    );
    flushSolid();
  }
  expect(requests).toHaveLength(0);
  container.querySelector<HTMLButtonElement>('.tool-invocation-header')!.click();
  flushSolid();
  expect(requests).toHaveLength(1);
  for (let index = 0; index < 100; index++) {
    setPart(
      storePath('state', {
        status: 'running',
        input: { command: 'npm test' },
        metadata: { output: `Next ${index}` },
        time: { start: 1 },
      })
    );
    flushSolid();
  }
  expect(requests).toHaveLength(1);
  respond(requests[0]!, {
    ...part,
    deferred: undefined,
    state: { ...part.state, metadata: { output: 'Full running output' } },
  });
  await vi.waitFor(() => expect(container.textContent).toContain('Full running output'));
  flushSolid();
  await vi.waitFor(() => expect(requests).toHaveLength(2));
  flushSolid();
  setPart(
    storePath('state', {
      status: 'completed',
      input: { command: 'npm test' },
      title: 'Tests',
      output: 'Final summary',
      metadata: {},
      time: { start: 1, end: 2 },
    })
  );
  flushSolid();
  respond(requests[1]!, { ...part, deferred: undefined });
  await vi.waitFor(() => expect(requests).toHaveLength(3));
  flushSolid();
  respond(requests[2]!, {
    ...part,
    deferred: undefined,
    state: { ...part.state, output: 'Full final output' },
  });
  await vi.waitFor(() => expect(container.textContent).toContain('Full final output'));
  flushSolid();
  expect(part.state).toMatchObject({ output: 'Final summary' });
  container.querySelector<HTMLButtonElement>('.tool-invocation-header')!.click();
  flushSolid();
  expect(container.querySelector('.tool-invocation-detail')).toBeNull();
  expect(container.textContent).not.toContain('Full final output');
  container.querySelector<HTMLButtonElement>('.tool-invocation-header')!.click();
  flushSolid();
  expect(requests).toHaveLength(4);
  container.querySelector<HTMLButtonElement>('.tool-invocation-header')!.click();
  flushSolid();
  respond(requests[3]!, {
    ...part,
    deferred: undefined,
    state: { ...part.state, output: 'Late output must not appear' },
  });
  await Promise.resolve();
  flushSolid();
  expect(container.textContent).not.toContain('Late output');
});

it('ignores a late detail response after the disclosure closes', async () => {
  const part: ReasoningPart = {
    id: 'p1',
    sessionID: 's1',
    messageID: 'm1',
    type: 'reasoning',
    text: 'Summary',
    time: { start: 1, end: 2 },
    deferred: path,
  };
  dispose = render(() => <MessagePart part={part} />, container);
  flushSolid();
  const header = container.querySelector<HTMLButtonElement>('.thinking-header')!;
  header.click();
  flushSolid();
  expect(requests).toHaveLength(1);
  header.click();
  flushSolid();
  respond(requests[0]!, { ...part, deferred: undefined, text: 'Stale detail must not appear' });
  await Promise.resolve();
  flushSolid();
  expect(container.querySelector('.thinking-content')).toBeNull();
  expect(container.textContent).not.toContain('Stale detail');
  header.click();
  flushSolid();
  expect(requests).toHaveLength(2);
  respond(requests[1]!, { ...part, deferred: undefined, text: 'Fresh complete detail' });
  await vi.waitFor(() => expect(container.textContent).toContain('Fresh complete detail'));
  flushSolid();
});

it('resolves a deferred text attachment before creating an editable draft', async () => {
  setState(storePath('activeSessionId', 's1'));
  flushSolid();
  dispose = render(
    () => (
      <Message
        info={{
          id: 'm1',
          sessionID: 's1',
          role: 'user',
          time: { created: 1 },
          agent: 'build',
          model: { providerID: 'test', modelID: 'test' },
        }}
        parts={[
          {
            id: 'p1',
            sessionID: 's1',
            messageID: 'm1',
            type: 'file',
            mime: 'text/plain',
            filename: 'notes.txt',
            url: `varro-content:${path}`,
          },
        ]}
      />
    ),
    container
  );
  flushSolid();
  expect(requests).toHaveLength(0);
  container.querySelector<HTMLElement>('.user-message-card')!.click();
  flushSolid();
  expect(requests).toHaveLength(1);
  expect(editingMessage()).toBeNull();
  respond(requests[0]!, { type: 'file', url: 'data:text/plain;base64,Y29tcGxldGUgbm90ZXM=' });
  await vi.waitFor(() =>
    expect(editingMessage()?.context.files[0]?.pastedText).toBe('complete notes')
  );
  flushSolid();
});
