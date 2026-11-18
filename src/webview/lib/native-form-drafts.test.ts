import { flush as flushSolid } from 'solid-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { QuestionRequest } from '../types';

const storageKey = 'varro.nativeFormDrafts.v1';
beforeEach(() => {
  vi.resetModules();
  flushSolid();
  window.localStorage.clear();
  flushSolid();
});

describe('native form draft checkpoints', () => {
  it.each(['ask', 'snapshot'])(
    'retains a restored draft during initial %s hydration',
    async (kind) => {
      const { nativeFormDrafts } = await import('./native-form-drafts');
      flushSolid();
      const draft = {
        id: 'frm_hydrated',
        sessionID: 'ses_child',
        values: { answer: 'keep this', zero: 0, no: false },
        custom: { selection: 'unfinished' },
      };
      nativeFormDrafts.save(draft);
      flushSolid();
      vi.resetModules();
      flushSolid();
      const reloaded = await import('./native-form-drafts');
      flushSolid();
      const permissions = await import('./state-permissions');
      flushSolid();
      const question: QuestionRequest = {
        id: draft.id,
        sessionID: draft.sessionID,
        questions: [],
        kind: 'native-form',
        form: {
          id: draft.id,
          sessionID: draft.sessionID,
          title: 'Pending input',
          fields: [{ key: 'answer', type: 'string' }],
        },
      };

      if (kind === 'ask') permissions.upsertQuestion(question);
      else permissions.setQuestions([question]);
      flushSolid();

      expect(reloaded.nativeFormDrafts.get(draft.id, draft.sessionID)).toEqual(draft);
      permissions.upsertQuestion(question);
      flushSolid();
      expect(reloaded.nativeFormDrafts.get(draft.id, draft.sessionID)).toEqual(draft);

      permissions.removeResolvedQuestion(question.id);
      flushSolid();
      expect(reloaded.nativeFormDrafts.get(draft.id, draft.sessionID)).toBeUndefined();
      reloaded.nativeFormDrafts.save(draft);
      flushSolid();
      permissions.upsertQuestion(question);
      flushSolid();
      expect(reloaded.nativeFormDrafts.get(draft.id, draft.sessionID)).toBeUndefined();
    }
  );

  it('removes a draft when an authoritative snapshot resolves its pending request', async () => {
    const { nativeFormDrafts } = await import('./native-form-drafts');
    flushSolid();
    const { setQuestions } = await import('./state-permissions');
    flushSolid();
    const question: QuestionRequest = { id: 'frm_resolved', sessionID: 'ses_one', questions: [] };
    setQuestions([question]);
    flushSolid();
    nativeFormDrafts.save({
      id: question.id,
      sessionID: question.sessionID,
      values: { answer: 'no longer pending' },
      custom: {},
    });
    flushSolid();

    setQuestions([]);
    flushSolid();

    expect(nativeFormDrafts.get(question.id, question.sessionID)).toBeUndefined();
  });

  it('restores values and unfinished custom selections after a module reload', async () => {
    const { nativeFormDrafts } = await import('./native-form-drafts');
    flushSolid();
    const draft = {
      id: 'frm_one',
      sessionID: 'ses_child',
      values: { zero: 0, no: false, empty: '', selection: [] },
      custom: { selection: 'unfinished' },
    };
    nativeFormDrafts.save(draft);
    flushSolid();
    vi.resetModules();
    flushSolid();
    const reloaded = await import('./native-form-drafts');
    flushSolid();
    expect(reloaded.nativeFormDrafts.get('frm_one', 'ses_child')).toEqual(draft);
    expect(reloaded.nativeFormDrafts.get('frm_one', 'ses_other')).toBeUndefined();
    reloaded.nativeFormDrafts.remove('frm_one');
    flushSolid();
    expect(window.localStorage.getItem(storageKey)).toBeNull();
  });
  it('bounds the cache and rejects malformed or oversized saved drafts', async () => {
    window.localStorage.setItem(
      storageKey,
      JSON.stringify({
        version: 1,
        entries: [{ id: 'frm_bad', sessionID: 'ses_one', values: { n: null }, custom: {} }],
      })
    );
    flushSolid();
    const { nativeFormDrafts } = await import('./native-form-drafts');
    flushSolid();
    expect(nativeFormDrafts.get('frm_bad', 'ses_one')).toBeUndefined();
    for (let index = 0; index < 101; index++)
      nativeFormDrafts.save({
        id: `frm_${index}`,
        sessionID: 'ses_one',
        values: { v: index },
        custom: {},
      });
    expect(nativeFormDrafts.get('frm_0', 'ses_one')).toBeUndefined();
    expect(nativeFormDrafts.get('frm_100', 'ses_one')?.values).toEqual({ v: 100 });
    nativeFormDrafts.save({
      id: 'frm_big',
      sessionID: 'ses_one',
      values: { text: 'x'.repeat(65_536) },
      custom: {},
    });
    flushSolid();
    expect(nativeFormDrafts.get('frm_big', 'ses_one')).toBeUndefined();
  });

  it('restores selected and unchecked custom rows and rejects malformed row state', async () => {
    window.localStorage.setItem(
      storageKey,
      JSON.stringify({
        version: 1,
        entries: [
          {
            id: 'frm_bad_rows',
            sessionID: 'ses_child',
            values: {},
            custom: {},
            multiselectRows: { choices: [{ id: 'row_bad', value: 'text', selected: 'yes' }] },
          },
        ],
      })
    );
    flushSolid();
    const { nativeFormDrafts } = await import('./native-form-drafts');
    flushSolid();
    expect(nativeFormDrafts.get('frm_bad_rows', 'ses_child')).toBeUndefined();
    const draft = {
      id: 'frm_rows',
      sessionID: 'ses_child',
      values: { choices: [] },
      custom: {},
      multiselectRows: {
        choices: [
          { id: 'first', value: 'Selected\nvalue', selected: true },
          { id: 'second', value: 'Unchecked draft', selected: false },
          { id: 'blank', value: '', selected: false },
        ],
      },
    };
    nativeFormDrafts.save(draft);
    flushSolid();
    vi.resetModules();
    flushSolid();
    const reloaded = await import('./native-form-drafts');
    flushSolid();
    expect(reloaded.nativeFormDrafts.get('frm_rows', 'ses_child')).toEqual(draft);
  });
});
