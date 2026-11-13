import {
  Show,
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  on,
  onCleanup,
} from 'solid-js';
import { Portal } from 'solid-js/web';
import type { Permission } from '../types';
import {
  alwaysAllowPermissionForProject,
  alwaysAllowPermissionForSession,
  alwaysAllowPermissionForGlobal,
  respondPermission,
} from '../hooks/useOpenCode';
import { getPermissionModeForSession } from '../lib/state-permission-modes';
import { state } from '../lib/app-state';
import { getToolKind } from '../lib/tool-normalization';
import { cardShieldIcon } from '../lib/ui-icons';
import { CopyIconButton } from './CopyIconButton';
import { UiIcon } from './UiIcon';
import { isBoolean, isNumber, isString, isObject } from '../lib/runtime-values';

const respondingPermissionIds = new Set<string>();
const [respondingPermissionVersion, setRespondingPermissionVersion] = createSignal(0);

function formatMetadataValue<T>(value: T): string {
  if (isString(value)) return value;
  if (isNumber(value) || isBoolean(value)) return String(value);
  return JSON.stringify(value);
}

export function PermissionPrompt(props: {
  permission: Permission;
  queuePosition?: number;
  queueTotal?: number;
}) {
  const sessionId = () => props.permission.sessionID;
  const sourceAgent = createMemo(() => {
    const session = state.sessions.find((candidate) => candidate.id === sessionId());
    const message = state.messages.find(
      (entry) =>
        entry.info.sessionID === sessionId() && entry.info.id === props.permission.messageID
    );
    let taskAgent: string | undefined;
    for (const entry of state.messages) {
      for (const part of entry.parts) {
        if (part.type !== 'tool' || getToolKind(part.tool) !== 'task') continue;
        const metadata = 'metadata' in part.state ? part.state.metadata : undefined;
        const childId = metadata?.sessionId ?? metadata?.sessionID ?? part.state.input?.task_id;
        const agent = part.state.input?.subagent_type;
        if (childId === sessionId() && isString(agent) && agent.trim()) {
          taskAgent = agent.trim();
        }
      }
    }
    if (!session?.parentID && !taskAgent) return undefined;
    const messageAgent = message?.info.role === 'assistant' ? message.info.agent : undefined;
    return messageAgent?.trim() || session?.agent?.trim() || taskAgent || 'subagent';
  });
  const [alwaysMenuOpen, setAlwaysMenuOpen] = createSignal(false);
  const [commandExpanded, setCommandExpanded] = createSignal(false);
  const [reviewScope, setReviewScope] = createSignal<'session' | 'project' | 'global'>();
  const [patternDraft, setPatternDraft] = createSignal('');
  const currentPermissionId = createMemo(() => props.permission.id);
  const patternHintId = createUniqueId();
  const nativeServer = () =>
    state.serverStatus.state === 'running' && state.serverStatus.apiVersion === 2;
  const reviewedPatterns = () => [
    ...new Set(
      patternDraft()
        .split('\n')
        .map((pattern) => pattern.trim())
        .filter(Boolean)
    ),
  ];
  const validPatterns = () =>
    reviewedPatterns().length > 0 &&
    reviewedPatterns().length <= 50 &&
    reviewedPatterns().every((pattern) => pattern.length <= 2000);
  const patternHint = () => {
    if (reviewedPatterns().length === 0) return 'Enter at least one resource pattern.';
    if (reviewedPatterns().length > 50) return 'Use at most 50 resource patterns.';
    if (reviewedPatterns().some((pattern) => pattern.length > 2000))
      return 'Each pattern must be 2000 characters or fewer.';
    return 'One pattern per line. * matches any text.';
  };
  createEffect(
    on(currentPermissionId, () => {
      setCommandExpanded(false);
      setReviewScope(undefined);
      setPatternDraft('');
      setAlwaysMenuOpen(false);
      setResponseError(undefined);
    })
  );
  const [responseError, setResponseError] = createSignal<string>();
  const [alwaysMenuPosition, setAlwaysMenuPosition] = createSignal({ left: 0, top: 0 });
  let alwaysMenuButton: HTMLButtonElement | undefined;
  let alwaysMenu: HTMLDivElement | undefined;
  const cancelReview = () => {
    if (responding()) return;
    setReviewScope(undefined);
    setResponseError(undefined);
    queueMicrotask(() => alwaysMenuButton?.focus());
  };
  const isAutoApproveMode = () => getPermissionModeForSession(sessionId()) === 'auto';
  const responding = () => {
    respondingPermissionVersion();
    return respondingPermissionIds.has(props.permission.id);
  };
  const duplicateCount = () =>
    props.permission.groupMembers?.length || props.permission.duplicateIDs?.length || 0;

  const handleRespond = async (response: 'once' | 'always' | 'reject') => {
    const permissionId = props.permission.id;
    if (respondingPermissionIds.has(permissionId)) return;
    setResponseError(undefined);
    respondingPermissionIds.add(permissionId);
    setRespondingPermissionVersion((version) => version + 1);
    try {
      await respondPermission(sessionId(), permissionId, response);
    } catch (error) {
      setResponseError(error instanceof Error ? error.message : 'Failed to respond to permission');
    } finally {
      respondingPermissionIds.delete(permissionId);
      setRespondingPermissionVersion((version) => version + 1);
    }
  };
  const chooseScope = (scope: 'session' | 'server' | 'project' | 'global') => {
    setAlwaysMenuOpen(false);
    if (nativeServer() && scope !== 'server') {
      let patterns = props.permission.always ?? [];
      if (props.permission.type === 'webfetch') {
        const resources = props.permission.pattern;
        const requested = (Array.isArray(resources) ? resources : [resources]).filter(
          (resource): resource is string => isString(resource) && /^https?:\/\//i.test(resource)
        );
        const url = props.permission.metadata?.url;
        if (requested.length > 0) patterns = requested;
        else if (isString(url) && url.trim()) patterns = [url];
      }
      setPatternDraft(patterns.join('\n'));
      setResponseError(undefined);
      setReviewScope(scope);
    } else {
      void handleAlways(scope);
    }
  };
  const handleAlways = async (
    scope: 'session' | 'server' | 'project' | 'global',
    patterns?: string[]
  ) => {
    const permissionId = props.permission.id;
    if (respondingPermissionIds.has(permissionId)) return;
    setResponseError(undefined);
    setAlwaysMenuOpen(false);
    respondingPermissionIds.add(permissionId);
    setRespondingPermissionVersion((version) => version + 1);
    try {
      if (scope === 'session') {
        if (patterns) await alwaysAllowPermissionForSession(sessionId(), permissionId, patterns);
        else await alwaysAllowPermissionForSession(sessionId(), permissionId);
      } else if (scope === 'project') {
        if (patterns) await alwaysAllowPermissionForProject(sessionId(), permissionId, patterns);
        else await alwaysAllowPermissionForProject(sessionId(), permissionId);
      } else if (scope === 'global' && patterns) {
        await alwaysAllowPermissionForGlobal(sessionId(), permissionId, patterns);
      } else {
        await respondPermission(sessionId(), permissionId, 'always');
      }
      setReviewScope(undefined);
    } catch (error) {
      setResponseError(
        error instanceof Error ? error.message : 'Failed to save permission approval'
      );
    } finally {
      respondingPermissionIds.delete(permissionId);
      setRespondingPermissionVersion((version) => version + 1);
    }
  };

  createEffect(() => {
    if (!alwaysMenuOpen()) return;
    const closeOnPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (alwaysMenuButton?.contains(target) || alwaysMenu?.contains(target)) return;
      setAlwaysMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setAlwaysMenuOpen(false);
      alwaysMenuButton?.focus();
    };
    window.addEventListener('pointerdown', closeOnPointerDown);
    window.addEventListener('keydown', closeOnEscape, true);
    onCleanup(() => {
      window.removeEventListener('pointerdown', closeOnPointerDown);
      window.removeEventListener('keydown', closeOnEscape, true);
    });
  });

  const shellCommand = createMemo(() => {
    if (props.permission.type !== 'bash' && props.permission.type !== 'shell') return undefined;
    const command = props.permission.metadata?.command;
    if (isString(command) && command.trim()) return command;
    const patterns = props.permission.pattern;
    const resources = (Array.isArray(patterns) ? patterns : [patterns]).filter(
      (pattern): pattern is string => isString(pattern) && Boolean(pattern.trim())
    );
    if (resources.length > 0) return resources.join('\n');
    return /^(?:bash|shell)\s+([\s\S]+)$/.exec(props.permission.title)?.[1];
  });
  const metadataEntries = (): [string, unknown][] => {
    const meta = props.permission.metadata;
    const entries =
      meta && isObject(meta)
        ? Object.entries(meta).filter(([, v]) => v !== undefined && v !== null)
        : [];
    const command = shellCommand();
    if (command) return [['command', command], ...entries.filter(([key]) => key !== 'command')];
    return entries;
  };
  const displayTitle = () => {
    const summary = props.permission.actionSummary?.trim();
    if (summary) return summary;
    if (shellCommand()) {
      return 'Run command';
    }
    return props.permission.title;
  };

  return (
    <div class="chat-tool-invocation-part permission-prompt">
      <div class="permission-prompt-header">
        <UiIcon source={cardShieldIcon} class="permission-prompt-icon" width={16} height={16} />
        <span class="permission-prompt-label">Permission Required</span>
        <Show when={sourceAgent()}>
          {(agent) => (
            <span class="permission-prompt-agent" title={`Requested by @${agent()}`}>
              @{agent()}
            </span>
          )}
        </Show>
        <Show when={(props.queueTotal ?? 0) > 1 || duplicateCount() > 1}>
          <div class="permission-prompt-indicators">
            <Show when={(props.queueTotal ?? 0) > 1}>
              <span class="permission-prompt-step">
                {props.queuePosition ?? 1} / {props.queueTotal}
              </span>
            </Show>
            <Show when={duplicateCount() > 1}>
              <span
                class="permission-prompt-count"
                title={`${duplicateCount()} identical requests grouped`}
                aria-label={`${duplicateCount()} identical requests grouped`}
              >
                ×{duplicateCount()}
              </span>
            </Show>
          </div>
        </Show>
      </div>

      <div class="permission-prompt-content">
        <div class="permission-prompt-text-shell">
          <span class="permission-prompt-text">{displayTitle()}</span>
        </div>

        <Show when={metadataEntries().length > 0 || Boolean(props.permission.autoApproveReason)}>
          <div class="permission-prompt-details">
            <Show when={metadataEntries().length > 0}>
              <div class="permission-prompt-meta">
                {metadataEntries().map(([key, value]) => {
                  const text = formatMetadataValue(value);
                  return (
                    <div
                      class="permission-meta-entry"
                      classList={{
                        'permission-command-expanded': key === 'command' && commandExpanded(),
                      }}
                    >
                      <span class="permission-meta-key">{key}</span>
                      <div class="permission-meta-value-shell">
                        <span class="permission-meta-value">{text}</span>
                        <CopyIconButton text={text} label={key} />
                      </div>
                      <Show when={key === 'command'}>
                        <button
                          type="button"
                          class="permission-command-toggle"
                          aria-expanded={commandExpanded()}
                          onClick={() => setCommandExpanded((expanded) => !expanded)}
                        >
                          {commandExpanded() ? 'Collapse command' : 'Expand command'}
                        </button>
                      </Show>
                    </div>
                  );
                })}
              </div>
            </Show>

            <Show when={props.permission.autoApproveReason}>
              {(reason) => (
                <div class="permission-prompt-auto-reason">
                  <span class="permission-prompt-auto-reason-label">AI check</span>
                  <span>{reason()}</span>
                </div>
              )}
            </Show>
          </div>
        </Show>
      </div>

      <Show when={duplicateCount() > 1}>
        <div class="permission-prompt-group-note">
          Requested {duplicateCount()} times in parallel. Allow once handles one request; Reject
          handles all {duplicateCount()}.
        </div>
      </Show>

      <Show when={props.permission.recoveredIncomplete || isAutoApproveMode()}>
        <div class="permission-prompt-scope-note">
          <Show
            when={!props.permission.recoveredIncomplete}
            fallback={
              <>Approval details are incomplete after reload. Reject or wait for reconnection.</>
            }
          >
            Always allow also guides AI review toward similar non-destructive actions.
          </Show>
        </div>
      </Show>

      <Show when={responseError()}>
        {(error) => (
          <div class="permission-prompt-error" role="alert">
            {error()}
          </div>
        )}
      </Show>

      <Show when={reviewScope()}>
        {(scope) => (
          <form
            class="permission-approval-review"
            aria-label="Review standing approval"
            onKeyDown={(event) => {
              if (event.key !== 'Escape' || responding()) return;
              event.preventDefault();
              event.stopPropagation();
              cancelReview();
            }}
            onSubmit={(event) => {
              event.preventDefault();
              if (validPatterns() && !responding()) void handleAlways(scope(), reviewedPatterns());
            }}
          >
            <div class="permission-approval-fields">
              <div class="permission-approval-heading">
                <span>Always allow</span>
                <span
                  class="permission-approval-scope"
                  title={
                    scope() === 'global'
                      ? 'Global OpenCode config, across all projects. Unavailable in attach-only mode.'
                      : undefined
                  }
                >
                  {scope() === 'session'
                    ? 'This session'
                    : scope() === 'project'
                      ? 'Project config'
                      : 'Global config'}
                </span>
              </div>
              <label>
                Resource patterns
                <textarea
                  ref={(element) => queueMicrotask(() => element.focus())}
                  aria-label="Approval resource patterns"
                  aria-describedby={patternHintId}
                  aria-invalid={!validPatterns()}
                  rows={2}
                  value={patternDraft()}
                  disabled={responding()}
                  spellcheck={false}
                  onInput={(event) => setPatternDraft(event.currentTarget.value)}
                />
              </label>
              <div
                id={patternHintId}
                class="permission-approval-hint"
                classList={{ 'is-invalid': !validPatterns() }}
              >
                {patternHint()}
              </div>
            </div>
            <div class="permission-prompt-actions permission-approval-actions">
              <button
                class="question-btn question-btn-secondary"
                type="button"
                disabled={responding()}
                onClick={cancelReview}
              >
                Cancel
              </button>
              <button
                class="question-btn question-btn-primary"
                type="submit"
                title="Save the rule and allow the current request. The requested command stays unchanged."
                disabled={responding() || !validPatterns() || props.permission.recoveredIncomplete}
              >
                {responding() ? 'Saving...' : 'Save & allow'}
              </button>
            </div>
          </form>
        )}
      </Show>

      <Show when={!reviewScope()}>
        <div class="permission-prompt-actions">
          <button
            class="question-btn question-btn-primary"
            aria-label="Allow once"
            disabled={responding() || props.permission.recoveredIncomplete}
            onClick={() => void handleRespond('once')}
          >
            <span class="permission-action-label permission-action-label-full" aria-hidden="true">
              Allow once
            </span>
            <span class="permission-action-label permission-action-label-short" aria-hidden="true">
              Once
            </span>
          </button>
          <button
            ref={(element) => (alwaysMenuButton = element)}
            class="question-btn question-btn-secondary permission-always-main"
            type="button"
            aria-label="Allow always"
            aria-haspopup="menu"
            aria-expanded={alwaysMenuOpen()}
            title="Choose where to allow matching requests"
            disabled={responding() || props.permission.recoveredIncomplete}
            onClick={() => {
              if (!alwaysMenuOpen() && alwaysMenuButton) {
                const rect = alwaysMenuButton.getBoundingClientRect();
                setAlwaysMenuPosition({ left: rect.right, top: rect.top - 4 });
              }
              setAlwaysMenuOpen((open) => !open);
            }}
          >
            <span class="permission-always-label" aria-hidden="true">
              <span class="permission-action-label permission-action-label-full">Allow always</span>
              <span class="permission-action-label permission-action-label-short">Always</span>
            </span>
            <svg
              class="permission-always-chevron"
              width="12"
              height="12"
              viewBox="0 0 15 15"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="m4 6 3.5 3.5L11 6"
                stroke="currentColor"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </button>
          <button
            class="question-btn question-btn-danger"
            aria-label="Reject"
            disabled={responding()}
            onClick={() => void handleRespond('reject')}
          >
            <span class="permission-action-label permission-action-label-full" aria-hidden="true">
              Reject
            </span>
            <span class="permission-action-label permission-action-label-short" aria-hidden="true">
              Reject
            </span>
          </button>
        </div>
      </Show>
      <Show when={alwaysMenuOpen()}>
        <Portal>
          <div
            ref={(element) => {
              alwaysMenu = element;
              queueMicrotask(() => {
                const triggerRect = alwaysMenuButton?.getBoundingClientRect();
                const menuRect = element.getBoundingClientRect();
                if (!triggerRect) return;
                const left = Math.max(8, triggerRect.right - menuRect.width);
                const top =
                  triggerRect.top - menuRect.height - 4 >= 8
                    ? triggerRect.top - menuRect.height - 4
                    : triggerRect.bottom + 4;
                setAlwaysMenuPosition({ left, top });
                element.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
              });
            }}
            class="permission-always-menu"
            role="menu"
            aria-label="Always allow scope"
            style={{
              left: `${alwaysMenuPosition().left}px`,
              top: `${alwaysMenuPosition().top}px`,
            }}
          >
            <button type="button" role="menuitem" onClick={() => chooseScope('session')}>
              <span>For this session</span>
              <small>Matching requests in this session</small>
            </button>
            <Show
              when={state.serverStatus.state === 'running' && state.serverStatus.apiVersion === 1}
            >
              <button type="button" role="menuitem" onClick={() => chooseScope('server')}>
                <span>Until server restart</span>
                <small>Matching requests across sessions</small>
              </button>
            </Show>
            <button type="button" role="menuitem" onClick={() => chooseScope('project')}>
              <span>For this project</span>
              <small>Saved in the project OpenCode config</small>
            </button>
            <Show when={nativeServer()}>
              <button type="button" role="menuitem" onClick={() => chooseScope('global')}>
                <span>Global</span>
                <small>Saved in the global OpenCode config</small>
              </button>
            </Show>
          </div>
        </Portal>
      </Show>
    </div>
  );
}
