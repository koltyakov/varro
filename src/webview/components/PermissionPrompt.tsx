import { Show } from 'solid-js';
import type { Permission } from '../types';
import { respondPermission } from '../hooks/useOpenCode';

function formatMetadataValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

export function PermissionPrompt(props: { permission: Permission }) {
  const sessionId = () => props.permission.sessionID;

  const metadataEntries = () => {
    const meta = props.permission.metadata;
    if (!meta || typeof meta !== 'object') return [];
    return Object.entries(meta).filter(([, v]) => v !== undefined && v !== null);
  };

  return (
    <div class="permission-prompt animate-fade-in">
      <div class="permission-prompt-header">
        <svg class="permission-prompt-icon" viewBox="0 0 16 16" fill="currentColor">
          <path d="M8 1L2.5 3v4c0 3.4 2.3 6.5 5.5 7.5 3.2-1 5.5-4.1 5.5-7.5V3L8 1zm4 6c0 2.8-1.8 5.2-4 6.2C5.8 12.2 4 9.8 4 7V4l4-1.5L12 4v3z" />
        </svg>
        <span class="permission-prompt-label">Permission Required</span>
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

      <div class="permission-prompt-actions">
        <button
          class="question-btn question-btn-secondary"
          onClick={() => respondPermission(sessionId(), props.permission.id, 'reject')}
        >
          Reject
        </button>
        <button
          class="question-btn question-btn-secondary"
          onClick={() => respondPermission(sessionId(), props.permission.id, 'once')}
        >
          Once
        </button>
        <button
          class="question-btn question-btn-primary"
          onClick={() => respondPermission(sessionId(), props.permission.id, 'always')}
        >
          Always
        </button>
      </div>
    </div>
  );
}
