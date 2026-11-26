import { flush as flushSolid } from 'solid-js';
import { storePath } from '@solidjs/signals';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@solidjs/web';
import type {
  OpenCodeGlobalPermissionConfig,
  OpenCodePermissionConfig,
  PermissionRule,
} from '../../shared/opencode-types';
import type { WebviewMessage } from '../../shared/protocol';
import type { SkillSummary } from '../lib/client';
import {
  resetDefaultAppState,
  setShowSkillSettings,
  setState,
  showSkillSettings,
} from '../lib/state';
import { SkillSettingsPanel } from './SkillSettingsPanel';

const mocks = vi.hoisted(() => ({
  list: vi.fn<() => Promise<SkillSummary[]>>(),
  projectConfig: vi.fn<() => Promise<OpenCodePermissionConfig>>(),
  globalConfig: vi.fn<() => Promise<OpenCodeGlobalPermissionConfig>>(),
  saveProject: vi.fn<(rules: PermissionRule[]) => Promise<OpenCodePermissionConfig>>(),
  saveGlobal: vi.fn<(rules: PermissionRule[]) => Promise<OpenCodeGlobalPermissionConfig>>(),
  openConfig: vi.fn<(scope: 'global' | 'project') => Promise<void>>(),
  postMessage: vi.fn<(message: WebviewMessage) => boolean>(),
}));

/* oxlint-disable anti-slop/no-module-mocking -- Exercise skill settings against the client and bridge boundaries. */
vi.mock('../lib/client', () => ({
  client: {
    skill: { list: mocks.list },
    mcp: { openConfig: mocks.openConfig },
    varro: {
      openCodePermissionConfig: mocks.projectConfig,
      openCodeGlobalPermissionConfig: mocks.globalConfig,
      saveOpenCodePermissionConfig: mocks.saveProject,
      saveOpenCodeGlobalPermissionConfig: mocks.saveGlobal,
    },
  },
}));
vi.mock('../lib/bridge', () => ({ postMessage: mocks.postMessage }));

const GLOBAL_PATH = '/home/.config/opencode/opencode.json';
let globalRules: PermissionRule[];
let projectRules: PermissionRule[];
let container: HTMLDivElement;
let cleanup: (() => void) | undefined;

async function flush() {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
  flushSolid();
}

function projectConfig(): OpenCodePermissionConfig {
  return {
    targetPath: '/repo/opencode.json',
    projectRules: structuredClone(projectRules),
    inheritedSources: [{ path: GLOBAL_PATH, rules: structuredClone(globalRules), scope: 'global' }],
    effectiveRules: [],
  };
}

function openTab(label: 'This project' | 'Global') {
  const tab = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
    (element) => element.textContent === label
  );
  if (!tab) throw new Error(`Missing ${label} tab`);
  tab.click();
  flushSolid();
}

function row(id: string) {
  const element = [...container.querySelectorAll<HTMLElement>('.mcp-settings-server')].find(
    (candidate) => candidate.querySelector('label span')?.textContent === id
  );
  if (!element) throw new Error(`Missing row for ${id}`);
  return element;
}

function checkbox(id: string) {
  return row(id).querySelector<HTMLInputElement>('input[type="checkbox"]')!;
}

function button(id: string, label: string) {
  return [...row(id).querySelectorAll<HTMLButtonElement>('button')].find(
    (element) => element.textContent === label
  );
}

async function renderPanel() {
  cleanup = render(() => SkillSettingsPanel(), container);
  flushSolid();
  await flush();
}

function hideDisabledToggle() {
  const label = [...container.querySelectorAll<HTMLLabelElement>('.skill-settings-filter')][0];
  if (!label) throw new Error('Missing Hide disabled toggle');
  return label;
}

function listedSkills() {
  return [...container.querySelectorAll('.mcp-settings-server label span')].map(
    (element) => element.textContent
  );
}

beforeEach(() => {
  localStorage.clear();
  flushSolid();
  resetDefaultAppState();
  flushSolid();
  setShowSkillSettings(true);
  setState(storePath('editorContext', 'workspacePath', '/repo'));
  flushSolid();
  globalRules = [rule('skill', 'legacy', 'deny')];
  projectRules = [];
  mocks.list.mockReset().mockResolvedValue([
    { id: 'review', name: 'review', description: 'Review code', path: '/skills/review/SKILL.md' },
    { id: 'legacy', name: 'legacy', description: '' },
  ]);
  mocks.projectConfig.mockReset().mockImplementation(async () => projectConfig());
  mocks.globalConfig.mockReset().mockImplementation(async () => ({
    targetPath: GLOBAL_PATH,
    rules: structuredClone(globalRules),
    supportsPatterns: false,
  }));
  mocks.saveProject.mockReset().mockImplementation(async (rules) => {
    projectRules = rules;
    return projectConfig();
  });
  mocks.saveGlobal.mockReset().mockImplementation(async (rules) => {
    globalRules = rules;
    return { targetPath: GLOBAL_PATH, rules, supportsPatterns: false };
  });
  mocks.openConfig.mockReset().mockResolvedValue(undefined);
  mocks.postMessage.mockReset().mockReturnValue(true);
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  flushSolid();
  container.remove();
  resetDefaultAppState();
  flushSolid();
});

