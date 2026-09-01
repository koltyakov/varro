import {
  For,
  Index,
  Show,
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  onMount,
} from 'solid-js';
import type { OpenCodePermissionConfig } from '../../shared/protocol';
import type { PermissionRule } from '../../shared/opencode-types';
import {
  KNOWN_PERMISSION_NAMES,
  getSessionPermissionRulesForMode,
} from '../../shared/permission-rules';
import { client } from '../lib/client';
import { setShowPermissionSettings } from '../lib/state';
import {
  checkIcon,
  navArrowDownIcon,
  navArrowLeftIcon,
  plusIcon,
  trashIcon,
} from '../lib/ui-icons';
import { Tooltip } from './Tooltip';
import { UiIcon } from './UiIcon';

const EMPTY_CONFIG: OpenCodePermissionConfig = {
  targetPath: '',
  projectRules: [],
  inheritedSources: [],
  effectiveRules: [],
};

function getConfigFileName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).at(-1) || 'opencode.json';
}

function formatRuleScope(rule: PermissionRule) {
  if (rule.permission === '*' && rule.pattern === '*') return 'Everything else';
  if (rule.pattern === '*') return rule.permission;
  return `${rule.permission}: ${rule.pattern}`;
}

const SUGGESTED_PERMISSION_NAMES = ['*', ...KNOWN_PERMISSION_NAMES] as const;
type SuggestedPermissionName = (typeof SUGGESTED_PERMISSION_NAMES)[number];
const PERMISSION_DETAILS_REQUIRED_WIDTH = 235;
const PERMISSION_DESCRIPTIONS = {
  '*': 'Matches any permission that is not overridden by a later rule.',
  read: 'Reads file contents.',
  edit: 'Creates, updates, or removes files.',
  glob: 'Finds files by path pattern.',
  grep: 'Searches file contents for matching text.',
  list: 'Lists files and directories.',
  bash: 'Runs commands in a shell.',
  shell: 'Runs commands in a shell.',
  task: 'Launches a subagent. Its actions remain permission checked.',
  external_directory: 'Accesses paths outside the session working directory.',
  todowrite: 'Updates the coding session task list.',
  question: 'Asks the user for input.',
  webfetch: 'Fetches content from a specific URL.',
  websearch: 'Searches the public web.',
  codesearch: 'Searches public code sources.',
  lsp: 'Uses language-server navigation and code intelligence.',
  doom_loop: 'Continues after repeated tool calls trigger loop protection.',
  skill: 'Loads specialized instructions into the session.',
} satisfies Record<SuggestedPermissionName, string>;

function isSuggestedPermissionName(value: string): value is SuggestedPermissionName {
  return SUGGESTED_PERMISSION_NAMES.some((name) => name === value);
}

function getPermissionDescription(permission: string) {
  return isSuggestedPermissionName(permission)
    ? PERMISSION_DESCRIPTIONS[permission]
    : 'A custom permission defined by OpenCode, a plugin, or an MCP tool.';
}

function PermissionRuleOverview(props: { rules: PermissionRule[] }) {
  const groups = () =>
    (['allow', 'ask', 'deny'] as const)
      .map((action) => ({
        action,
        rules: props.rules.filter((rule) => rule.action === action),
      }))
      .filter((group) => group.rules.length > 0);

  return (
    <div class="permission-rule-overview">
      <For each={groups()}>
        {(group) => (
          <div class={`permission-rule-group ${group.action}`}>
            <div class="permission-rule-group-label">
              <span class="permission-rule-group-dot" aria-hidden="true" />
              {group.action === 'allow'
                ? 'Allowed'
                : group.action === 'ask'
                  ? 'Ask first'
                  : 'Denied'}
              <span class="permission-rule-group-count">{group.rules.length}</span>
            </div>
            <div class="permission-rule-chips">
              <For each={group.rules}>
                {(rule) => (
                  <Tooltip content={getPermissionDescription(rule.permission)}>
                    <code>
                      <span>{formatRuleScope(rule)}</span>
                    </code>
                  </Tooltip>
                )}
              </For>
            </div>
          </div>
        )}
      </For>
    </div>
  );
}

