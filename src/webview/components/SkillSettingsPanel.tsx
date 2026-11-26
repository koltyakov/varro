import { createEffect, createMemo, createSignal, For, onCleanup, onSettled, Show } from 'solid-js';
import type {
  OpenCodeGlobalPermissionConfig,
  OpenCodePermissionConfig,
  PermissionRule,
} from '../../shared/opencode-types';
import type { McpConfigScope } from '../../shared/mcp-config';
import { ariaBoolean } from '../lib/aria';
import { postMessage } from '../lib/bridge';
import { client } from '../lib/client';
import type { SkillSummary } from '../lib/client';
import { hasSkillRule, isSkillEnabled, setSkillRule } from '../lib/skill-permissions';
import { requestComposerFocus, setShowSkillSettings, state } from '../lib/state';
import { STORAGE_KEYS, readStored, writeStored } from '../lib/state-storage';
import { NavArrowLeftControlIcon } from './ControlIcons';

type SkillScope = McpConfigScope;

const SKILL_SCOPES: { scope: SkillScope; label: string; description: string }[] = [
  {
    scope: 'global',
    label: 'Global',
    description: 'Settings here apply to every project that does not override them.',
  },
  {
    scope: 'project',
    label: 'This project',
    description: 'Settings here apply only to this project and take priority over Global.',
  },
];

type SkillPermissions = {
  project: OpenCodePermissionConfig;
  global: OpenCodeGlobalPermissionConfig;
};

