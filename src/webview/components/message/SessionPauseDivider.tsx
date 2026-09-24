import { Show, createSignal } from 'solid-js';
import { SESSION_RESUME_PROMPT } from '../../../shared/session-pauses';
import { sendMessage } from '../../hooks/useOpenCode';
import { setError, state } from '../../lib/state';
import type { SessionPause } from '../../lib/session-pauses';
import { playIcon } from '../../lib/ui-icons';
import { Tooltip } from '../Tooltip';
import { UiIcon } from '../UiIcon';

export function SessionResumeButton(props: { pause: SessionPause }) {
  const [resuming, setResuming] = createSignal(false);
  const canResume = () =>
    !props.pause.resumed &&
    state.activeSessionId === props.pause.sessionId &&
    state.serverStatus.state === 'running' &&
    state.serverStatus.apiVersion === 2;
  const resume = async () => {
    if (!canResume() || resuming()) return;
    setResuming(true);
    try {
      await sendMessage(SESSION_RESUME_PROMPT, {
        targetSessionId: props.pause.sessionId,
        preserveComposer: true,
        queuedAttachments: {},
        queuedContext: {
          editorContext: {
            ...state.editorContext,
            activeFile: null,
            selection: null,
            diagnostics: [],
          },
          currentDocumentEnabled: false,
          issuesEnabled: false,
        },
      });
    } catch (error) {
      setError(
        `Failed to resume the session: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      setResuming(false);
    }
  };

  return (
    <Show when={canResume()}>
      <Tooltip content={resuming() ? 'Resuming…' : 'Resume'} delay={500}>
        <button
          type="button"
          class="assistant-dialog-summary-turn-action session-pause-resume"
          aria-label={resuming() ? 'Resuming' : 'Resume'}
          disabled={resuming()}
          onClick={() => void resume()}
        >
          <UiIcon source={playIcon} width={16} height={16} aria-hidden="true" />
        </button>
      </Tooltip>
    </Show>
  );
}

export function SessionPauseDivider(props: { pause: SessionPause }) {
  return (
    <div class="model-change-indicator session-pause-divider" data-resumed={props.pause.resumed}>
      <span class="model-change-label">
        {props.pause.resumed ? 'Paused and resumed' : 'Paused'}
      </span>
      <SessionResumeButton pause={props.pause} />
    </div>
  );
}
