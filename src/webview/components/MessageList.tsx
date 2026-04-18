import { For, Show, createEffect, onCleanup } from 'solid-js';
import { state, isLoading } from '../lib/state';
import { Message } from './Message';

export function MessageList() {
  let containerRef: HTMLDivElement | undefined;
  let userScrolledUp = false;

  function onScroll() {
    if (!containerRef) return;
    const near =
      containerRef.scrollHeight - containerRef.scrollTop - containerRef.clientHeight < 60;
    userScrolledUp = !near;
  }

  createEffect(() => {
    const _len = state.messages.length;
    const _parts = state.messages.reduce((acc, m) => acc + m.parts.length, 0);
    void _len;
    void _parts;
    if (!containerRef || userScrolledUp) return;
    requestAnimationFrame(() => {
      containerRef!.scrollTop = containerRef!.scrollHeight;
    });
  });

  onCleanup(() => {});

  return (
    <div
      ref={containerRef}
      class="interactive-list min-h-0 flex-1 overflow-y-auto scroll-smooth"
      onScroll={onScroll}
    >
      <For each={state.messages}>
        {(msg, i) => {
          const prev = () => (i() > 0 ? state.messages[i() - 1] : null);
          const isFirstInGroup = () => !prev() || prev()!.info.role !== msg.info.role;
          return (
            <div
              class={`interactive-item-container ${
                msg.info.role === 'user' ? 'interactive-request' : 'interactive-response'
              }`}
            >
              <Message info={msg.info} parts={msg.parts} isFirstInGroup={isFirstInGroup()} />
            </div>
          );
        }}
      </For>
      <Show when={isLoading()}>
        <div class="interactive-item-container interactive-response" style={{ padding: '8px 16px' }}>
          <div class="loading-indicator">
            <div class="loading-spinner" />
            <span class="chat-animated-ellipsis" />
          </div>
        </div>
      </Show>
    </div>
  );
}
