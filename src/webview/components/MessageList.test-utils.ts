import { afterEach, beforeEach, vi } from 'vitest';
import { reconcile } from 'solid-js/store';
import {
  setState,
  setShowInlineFileChanges,
  setShowThinkingPreference,
  state,
  stopLoading,
} from '../lib/state';
import type {
  AssistantMessage,
  FilePart,
  Message,
  Part,
  Session,
  ToolPart,
  UserMessage,
} from '../types';
import { resetMessageWindowState } from '../lib/message-window';
import { resetMessageEditState } from '../lib/message-edit-state';
import { setExpandedDiffOverlay } from '../lib/diff-overlay-state';
import { resetToolCallExpansionState } from '../lib/tool-call-expansion-state';

const testDiffOverlayOwner = Symbol();

export interface MessageListTestEnvironmentState {
  getContainer(): HTMLDivElement | null;
  setContainer(element: HTMLDivElement | null): void;
  getCleanup(): (() => void) | undefined;
  setCleanup(cleanup: (() => void) | undefined): void;
}

export function installMessageListTestEnvironment(
  environment: MessageListTestEnvironmentState
): void {
  let originalResizeObserver: typeof globalThis.ResizeObserver | undefined;
  let originalIntersectionObserver: typeof globalThis.IntersectionObserver | undefined;
  let originalRequestAnimationFrame: typeof globalThis.requestAnimationFrame | undefined;
  let originalCancelAnimationFrame: typeof globalThis.cancelAnimationFrame | undefined;
  let originalScrollIntoView: typeof HTMLElement.prototype.scrollIntoView | undefined;

  beforeEach(() => {
    const nextContainer = document.createElement('div');
    environment.setContainer(nextContainer);
    document.body.appendChild(nextContainer);
    originalResizeObserver = globalThis.ResizeObserver;
    originalIntersectionObserver = globalThis.IntersectionObserver;
    originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
    originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as typeof ResizeObserver;
    globalThis.requestAnimationFrame = vi.fn().mockImplementation((cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    globalThis.cancelAnimationFrame = vi.fn();
    vi.useFakeTimers();
  });

  afterEach(async () => {
    environment.getCleanup()?.();
    environment.setCleanup(undefined);
    await Promise.resolve();
    vi.useRealTimers();
    environment.getContainer()?.remove();
    environment.setContainer(null);
    setState('messages', []);
    setState('sessions', []);
    setState('permissions', []);
    setState('questions', []);
    setState('activeSessionId', null);
    setState('messagesLoading', false);
    setState('providers', []);
    setState('agents', []);
    setState('allAgents', []);
    setState('queuedMessages', []);
    setState('streamingPartId', null);
    setState('streamingText', '');
    resetMessageWindowState();
    resetToolCallExpansionState();
    setState('sessionSelectedAgents', reconcile({}));
    setState('sessionStatus', reconcile({}));
    setState('sessionAutoPermissionCounts', reconcile({}));
    setState('skippedPlanSessions', reconcile({}));
    setShowInlineFileChanges(false);
    setShowThinkingPreference(true);
    stopLoading();
    resetMessageEditState();
    setExpandedDiffOverlay(testDiffOverlayOwner, false);
    if (originalResizeObserver) {
      globalThis.ResizeObserver = originalResizeObserver;
    } else {
      delete (globalThis as Partial<typeof globalThis>).ResizeObserver;
    }
    if (originalIntersectionObserver) {
      globalThis.IntersectionObserver = originalIntersectionObserver;
    } else {
      delete (globalThis as Partial<typeof globalThis>).IntersectionObserver;
    }
    if (originalRequestAnimationFrame) {
      globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    } else {
      delete (globalThis as Partial<typeof globalThis>).requestAnimationFrame;
    }
    if (originalCancelAnimationFrame) {
      globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
    } else {
      delete (globalThis as Partial<typeof globalThis>).cancelAnimationFrame;
    }
    if (originalScrollIntoView) {
      HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    } else {
      delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
    }
    vi.restoreAllMocks();
  });
}

export { testDiffOverlayOwner };

export function installQueuedAnimationFrameMocks() {
  const originalGlobalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalGlobalCancelAnimationFrame = globalThis.cancelAnimationFrame;
  const originalWindowRequestAnimationFrame = window.requestAnimationFrame;
  const originalWindowCancelAnimationFrame = window.cancelAnimationFrame;
  const pendingAnimationFrameCallbacks: Array<FrameRequestCallback | null> = [];
  const requestAnimationFrameMock = vi.fn().mockImplementation((cb: FrameRequestCallback) => {
    pendingAnimationFrameCallbacks.push(cb);
    return pendingAnimationFrameCallbacks.length;
  });
  const cancelAnimationFrameMock = vi.fn().mockImplementation((id: number) => {
    if (id <= 0) return;
    pendingAnimationFrameCallbacks[id - 1] = null;
  });

  Object.defineProperty(globalThis, 'requestAnimationFrame', {
    configurable: true,
    writable: true,
    value: requestAnimationFrameMock,
  });
  Object.defineProperty(globalThis, 'cancelAnimationFrame', {
    configurable: true,
    writable: true,
    value: cancelAnimationFrameMock,
  });
  Object.defineProperty(window, 'requestAnimationFrame', {
    configurable: true,
    writable: true,
    value: requestAnimationFrameMock,
  });
  Object.defineProperty(window, 'cancelAnimationFrame', {
    configurable: true,
    writable: true,
    value: cancelAnimationFrameMock,
  });

  return {
    flush(now = 0) {
      const callbacks = pendingAnimationFrameCallbacks.splice(0);
      for (const callback of callbacks) callback?.(now);
    },
    restore() {
      Object.defineProperty(globalThis, 'requestAnimationFrame', {
        configurable: true,
        writable: true,
        value: originalGlobalRequestAnimationFrame,
      });
      Object.defineProperty(globalThis, 'cancelAnimationFrame', {
        configurable: true,
        writable: true,
        value: originalGlobalCancelAnimationFrame,
      });
      Object.defineProperty(window, 'requestAnimationFrame', {
        configurable: true,
        writable: true,
        value: originalWindowRequestAnimationFrame,
      });
      Object.defineProperty(window, 'cancelAnimationFrame', {
        configurable: true,
        writable: true,
        value: originalWindowCancelAnimationFrame,
      });
    },
  };
}

export function installControllableIntersectionObserver() {
  let callback: IntersectionObserverCallback | undefined;
  let observer: IntersectionObserver | undefined;

  class TestIntersectionObserver {
    readonly root = null;
    readonly rootMargin = '0px';
    readonly thresholds = [0, 1];

    constructor(nextCallback: IntersectionObserverCallback) {
      callback = nextCallback;
      observer = this as unknown as IntersectionObserver;
    }

    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  }

  globalThis.IntersectionObserver =
    TestIntersectionObserver as unknown as typeof IntersectionObserver;

  return {
    emit(
      entries: Array<Partial<IntersectionObserverEntry> & Pick<IntersectionObserverEntry, 'target'>>
    ) {
      if (!callback || !observer) throw new Error('IntersectionObserver was not created');
      callback(entries as IntersectionObserverEntry[], observer);
    },
  };
}

export function textPart(
  id: string,
  text: string,
  options?: { ignored?: boolean; synthetic?: boolean }
): Part {
  return {
    id,
    sessionID: 'session-1',
    messageID: 'message-1',
    type: 'text',
    text,
    ...options,
  };
}

export function filePart(id: string, filename: string): FilePart {
  return {
    id,
    sessionID: 'session-1',
    messageID: 'message-1',
    type: 'file',
    mime: 'image/png',
    filename,
    url: `https://example.test/${id}.png`,
  };
}

export function userMessage(id: string): UserMessage {
  return {
    id,
    sessionID: 'session-1',
    role: 'user',
    time: { created: 1 },
    agent: 'build',
    model: { providerID: 'openai', modelID: 'gpt-5.4' },
  };
}

export function assistantMessage(
  id: string,
  options?: {
    agent?: string;
    error?: AssistantMessage['error'];
    mode?: string;
    modelID?: string;
    parentID?: string;
    providerID?: string;
    sessionID?: string;
    time?: AssistantMessage['time'];
    tokens?: AssistantMessage['tokens'];
    variant?: string;
  }
): AssistantMessage {
  return {
    id,
    sessionID: options?.sessionID ?? 'session-1',
    role: 'assistant',
    time: options?.time ?? { created: 1, completed: 2 },
    parentID: options?.parentID ?? 'parent-1',
    modelID: options?.modelID ?? 'gpt-5.4',
    providerID: options?.providerID ?? 'openai',
    mode: options?.mode ?? 'default',
    agent: options?.agent,
    error: options?.error,
    path: { cwd: '/workspace', root: '/workspace' },
    cost: 0,
    tokens: options?.tokens ?? {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    variant: options?.variant,
  };
}

export function hasAssistantModelChangeBetween(previousId: string, currentId: string) {
  const previous = state.messages.find((message) => message.info.id === previousId);
  const current = state.messages.find((message) => message.info.id === currentId);
  return (
    previous?.info.role === 'assistant' &&
    current?.info.role === 'assistant' &&
    (previous.info.providerID !== current.info.providerID ||
      previous.info.modelID !== current.info.modelID)
  );
}

export function session(id: string, options: Partial<Session> = {}): Session {
  return {
    id,
    projectID: 'project-1',
    directory: '/workspace',
    title: id,
    version: '1',
    time: { created: 1, updated: 1 },
    ...options,
  };
}

export function entry(info: Message) {
  return { info, parts: [] as Part[] };
}

export function toolPart(id: string, messageID = 'message-1', callID = 'call-1'): ToolPart {
  return {
    id,
    sessionID: 'session-1',
    messageID,
    type: 'tool',
    callID,
    tool: 'bash',
    state: {
      status: 'running',
      input: { command: 'pwd' },
      time: { start: 1 },
    },
  };
}

export function reasoningPart(id: string, text: string): Part {
  return {
    id,
    sessionID: 'session-1',
    messageID: 'message-1',
    type: 'reasoning',
    text,
    time: { start: 1 },
  };
}
