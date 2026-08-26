import { Show, createEffect, createSignal, untrack } from 'solid-js';
import { Portal } from 'solid-js/web';
import { normalizeSessionTitle } from '../../../shared/session-title';
import { renameSession } from '../../hooks/useOpenCode';
import { postMessage } from '../../lib/bridge';
import { clampPopupToViewport } from '../../lib/popup-position';
import { shareSession, unshareSession } from '../../lib/session-sharing';
import { getSelectedModelForSession, setError } from '../../lib/state';
import { writeClipboard } from '../../lib/write-clipboard';
import type { Session } from '../../types';
import { showSessionActionFeedback } from './SessionActionFeedback';

type RenameSelection = { start: number; end: number };

export type SessionActionsState = {
  sessionId: () => string | null;
  position: () => { x: number; y: number };
  renaming: () => boolean;
  renameValue: () => string;
  renameSelection: () => RenameSelection | null;
  renamePending: () => boolean;
  open: (sessionId: string, event: MouseEvent) => void;
  close: () => void;
  beginRename: (title: string) => void;
  setRenameValue: (value: string) => void;
  setRenameSelection: (selection: RenameSelection) => void;
  setRenamePending: (pending: boolean) => void;
};

export function createSessionActionsState(
  options: {
    onOpen?: (sessionId: string) => void;
    onClose?: () => void;
  } = {}
): SessionActionsState {
  const [sessionId, setSessionId] = createSignal<string | null>(null);
  const [position, setPosition] = createSignal({ x: 0, y: 0 });
  const [renaming, setRenaming] = createSignal(false);
  const [renameValue, setRenameValue] = createSignal('');
  const [renameSelection, setRenameSelection] = createSignal<RenameSelection | null>(null);
  const [renamePending, setRenamePending] = createSignal(false);

  return {
    sessionId,
    position,
    renaming,
    renameValue,
    renameSelection,
    renamePending,
    open: (nextSessionId, event) => {
      event.preventDefault();
      options.onOpen?.(nextSessionId);
      setPosition({ x: event.clientX, y: event.clientY });
      setRenaming(false);
      setSessionId(nextSessionId);
    },
    close: () => {
      setSessionId(null);
      setRenaming(false);
      setRenamePending(false);
      options.onClose?.();
    },
    beginRename: (title) => {
      setRenameValue(normalizeSessionTitle(title) || '');
      setRenameSelection(null);
      setRenaming(true);
    },
    setRenameValue,
    setRenameSelection,
    setRenamePending,
  };
}

