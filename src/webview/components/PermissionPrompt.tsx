import { Show, createSignal } from 'solid-js';
import type { Permission } from '../types';
import { respondPermission } from '../hooks/useOpenCode';

function formatMetadataValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

export function PermissionPrompt(props: { permission: Permission }) {
  const sessionId = () => props.permission.sessionID;
  const [responding, setResponding] = createSignal(false);
  const duplicateCount = () =>
    props.permission.groupMembers?.length || props.permission.duplicateIDs?.length || 0;

  const handleRespond = async (response: 'once' | 'always' | 'reject') => {
    if (responding()) return;
    setResponding(true);
    try {
      await respondPermission(sessionId(), props.permission.id, response);
    } finally {
      setResponding(false);
    }
  };

  const metadataEntries = () => {
    const meta = props.permission.metadata;
    if (!meta || typeof meta !== 'object') return [];
    return Object.entries(meta).filter(([, v]) => v !== undefined && v !== null);
  };

  return (
    <div class="chat-tool-invocation-part permission-prompt animate-fade-in">
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

      <div class="permission-prompt-text">{props.permission.title}</div>

      <Show when={metadataEntries().length > 0}>
        <div class="permission-prompt-meta">
          {metadataEntries().map(([key, value]) => (
            <div class="permission-meta-entry">
              <span class="permission-meta-key">{key}</span>
              <span class="permission-meta-value">{formatMetadataValue(value)}</span>
            </div>
          ))}
        </div>
      </Show>

      <Show when={duplicateCount() > 1}>
        <div class="permission-prompt-group-note">
          Requested {duplicateCount()} times in parallel — one response applies to all.
        </div>
      </Show>

      <div class="permission-prompt-actions">
        <button
          class="question-btn question-btn-secondary"
          disabled={responding()}
          onClick={() => handleRespond('reject')}
        >
          Reject
        </button>
        <button
          class="question-btn question-btn-secondary"
          disabled={responding()}
          onClick={() => handleRespond('once')}
        >
          Once
        </button>
        <button
          class="question-btn question-btn-primary"
          disabled={responding()}
          onClick={() => handleRespond('always')}
        >
          Always
        </button>
      </div>
    </div>
  );
}
