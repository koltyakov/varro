import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import type { WebviewMessage } from '../../shared/protocol';
import type { ReasoningPart, ToolPart } from '../types';
import { cleanupBridge, initializeBridge } from '../lib/bridge';
import { resetDefaultAppState, setShowThinking, setState } from '../lib/state';
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
  resetToolCallExpansionState();
  resetMessageEditState();
  setShowThinking(true);
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
  dispose = undefined;
  cleanupBridge();
  resetMessageEditState();
  delete window.__sendToExtension;
  document.body.replaceChildren();
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
  await Promise.resolve();
  expect(requests).toHaveLength(0);
  intersect!(
    [fixture<IntersectionObserverEntry>({ isIntersecting: true })],
    fixture<IntersectionObserver>({})
  );
  await vi.waitFor(() => expect(requests).toHaveLength(1));
  expect(requests[0]?.path).toBe(`${path}?view=thumbnail`);
  respond(requests[0]!, { url: 'data:image/png;base64,THUMBNAIL' });
  await vi.waitFor(() =>
    expect(container.querySelector('img')?.getAttribute('src')).toBe(
      'data:image/png;base64,THUMBNAIL'
    )
  );
  setOpen(true);
  await vi.waitFor(() => expect(requests).toHaveLength(2));
  expect(requests[1]?.path).toBe(path);
  respond(requests[1]!, { type: 'file', url: 'data:image/png;base64,ORIGINAL' });
  await vi.waitFor(() =>
    expect(document.querySelector('.chat-image-preview-img')?.getAttribute('src')).toBe(
      'data:image/png;base64,ORIGINAL'
    )
  );
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
  expect(requests).toHaveLength(0);
  container.querySelector<HTMLButtonElement>('.thinking-header')!.click();
  expect(requests).toHaveLength(1);
  expect(container.textContent).toContain('Loading thinking');
  respond(requests[0]!, undefined, 'Detail request failed');
  await vi.waitFor(() => expect(container.querySelector('[role="alert"]')).not.toBeNull());
  container.querySelector<HTMLButtonElement>('[role="alert"] button')!.click();
  expect(requests).toHaveLength(2);
  respond(requests[1]!, {
    ...part,
    deferred: undefined,
    text: '**Checking**\n\nThe complete thinking transcript.',
  });
  await vi.waitFor(() =>
    expect(container.textContent).toContain('The complete thinking transcript.')
  );
  container.querySelector<HTMLButtonElement>('.thinking-header')!.click();
  expect(container.querySelector('.thinking-content')).toBeNull();
  expect(part.text).toBe('**Checking**\n\nSummary');
});

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
  expect(requests).toHaveLength(0);
  container.querySelector<HTMLButtonElement>('[aria-expanded="false"]')!.click();
  expect(requests).toHaveLength(1);
  expect(container.textContent).toContain('Loading tool details');
  respond(requests[0]!, {
    ...part,
    deferred: undefined,
    state: { ...part.state, output: 'Full test output, including the final result.' },
  });
  await vi.waitFor(() => expect(container.textContent).toContain('including the final result.'));
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
  const header = container.querySelector<HTMLButtonElement>('.thinking-header')!;
  header.click();
  expect(requests).toHaveLength(1);
  header.click();
  respond(requests[0]!, { ...part, deferred: undefined, text: 'Stale detail must not appear' });
  await Promise.resolve();
  expect(container.querySelector('.thinking-content')).toBeNull();
  expect(container.textContent).not.toContain('Stale detail');
  header.click();
  expect(requests).toHaveLength(2);
  respond(requests[1]!, { ...part, deferred: undefined, text: 'Fresh complete detail' });
  await vi.waitFor(() => expect(container.textContent).toContain('Fresh complete detail'));
});

it('resolves a deferred text attachment before creating an editable draft', async () => {
  setState('activeSessionId', 's1');
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
  expect(requests).toHaveLength(0);
  container.querySelector<HTMLElement>('.user-message-card')!.click();
  expect(requests).toHaveLength(1);
  expect(editingMessage()).toBeNull();
  respond(requests[0]!, { type: 'file', url: 'data:text/plain;base64,Y29tcGxldGUgbm90ZXM=' });
  await vi.waitFor(() =>
    expect(editingMessage()?.context.files[0]?.pastedText).toBe('complete notes')
  );
});
