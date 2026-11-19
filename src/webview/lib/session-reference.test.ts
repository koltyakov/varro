import { flush as flushSolid, createEffect, createRoot } from 'solid-js';
import { storePath } from '@solidjs/signals';
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
  it('resolves external metadata without adding it to the workspace catalog', () => {
    setState(
      storePath('sessionLookups', 'ses_other', {
        id: 'ses_other',
        title: 'Other project investigation',
        directory: '/projects/other',
        external: true,
      })
    );
    flushSolid();
    expect(resolveSessionReference('ses_other')).toMatchObject({
      title: 'Other project investigation',
      directory: '/projects/other',
      folderLabel: 'other',
      external: true,
    });
    flushSolid();
    expect(splitSessionReferenceText('ses_other session:ses_other')).toEqual([
      { type: 'session', reference: resolveSessionReference('ses_other', 'ses_other') },
      { type: 'text', content: ' ' },
      { type: 'session', reference: resolveSessionReference('ses_other', 'session:ses_other') },
    ]);
    flushSolid();
    expect(getSessionReferenceContextKey('ses_other')).toContain(':other:external');
    expect(state.sessions).toEqual([]);
    setState(storePath('sessions', [session('ses_other', 'Live catalog title')]));
    flushSolid();
    expect(resolveSessionReference('ses_other')?.title).toBe('Live catalog title');
    flushSolid();
    expect(resolveSessionReference('ses_other')?.external).toBeUndefined();
    flushSolid();
  });
  it.each(resolvers)(
    '$name traverses the catalog at most once for many references',
    ({ resolve }) => {
      let idReads = 0;
      const count = 1000;
      setState(
        storePath(
          'sessions',
          Array.from({ length: count }, (_, index) => ({
            ...session(`ses_${index}`),
            get id() {
              idReads += 1;
              return `ses_${index}`;
            },
          }))
        )
      );
      flushSolid();
      const content = Array.from(
        { length: 40 },
        (_, index) => `session:ses_${count - index - 1}`
      ).join(' ');
      idReads = 0;
      resolve(content);
      flushSolid();
      expect(idReads).toBeLessThan(count * 2);
    }
  );

  it.each(resolvers)(
    '$name preserves zero-reference and single-reference short circuits',
    ({ resolve }) => {
      let unrelatedReads = 0;
      setState(
        storePath('sessions', [
          session('ses_first'),
          {
            ...session('ses_other'),
            get id() {
              unrelatedReads += 1;
              return 'ses_other';
            },
          },
        ])
      );
      flushSolid();
      unrelatedReads = 0;
      resolve('Plain text without references');
      flushSolid();
      resolve('See ses_first');
      flushSolid();
      expect(unrelatedReads).toBe(0);
    }
  );

  it('matches the previous context-key contract for mixed and repeated markers', () => {
    setState(
      storePath('editorContext', 'workspaceFolders', [
        { name: 'repo', path: '/repo' },
        { name: 'other', path: '/other' },
      ])
    );
    flushSolid();
    setState(
      storePath('sessions', [
        ...Array.from({ length: 30 }, (_, index) =>
          session(`ses_${index}`, index % 3 ? `Title ${index}` : '', index % 2 ? '/other' : '/repo')
        ),
        session('ses_0', 'Duplicate must not win'),
      ])
    );
    flushSolid();
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
    setState(
      storePath('sessions', [
        session('ses_a', 'First'),
        session('ses_a', 'Duplicate'),
        session('ses_b', 'Second'),
      ])
    );
    flushSolid();
    expect(splitSessionReferenceText('ses_a ses_missing session:ses_b ses_a')).toEqual([
      { type: 'session', reference: resolveSessionReference('ses_a', 'ses_a') },
      { type: 'text', content: ' ses_missing ' },
      { type: 'session', reference: resolveSessionReference('ses_b', 'session:ses_b') },
      { type: 'text', content: ' ' },
      { type: 'session', reference: resolveSessionReference('ses_a', 'ses_a') },
    ]);
    flushSolid();
    expect(getSessionReferenceContextKey('ses_a ses_b')).toContain('found:ses_a:/repo:First:');
  });

  it('reacts to discovery, renaming, folder changes, reordering, and removal', () => {
    let key = '';
    const dispose = createRoot((cleanup) => {
      createEffect(
        () => getSessionReferenceContextKey('ses_a ses_b'),
        (value) => {
          key = value;
        }
      );
      return cleanup;
    });
    flushSolid();
    try {
      expect(key).toBe('missing:ses_a\u0000missing:ses_b');
      setState(storePath('sessions', [session('ses_a', 'Original'), session('ses_b', 'Other')]));
      flushSolid();
      expect(key).toContain('found:ses_a:/repo:Original:');
      setState(storePath('sessions', 0, 'title', 'Renamed'));
      flushSolid();
      expect(key).toContain('found:ses_a:/repo:Renamed:');
      setState(
        storePath('editorContext', 'workspaceFolders', [
          { name: 'repo', path: '/repo' },
          { name: 'other', path: '/other' },
        ])
      );
      flushSolid();
      setState(storePath('sessions', 0, 'directory', '/other'));
      flushSolid();
      expect(key).toContain('found:ses_a:/other:Renamed:other');
      setState(storePath('sessions', [state.sessions[1]!, state.sessions[0]!]));
      flushSolid();
      expect(key).toContain('found:ses_a:/other:Renamed:other');
      setState(storePath('sessions', [state.sessions[0]!]));
      flushSolid();
      expect(key).toContain('missing:ses_a');
    } finally {
      dispose();
      flushSolid();
    }
  });
});