export function SessionActionsMenu(props: {
  session: Session;
  state: SessionActionsState;
  isPinned: boolean;
  showOpenInSidebar?: boolean;
  showOpenAsEditor?: boolean;
  inputIdPrefix: string;
  onMenuRef: (element: HTMLDivElement) => void;
  onEscape: () => void;
  onOpenAsEditor?: (sessionId: string) => void;
  onTogglePinned: (sessionId: string) => void | Promise<void>;
  onDelete: (sessionId: string) => void | Promise<void>;
}) {
  let menuRef: HTMLDivElement | undefined;
  let renameInputRef: HTMLInputElement | undefined;

  const beginRename = () => {
    props.state.beginRename(props.session.title);
    queueMicrotask(() => {
      renameInputRef?.focus();
      renameInputRef?.select();
    });
  };
  const submitRename = async () => {
    if (props.state.renamePending()) return;
    const title = props.state.renameValue().trim();
    if (!title) return;
    const sessionId = props.session.id;
    props.state.setRenamePending(true);
    const renamed = await renameSession(sessionId, title);
    if (props.state.sessionId() !== sessionId) return;
    props.state.setRenamePending(false);
    if (renamed) props.state.close();
  };
  const copySessionId = async () => {
    const sessionId = props.session.id;
    props.state.close();
    if (!(await writeClipboard(sessionId))) {
      setError('Failed to copy session ID');
      return;
    }
    showSessionActionFeedback('Session ID copied');
  };
  const copyShareLink = async () => {
    const session = props.session;
    props.state.close();
    if (!(await shareSession(session))) return;
    showSessionActionFeedback('Share link copied');
  };
  const unshare = async () => {
    const session = props.session;
    props.state.close();
    if (!(await unshareSession(session))) return;
    showSessionActionFeedback('Session unshared');
  };
  const updateRenameSelection = (input: HTMLInputElement) => {
    props.state.setRenameSelection({
      start: input.selectionStart ?? 0,
      end: input.selectionEnd ?? 0,
    });
  };

  createEffect(() => {
    props.state.position();
    props.state.renaming();
    queueMicrotask(() => {
      if (menuRef) clampPopupToViewport(menuRef);
    });
  });

  return (
    <Portal>
      <div
        ref={(element) => {
          menuRef = element;
          props.onMenuRef(element);
        }}
        class="session-item-actions-menu"
        role="menu"
        aria-label="Session actions"
        style={{
          left: `${props.state.position().x}px`,
          top: `${props.state.position().y}px`,
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          props.state.close();
          props.onEscape();
        }}
      >
        <Show
          when={props.state.renaming()}
          fallback={
            <>
              <Show when={props.showOpenInSidebar}>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    const sessionId = props.session.id;
                    props.state.close();
                    postMessage({
                      type: 'session/open-in-sidebar',
                      payload: { sessionId },
                    });
                  }}
                >
                  Open
                </button>
              </Show>
              <Show when={props.showOpenAsEditor}>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    const sessionId = props.session.id;
                    const title = props.session.title;
                    const selectedModel = getSelectedModelForSession(sessionId);
                    const sessionModel = props.session.model
                      ? {
                          providerID: props.session.model.providerID,
                          modelID: props.session.model.id,
                          variant: props.session.model.variant,
                        }
                      : undefined;
                    const model = selectedModel
                      ? {
                          providerID: selectedModel.providerID,
                          modelID: selectedModel.modelID,
                          variant: selectedModel.variant,
                        }
                      : sessionModel;
                    props.state.close();
                    const posted = postMessage({
                      type: 'session/open-in-editor',
                      payload: {
                        sessionId,
                        title,
                        model,
                      },
                    });
                    if (posted) props.onOpenAsEditor?.(sessionId);
                  }}
                >
                  Open in Editor
                </button>
              </Show>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  const sessionId = props.session.id;
                  props.state.close();
                  postMessage({
                    type: 'session/open-in-opencode',
                    payload: { sessionId },
                  });
                }}
              >
                Open in terminal
              </button>
              <Show when={!props.session.parentID}>
                <div class="session-item-actions-separator" role="separator" />
                <button type="button" role="menuitem" onClick={beginRename}>
                  Rename
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    const sessionId = props.session.id;
                    const onTogglePinned = props.onTogglePinned;
                    props.state.close();
                    void onTogglePinned(sessionId);
                  }}
                >
                  {props.isPinned ? 'Unpin session' : 'Pin session'}
                </button>
              </Show>
              <div class="session-item-actions-separator" role="separator" />
              <button type="button" role="menuitem" onClick={() => void copySessionId()}>
                Copy session ID
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => (props.session.share?.url ? void unshare() : void copyShareLink())}
              >
                {props.session.share?.url ? 'Unshare session' : 'Share session'}
              </button>
              <Show when={!props.session.parentID}>
                <div class="session-item-actions-separator" role="separator" />
                <button
                  type="button"
                  role="menuitem"
                  class="is-destructive"
                  onClick={() => {
                    const sessionId = props.session.id;
                    const onDelete = props.onDelete;
                    props.state.close();
                    void onDelete(sessionId);
                  }}
                >
                  Move to Recycle Bin
                </button>
              </Show>
            </>
          }
        >
          <form
            class="session-item-rename-form"
            onSubmit={(event) => {
              event.preventDefault();
              void submitRename();
            }}
          >
            <label for={`${props.inputIdPrefix}-${props.session.id}`}>Session name</label>
            <input
              ref={(element) => {
                renameInputRef = element;
                const selection = untrack(props.state.renameSelection);
                if (!selection) return;
                queueMicrotask(() => {
                  element.focus();
                  element.setSelectionRange(selection.start, selection.end);
                });
              }}
              id={`${props.inputIdPrefix}-${props.session.id}`}
              value={props.state.renameValue()}
              onInput={(event) => {
                props.state.setRenameValue(event.currentTarget.value);
                props.state.setRenameSelection({
                  start: event.currentTarget.selectionStart ?? event.currentTarget.value.length,
                  end: event.currentTarget.selectionEnd ?? event.currentTarget.value.length,
                });
              }}
              onSelect={(event) => updateRenameSelection(event.currentTarget)}
              onMouseUp={(event) => updateRenameSelection(event.currentTarget)}
              onKeyUp={(event) => updateRenameSelection(event.currentTarget)}
              disabled={props.state.renamePending()}
            />
            <div class="session-item-rename-actions">
              <button type="button" onClick={props.state.close}>
                Cancel
              </button>
              <button
                type="submit"
                disabled={!props.state.renameValue().trim() || props.state.renamePending()}
              >
                Save
              </button>
            </div>
          </form>
        </Show>
      </div>
    </Portal>
  );
}
