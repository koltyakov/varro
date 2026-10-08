import { describe, expect, it } from 'vitest';
import { getLinkContext } from './link-context';

describe('getLinkContext', () => {
  it('replaces selection-based Copy with the complete displayed link text', () => {
    expect(JSON.parse(getLinkContext('Project folder', { path: '/repo/project' }))).toEqual({
      preventDefaultContextMenuItems: true,
      varroLinkText: 'Project folder',
      webviewSection: 'varroFileLink',
      varroFilePath: '/repo/project',
    });
  });

  it('keeps a labeled URL separate from its displayed text', () => {
    const url = 'https://example.com/docs?q=one&next=two#section';
    expect(JSON.parse(getLinkContext('Example docs', { url }))).toEqual({
      preventDefaultContextMenuItems: true,
      varroLinkText: 'Example docs',
      webviewSection: 'varroExternalLink',
      varroLinkUrl: url,
    });
  });

  it('offers whole-text Copy for session links without an external or file target', () => {
    expect(JSON.parse(getLinkContext('Permission request states'))).toEqual({
      preventDefaultContextMenuItems: true,
      varroLinkText: 'Permission request states',
      webviewSection: 'varroLink',
    });
  });
});
