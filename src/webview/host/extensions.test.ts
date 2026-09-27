import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  captureExtensionContexts,
  getHostFilePath,
  hostMetadata,
  registerHostExtension,
  startHostExtension,
  supportsDetachedEditors,
} from './extensions';
import type { ContextProvider } from './extensions';
import type { ExtensionContext } from '../../shared/extension-context';
import {
  cloneExtensionContexts,
  formatExtensionContext,
  isExtensionContext,
} from '../../shared/extension-context';
import { parseExtensionMessage } from '../../shared/extension-message';
import { asRecord, isString } from '../../shared/type-utils';
import { buildSessionSendBody, getQueuedAttachmentSnapshot } from '../hooks/session/session-send';
import {
  getUserMessageEditContext,
  getUserMessageEditText,
  parseUserMessageContent,
} from '../components/message/UserMessageContent';
import { stripContextForHistory } from '../lib/context-history';
import type { TextPart } from '../types';
import { BrowserPersistence } from '../lib/browser-persistence';
import { cleanupBridge, initializeBridge, onMessage, postMessage } from '../lib/bridge';

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
});

const provider: ContextProvider = {
  id: 'example.issue',
  version: 1,
  validate: (data) => isString(asRecord(data)?.summary),
  capture: (data) => ({ text: `Issue: ${asRecord(data)?.summary}`, detail: 'Tracker' }),
};
const context = (): ExtensionContext => ({
  provider: provider.id,
  version: 1,
  label: 'BUG-42',
  placement: 'alongside-document',
  data: { summary: 'Original', nested: { labels: ['bug'] } },
});
function composer(contexts: ExtensionContext[]) {
  return {
    selectedAgent: null,
    selectedModel: null,
    providers: [],
    providerDefaults: {},
    modelVariantSelections: {},
    droppedFiles: [],
    clipboardImages: [],
    terminalSelection: null,
    editorContext: {
      workspacePath: '/repo',
      activeFile: { path: '/repo/file.ts', relativePath: 'file.ts', language: 'typescript' },
      selection: null,
      diagnostics: [],
      extensionContexts: contexts,
    },
  };
}
const part = (text: string): TextPart => ({
  type: 'text',
  id: 'part',
  sessionID: 'session',
  messageID: 'message',
  text,
});

