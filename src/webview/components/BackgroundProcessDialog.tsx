import {
  For,
  Show,
  batch,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  untrack,
} from 'solid-js';
import { Portal } from 'solid-js/web';
import type { BackgroundProcess } from '../../shared/background-process';
import { client } from '../lib/client';
import { useSecondClock } from '../lib/clock';
import { trapModalFocus } from '../lib/modal-focus';
import { xmarkIcon } from '../lib/ui-icons';
import { UiIcon } from './UiIcon';
import { recheckSessionStatus, sendMessage } from '../hooks/useOpenCode';
import { captureSessionStatusSnapshotTime, sessionStore } from '../lib/stores/session-store';
import { buildStopProcessPrompt } from '../lib/background-process-action';
import { error as sendError, setError, state } from '../lib/state';

const RETAINED_OUTPUT_CHARS = 128 * 1024;
const POLL_INTERVAL_MS = 1_000;

type ProcessLog = { text: string; cursor: number; size: number; truncated: boolean };

export function BackgroundProcessDialog(props: {
  sessionID: string;
  directory?: string;
  processID?: string;
  onClose: () => void;
}) {
  const [processes, setProcesses] = createSignal<BackgroundProcess[]>([]);
  const [availableIDs, setAvailableIDs] = createSignal(new Set<string>());
  const [selectedID, setSelectedID] = createSignal<string | null>(props.processID ?? null);
  const [logs, setLogs] = createSignal(new Map<string, ProcessLog>());
  const [listError, setListError] = createSignal<string | null>(null);
  const [outputError, setOutputError] = createSignal<string | null>(null);
  const [loaded, setLoaded] = createSignal(false);
  const [retry, setRetry] = createSignal(0);
  const [actionPending, setActionPending] = createSignal(false);
  const [actionError, setActionError] = createSignal<string | null>(null);
  const actionController = new AbortController();
  let actionRevision = 0;
  const [wrapOutput, setWrapOutput] = createSignal(false);
  const [followOutput, setFollowOutput] = createSignal(true);
  // oxlint-disable-next-line no-unassigned-vars
  let outputElement: HTMLPreElement | undefined;
  let dialogElement: HTMLElement | undefined;
  let previousOutputScrollTop = 0;
  let disposed = false;
  onCleanup(() => {
    disposed = true;
    actionController.abort();
  });
  const selectedProcess = createMemo(() =>
    processes().find((process) => process.id === selectedID())
  );
  const selectedStatus = createMemo(() =>
    availableIDs().has(selectedID() ?? '') ? selectedProcess()?.status : undefined
  );
  const selectedLog = createMemo(() => logs().get(selectedID() ?? ''));
  createEffect(() => {
    selectedID();
    setFollowOutput(true);
  });
  createEffect(() => {
    selectedLog();
    wrapOutput();
    followOutput();
    queueMicrotask(() => {
      if (!disposed && outputElement && followOutput()) {
        outputElement.scrollTop = outputElement.scrollHeight;
        previousOutputScrollTop = outputElement.scrollTop;
      }
    });
  });
  const now = useSecondClock(() =>
    processes().some((process) => availableIDs().has(process.id) && process.status === 'running')
  );

  createEffect(() => {
    const sessionID = props.sessionID;
    const directory = props.directory;
    retry();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    onCleanup(() => {
      controller.abort();
      clearTimeout(timer);
    });
    const poll = async () => {
      if (document.hidden || untrack(actionPending)) {
        timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
        return;
      }
      try {
        const revision = actionRevision;
        const next = await client.session.backgroundProcesses(sessionID, {
          directory,
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (revision !== actionRevision) {
          timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
          return;
        }
        const ids = new Set(next.map((process) => process.id));
        // Keep inspected processes and logs after server cleanup and the assistant handoff.
        batch(() => {
          setProcesses((previous) => {
            const previousByID = new Map(previous.map((process) => [process.id, process]));
            return [
              ...next
                .map((process) => {
                  const existing = previousByID.get(process.id);
                  return existing && sameProcess(existing, process) ? existing : process;
                })
                .toSorted(
                  (a, b) =>
                    Number(b.status === 'running') - Number(a.status === 'running') ||
                    b.time.started - a.time.started
                ),
              ...previous.filter((process) => !ids.has(process.id)),
            ];
          });
          setAvailableIDs(ids);
          setLoaded(true);
          setListError(null);
          if (!untrack(selectedID))
            setSelectedID(
              next.find((process) => process.status === 'running')?.id ?? next[0]?.id ?? null
            );
        });
        timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
      } catch (error) {
        if (!controller.signal.aborted)
          setListError(error instanceof Error ? error.message : String(error));
      }
    };
    void poll();
  });

  createEffect(() => {
    const id = selectedID();
    const status = selectedStatus();
    const sessionID = props.sessionID;
    const directory = props.directory;
    retry();
    setOutputError(null);
    if (!id || !status) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    onCleanup(() => {
      controller.abort();
      clearTimeout(timer);
    });
    const poll = async () => {
      if (document.hidden) {
        timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
        return;
      }
      try {
        const previous = untrack(logs).get(id);
        const output = await client.session.backgroundProcessOutput(sessionID, id, {
          directory,
          cursor: previous?.cursor,
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        const combined = (previous?.text ?? '') + output.output;
        const log: ProcessLog = {
          text: combined.slice(-RETAINED_OUTPUT_CHARS),
          cursor: output.cursor,
          size: output.size,
          truncated: Boolean(
            previous?.truncated || output.truncated || combined.length > RETAINED_OUTPUT_CHARS
          ),
        };
        if (
          !previous ||
          output.output ||
          previous.cursor !== log.cursor ||
          previous.size !== log.size ||
          previous.truncated !== log.truncated
        )
          setLogs((current) => new Map(current).set(id, log));
        if (status === 'running' || output.cursor < output.size)
          timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
      } catch (error) {
        if (!controller.signal.aborted)
          setOutputError(error instanceof Error ? error.message : String(error));
      }
    };
    void poll();
  });

  const elapsed = (process: BackgroundProcess) => {
    const end =
      process.time.completed ?? (availableIDs().has(process.id) ? now() : process.time.started);
    const seconds = Math.max(0, Math.floor((end - process.time.started) / 1000));
    return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  };
  const statusLabel = (process: BackgroundProcess) => {
    if (!availableIDs().has(process.id)) return 'No longer available';
    if (process.status === 'exited')
      return process.exit === undefined ? 'Exited' : `Exited (${process.exit})`;
    if (process.status === 'timeout') return 'Timed out';
    return process.status === 'killed' ? 'Killed' : process.service ? 'Service running' : 'Running';
  };

  const changeProcess = async (process: BackgroundProcess, service?: boolean) => {
    if (actionPending()) return;
    const focusedControl = document.activeElement;
    if (focusedControl instanceof HTMLElement && dialogElement?.contains(focusedControl))
      dialogElement.focus({ preventScroll: true });
    setActionPending(true);
    setActionError(null);
    actionRevision++;
    let closeAfterStop = false;
    try {
      const options = { directory: props.directory, signal: actionController.signal };
      if (service === undefined)
        await client.session.stopBackgroundProcess(props.sessionID, process.id, options);
      else
        await client.session.setBackgroundProcessService(
          props.sessionID,
          process.id,
          service,
          options
        );
      if (actionController.signal.aborted) return;
      if (service === undefined) {
        setAvailableIDs((ids) => {
          const next = new Set(ids);
          next.delete(process.id);
          return next;
        });
        closeAfterStop = !processes().some(
          (candidate) => availableIDs().has(candidate.id) && candidate.status === 'running'
        );
      } else
        setProcesses((current) =>
          current.map((candidate) =>
            candidate.id === process.id ? { ...candidate, service } : candidate
          )
        );
      const snapshotStartedAt = captureSessionStatusSnapshotTime();
      const statuses = await client.session.status({
        fresh: true,
        signal: actionController.signal,
      });
      if (actionController.signal.aborted) return;
      sessionStore.setSessionStatuses(statuses, { snapshotStartedAt });
      await recheckSessionStatus(props.sessionID);
    } catch (error) {
      if (!actionController.signal.aborted)
        setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      actionRevision++;
      if (!actionController.signal.aborted) {
        setActionPending(false);
        if (closeAfterStop) props.onClose();
        else if (
          document.activeElement === dialogElement &&
          focusedControl instanceof HTMLElement &&
          focusedControl.isConnected &&
          !focusedControl.hasAttribute('disabled')
        )
          focusedControl.focus({ preventScroll: true });
      }
    }
  };

  const steerStop = async (process: BackgroundProcess) => {
    if (actionPending()) return;
    setActionPending(true);
    const sessionID = props.sessionID;
    const pendingSend = sendMessage(buildStopProcessPrompt(process), {
      delivery: 'steer',
      targetSessionId: sessionID,
      workspaceDirectory: props.directory,
      preserveComposer: true,
      omitContext: true,
    });
    props.onClose();
    try {
      const sent = await pendingSend;
      if (!sent && state.activeSessionId === sessionID)
        setError(sendError() ?? 'Could not send the stop request. Try again.');
    } catch (error) {
      if (state.activeSessionId === sessionID)
        setError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <Portal>
      <div
        class="background-process-overlay"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            props.onClose();
          }
        }}
      >
        <section
          class="background-process-dialog"
          classList={{ 'has-process-target': props.processID !== undefined }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="background-process-title"
          ref={(element) => {
            dialogElement = element;
            onCleanup(trapModalFocus(element, { preventScrollOnRestore: true }));
          }}
        >
          <header class="background-process-dialog-header">
            <h2 id="background-process-title">Background processes</h2>
            <button
              type="button"
              class="background-process-close"
              aria-label="Close background process details"
              onClick={props.onClose}
            >
              <UiIcon source={xmarkIcon} width={16} height={16} aria-hidden="true" />
            </button>
          </header>
          <Show when={listError()}>
            {(error) => (
              <div class="background-process-error" role="alert">
                {error()}{' '}
                <button type="button" onClick={() => setRetry((value) => value + 1)}>
                  Retry
                </button>
              </div>
            )}
          </Show>
          <Show
            when={processes().length > 0}
            fallback={
              <p class="background-process-empty">
                {loaded()
                  ? 'No background processes are available for this session.'
                  : listError()
                    ? 'Could not load background processes.'
                    : 'Loading background processes...'}
              </p>
            }
          >
            <div class="background-process-dialog-body">
              <nav class="background-process-list" aria-label="Background processes">
                <For each={processes().map((process) => process.id)}>
                  {(id) => (
                    <Show when={processes().find((process) => process.id === id)}>
                      {(process) => (
                        <button
                          type="button"
                          class="background-process-list-item"
                          classList={{ 'is-selected': selectedID() === id }}
                          aria-pressed={selectedID() === id}
                          onClick={() => setSelectedID(id)}
                        >
                          <span class="background-process-command">{process().command}</span>
                          <span class="background-process-meta">
                            {statusLabel(process())} ·{' '}
                            {availableIDs().has(id) || process().time.completed !== undefined
                              ? elapsed(process())
                              : 'Log retained'}
                          </span>
                        </button>
                      )}
                    </Show>
                  )}
                </For>
              </nav>
              <Show when={selectedProcess()}>
                {(process) => (
                  <div class="background-process-detail">
                    <div class="background-process-detail-heading">
                      <div class="background-process-detail-command">{process().command}</div>
                      <Show
                        when={
                          availableIDs().has(process().id) || process().time.completed !== undefined
                        }
                      >
                        <span class="background-process-duration">{elapsed(process())}</span>
                      </Show>
                    </div>
                    <div class="background-process-meta background-process-detail-meta">
                      {statusLabel(process())} · {process().cwd}
                      <Show when={process().pid !== undefined}> · PID {process().pid}</Show>
                      <Show when={process().signal}> · Signal {process().signal}</Show>
                    </div>
                    <Show when={!availableIDs().has(process().id)}>
                      <p>Removed by server. Output retained.</p>
                    </Show>
                    <div class="background-process-controls">
                      <label>
                        <input
                          type="checkbox"
                          checked={!process().service}
                          disabled={
                            actionPending() ||
                            !availableIDs().has(process().id) ||
                            process().status !== 'running'
                          }
                          onChange={(event) => {
                            const service = !event.currentTarget.checked;
                            event.currentTarget.checked = !process().service;
                            void changeProcess(process(), service);
                          }}
                        />
                        Wait for completion
                      </label>
                      <div class="background-process-actions">
                        <button
                          type="button"
                          disabled={
                            actionPending() ||
                            !availableIDs().has(process().id) ||
                            process().status !== 'running'
                          }
                          onClick={() => void changeProcess(process())}
                        >
                          Stop process
                        </button>
                        <button
                          type="button"
                          title="Ask the agent to stop this process"
                          disabled={
                            actionPending() ||
                            !availableIDs().has(process().id) ||
                            process().status !== 'running'
                          }
                          onClick={() => void steerStop(process())}
                        >
                          Steer stop
                        </button>
                      </div>
                    </div>
                    <div class="background-process-meta">
                      {process().service
                        ? 'Runs independently. Chat does not wait for this process.'
                        : 'Chat waits for this process and its completion response.'}
                    </div>
                    <Show when={actionError()}>
                      {(error) => (
                        <div class="background-process-error" role="alert">
                          {error()}
                        </div>
                      )}
                    </Show>
                    <Show when={outputError()}>
                      {(error) => (
                        <div class="background-process-error" role="alert">
                          {error()}{' '}
                          <button type="button" onClick={() => setRetry((value) => value + 1)}>
                            Retry
                          </button>
                        </div>
                      )}
                    </Show>
                    <Show when={selectedLog()?.truncated}>
                      <div class="background-process-meta">
                        Earlier output omitted. Showing the latest retained output.
                      </div>
                    </Show>
                    <div class="background-process-console">
                      <div class="background-process-output-toolbar">
                        <span class="background-process-meta">Output</span>
                        <div class="background-process-output-actions">
                          <button
                            type="button"
                            aria-label="Wrap output lines"
                            aria-pressed={wrapOutput()}
                            title="Wrap long output lines"
                            onClick={() => setWrapOutput((value) => !value)}
                          >
                            Wrap
                          </button>
                          <button
                            type="button"
                            aria-label="Follow output"
                            aria-pressed={followOutput()}
                            title={
                              followOutput()
                                ? 'Pause following new output'
                                : 'Scroll to the latest output and keep following'
                            }
                            onClick={() => setFollowOutput((value) => !value)}
                          >
                            {followOutput() ? 'Following' : 'Follow'}
                          </button>
                        </div>
                      </div>
                      <pre
                        ref={outputElement}
                        class="background-process-output"
                        classList={{ 'is-wrapped': wrapOutput() }}
                        tabindex="0"
                        aria-label="Process output"
                        onScroll={(event) => {
                          const element = event.currentTarget;
                          if (element.scrollTop === previousOutputScrollTop) return;
                          previousOutputScrollTop = element.scrollTop;
                          setFollowOutput(
                            element.scrollTop + element.clientHeight >= element.scrollHeight - 8
                          );
                        }}
                      >
                        {selectedLog()?.text ||
                          (selectedLog()
                            ? 'No output yet.'
                            : outputError()
                              ? 'Output unavailable.'
                              : availableIDs().has(process().id)
                                ? 'Loading output...'
                                : 'No output was loaded before this process was removed.')}
                      </pre>
                    </div>
                    <Show when={(selectedLog()?.cursor ?? 0) < (selectedLog()?.size ?? 0)}>
                      <div class="background-process-meta">Loading remaining output...</div>
                    </Show>
                  </div>
                )}
              </Show>
            </div>
          </Show>
        </section>
      </div>
    </Portal>
  );
}

function sameProcess(a: BackgroundProcess, b: BackgroundProcess): boolean {
  return (
    a.id === b.id &&
    a.status === b.status &&
    a.command === b.command &&
    a.cwd === b.cwd &&
    a.pid === b.pid &&
    a.exit === b.exit &&
    a.signal === b.signal &&
    a.service === b.service &&
    a.time.started === b.time.started &&
    a.time.completed === b.time.completed
  );
}
