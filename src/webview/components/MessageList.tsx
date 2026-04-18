import { For, Show, createEffect, createSignal } from 'solid-js';
import { state, isLoading } from '../lib/state';
import { Message } from './Message';

export function MessageList() {
  let containerRef: HTMLDivElement | undefined;
  const [autoScroll, setAutoScroll] = createSignal(true);

  function onScroll() {
    if (!containerRef) return;
    const near =
      containerRef.scrollHeight - containerRef.scrollTop - containerRef.clientHeight < 60;
    setAutoScroll(near);
  }

  createEffect(() => {
    const _len = state.messages.length;
    const _parts = state.messages.reduce((acc, m) => acc + m.parts.length, 0);
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
      <For each={state.messages}>
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
      <Show when={isLoading()}>
        <div class="interactive-item-container interactive-response" style={{ padding: '10px 16px' }}>
          <div class="loading-indicator">
            <div class="loading-spinner" />
            <span style={{ 'font-size': '11px', color: 'var(--color-vscode-muted)' }}>Generating</span>
            <span class="chat-animated-ellipsis" />
          </div>
        </div>
      </Show>
    </div>
  );
}
