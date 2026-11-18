import { flush as flushSolid } from 'solid-js';
import { storePath } from '@solidjs/signals';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent, Session } from '../types';
import type { ClipboardImage, NativePdfAttachment } from './app-state-types';
import { fixture } from '../test-fixtures';
import * as feedback from '../components/chat/SessionActionFeedback';
import { MAX_SIDE_QUESTION_LENGTH } from '../../shared/side-question';
import {
  closeSideQuestion,
  openSideQuestion,
  sideQuestionUnavailableReason,
  sideQuestionView,
} from './side-question';
import { inputText, resetDefaultAppState, setInputText, setState, state } from './state';

beforeEach(() => {
  resetDefaultAppState();
  flushSolid();
  closeSideQuestion();
  flushSolid();
  setState(storePath('serverStatus', { state: 'running', url: 'mock://opencode', apiVersion: 2 }));
  flushSolid();
  setState(storePath('sessions', [fixture<Session>({ id: 'ses_side', directory: '/repo' })]));
  flushSolid();
  setState(storePath('activeSessionId', 'ses_side'));
  flushSolid();
  setState(storePath('currentDocumentEnabled', true));
  flushSolid();
  setState(
    storePath('allAgents', [fixture<Agent>({ name: 'explore' }), fixture<Agent>({ name: 'build' })])
  );
  flushSolid();
  vi.spyOn(feedback, 'showSessionActionFeedback').mockImplementation(() => {});
});

afterEach(() => {
  closeSideQuestion();
  flushSolid();
  vi.restoreAllMocks();
  flushSolid();
});

