import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { OpenCodePathAliases } from './opencode-path-aliases';

// Windows keeps directory spellings unchanged; see OpenCodePathAliases.enabled.
describe.skipIf(process.platform === 'win32')('OpenCodePathAliases', () => {
  let root: string;
  let physical: string;
  let logical: string;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'varro-path-aliases-')));
    physical = join(root, 'data', 'Project');
    logical = join(root, 'home', 'Project');
    await mkdir(physical, { recursive: true });
    await mkdir(join(root, 'home'));
    await symlink(physical, logical, 'dir');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('sends physical directories and restores the editor spelling in server data', () => {
    const aliases = new OpenCodePathAliases();

    expect(aliases.toServerDirectory(`${logical}/`)).toBe(physical);
    expect(aliases.toServerDirectory(join(logical, 'missing'))).toBe(join(physical, 'missing'));
    expect(
      aliases.fromServer({
        sessions: [{ directory: physical, files: [join(physical, 'src', 'a.ts')] }],
        sibling: `${physical}-other`,
        output: `${physical}\n${physical}/src`,
        title: 'unchanged',
      })
    ).toEqual({
      sessions: [{ directory: logical, files: [join(logical, 'src', 'a.ts')] }],
      sibling: `${physical}-other`,
      output: `${physical}\n${physical}/src`,
      title: 'unchanged',
    });
  });

  it('rewrites request directories in query parameters and bodies', () => {
    const aliases = new OpenCodePathAliases();
    const query = `?location%5Bdirectory%5D=${encodeURIComponent(logical)}&limit=5`;

    const path = new URL(aliases.toServerRequestPath(`/api/session${query}`), 'http://localhost');

    expect(path.searchParams.get('location[directory]')).toBe(physical);
    expect(path.searchParams.get('limit')).toBe('5');
    expect(aliases.toServerRequestPath('/api/session?limit=5')).toBe('/api/session?limit=5');
    expect(
      aliases.toServer({ location: { directory: logical }, path: join(logical, 'README.md') })
    ).toEqual({ location: { directory: physical }, path: join(physical, 'README.md') });
  });

  it('keeps values unchanged without a symlinked directory', () => {
    const aliases = new OpenCodePathAliases();
    const data = { directory: physical };

    expect(aliases.toServerDirectory(physical)).toBe(physical);
    expect(aliases.toServerDirectory('/missing/varro/workspace')).toBe('/missing/varro/workspace');
    expect(aliases.fromServer(data)).toBe(data);
  });

  it('preserves exact paths when aliasing is disabled', () => {
    let enabled = false;
    const aliases = new OpenCodePathAliases(() => enabled);

    expect(aliases.toServerDirectory(logical)).toBe(logical);
    enabled = true;
    expect(aliases.toServerDirectory(logical)).toBe(physical);
    enabled = false;
    expect(aliases.fromServer({ directory: physical })).toEqual({ directory: physical });
  });
});