function PermissionNameInput(props: { value: string; onInput: (value: string) => void }) {
  const listId = createUniqueId();
  const [open, setOpen] = createSignal(false);
  const [activeIndex, setActiveIndex] = createSignal(0);
  const [scrollTop, setScrollTop] = createSignal(0);
  const [scrollHeight, setScrollHeight] = createSignal(0);
  const [clientHeight, setClientHeight] = createSignal(0);
  const [details, setDetails] = createSignal<{ name: SuggestedPermissionName; top: number } | null>(
    null
  );
  let optionsShell: HTMLDivElement | undefined;
  let optionsElement: HTMLDivElement | undefined;
  const suggestions = () => {
    const query = props.value.trim().toLocaleLowerCase();
    if (!query) return [...SUGGESTED_PERMISSION_NAMES];
    return SUGGESTED_PERMISSION_NAMES.filter((name) => name.toLocaleLowerCase().includes(query));
  };
  const selectSuggestion = (value: string) => {
    props.onInput(value);
    setOpen(false);
  };
  const showDetails = (name: SuggestedPermissionName, option: HTMLElement) => {
    if (!optionsShell) {
      setDetails(null);
      return;
    }
    const shellBox = optionsShell.getBoundingClientRect();
    if (shellBox.right + PERMISSION_DETAILS_REQUIRED_WIDTH > window.innerWidth) {
      setDetails(null);
      return;
    }
    const optionBox = option.getBoundingClientRect();
    setDetails({
      name,
      top: Math.max(
        0,
        Math.min(optionBox.top - shellBox.top, window.innerHeight - shellBox.top - 90)
      ),
    });
  };
  const updateScrollMetrics = () => {
    if (!optionsElement) return;
    setScrollTop(optionsElement.scrollTop);
    setScrollHeight(optionsElement.scrollHeight);
    setClientHeight(optionsElement.clientHeight);
  };
  const thumbHeight = createMemo(() => {
    if (scrollHeight() <= clientHeight()) return 0;
    return Math.max(24, (clientHeight() * clientHeight()) / scrollHeight());
  });
  const thumbTop = createMemo(() => {
    const availableTrack = clientHeight() - thumbHeight();
    const availableScroll = scrollHeight() - clientHeight();
    return availableScroll > 0 ? (scrollTop() / availableScroll) * availableTrack : 0;
  });

  createEffect(() => {
    if (open() && suggestions().length > 0) queueMicrotask(updateScrollMetrics);
  });

  return (
    <div class="permission-name-combobox">
      <input
        value={props.value}
        role="combobox"
        aria-label="Permission name"
        aria-autocomplete="list"
        aria-controls={listId}
        aria-expanded={open()}
        aria-activedescendant={open() ? `${listId}-${activeIndex()}` : undefined}
        autocomplete="off"
        spellcheck={false}
        placeholder="Permission"
        onFocus={() => {
          setActiveIndex(0);
          setOpen(true);
        }}
        onBlur={() => {
          setOpen(false);
          setDetails(null);
        }}
        onInput={(event) => {
          props.onInput(event.currentTarget.value);
          setActiveIndex(0);
          setOpen(true);
        }}
        onKeyDown={(event) => {
          const values = suggestions();
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setOpen(true);
            setActiveIndex((index) => Math.min(index + 1, Math.max(0, values.length - 1)));
          } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            setOpen(true);
            setActiveIndex((index) => Math.max(0, index - 1));
          } else if (event.key === 'Enter' && open() && values[activeIndex()]) {
            event.preventDefault();
            selectSuggestion(values[activeIndex()]!);
          } else if (event.key === 'Escape') {
            setOpen(false);
          }
        }}
      />
      <UiIcon source={navArrowDownIcon} width={10} height={10} aria-hidden="true" />
      <Show when={open() && suggestions().length > 0}>
        <div
          ref={(element) => {
            optionsShell = element;
          }}
          class="permission-name-options-shell"
        >
          <div
            ref={(element) => {
              optionsElement = element;
              queueMicrotask(updateScrollMetrics);
            }}
            id={listId}
            class="permission-name-options"
            role="listbox"
            onScroll={() => {
              updateScrollMetrics();
              setDetails(null);
            }}
          >
            <For each={suggestions()}>
              {(name, index) => (
                <button
                  id={`${listId}-${index()}`}
                  type="button"
                  role="option"
                  aria-selected={props.value === name}
                  class={activeIndex() === index() ? 'active' : ''}
                  onMouseEnter={(event) => {
                    setActiveIndex(index());
                    showDetails(name, event.currentTarget);
                  }}
                  onMouseLeave={() => setDetails(null)}
                  onFocus={(event) => showDetails(name, event.currentTarget)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => selectSuggestion(name)}
                >
                  <code>{name}</code>
                  <Show when={name === '*'}>
                    <span>All permissions</span>
                  </Show>
                </button>
              )}
            </For>
          </div>
          <Show when={thumbHeight() > 0}>
            <div class="permission-name-scrollbar" aria-hidden="true">
              <div
                class="permission-name-scrollbar-thumb"
                style={{ height: `${thumbHeight()}px`, transform: `translateY(${thumbTop()}px)` }}
              />
            </div>
          </Show>
          <Show when={details()}>
            {(value) => (
              <div
                class="model-picker-details right permission-name-details"
                style={{ top: `${value().top}px` }}
                aria-live="polite"
              >
                <div class="permission-name-details-title">
                  {value().name === '*' ? 'All permissions' : value().name}
                </div>
                <div class="permission-name-details-description">
                  {PERMISSION_DESCRIPTIONS[value().name]}
                </div>
              </div>
            )}
          </Show>
        </div>
      </Show>
    </div>
  );
}

