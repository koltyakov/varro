import { Show, createSignal } from 'solid-js';
import type { Permission } from '../types';
import { respondPermission } from '../hooks/useOpenCode';
import { CopyIconButton } from './CopyIconButton';

const respondingPermissionIds = new Set<string>();
const [respondingPermissionVersion, setRespondingPermissionVersion] = createSignal(0);

function formatMetadataValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

export function PermissionPrompt(props: {
  permission: Permission;
  queuePosition?: number;
  queueTotal?: number;
}) {
  const sessionId = () => props.permission.sessionID;
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

  const metadataEntries = () => {
    const meta = props.permission.metadata;
    if (!meta || typeof meta !== 'object') return [];
    return Object.entries(meta).filter(([, v]) => v !== undefined && v !== null);
  };

  return (
    <div class="chat-tool-invocation-part permission-prompt">
      <div class="permission-prompt-header">
        <svg class="permission-prompt-icon" viewBox="0 0 24 24" fill="none">
          <path
            d="M13.1469 21.1972L14.8163 20.0286C19.1794 16.9744 21.3182 11.6252 20.2636 6.40484C20.212 6.14963 20.0447 5.93295 19.8108 5.8186L12 2L4.18923 5.8186C3.95533 5.93295 3.78795 6.14963 3.7364 6.40484C2.68177 11.6252 4.82058 16.9744 9.18369 20.0286L10.8531 21.1972C11.5417 21.6792 12.4583 21.6792 13.1469 21.1972Z"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
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

      <div class="permission-prompt-text-shell">
        <span class="permission-prompt-text">{props.permission.title}</span>
        <CopyIconButton text={props.permission.title} label="permission request" />
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

      <Show when={duplicateCount() > 1}>
        <div class="permission-prompt-group-note">
          Requested {duplicateCount()} times in parallel. Allow once handles one request; Reject
          handles all {duplicateCount()}.
        </div>
      </Show>

      <div class="permission-prompt-scope-note">
        "Always allow" covers matching requests. In Auto approve mode, it also guides AI review
        toward similar non-destructive actions.
      </div>

      <div class="permission-prompt-actions">
        <button
          class="question-btn question-btn-primary"
          aria-label="Allow once"
          disabled={responding()}
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
          class="question-btn question-btn-secondary"
          aria-label="Allow always"
          title="Allow matching future requests and guide AI review of similar non-destructive actions"
          disabled={responding()}
          onClick={() => handleRespond('always')}
        >
          <span class="permission-action-label permission-action-label-full" aria-hidden="true">
            Allow always
          </span>
          <span class="permission-action-label permission-action-label-short" aria-hidden="true">
            Always
          </span>
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
    </div>
  );
}
