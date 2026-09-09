import { createComputed, createRoot } from 'solid-js';
import { afterEach, describe, expect, it } from 'vitest';
import type { Session } from '../types';
import { resetDefaultAppState, setState, state } from './state';
import {
  getSessionReferenceContextKey,
  resolveSessionReference,
  SESSION_ID_RE,
  splitSessionReferenceText,
} from './session-reference';

function session(id: string, title = id, directory = '/repo'): Session {
  return {
    id,
    title,
    directory,
    projectID: 'project',
    version: '1',
    time: { created: 0, updated: 0 },
  };
}

afterEach(resetDefaultAppState);

const resolvers = [
  { name: 'context key', resolve: getSessionReferenceContextKey },
  { name: 'text segments', resolve: splitSessionReferenceText },
];

describe('session references', () => {
  it.each(resolvers)(
    '$name traverses the catalog at most once for many references',
    ({ resolve }) => {
      let idReads = 0;
      const count = 1000;
      setState(
        'sessions',
        Array.from({ length: count }, (_, index) => ({
          ...session(`ses_${index}`),
          get id() {
            idReads += 1;
            return `ses_${index}`;
          },
        }))
      );
      const content = Array.from(
        { length: 40 },
        (_, index) => `session:ses_${count - index - 1}`
      ).join(' ');
      idReads = 0;
      resolve(content);
      expect(idReads).toBeLessThan(count * 2);
    }
  );

  it.each(resolvers)(
    '$name preserves zero-reference and single-reference short circuits',
    ({ resolve }) => {
      let unrelatedReads = 0;
      setState('sessions', [
        session('ses_first'),
        {
          ...session('ses_other'),
          get id() {
            unrelatedReads += 1;
            return 'ses_other';
          },
        },
      ]);
      unrelatedReads = 0;
      resolve('Plain text without references');
      resolve('See ses_first');
      expect(unrelatedReads).toBe(0);
    }
  );

  it('matches the previous context-key contract for mixed and repeated markers', () => {
    setState('editorContext', 'workspaceFolders', [
      { name: 'repo', path: '/repo' },
      { name: 'other', path: '/other' },
    ]);
    setState('sessions', [
      ...Array.from({ length: 30 }, (_, index) =>
        session(`ses_${index}`, index % 3 ? `Title ${index}` : '', index % 2 ? '/other' : '/repo')
      ),
      session('ses_0', 'Duplicate must not win'),
    ]);
    for (let round = 0; round < 100; round++) {
      const content = Array.from(
        { length: round % 50 },
        (_, index) => `${index % 2 ? 'session:' : ''}ses_${(index * 7 + round) % 40}`
      ).join(' prose ');
      const expected = [
        ...new Set(Array.from(content.matchAll(SESSION_ID_RE), (match) => match[0])),
      ]
        .map((marker) => {
          const match = Array.from(marker.matchAll(SESSION_ID_RE))[0]!;
          const reference = resolveSessionReference(match[1] || match[2]!, marker);
          return reference
            ? `found:${reference.id}:${reference.directory}:${reference.title}:${reference.folderLabel ?? ''}`
            : `missing:${marker}`;
        })
        .join('\u0000');
      expect(getSessionReferenceContextKey(content)).toBe(expected);
    }
  });

  it('preserves segment order, missing text, repeated markers, and first duplicate ownership', () => {
    setState('sessions', [
      session('ses_a', 'First'),
      session('ses_a', 'Duplicate'),
      session('ses_b', 'Second'),
    ]);
    expect(splitSessionReferenceText('ses_a ses_missing session:ses_b ses_a')).toEqual([
      { type: 'session', reference: resolveSessionReference('ses_a', 'ses_a') },
      { type: 'text', content: ' ses_missing ' },
      { type: 'session', reference: resolveSessionReference('ses_b', 'session:ses_b') },
      { type: 'text', content: ' ' },
      { type: 'session', reference: resolveSessionReference('ses_a', 'ses_a') },
    ]);
    expect(getSessionReferenceContextKey('ses_a ses_b')).toContain('found:ses_a:/repo:First:');
  });

  it('reacts to discovery, renaming, folder changes, reordering, and removal', () => {
    let key = '';
    const dispose = createRoot((cleanup) => {
      createComputed(() => {
        key = getSessionReferenceContextKey('ses_a ses_b');
      });
      return cleanup;
    });
    try {
      expect(key).toBe('missing:ses_a\u0000missing:ses_b');
      setState('sessions', [session('ses_a', 'Original'), session('ses_b', 'Other')]);
      expect(key).toContain('found:ses_a:/repo:Original:');
      setState('sessions', 0, 'title', 'Renamed');
      expect(key).toContain('found:ses_a:/repo:Renamed:');
      setState('editorContext', 'workspaceFolders', [
        { name: 'repo', path: '/repo' },
        { name: 'other', path: '/other' },
      ]);
      setState('sessions', 0, 'directory', '/other');
      expect(key).toContain('found:ses_a:/other:Renamed:other');
      setState('sessions', [state.sessions[1]!, state.sessions[0]!]);
      expect(key).toContain('found:ses_a:/other:Renamed:other');
      setState('sessions', [state.sessions[0]!]);
      expect(key).toContain('missing:ses_a');
    } finally {
      dispose();
    }
  });
});
