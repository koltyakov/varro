import { Show, createEffect, createSignal, onCleanup } from 'solid-js';
import { Portal } from 'solid-js/web';
import { postMessage } from '../../lib/bridge';
import { client } from '../../lib/client';
import { clampPopupToViewport } from '../../lib/popup-position';
import { folderIcon, gitIcon } from '../../lib/ui-icons';
import { isSameWorkspacePath } from '../../../shared/workspace-path';
import { Tooltip } from '../Tooltip';
import { UiIcon } from '../UiIcon';
import {
  copySessionFolderPath,
  mergeSessionWorktree,
  moveSessionWorktreeResults,
} from '../../lib/session-location-actions';

export function SessionLocationIndicator(props: {
  sessionId: string;
  directory: string;
  isGitWorktree?: boolean;
  moved?: boolean;
  readOnly?: boolean;
}) {
  const [isGitWorktree, setIsGitWorktree] = createSignal(false);
  const [position, setPosition] = createSignal<{ x: number; y: number } | null>(null);
  let button: HTMLButtonElement | undefined;
  let menu: HTMLDivElement | undefined;
  const close = () => setPosition(null);

  createEffect(() => {
    const sessionId = props.sessionId;
    const directory = props.directory;
    close();
    setIsGitWorktree(false);
    if (props.isGitWorktree !== undefined) {
      setIsGitWorktree(props.isGitWorktree);
      return;
    }
    let cancelled = false;
    void client.varro.session
      .location(sessionId, { directory })
      .then((location) => {
        if (!cancelled && isSameWorkspacePath(location.directory, directory)) {
          setIsGitWorktree(location.isGitWorktree);
        }
      })
      .catch(() => {
        // The known session path remains useful if optional worktree metadata is unavailable.
      });
    onCleanup(() => {
      cancelled = true;
    });
  });

  createEffect(() => {
    if (!position()) return;
    const closeOutside = (event: Event) => {
      if (
        event.target instanceof Node &&
        (menu?.contains(event.target) || button?.contains(event.target))
      )
        return;
      close();
    };
    window.addEventListener('pointerdown', closeOutside, true);
    window.addEventListener('contextmenu', closeOutside, true);
    window.addEventListener('focusin', closeOutside);
    onCleanup(() => {
      window.removeEventListener('pointerdown', closeOutside, true);
      window.removeEventListener('contextmenu', closeOutside, true);
      window.removeEventListener('focusin', closeOutside);
    });
    queueMicrotask(() => {
      if (!menu) return;
      clampPopupToViewport(menu);
      menu.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    });
  });

  return (
    <Show when={props.moved || isGitWorktree()}>
      <Tooltip content={props.directory} placement="bottom" disabled={position() !== null}>
        <button
          ref={(element) => {
            button = element;
          }}
          type="button"
          class="chat-header-btn chat-header-location"
          aria-label={isGitWorktree() ? 'Session Git worktree' : 'Session folder'}
          aria-haspopup="menu"
          aria-expanded={position() ? 'true' : undefined}
          onClick={() => {
            const rect = button!.getBoundingClientRect();
            setPosition({ x: rect.left, y: rect.bottom });
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setPosition({ x: event.clientX, y: event.clientY });
          }}
        >
          <UiIcon source={isGitWorktree() ? gitIcon : folderIcon} width={14} height={14} />
        </button>
      </Tooltip>
      <Show when={position()}>
        {(point) => (
          <Portal>
            <div
              ref={(element) => {
                menu = element;
              }}
              class="session-item-actions-menu"
              role="menu"
              aria-label="Session folder actions"
              style={{ left: `${point().x}px`, top: `${point().y}px` }}
              onKeyDown={(event) => {
                if (event.key !== 'Escape') return;
                event.preventDefault();
                close();
                button?.focus();
              }}
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  const payload = { sessionId: props.sessionId, directory: props.directory };
                  close();
                  postMessage({ type: 'vscode/open-folder', payload });
                }}
              >
                Open folder
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  const directory = props.directory;
                  close();
                  void copySessionFolderPath(directory);
                }}
              >
                Copy folder path
              </button>
              <Show when={isGitWorktree()}>
                <button
                  type="button"
                  role="menuitem"
                  disabled={props.readOnly}
                  onClick={() => {
                    const sessionId = props.sessionId;
                    const directory = props.directory;
                    close();
                    void mergeSessionWorktree(sessionId, directory);
                  }}
                >
                  Merge changes
                </button>
                <button
                  type="button"
                  role="menuitem"
                  disabled={props.readOnly}
                  onClick={() => {
                    const sessionId = props.sessionId;
                    const directory = props.directory;
                    close();
                    void moveSessionWorktreeResults(sessionId, directory);
                  }}
                >
                  Migrate changes
                </button>
              </Show>
            </div>
          </Portal>
        )}
      </Show>
    </Show>
  );
}
