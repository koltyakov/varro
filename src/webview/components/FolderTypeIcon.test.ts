import { describe, expect, it } from 'vitest';
import folderIcon from 'material-icon-theme/icons/folder.svg';
import docsIcon from 'material-icon-theme/icons/folder-docs.svg';
import githubIcon from 'material-icon-theme/icons/folder-github.svg';
import gradleIcon from 'material-icon-theme/icons/folder-gradle.svg';
import srcIcon from 'material-icon-theme/icons/folder-src.svg';
import { getFolderTypeIcon, hasRecognizedFolderType } from './FolderTypeIcon';

describe('getFolderTypeIcon', () => {
  it('uses conventional folder names regardless of path or case', () => {
    expect(getFolderTypeIcon('/repo/docs/')).toBe(docsIcon);
    expect(getFolderTypeIcon('C:\\repo\\SRC')).toBe(srcIcon);
    expect(getFolderTypeIcon('/repo/.github')).toBe(githubIcon);
    expect(getFolderTypeIcon('/repo/.gradle')).toBe(gradleIcon);
    expect(getFolderTypeIcon('/repo/gradle')).toBe(gradleIcon);
    expect(hasRecognizedFolderType('/repo/docs')).toBe(true);
  });

  it('uses a generic folder for unfamiliar names', () => {
    expect(getFolderTypeIcon('/repo/custom')).toBe(folderIcon);
    expect(hasRecognizedFolderType('/repo/custom')).toBe(false);
  });
});