describe('host extension contract', () => {
  it('negotiates required features, rejects incompatible versions, and fixes registration until unmount', () => {
    expect(hostMetadata().ideName).toBe('VS Code');
    expect(supportsDetachedEditors()).toBe(true);
    expect(() => registerHostExtension({ id: 'example.host', apiVersion: 2 })).toThrow(
      'Unsupported'
    );
    expect(() =>
      registerHostExtension({ id: 'example.host', apiVersion: 1, requires: ['future-feature'] })
    ).toThrow('Unsupported');
    const cleanup = vi.fn();
    dispose = registerHostExtension({
      id: 'example.host',
      apiVersion: 1,
      requires: ['context-providers'],
      capabilities: { detachedEditors: false },
      dispose: cleanup,
    });
    expect(supportsDetachedEditors()).toBe(false);
    const stop = startHostExtension();
    expect(() => registerHostExtension({ id: 'other.host', apiVersion: 1 })).toThrow(
      'before loading'
    );
    expect(dispose).toThrow('Unmount');
    stop();
    dispose();
    dispose();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(supportsDetachedEditors()).toBe(true);
  });

  it('freezes queued context, survives a missing provider, and preserves inline-edit attachments', () => {
    dispose = registerHostExtension({ id: 'example.host', apiVersion: 1, contexts: [provider] });
    const source = context();
    const queued = captureExtensionContexts([source])!;
    source.data = { summary: 'Changed after queueing' };
    dispose();
    const sent = buildSessionSendBody(composer(queued), 'session', 'Fix it', () => true)!;
    const text = sent.body.parts.flatMap((item) => (item.text ? [item.text] : [])).join('\n\n');
    expect(text).toContain('Original');
    expect(text).not.toContain('Changed after queueing');
    expect(text).toContain('[Active file: file.ts]');
    const parts = [part(text)];
    expect(getUserMessageEditText(parts)).toBe('Fix it');
    const edited = getUserMessageEditContext(parts);
    expect(edited.extensionContexts).toEqual(queued);
    expect(
      getQueuedAttachmentSnapshot({
        droppedFiles: [],
        clipboardImages: [],
        terminalSelection: null,
        extensionContexts: edited.extensionContexts,
      }).extensionContexts
    ).toEqual(queued);
    expect(stripContextForHistory(`Fix it\n\n${formatExtensionContext(queued[0]!)}`)).toBe(
      'Fix it\n'
    );
    expect(
      parseUserMessageContent(parts).attachments.some((item) => item.type === 'extension-context')
    ).toBe(true);
  });

  it('supports independent providers and explicit replacement without changing core protocol types', () => {
    const second = { ...provider, id: 'example.ticket' };
    dispose = registerHostExtension({
      id: 'example.host',
      apiVersion: 1,
      contexts: [provider, second],
    });
    const contexts = [
      context(),
      { ...context(), provider: second.id, placement: 'replace-document' as const },
    ];
    const payload = composer(contexts).editorContext;
    expect(parseExtensionMessage({ type: 'context/update', payload })?.type).toBe('context/update');
    const body = buildSessionSendBody(composer(contexts), 'session', 'Fix it', () => true)!.body;
    expect(body.parts.filter((item) => item.text?.startsWith('[Extension context]'))).toHaveLength(
      2
    );
    expect(JSON.stringify(body)).not.toContain('[Active file:');
    expect(
      buildSessionSendBody(composer(contexts), 'session', 'Fix it', () => false)!.body.parts
    ).toEqual([{ type: 'text', text: 'Fix it' }]);
  });

  it('preserves unknown versions but blocks sending uncaptured or invalid context', () => {
    const future = { ...context(), version: 99 };
    expect(cloneExtensionContexts([future])).toEqual([future]);
    expect(() => buildSessionSendBody(composer([future]), 'session', 'Fix it', () => true)).toThrow(
      'provider unavailable'
    );
    dispose = registerHostExtension({
      id: 'example.host',
      apiVersion: 1,
      contexts: [
        {
          ...provider,
          capture() {
            throw new Error('offline');
          },
        },
      ],
    });
    expect(() => captureExtensionContexts([context()])).toThrow('Could not capture BUG-42');
    expect(() => captureExtensionContexts([{ ...context(), data: {} }])).toThrow(
      'Could not capture'
    );
  });

  it('rejects oversized and cyclic payloads while preserving literal transcript examples', () => {
    const cyclic: object[] = [];
    cyclic.push(cyclic);
    expect(isExtensionContext({ ...context(), data: cyclic })).toBe(false);
    expect(isExtensionContext({ ...context(), data: 'x'.repeat(512_001) })).toBe(false);
    expect(isExtensionContext({ ...context(), data: undefined })).toBe(false);
    const captured = { ...context(), captured: { text: 'Use ``` in the example' } };
    const text = formatExtensionContext(captured);
    expect(text).toContain('````json');
    expect(stripContextForHistory(`~~~~text\n${text}\n~~~~`)).toBe(`~~~~text\n${text}\n~~~~`);
    expect(stripContextForHistory('[Extension context]\n```json\n{}\n```')).toContain('{}');
  });

  it('uses injected storage and file paths without changing browser objects', () => {
    const nativeStorage = window.localStorage;
    const file = new File(['hello'], 'note.txt');
    const storage = window.sessionStorage;
    dispose = registerHostExtension({
      id: 'example.host',
      apiVersion: 1,
      services: { projectStorage: storage, filePath: () => '/repo/note.txt' },
    });
    const persistence = new BrowserPersistence();
    persistence.set('extension-test', { saved: true });
    expect(storage.getItem('extension-test')).toBe('{"saved":true}');
    expect(nativeStorage.getItem('extension-test')).toBeNull();
    expect(window.localStorage).toBe(nativeStorage);
    expect(getHostFilePath(file)).toBe('/repo/note.txt');
    expect(Object.hasOwn(file, 'path')).toBe(false);
    storage.removeItem('extension-test');
  });

  it('validates transport messages and unsubscribes on bridge cleanup', () => {
    cleanupBridge();
    const target = new EventTarget();
    const unsubscribe = vi.fn();
    const send = vi.fn();
    dispose = registerHostExtension({
      id: 'example.host',
      apiVersion: 1,
      services: {
        send,
        subscribe(receive) {
          const listener = (event: Event) => {
            if (event instanceof MessageEvent) receive(event.data);
          };
          target.addEventListener('message', listener);
          return () => {
            target.removeEventListener('message', listener);
            unsubscribe();
          };
        },
      },
    });
    initializeBridge();
    const receive = vi.fn();
    onMessage(receive);
    target.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'context/update', payload: composer([]).editorContext },
      })
    );
    target.dispatchEvent(
      new MessageEvent('message', { data: { type: 'context/update', payload: {} } })
    );
    expect(receive).toHaveBeenCalledOnce();
    expect(postMessage({ type: 'ready' })).toBe(true);
    expect(send).toHaveBeenCalledWith({ type: 'ready' });
    cleanupBridge();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
