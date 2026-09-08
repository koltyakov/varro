import { Show, createEffect, createSignal, onCleanup } from 'solid-js';
import { Portal } from 'solid-js/web';
import type { Permission } from '../types';
import {
  alwaysAllowPermissionForProject,
  alwaysAllowPermissionForSession,
  respondPermission,
} from '../hooks/useOpenCode';
import { getPermissionModeForSession } from '../lib/state-permission-modes';
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
  const [alwaysMenuOpen, setAlwaysMenuOpen] = createSignal(false);
  const [alwaysMenuPosition, setAlwaysMenuPosition] = createSignal({ left: 0, top: 0 });
  let alwaysMenuButton: HTMLButtonElement | undefined;
  let alwaysMenu: HTMLDivElement | undefined;
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
    respondingPermissionIds.add(permissionId);
    setRespondingPermissionVersion((version) => version + 1);
    try {
      await respondPermission(sessionId(), permissionId, response);
    } finally {
      respondingPermissionIds.delete(permissionId);
      setRespondingPermissionVersion((version) => version + 1);
    }
  };
  const handleAlways = async (scope: 'session' | 'server' | 'project') => {
    const permissionId = props.permission.id;
    if (respondingPermissionIds.has(permissionId)) return;
    setAlwaysMenuOpen(false);
    respondingPermissionIds.add(permissionId);
    setRespondingPermissionVersion((version) => version + 1);
    try {
      if (scope === 'session') {
        await alwaysAllowPermissionForSession(sessionId(), permissionId);
      } else if (scope === 'project') {
        await alwaysAllowPermissionForProject(sessionId(), permissionId);
      } else {
        await respondPermission(sessionId(), permissionId, 'always');
      }
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

  const metadataEntries = () => {
    const meta = props.permission.metadata;
    if (!meta || !isObject(meta)) return [];
    return Object.entries(meta).filter(([, v]) => v !== undefined && v !== null);
  };
  const displayTitle = () => {
    const summary = props.permission.actionSummary?.trim();
    if (summary) return summary;
    const command = props.permission.metadata?.command;
    if (
      (props.permission.type === 'bash' || props.permission.type === 'shell') &&
      isString(command) &&
      command.trim()
    ) {
      return 'Run command';
    }
    return props.permission.title;
  };

  return (
    <div class="chat-tool-invocation-part permission-prompt">
      <div class="permission-prompt-header">
        <UiIcon source={cardShieldIcon} class="permission-prompt-icon" width={16} height={16} />
        <span class="permission-prompt-label">Permission Required</span>
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
                    <div class="permission-meta-entry">
                      <span class="permission-meta-key">{key}</span>
                      <div class="permission-meta-value-shell">
                        <span class="permission-meta-value">{text}</span>
                        <CopyIconButton text={text} label={key} />
                      </div>
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

      <div class="permission-prompt-actions">
        <button
          class="question-btn question-btn-primary"
          aria-label="Allow once"
          disabled={responding() || props.permission.recoveredIncomplete}
          onClick={() => handleRespond('once')}
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
          onClick={() => handleRespond('reject')}
        >
          <span class="permission-action-label permission-action-label-full" aria-hidden="true">
            Reject
          </span>
          <span class="permission-action-label permission-action-label-short" aria-hidden="true">
            Reject
          </span>
        </button>
      </div>
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
            <button type="button" role="menuitem" onClick={() => handleAlways('session')}>
              <span>For this session</span>
              <small>Matching requests in this session</small>
            </button>
            <button type="button" role="menuitem" onClick={() => handleAlways('server')}>
              <span>Until server restart</span>
              <small>Matching requests across sessions</small>
            </button>
            <button type="button" role="menuitem" onClick={() => handleAlways('project')}>
              <span>For this project</span>
              <small>Saved in the project OpenCode config</small>
            </button>
          </div>
        </Portal>
      </Show>
    </div>
  );
}