export function SkillSettingsPanel() {
  const [skills, setSkills] = createSignal<SkillSummary[] | null>(null);
  const [permissions, setPermissions] = createSignal<SkillPermissions | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [saving, setSaving] = createSignal(false);
  const [openingConfig, setOpeningConfig] = createSignal(false);
  const [error, setError] = createSignal('');
  const [scope, setScope] = createSignal<SkillScope>('global');
  const [pending, setPending] = createSignal<{
    id: string;
    scope: SkillScope;
    enabled: boolean;
  } | null>(null);
  const [hideDisabled, setHideDisabled] = createSignal(
    readStored<boolean>(STORAGE_KEYS.skillSettingsHideDisabled) === true
  );
  // Skills turned off while hidden stay listed until the filter or tab changes,
  // so a row does not vanish under the pointer.
  const [keptVisible, setKeptVisible] = createSignal<ReadonlySet<string>>(new Set());
  let generation = 0;
  let disposed = false;
  let backButton: HTMLButtonElement | undefined;
  let tabList: HTMLDivElement | undefined;

  const sortedSkills = createMemo(() =>
    (skills() ?? []).toSorted((left, right) => left.id.localeCompare(right.id))
  );
  const disabledCount = createMemo(
    () => sortedSkills().filter((skill) => !savedValue(skill.id, scope())).length
  );
  const visibleSkills = createMemo(() =>
    hideDisabled()
      ? sortedSkills().filter(
          (skill) => isChecked(skill.id, scope()) || keptVisible().has(skill.id)
        )
      : sortedSkills()
  );
  const activity = () => {
    if (openingConfig()) return 'Opening...';
    if (saving()) return 'Saving...';
    return loading() && skills() ? 'Refreshing...' : '';
  };
  const canEdit = () => !loading() && !saving() && permissions() !== null;

  // Global files in the order OpenCode applies them, with the target's rules replaced.
  function globalChain(current: SkillPermissions, targetRules = current.global.rules) {
    const sources = current.project.inheritedSources
      .filter((source) => source.scope === 'global')
      .toReversed();
    const target = sources.findIndex((source) => source.path === current.global.targetPath);
    const rules = sources.map((source) => source.rules);
    if (target === -1) rules.push(targetRules);
    else rules[target] = targetRules;
    return rules.flat();
  }

  // Every inherited file, then this project's target file, which OpenCode applies last.
  function projectChain(current: SkillPermissions, targetRules = current.project.projectRules) {
    return [
      ...current.project.inheritedSources.toReversed().flatMap((source) => source.rules),
      ...targetRules,
    ];
  }

  function savedValue(id: string, target: SkillScope) {
    const current = permissions();
    if (!current) return true;
    return isSkillEnabled(target === 'global' ? globalChain(current) : projectChain(current), id);
  }

  function isChecked(id: string, target: SkillScope) {
    const change = pending();
    return change?.id === id && change.scope === target ? change.enabled : savedValue(id, target);
  }

  function hasOverride(id: string) {
    const current = permissions();
    return current ? hasSkillRule(current.project.projectRules, id) : false;
  }

  function skillNote(id: string) {
    if (scope() !== 'global' || !permissions()) return '';
    const project = savedValue(id, 'project');
    if (project === savedValue(id, 'global')) return '';
    return project ? 'On in this project' : 'Off in this project';
  }

  function selectScope(next: SkillScope) {
    setScope(next);
    setKeptVisible(new Set<string>());
  }

  function changeHideDisabled(hidden: boolean) {
    setHideDisabled(hidden);
    setKeptVisible(new Set<string>());
    writeStored(STORAGE_KEYS.skillSettingsHideDisabled, hidden ? true : null);
  }

  function changeSkill(id: string, target: SkillScope, input: HTMLInputElement) {
    const enabled = input.checked;
    input.checked = isChecked(id, target);
    if (hideDisabled() && !enabled) setKeptVisible((ids) => new Set(ids).add(id));
    void saveSkill(id, target, enabled);
  }

  function openSkill(skill: SkillSummary) {
    if (skill.path)
      postMessage({ type: 'vscode/open', payload: { path: skill.path, kind: 'file' } });
  }

  function moveTab(event: KeyboardEvent) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const next = SKILL_SCOPES.find((item) => item.scope !== scope());
    if (!next) return;
    selectScope(next.scope);
    tabList?.querySelector<HTMLButtonElement>(`#skill-settings-tab-${next.scope}`)?.focus();
  }

  async function openConfig() {
    if (openingConfig() || saving()) return;
    const current = generation;
    setOpeningConfig(true);
    setError('');
    try {
      await client.mcp.openConfig(scope());
    } catch (cause) {
      if (!disposed && current === generation)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (!disposed && current === generation) setOpeningConfig(false);
    }
  }

  async function readPermissions(): Promise<SkillPermissions> {
    const [project, global] = await Promise.all([
      client.varro.openCodePermissionConfig(),
      client.varro.openCodeGlobalPermissionConfig(),
    ]);
    return { project, global };
  }

  async function load() {
    const current = ++generation;
    setLoading(true);
    setSaving(false);
    setOpeningConfig(false);
    setPending(null);
    setError('');
    const [skillResult, permissionResult] = await Promise.allSettled([
      client.skill.list(),
      readPermissions(),
    ]);
    if (disposed || current !== generation) return;
    if (skillResult.status === 'fulfilled') setSkills(skillResult.value);
    setPermissions(permissionResult.status === 'fulfilled' ? permissionResult.value : null);
    const failure = [skillResult, permissionResult].find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected')
      setError(failure.reason instanceof Error ? failure.reason.message : String(failure.reason));
    setLoading(false);
  }

  async function saveSkill(id: string, target: SkillScope, enabled: boolean | null) {
    const current = permissions();
    if (!current || !canEdit()) return;
    const request = generation;
    setSaving(true);
    setError('');
    if (enabled !== null) setPending({ id, scope: target, enabled });
    try {
      if (target === 'global') {
        const rules = setSkillRule(current.global.rules, id, enabled, (next: PermissionRule[]) =>
          globalChain(current, next)
        );
        await client.varro.saveOpenCodeGlobalPermissionConfig(rules);
      } else {
        const rules = setSkillRule(current.project.projectRules, id, enabled, (next) =>
          projectChain(current, next)
        );
        await client.varro.saveOpenCodePermissionConfig(rules);
      }
      const next = await readPermissions();
      if (disposed || request !== generation) return;
      setPermissions(next);
    } catch (cause) {
      if (!disposed && request === generation)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (!disposed && request === generation) {
        setPending(null);
        setSaving(false);
      }
    }
  }

  createEffect(
    () => state.editorContext.workspacePath,
    (workspacePath, previous) => {
      // Project rules belong to the workspace that loaded them.
      if (previous !== undefined && previous !== workspacePath) setPermissions(null);
      void load();
    }
  );
  onSettled(() => backButton?.focus());
  onCleanup(() => {
    disposed = true;
    generation += 1;
  });

  return (
    <section class="mcp-settings-panel skill-settings-panel" aria-label="Skill settings">
      <header class="mcp-settings-header">
        <div class="mcp-settings-header-inner">
          <button
            ref={(element) => {
              backButton = element;
            }}
            type="button"
            class="chat-header-btn"
            aria-label="Back"
            onClick={() => {
              setShowSkillSettings(false);
              requestComposerFocus();
            }}
          >
            <NavArrowLeftControlIcon class="chat-header-back-icon" />
          </button>
          <h1>Skill settings</h1>
          <Show when={activity()}>
            <span class="mcp-settings-saving" role="status">
              {activity()}
            </span>
          </Show>
        </div>
      </header>
      <div class="mcp-settings-body">
        <div class="mcp-settings-content">
          <p class="mcp-settings-description">
            Checked skills are available to agents. Unchecked skills are denied by a skill
            permission rule in OpenCode config.
          </p>
          <div>
            <button
              type="button"
              disabled={openingConfig() || saving()}
              onClick={() => void openConfig()}
            >
              Open OpenCode config
            </button>
          </div>
          <Show when={error()}>
            <div class="mcp-settings-error" role="alert">
              <span>{error()}</span>
              <Show when={!loading() && (!skills() || !permissions())}>
                <button type="button" onClick={() => void load()}>
                  Retry
                </button>
              </Show>
            </div>
          </Show>
          <Show when={loading() && !skills()}>
            <div class="chat-messages-loading" role="status" aria-label="Loading skills">
              <span class="chat-messages-loading-dot" />
              <span class="chat-messages-loading-dot" style={{ 'animation-delay': '0.3s' }} />
              <span class="chat-messages-loading-dot" style={{ 'animation-delay': '0.6s' }} />
            </div>
          </Show>
          <Show when={skills()}>
            <div
              ref={(element) => {
                tabList = element;
              }}
              class="mcp-settings-tabs"
              role="tablist"
              aria-label="Settings scope"
              onKeyDown={moveTab}
            >
              <For each={SKILL_SCOPES}>
                {(item) => (
                  <button
                    type="button"
                    role="tab"
                    id={`skill-settings-tab-${item.scope}`}
                    aria-selected={ariaBoolean(scope() === item.scope)}
                    aria-controls="skill-settings-tabpanel"
                    tabindex={scope() === item.scope ? 0 : -1}
                    disabled={saving() || openingConfig()}
                    onClick={() => selectScope(item.scope)}
                  >
                    {item.label}
                  </button>
                )}
              </For>
            </div>
            <div
              id="skill-settings-tabpanel"
              class="mcp-settings-tabpanel"
              role="tabpanel"
              aria-labelledby={`skill-settings-tab-${scope()}`}
            >
              <p class="mcp-settings-note">
                {SKILL_SCOPES.find((item) => item.scope === scope())?.description}
              </p>
              <Show when={sortedSkills().length > 0}>
                <label class="mcp-settings-server-toggle skill-settings-filter">
                  <input
                    type="checkbox"
                    checked={hideDisabled()}
                    disabled={!permissions()}
                    onChange={(event) => changeHideDisabled(event.currentTarget.checked)}
                  />
                  <span>Hide disabled ({disabledCount()})</span>
                </label>
              </Show>
              <Show
                when={visibleSkills().length > 0}
                fallback={
                  <p class="mcp-settings-empty">
                    {sortedSkills().length > 0
                      ? 'All skills are disabled here. Clear Hide disabled to show them.'
                      : 'No skills found.'}
                  </p>
                }
              >
                <div class="mcp-settings-servers" aria-busy={ariaBoolean(saving() || loading())}>
                  <For each={visibleSkills()}>
                    {(skill) => (
                      <div class="mcp-settings-server">
                        <label class="mcp-settings-server-toggle">
                          <input
                            type="checkbox"
                            checked={isChecked(skill.id, scope())}
                            disabled={!canEdit()}
                            onChange={(event) =>
                              changeSkill(skill.id, scope(), event.currentTarget)
                            }
                          />
                          <span>{skill.id}</span>
                        </label>
                        <div class="skill-settings-actions">
                          <Show when={scope() === 'project' && hasOverride(skill.id)}>
                            <button
                              type="button"
                              class="mcp-settings-reset"
                              aria-label={`Use global setting for ${skill.id}`}
                              disabled={!canEdit()}
                              onClick={() => void saveSkill(skill.id, 'project', null)}
                            >
                              Use global
                            </button>
                          </Show>
                          <Show when={skill.path}>
                            <button
                              type="button"
                              class="mcp-settings-reset"
                              aria-label={`Open ${skill.id} SKILL.md`}
                              title={skill.path}
                              onClick={() => openSkill(skill)}
                            >
                              Open
                            </button>
                          </Show>
                        </div>
                        <Show when={skill.description}>
                          <p
                            class="mcp-settings-server-detail mcp-settings-note skill-settings-description"
                            title={skill.description}
                          >
                            {skill.description}
                          </p>
                        </Show>
                        <Show when={skillNote(skill.id)}>
                          <p class="mcp-settings-server-detail mcp-settings-note">
                            {skillNote(skill.id)}
                          </p>
                        </Show>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </div>
          </Show>
        </div>
      </div>
    </section>
  );
}