const PERMISSION_ACTIONS = [
  { value: 'allow', label: 'Allow' },
  { value: 'ask', label: 'Ask' },
  { value: 'deny', label: 'Deny' },
] as const;

function PermissionActionSelect(props: {
  value: PermissionRule['action'];
  onChange: (value: PermissionRule['action']) => void;
}) {
  const listId = createUniqueId();
  const [open, setOpen] = createSignal(false);
  const [activeIndex, setActiveIndex] = createSignal(0);
  let trigger: HTMLButtonElement | undefined;
  const options: HTMLButtonElement[] = [];
  const selectedIndex = () =>
    Math.max(
      0,
      PERMISSION_ACTIONS.findIndex((action) => action.value === props.value)
    );
  const focusOption = (index: number) => {
    const nextIndex = Math.max(0, Math.min(index, PERMISSION_ACTIONS.length - 1));
    setActiveIndex(nextIndex);
    queueMicrotask(() => options[nextIndex]?.focus());
  };
  const openMenu = () => {
    setOpen(true);
    focusOption(selectedIndex());
  };
  const closeMenu = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) queueMicrotask(() => trigger?.focus());
  };
  const selectAction = (action: PermissionRule['action']) => {
    props.onChange(action);
    closeMenu(true);
  };

  return (
    <span
      class="permission-config-select"
      onFocusOut={(event) => {
        const next = event.relatedTarget;
        if (!(next instanceof Node) || !event.currentTarget.contains(next)) closeMenu();
      }}
    >
      <button
        ref={(element) => {
          trigger = element;
        }}
        type="button"
        class="permission-config-action-button"
        aria-label="Action"
        aria-haspopup="listbox"
        aria-controls={listId}
        aria-expanded={open()}
        onClick={() => {
          if (open()) closeMenu();
          else openMenu();
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            openMenu();
          }
        }}
      >
        <span>{PERMISSION_ACTIONS[selectedIndex()]!.label}</span>
        <UiIcon source={navArrowDownIcon} width={10} height={10} aria-hidden="true" />
      </button>
      <Show when={open()}>
        <div id={listId} class="permission-action-options" role="listbox">
          <For each={PERMISSION_ACTIONS}>
            {(action, index) => (
              <button
                ref={(element) => {
                  options[index()] = element;
                }}
                type="button"
                role="option"
                data-action={action.value}
                aria-selected={props.value === action.value}
                class={activeIndex() === index() ? 'active' : ''}
                onMouseEnter={() => setActiveIndex(index())}
                onClick={() => selectAction(action.value)}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowDown') {
                    event.preventDefault();
                    focusOption((index() + 1) % PERMISSION_ACTIONS.length);
                  } else if (event.key === 'ArrowUp') {
                    event.preventDefault();
                    focusOption(
                      (index() - 1 + PERMISSION_ACTIONS.length) % PERMISSION_ACTIONS.length
                    );
                  } else if (event.key === 'Home') {
                    event.preventDefault();
                    focusOption(0);
                  } else if (event.key === 'End') {
                    event.preventDefault();
                    focusOption(PERMISSION_ACTIONS.length - 1);
                  } else if (event.key === 'Escape') {
                    event.preventDefault();
                    closeMenu(true);
                  }
                }}
              >
                <span class="permission-action-check" aria-hidden="true">
                  <Show when={props.value === action.value}>
                    <UiIcon source={checkIcon} width={11} height={11} />
                  </Show>
                </span>
                <span>{action.label}</span>
              </button>
            )}
          </For>
        </div>
      </Show>
    </span>
  );
}