function rule(permission: string, pattern: string, action: PermissionRule['action']) {
  return { permission, pattern, action };
}

describe('SkillSettingsPanel', () => {
  it('lists skills sorted by ID with their effective global state', async () => {
    await renderPanel();

    const names = [...container.querySelectorAll('.mcp-settings-server label span')].map(
      (element) => element.textContent
    );
    expect(names).toEqual(['legacy', 'review']);
    expect(checkbox('legacy').checked).toBe(false);
    expect(checkbox('review').checked).toBe(true);
    expect(row('review').textContent).toContain('Review code');
  });

  it('denies a skill globally', async () => {
    await renderPanel();

    checkbox('review').click();
    await flush();

    expect(mocks.saveGlobal).toHaveBeenCalledWith([
      rule('skill', 'legacy', 'deny'),
      rule('skill', 'review', 'deny'),
    ]);
    expect(checkbox('review').checked).toBe(false);
  });

  it('overrides a global deny in this project and resets it', async () => {
    await renderPanel();
    openTab('This project');
    expect(checkbox('legacy').checked).toBe(false);

    checkbox('legacy').click();
    await flush();

    expect(mocks.saveProject).toHaveBeenLastCalledWith([rule('skill', 'legacy', 'allow')]);
    expect(checkbox('legacy').checked).toBe(true);
    openTab('Global');
    expect(row('legacy').textContent).toContain('On in this project');
    openTab('This project');

    button('legacy', 'Use global')!.click();
    await flush();

    expect(mocks.saveProject).toHaveBeenLastCalledWith([]);
    expect(checkbox('legacy').checked).toBe(false);
    expect(button('legacy', 'Use global')).toBeUndefined();
  });

  it('hides disabled skills but keeps one just turned off until the view changes', async () => {
    await renderPanel();
    expect(hideDisabledToggle().textContent).toBe('Hide disabled (1)');

    hideDisabledToggle().querySelector('input')!.click();
    flushSolid();
    expect(listedSkills()).toEqual(['review']);
    expect(localStorage.getItem('varro.skillSettingsHideDisabled')).toBe('true');

    checkbox('review').click();
    await flush();
    expect(mocks.saveGlobal).toHaveBeenCalledOnce();
    expect(listedSkills()).toEqual(['review']);
    expect(checkbox('review').checked).toBe(false);
    expect(hideDisabledToggle().textContent).toBe('Hide disabled (2)');

    openTab('This project');
    expect(listedSkills()).toEqual([]);
    expect(container.querySelector('.mcp-settings-empty')?.textContent).toContain(
      'All skills are disabled here'
    );

    hideDisabledToggle().querySelector('input')!.click();
    flushSolid();
    expect(listedSkills()).toEqual(['legacy', 'review']);
    expect(localStorage.getItem('varro.skillSettingsHideDisabled')).toBeNull();
  });

  it('restores the saved Hide disabled choice', async () => {
    localStorage.setItem('varro.skillSettingsHideDisabled', 'true');
    await renderPanel();

    expect(hideDisabledToggle().querySelector('input')!.checked).toBe(true);
    expect(listedSkills()).toEqual(['review']);
  });

  it('opens SKILL.md for local skills only', async () => {
    await renderPanel();

    expect(button('legacy', 'Open')).toBeUndefined();
    button('review', 'Open')!.click();

    expect(mocks.postMessage).toHaveBeenCalledWith({
      type: 'vscode/open',
      payload: { path: '/skills/review/SKILL.md', kind: 'file' },
    });
  });

  it('shows skills read-only when permission config cannot load', async () => {
    mocks.projectConfig.mockRejectedValueOnce(new Error('Attach-only server'));
    await renderPanel();

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Attach-only server');
    expect(checkbox('review').disabled).toBe(true);

    const retry = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (element) => element.textContent === 'Retry'
    );
    retry!.click();
    await flush();

    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(checkbox('review').disabled).toBe(false);
  });

  it('closes from the back button', async () => {
    await renderPanel();

    container.querySelector<HTMLButtonElement>('[aria-label="Back"]')!.click();
    flushSolid();

    expect(showSkillSettings()).toBe(false);
  });
});
