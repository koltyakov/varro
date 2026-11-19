import { Errored, Show, createEffect, createMemo } from 'solid-js';
import { type JSX } from '@solidjs/web';
import { postMessage } from '../../lib/bridge';
import { logError } from '../../lib/log';
import { statusIcons } from '../../lib/status-icons';
import { UiIcon } from '../UiIcon';

export function SettingsPanelBoundary(props: {
  name: string;
  panelClass: string;
  onClose: () => void;
  children: JSX.Element;
}) {
  return (
    <Errored
      fallback={
        // oxlint-disable-next-line react/no-unstable-nested-components -- Solid Errored owns this fallback callback; it is not a React component type.
        (source) => {
          const error = createMemo(() => {
            const value = source();
            return value instanceof Error ? value : new Error(String(value));
          });
          createEffect(error, (value) => logError(`settings-panel:${props.name}`, value));
          const importFailed = createMemo(() =>
            /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS/i.test(
              error().message
            )
          );
          return (
            <section class={props.panelClass} aria-label={props.name}>
              <div class="server-status-surface settings-panel-error-surface" role="alert">
                <div class="settings-panel-error-card">
                  <h2 class="settings-panel-error-title">
                    <UiIcon
                      source={statusIcons.warningCircle}
                      class="settings-panel-error-icon"
                      width={20}
                      height={20}
                    />
                    <span>{props.name} could not load</span>
                  </h2>
                  <p class="settings-panel-error-description">
                    {importFailed()
                      ? 'A required sidebar file is unavailable. This can happen after Varro is updated or reinstalled. Reload the sidebar to load the current files.'
                      : 'This panel ran into a problem. Reload the sidebar to try again, or return to chat without reloading.'}
                  </p>
                  <Show when={!importFailed()}>
                    <details class="settings-panel-error-details">
                      <summary>Error details</summary>
                      <pre>{error().message}</pre>
                    </details>
                  </Show>
                  <div class="settings-panel-error-actions">
                    <button
                      class="server-status-action-button"
                      onClick={() => postMessage({ type: 'webview/reload' })}
                    >
                      <span>Reload sidebar</span>
                    </button>
                    <button class="server-status-secondary-button" onClick={props.onClose}>
                      <span>Back to chat</span>
                    </button>
                  </div>
                </div>
              </div>
            </section>
          );
        }
      }
    >
      {props.children}
    </Errored>
  );
}