function PermissionRuleRow(props: {
  rule: PermissionRule;
  onChange: (rule: PermissionRule) => void;
  onRemove: () => void;
}) {
  return (
    <div class="permission-config-rule">
      <PermissionNameInput
        value={props.rule.permission}
        onInput={(permission) => props.onChange({ ...props.rule, permission })}
      />
      <input
        value={props.rule.pattern}
        aria-label="Pattern"
        placeholder="Pattern"
        onInput={(event) => props.onChange({ ...props.rule, pattern: event.currentTarget.value })}
      />
      <span class="permission-config-edit-actions">
        <PermissionActionSelect
          value={props.rule.action}
          onChange={(action) => props.onChange({ ...props.rule, action })}
        />
        <Tooltip content="Remove rule">
          <button
            type="button"
            class="permission-config-remove"
            aria-label="Remove rule"
            onClick={props.onRemove}
          >
            <UiIcon source={trashIcon} width={14} height={14} />
          </button>
        </Tooltip>
      </span>
    </div>
  );
}

export function PermissionSettingsPanel() {
  const [config, setConfig] = createSignal(EMPTY_CONFIG);
  const [rules, setRules] = createSignal<PermissionRule[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const editModeAdditions = getSessionPermissionRulesForMode('edits', 'create').filter(
    (rule) => rule.permission === 'edit'
  );
  const defaultDirectRules = getSessionPermissionRulesForMode('default', 'create');
  const dirty = createMemo(() => JSON.stringify(rules()) !== JSON.stringify(config().projectRules));
  const effectiveDefaultRules = createMemo(() => [
    ...config().effectiveRules.filter(
      (rule) => !defaultDirectRules.some((direct) => direct.permission === rule.permission)
    ),
    ...defaultDirectRules,
  ]);
  const defaultDirectlyAllowsEdits = createMemo(
    () =>
      config().effectiveRules.findLast(
        (rule) => rule.pattern === '*' && (rule.permission === '*' || rule.permission === 'edit')
      )?.action === 'allow'
  );

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const next = await client.varro.openCodePermissionConfig();
      setConfig(next);
      setRules(next.projectRules.map((rule) => ({ ...rule })));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load permission configuration');
    } finally {
      setLoading(false);
    }
  }

  async function save() {
    const normalized = rules().map((rule) => ({
      permission: rule.permission.trim(),
      pattern: rule.pattern.trim(),
      action: rule.action,
    }));
    if (normalized.some((rule) => !rule.permission || !rule.pattern)) {
      setError('Every rule needs a permission name and pattern.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const next = await client.varro.saveOpenCodePermissionConfig(normalized);
      setConfig(next);
      setRules(next.projectRules.map((rule) => ({ ...rule })));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save permission configuration');
    } finally {
      setSaving(false);
    }
  }

  function updateRule(index: number, rule: PermissionRule) {
    setRules((current) => current.map((item, itemIndex) => (itemIndex === index ? rule : item)));
  }

  onMount(() => void load());

  return (
    <div class="permission-settings-panel">
      <header class="permission-settings-header">
        <div class="permission-settings-header-inner">
          <div class="permission-settings-header-left">
            <Tooltip content="Back">
              <button
                type="button"
                class="chat-header-btn"
                aria-label="Back"
                onClick={() => setShowPermissionSettings(false)}
              >
                <UiIcon source={navArrowLeftIcon} width={16} height={16} />
              </button>
            </Tooltip>
            <span>Permissions</span>
          </div>
          <button
            type="button"
            class="permission-settings-save"
            disabled={!dirty() || saving() || loading()}
            onClick={() => void save()}
          >
            {saving() ? 'Saving...' : 'Save rules'}
          </button>
        </div>
      </header>

      <div class="permission-settings-body">
        <div class="permission-settings-content">
          <Show when={error()}>
            <div class="permission-settings-error" role="alert">
              <span>{error()}</span>
              <button type="button" onClick={() => void load()}>
                Retry
              </button>
            </div>
          </Show>

          <section class="permission-config-section">
            <div class="permission-config-heading">
              <div>
                <h2>Project rules</h2>
                <p>Rules for this workspace. Later matching rules win.</p>
              </div>
              <button
                type="button"
                class="permission-config-add"
                disabled={loading() || saving()}
                onClick={() =>
                  setRules((current) => [
                    ...current,
                    { permission: '', pattern: '*', action: 'ask' },
                  ])
                }
              >
                <UiIcon source={plusIcon} width={14} height={14} />
                Add rule
              </button>
            </div>
            <div class="permission-config-source" title={config().targetPath || undefined}>
              <span>Workspace config</span>
              <code>{getConfigFileName(config().targetPath)}</code>
            </div>
            <div class="permission-config-column-labels" aria-hidden="true">
              <span>Permission</span>
              <span>Pattern</span>
              <span>Action</span>
            </div>
            <Show
              when={!loading()}
              fallback={<div class="permission-config-empty">Loading project rules...</div>}
            >
              <Show
                when={rules().length > 0}
                fallback={
                  <div class="permission-config-empty">
                    No project rules. OpenCode will use inherited and agent configuration.
                  </div>
                }
              >
                <Index each={rules()}>
                  {(rule, index) => (
                    <PermissionRuleRow
                      rule={rule()}
                      onChange={(next) => updateRule(index, next)}
                      onRemove={() =>
                        setRules((current) => current.filter((_, itemIndex) => itemIndex !== index))
                      }
                    />
                  )}
                </Index>
              </Show>
            </Show>
          </section>

          <For each={config().inheritedSources}>
            {(source) => (
              <section class="permission-config-section">
                <div class="permission-config-heading">
                  <div>
                    <h2>Inherited rules</h2>
                    <p title={source.path}>{getConfigFileName(source.path)}</p>
                  </div>
                  <span class="permission-config-level">Read only</span>
                </div>
                <PermissionRuleOverview rules={source.rules} />
              </section>
            )}
          </For>

          <Show when={effectiveDefaultRules().length > 0}>
            <section class="permission-config-section">
              <div class="permission-config-heading">
                <div>
                  <h2>Effective Default rules</h2>
                  <p>OpenCode's merged policy plus Varro's shared direct allowances.</p>
                </div>
                <span class="permission-config-level">Effective</span>
              </div>
              <PermissionRuleOverview rules={effectiveDefaultRules()} />
            </section>
          </Show>

          <Show when={!defaultDirectlyAllowsEdits()}>
            <section class="permission-config-section">
              <div class="permission-config-heading">
                <div>
                  <h2>Edit-mode addition</h2>
                  <p>Applied at session level when Auto-accept workspace edits is on.</p>
                </div>
                <span class="permission-config-level">Not saved</span>
              </div>
              <PermissionRuleOverview rules={editModeAdditions} />
            </section>
          </Show>
        </div>
      </div>
    </div>
  );
}
