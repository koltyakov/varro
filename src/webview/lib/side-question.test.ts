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
  closeSideQuestion();
  setState('serverStatus', { state: 'running', url: 'mock://opencode', apiVersion: 2 });
  setState('sessions', [fixture<Session>({ id: 'ses_side', directory: '/repo' })]);
  setState('activeSessionId', 'ses_side');
  setState('currentDocumentEnabled', true);
  setState('allAgents', [fixture<Agent>({ name: 'explore' }), fixture<Agent>({ name: 'build' })]);
  vi.spyOn(feedback, 'showSessionActionFeedback').mockImplementation(() => {});
});

afterEach(() => {
  closeSideQuestion();
  vi.restoreAllMocks();
});

describe('side-question prompt compatibility and context', () => {
  it('allows side questions after a move despite stale availability metadata', () => {
    setState('sessions', 0, 'transfer', { originDirectory: '/origin', available: false });
    expect(sideQuestionUnavailableReason()).toBeNull();
  });

  it.each([
    ['/btw @explore Why?', 'subagents'],
    ['/btw $[docs] Why?', 'skills'],
    ['/btw /test example', 'commands'],
    ['/btw session:ses_other Why?', 'other conversations'],
  ])('blocks incompatible inline content in %s without losing the draft', (text, reason) => {
    setInputText(text);
    expect(sideQuestionUnavailableReason()).toContain(reason);
    expect(openSideQuestion(text)).toBe(false);
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
    setState('clipboardImages', [image]);
    setInputText('/btw [Image 1] Why?');
    expect(sideQuestionUnavailableReason()).toBeNull();
    expect(openSideQuestion('[Image 1] Why?')).toBe(true);
    expect(sideQuestionView()).toMatchObject({ question: 'Why?' });
    expect(sideQuestionView()?.context ?? '').toBe('');
    expect(inputText()).toBe('/btw [Image 1] Why?');
    expect(state.clipboardImages).toEqual([image]);
  });

  it('still blocks PDFs instead of silently dropping them', () => {
    setState('nativePdfs', [
      fixture<NativePdfAttachment>({
        id: 'pdf',
        filename: 'file.pdf',
        url: 'data:application/pdf;base64,eA==',
      }),
    ]);
    setInputText('/btw Why?');
    expect(sideQuestionUnavailableReason()).toBe('Remove PDFs to ask a side question');
    expect(openSideQuestion('Why?')).toBe(false);
    expect(inputText()).toBe('/btw Why?');
    expect(state.clipboardImages.length + state.nativePdfs.length).toBe(1);
  });

  it('captures normal file/line references without confusing file names with agent mentions', () => {
    setInputText('/btw @build.ts Explain this');
    setState('editorContext', 'workspacePath', '/repo');
    setState('droppedFiles', [
      { path: '/repo/build.ts', relativePath: 'build.ts', type: 'file' },
      {
        path: '/repo/other.ts',
        relativePath: 'other.ts',
        type: 'file',
        lineRanges: [{ startLine: 2, endLine: 4 }],
      },
    ]);
    const files = state.droppedFiles;
    expect(sideQuestionUnavailableReason()).toBeNull();
    expect(openSideQuestion('@build.ts Explain this')).toBe(true);
    expect(sideQuestionView()?.question).toBe('@build.ts Explain this');
    expect(sideQuestionView()?.context).toContain('[Attached file: build.ts]');
    expect(sideQuestionView()?.context).toContain('[Selection from other.ts lines 2-4]');
    expect(state.droppedFiles).toBe(files);
  });

  it('captures editor and terminal text as an immutable snapshot', () => {
    setState('editorContext', 'workspacePath', '/repo');
    setState('editorContext', 'editorText', {
      kind: 'selection',
      path: '/repo/file.ts',
      relativePath: 'file.ts',
      language: 'typescript',
      range: { startLine: 2, endLine: 3 },
      text: 'const captured = 42;',
      truncated: false,
    });
    setState('terminalSelection', { terminalName: 'Tests', text: 'Assertion failed' });
    expect(openSideQuestion('Why?')).toBe(true);
    const context = sideQuestionView()?.context;
    expect(context).toContain('[Unsaved selection from file.ts lines 2-3]');
    expect(context).toContain('const captured = 42;');
    expect(context).toContain('[Selection from terminal Tests]');
    expect(context).toContain('Assertion failed');
    setState('editorContext', 'editorText', 'text', 'changed');
    expect(sideQuestionView()?.context).toBe(context);
  });

  it('omits automatic file and Problems context when their settings are disabled', () => {
    setState('autoAttachActiveFile', false);
    setState('autoAttachProblems', false);
    setState('editorContext', {
      workspacePath: '/repo',
      activeFile: { path: '/repo/file.ts', relativePath: 'file.ts', language: 'typescript' },
      selection: null,
      diagnostics: [
        { path: '/repo/file.ts', severity: 'error', line: 1, message: 'Automatic error' },
      ],
    });
    expect(openSideQuestion('Why?')).toBe(true);
    expect(sideQuestionView()?.context ?? '').toBe('');
  });

  it('includes pasted text instead of sending an unreadable data URL', () => {
    setState('droppedFiles', [
      {
        path: 'varro-paste:one',
        relativePath: 'pasted.txt',
        type: 'file',
        pastedText: 'kept text',
      },
    ]);
    expect(openSideQuestion('Explain')).toBe(true);
    expect(sideQuestionView()?.context).toContain('[Unsaved buffer from pasted.txt lines 1-1]');
    expect(sideQuestionView()?.context).toContain('kept text');
    expect(sideQuestionView()?.context).not.toContain('data:');
  });

  it('includes explicitly attached diagnostics instead of losing inline problem context', () => {
    setState('autoAttachProblems', true);
    setState('attachedDiagnostics', {
      inline: true,
      total: 1,
      diagnostics: [
        { path: '/repo/file.ts', severity: 'error', message: 'Expected a number', line: 2 },
      ],
    });
    setInputText('/btw [Problems] Explain');
    expect(openSideQuestion('[Problems] Explain')).toBe(true);
    expect(sideQuestionView()?.context).toContain('Expected a number');
    closeSideQuestion();
    expect(openSideQuestion()).toBe(true);
    expect(sideQuestionView()?.question).toBe('');
    expect(sideQuestionView()?.context).toContain('Expected a number');
    expect(inputText()).toBe('/btw [Problems] Explain');
  });

  it('blocks a disabled problems marker rather than stripping it from the prompt', () => {
    setState('autoAttachProblems', false);
    setInputText('/btw [Problems] Explain');
    expect(sideQuestionUnavailableReason()).toContain('Enable problems context');
    expect(openSideQuestion('[Problems] Explain')).toBe(false);
    expect(inputText()).toBe('/btw [Problems] Explain');
  });

  it('does not silently truncate oversized attached context', () => {
    setInputText('/btw Explain');
    setState('droppedFiles', [
      {
        path: 'varro-paste:one',
        relativePath: 'pasted.txt',
        type: 'file',
        pastedText: 'x'.repeat(MAX_SIDE_QUESTION_LENGTH),
      },
    ]);
    expect(openSideQuestion('Explain')).toBe(false);
    expect(sideQuestionView()).toBeNull();
    expect(inputText()).toBe('/btw Explain');
    expect(state.droppedFiles[0]?.pastedText).toHaveLength(MAX_SIDE_QUESTION_LENGTH);
    expect(feedback.showSessionActionFeedback).toHaveBeenCalledWith(
      'Question and context exceed the side-question limit',
      'warning'
    );
  });
});
