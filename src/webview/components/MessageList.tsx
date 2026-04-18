import { For, Show, createEffect, createMemo, createSignal } from 'solid-js';
import { state, isLoading } from '../lib/state';
import { Message } from './Message';

const emptyStateLogoUrl = new URL('../../../assets/icon.png', import.meta.url).href;

export function MessageList() {
  // oxlint-disable-next-line no-unassigned-vars
  let containerRef: HTMLDivElement | undefined;
  const [autoScroll, setAutoScroll] = createSignal(true);
  const visibleMessages = createMemo(() => state.messages);

  function onScroll() {
    if (!containerRef) return;
    const near =
      containerRef.scrollHeight - containerRef.scrollTop - containerRef.clientHeight < 60;
    setAutoScroll(near);
  }

  createEffect(() => {
    const _len = visibleMessages().length;
    const _parts = visibleMessages().reduce((acc, m) => acc + m.parts.length, 0);
    void _len;
    void _parts;
    if (!containerRef || !autoScroll()) return;
    requestAnimationFrame(() => {
      containerRef!.scrollTop = containerRef!.scrollHeight;
    });
  });

  return (
    <div
      ref={containerRef}
      class="interactive-list min-h-0 flex-1 overflow-y-auto scroll-smooth"
      onScroll={onScroll}
    >
      <div class="interactive-list-track">
        <Show
          when={visibleMessages().length > 0}
          fallback={
            <div class="chat-empty-state">
              <img
                class="chat-empty-logo"
                src={emptyStateLogoUrl}
                alt=""
                aria-hidden="true"
                draggable="false"
              />
            </div>
          }
        >
          <For each={visibleMessages()}>
            {(msg) => (
              <div
                class={`interactive-item-container ${
                  msg.info.role === 'user' ? 'interactive-request' : 'interactive-response'
                }`}
              >
                <Message info={msg.info} parts={msg.parts} />
              </div>
            )}
          </For>
        </Show>
        <Show when={isLoading()}>
          <div class="interactive-item-container interactive-response interactive-loading-row">
            <div class="loading-indicator">
              <div class="loading-spinner" />
              <span>Generating</span>
              <span class="chat-animated-ellipsis" />
            </div>
          </div>
        </Show>
      </div>
    </div>
  );
}
