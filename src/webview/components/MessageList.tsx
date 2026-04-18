import { For, Show, createEffect, onCleanup } from 'solid-js';
import { state, isLoading } from '../lib/state';
import { Message } from './Message';

export function MessageList() {
  // oxlint-disable-next-line no-unassigned-vars
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
      class="min-h-0 flex-1 overflow-y-auto scroll-smooth"
      onScroll={onScroll}
    >
      <div class="flex w-full flex-col px-3 py-2">
        <For each={state.messages}>
          {(msg, i) => {
            const prev = () => (i() > 0 ? state.messages[i() - 1] : null);
            const isFirstInGroup = () => !prev() || prev()!.info.role !== msg.info.role;
            return <Message info={msg.info} parts={msg.parts} isFirstInGroup={isFirstInGroup()} />;
          }}
        </For>
        <Show when={isLoading()}>
          <div class="mt-1 flex items-center gap-1.5 animate-fade-in">
            <span class="h-1.5 w-1.5 rounded-full bg-vscode-muted/40 animate-pulse-soft" />
            <span
              class="h-1.5 w-1.5 rounded-full bg-vscode-muted/40 animate-pulse-soft"
              style={{ 'animation-delay': '0.25s' }}
            />
            <span
              class="h-1.5 w-1.5 rounded-full bg-vscode-muted/40 animate-pulse-soft"
              style={{ 'animation-delay': '0.5s' }}
            />
          </div>
        </Show>
      </div>
    </div>
  );
}
