import folderIcon from 'material-icon-theme/icons/folder.svg';
import componentsIcon from 'material-icon-theme/icons/folder-components.svg';
import configIcon from 'material-icon-theme/icons/folder-config.svg';
import coverageIcon from 'material-icon-theme/icons/folder-coverage.svg';
import distIcon from 'material-icon-theme/icons/folder-dist.svg';
import docsIcon from 'material-icon-theme/icons/folder-docs.svg';
import environmentIcon from 'material-icon-theme/icons/folder-environment.svg';
import gitIcon from 'material-icon-theme/icons/folder-git.svg';
import githubIcon from 'material-icon-theme/icons/folder-github.svg';
import gradleIcon from 'material-icon-theme/icons/folder-gradle.svg';
import intellijIcon from 'material-icon-theme/icons/folder-intellij.svg';
import kotlinIcon from 'material-icon-theme/icons/folder-kotlin.svg';
import libIcon from 'material-icon-theme/icons/folder-lib.svg';
import nextIcon from 'material-icon-theme/icons/folder-next.svg';
import nodeIcon from 'material-icon-theme/icons/folder-node.svg';
import opencodeIcon from 'material-icon-theme/icons/folder-opencode.svg';
import publicIcon from 'material-icon-theme/icons/folder-public.svg';
import resourceIcon from 'material-icon-theme/icons/folder-resource.svg';
import scriptsIcon from 'material-icon-theme/icons/folder-scripts.svg';
import srcIcon from 'material-icon-theme/icons/folder-src.svg';
import targetIcon from 'material-icon-theme/icons/folder-target.svg';
import testIcon from 'material-icon-theme/icons/folder-test.svg';
import vscodeIcon from 'material-icon-theme/icons/folder-vscode.svg';
import { getLeafPathName } from '../lib/path-display';

const FOLDER_NAME_ICONS = new Map<string, string>(
  Object.entries({
    '.git': gitIcon,
    '.github': githubIcon,
    '.gradle': gradleIcon,
    '.idea': intellijIcon,
    '.kotlin': kotlinIcon,
    '.next': nextIcon,
    '.opencode': opencodeIcon,
    '.venv': environmentIcon,
    '.vscode': vscodeIcon,
    __tests__: testIcon,
    assets: resourceIcon,
    build: distIcon,
    components: componentsIcon,
    config: configIcon,
    coverage: coverageIcon,
    dist: distIcon,
    docs: docsIcon,
    e2e: coverageIcon,
    gradle: gradleIcon,
    lib: libIcon,
    node_modules: nodeIcon,
    out: distIcon,
    public: publicIcon,
    scripts: scriptsIcon,
    src: srcIcon,
    target: targetIcon,
    test: testIcon,
    tests: testIcon,
  })
);

export function getFolderTypeIcon(path: string): string {
  return FOLDER_NAME_ICONS.get(getLeafPathName(path).toLowerCase()) ?? folderIcon;
}

export function hasRecognizedFolderType(path: string): boolean {
  return FOLDER_NAME_ICONS.has(getLeafPathName(path).toLowerCase());
}

export function FolderTypeIcon(props: { path: string; class?: string }) {
  return (
    <img
      class={props.class ? `file-type-icon ${props.class}` : 'file-type-icon'}
      src={getFolderTypeIcon(props.path)}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}
