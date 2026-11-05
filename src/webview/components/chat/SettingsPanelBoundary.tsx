import { ErrorBoundary } from 'solid-js';
import type { JSX } from 'solid-js';
import { postMessage } from '../../lib/bridge';
import { logError } from '../../lib/log';

export function SettingsPanelBoundary(props: {
  name: string;
  panelClass: string;
  onClose: () => void;
  children: JSX.Element;
}) {
  return (
    <ErrorBoundary
      fallback={
        // oxlint-disable-next-line react/no-unstable-nested-components -- Solid ErrorBoundary owns this fallback callback; it is not a React component type.
        (error: Error) => {
          logError(`settings-panel:${props.name}`, error);
          const importFailed =
            /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS/i.test(
              error.message
            );
          return (
            <section class={props.panelClass} aria-label={props.name}>
              <div class="server-status-surface h-full" role="alert">
                <div class="server-status-content">
                  <p class="text-sm text-vscode-error">{props.name} could not load</p>
                  <p class="text-xs text-vscode-muted">
                    {importFailed
                      ? 'A sidebar file is unavailable. This can happen after Varro is updated or reinstalled. Reload the sidebar to load the current files, or return to chat without reloading.'
                      : error.message}
                  </p>
                  <button class="server-status-action-button" onClick={props.onClose}>
                    Back to chat
                  </button>
                  <button
                    class="server-status-action-button"
                    onClick={() => postMessage({ type: 'webview/reload' })}
                  >
                    Reload sidebar
                  </button>
                </div>
              </div>
            </section>
          );
        }
      }
    >
      {props.children}
    </ErrorBoundary>
  );
}