describe('side-question prompt compatibility and context', () => {
  it('allows side questions after a move despite stale availability metadata', () => {
    setState(
      storePath('sessions', 0, 'transfer', { originDirectory: '/origin', available: false })
    );
    flushSolid();
    expect(sideQuestionUnavailableReason()).toBeNull();
  });

  it.each([
    ['/btw @explore Why?', 'subagents'],
    ['/btw $[docs] Why?', 'skills'],
    ['/btw /test example', 'commands'],
    ['/btw session:ses_other Why?', 'other conversations'],
  ])('blocks incompatible inline content in %s without losing the draft', (text, reason) => {
    setInputText(text);
    flushSolid();
    expect(sideQuestionUnavailableReason()).toContain(reason);
    expect(openSideQuestion(text)).toBe(false);
    flushSolid();
    expect(inputText()).toBe(text);
    expect(sideQuestionView()).toBeNull();
  });

  it('excludes images and their placeholders without consuming the attachments', () => {
    const image = fixture<ClipboardImage>({
      id: 'image',
      filename: 'Image 1',
      mime: 'image/png',
      url: 'data:image/png;base64,eA==',
    });
    setState(storePath('clipboardImages', [image]));
    flushSolid();
    setInputText('/btw [Image 1] Why?');
    flushSolid();
    expect(sideQuestionUnavailableReason()).toBeNull();
    expect(openSideQuestion('[Image 1] Why?')).toBe(true);
    flushSolid();
    expect(sideQuestionView()).toMatchObject({ question: 'Why?' });
    expect(sideQuestionView()?.context ?? '').toBe('');
    expect(inputText()).toBe('/btw [Image 1] Why?');
    expect(state.clipboardImages).toEqual([image]);
  });

  it('still blocks PDFs instead of silently dropping them', () => {
    setState(
      storePath('nativePdfs', [
        fixture<NativePdfAttachment>({
          id: 'pdf',
          filename: 'file.pdf',
          url: 'data:application/pdf;base64,eA==',
        }),
      ])
    );
    flushSolid();
    setInputText('/btw Why?');
    flushSolid();
    expect(sideQuestionUnavailableReason()).toBe('Remove PDFs to ask a side question');
    expect(openSideQuestion('Why?')).toBe(false);
    flushSolid();
    expect(inputText()).toBe('/btw Why?');
    expect(state.clipboardImages.length + state.nativePdfs.length).toBe(1);
  });

  it('captures normal file/line references without confusing file names with agent mentions', () => {
    setInputText('/btw @build.ts Explain this');
    flushSolid();
    setState(storePath('editorContext', 'workspacePath', '/repo'));
    flushSolid();
    setState(
      storePath('droppedFiles', [
        { path: '/repo/build.ts', relativePath: 'build.ts', type: 'file' },
        {
          path: '/repo/other.ts',
          relativePath: 'other.ts',
          type: 'file',
          lineRanges: [{ startLine: 2, endLine: 4 }],
        },
      ])
    );
    flushSolid();
    const files = state.droppedFiles;
    expect(sideQuestionUnavailableReason()).toBeNull();
    expect(openSideQuestion('@build.ts Explain this')).toBe(true);
    flushSolid();
    expect(sideQuestionView()?.question).toBe('@build.ts Explain this');
    expect(sideQuestionView()?.context).toContain('[Attached file: build.ts]');
    expect(sideQuestionView()?.context).toContain('[Selection from other.ts lines 2-4]');
    expect(state.droppedFiles).toBe(files);
  });

  it('captures editor and terminal text as an immutable snapshot', () => {
    setState(storePath('editorContext', 'workspacePath', '/repo'));
    flushSolid();
    setState(
      storePath('editorContext', 'editorText', {
        kind: 'selection',
        path: '/repo/file.ts',
        relativePath: 'file.ts',
        language: 'typescript',
        range: { startLine: 2, endLine: 3 },
        text: 'const captured = 42;',
        truncated: false,
      })
    );
    flushSolid();
    setState(storePath('terminalSelection', { terminalName: 'Tests', text: 'Assertion failed' }));
    flushSolid();
    expect(openSideQuestion('Why?')).toBe(true);
    flushSolid();
    const context = sideQuestionView()?.context;
    expect(context).toContain('[Unsaved selection from file.ts lines 2-3]');
    expect(context).toContain('const captured = 42;');
    expect(context).toContain('[Selection from terminal Tests]');
    expect(context).toContain('Assertion failed');
    setState(storePath('editorContext', 'editorText', 'text', 'changed'));
    flushSolid();
    expect(sideQuestionView()?.context).toBe(context);
  });

  it('omits automatic file and Problems context when their settings are disabled', () => {
    setState(storePath('autoAttachActiveFile', false));
    flushSolid();
    setState(storePath('autoAttachProblems', false));
    flushSolid();
    setState(
      storePath('editorContext', {
        workspacePath: '/repo',
        activeFile: { path: '/repo/file.ts', relativePath: 'file.ts', language: 'typescript' },
        selection: null,
        diagnostics: [
          { path: '/repo/file.ts', severity: 'error', line: 1, message: 'Automatic error' },
        ],
      })
    );
    flushSolid();
    expect(openSideQuestion('Why?')).toBe(true);
    flushSolid();
    expect(sideQuestionView()?.context ?? '').toBe('');
  });

  it('includes pasted text instead of sending an unreadable data URL', () => {
    setState(
      storePath('droppedFiles', [
        {
          path: 'varro-paste:one',
          relativePath: 'pasted.txt',
          type: 'file',
          pastedText: 'kept text',
        },
      ])
    );
    flushSolid();
    expect(openSideQuestion('Explain')).toBe(true);
    flushSolid();
    expect(sideQuestionView()?.context).toContain('[Unsaved buffer from pasted.txt lines 1-1]');
    expect(sideQuestionView()?.context).toContain('kept text');
    expect(sideQuestionView()?.context).not.toContain('data:');
  });

  it('includes explicitly attached diagnostics instead of losing inline problem context', () => {
    setState(storePath('autoAttachProblems', true));
    flushSolid();
    setState(
      storePath('attachedDiagnostics', {
        inline: true,
        total: 1,
        diagnostics: [
          { path: '/repo/file.ts', severity: 'error', message: 'Expected a number', line: 2 },
        ],
      })
    );
    flushSolid();
    setInputText('/btw [Problems] Explain');
    flushSolid();
    expect(openSideQuestion('[Problems] Explain')).toBe(true);
    flushSolid();
    expect(sideQuestionView()?.context).toContain('Expected a number');
    closeSideQuestion();
    flushSolid();
    expect(openSideQuestion()).toBe(true);
    flushSolid();
    expect(sideQuestionView()?.question).toBe('');
    expect(sideQuestionView()?.context).toContain('Expected a number');
    expect(inputText()).toBe('/btw [Problems] Explain');
  });

  it('blocks a disabled problems marker rather than stripping it from the prompt', () => {
    setState(storePath('autoAttachProblems', false));
    flushSolid();
    setInputText('/btw [Problems] Explain');
    flushSolid();
    expect(sideQuestionUnavailableReason()).toContain('Enable problems context');
    expect(openSideQuestion('[Problems] Explain')).toBe(false);
    flushSolid();
    expect(inputText()).toBe('/btw [Problems] Explain');
  });

  it('does not silently truncate oversized attached context', () => {
    setInputText('/btw Explain');
    flushSolid();
    setState(
      storePath('droppedFiles', [
        {
          path: 'varro-paste:one',
          relativePath: 'pasted.txt',
          type: 'file',
          pastedText: 'x'.repeat(MAX_SIDE_QUESTION_LENGTH),
        },
      ])
    );
    flushSolid();
    expect(openSideQuestion('Explain')).toBe(false);
    flushSolid();
    expect(sideQuestionView()).toBeNull();
    expect(inputText()).toBe('/btw Explain');
    expect(state.droppedFiles[0]?.pastedText).toHaveLength(MAX_SIDE_QUESTION_LENGTH);
    expect(feedback.showSessionActionFeedback).toHaveBeenCalledWith(
      'Question and context exceed the side-question limit',
      'warning'
    );
  });
});
