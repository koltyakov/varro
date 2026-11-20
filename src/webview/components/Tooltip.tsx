import {
  createEffect,
  children,
  createSignal,
  createUniqueId,
  onCleanup,
  onSettled,
  Show,
} from 'solid-js';
import { type JSX, Portal } from '@solidjs/web';

import { registerComposerOverlayDismiss } from './chat-input/composer-overlay-dismiss';

export const DEFAULT_TOOLTIP_DELAY = 1000;

type TooltipPosition = {
  left: number;
  top: number;
  arrowLeft: number;
  arrowTop?: number;
  placement: 'top' | 'bottom' | 'left' | 'right';
};

export function Tooltip(props: {
  content: JSX.Element;
  children?: JSX.Element;
  /** Attach to an existing editor-owned element without reparenting it. */
  target?: HTMLElement;
  placement?: 'top' | 'bottom' | 'left' | 'right';
  variant?: 'tooltip' | 'panel';
  /** Align a description panel to the full owning row rather than its text trigger. */
  anchor?: () => HTMLElement | undefined;
  delay?: number;
  disabled?: boolean;
}) {
  const resolvedChildren = children(() => props.children);
  const tooltipId = createUniqueId();
  const [visible, setVisible] = createSignal(false);
  const [position, setPosition] = createSignal<TooltipPosition | null>(null);
  let trigger: HTMLElement | undefined;
  let tooltip: HTMLDivElement | undefined;
  let showTimer: ReturnType<typeof setTimeout> | undefined;
  let unregisterComposerDismiss: (() => void) | undefined;
  let panelResizeObserver: ResizeObserver | undefined;

  const hide = () => {
    if (showTimer) clearTimeout(showTimer);
    showTimer = undefined;
    unregisterComposerDismiss?.();
    unregisterComposerDismiss = undefined;
    panelResizeObserver?.disconnect();
    panelResizeObserver = undefined;
    setVisible(false);
    setPosition(null);
  };

  const updatePosition = () => {
    if (!trigger || !tooltip) return;

    const triggerBox = (props.anchor?.() ?? trigger).getBoundingClientRect();
    if (props.variant === 'panel') {
      tooltip.style.width = `${Math.min(triggerBox.width, Math.max(0, window.innerWidth - 16))}px`;
    }
    const tooltipBox = tooltip.getBoundingClientRect();
    const viewportMargin = 8;
    const gap = props.variant === 'panel' ? 7 : 6;
    if (props.placement === 'left' || props.placement === 'right') {
      const left =
        props.placement === 'right'
          ? Math.min(window.innerWidth - tooltipBox.width - viewportMargin, triggerBox.right + gap)
          : Math.max(viewportMargin, triggerBox.left - tooltipBox.width - gap);
      const top = Math.min(
        Math.max(viewportMargin, window.innerHeight - tooltipBox.height - viewportMargin),
        Math.max(viewportMargin, triggerBox.top + (triggerBox.height - tooltipBox.height) / 2)
      );
      setPosition({
        left: Math.round(left),
        top: Math.round(top),
        arrowLeft: props.placement === 'right' ? 0 : tooltipBox.width,
        arrowTop: Math.round(triggerBox.top + triggerBox.height / 2 - top),
        placement: props.placement,
      });
      return;
    }
    const left = Math.min(
      Math.max(viewportMargin, window.innerWidth - tooltipBox.width - viewportMargin),
      Math.max(viewportMargin, triggerBox.left + (triggerBox.width - tooltipBox.width) / 2)
    );
    const topPosition = triggerBox.top - tooltipBox.height - gap;
    const bottomPosition = triggerBox.bottom + gap;
    const placement =
      props.placement === 'bottom'
        ? bottomPosition + tooltipBox.height <= window.innerHeight - viewportMargin
          ? 'bottom'
          : 'top'
        : topPosition >= viewportMargin
          ? 'top'
          : 'bottom';
    const preferredTop = placement === 'top' ? topPosition : bottomPosition;
    const top = Math.min(
      Math.max(viewportMargin, window.innerHeight - tooltipBox.height - viewportMargin),
      Math.max(viewportMargin, preferredTop)
    );
    const arrowLeft = Math.min(
      tooltipBox.width - 10,
      Math.max(10, triggerBox.left + triggerBox.width / 2 - left)
    );

    setPosition({
      left: Math.round(left),
      top: Math.round(top),
      arrowLeft: Math.round(arrowLeft),
      placement,
    });
  };

  const show = () => {
    if (showTimer) clearTimeout(showTimer);
    unregisterComposerDismiss ??= registerComposerOverlayDismiss(hide);
    showTimer = setTimeout(() => {
      showTimer = undefined;
      // The trigger can stage its truncation measurement during the same hover event.
      if (props.disabled || trigger?.getAttribute('aria-expanded') === 'true') {
        hide();
        return;
      }
      setVisible(true);
      queueMicrotask(() => {
        if (!visible()) return;
        updatePosition();
        if (props.variant !== 'panel' || !tooltip || !globalThis.ResizeObserver) return;
        panelResizeObserver?.disconnect();
        panelResizeObserver = new ResizeObserver(updatePosition);
        panelResizeObserver.observe(tooltip);
        const anchor = props.anchor?.();
        if (anchor) panelResizeObserver.observe(anchor);
      });
    }, props.delay ?? DEFAULT_TOOLTIP_DELAY);
  };

  createEffect(
    () => ({ disabled: props.disabled, isVisible: visible() }),
    ({ disabled, isVisible }) => {
      if (disabled) {
        hide();
        return undefined;
      }
      if (!isVisible) return undefined;
      const reposition = () => updatePosition();
      window.addEventListener('resize', reposition);
      window.addEventListener('scroll', reposition, true);
      return () => {
        window.removeEventListener('resize', reposition);
        window.removeEventListener('scroll', reposition, true);
      };
    }
  );

  onSettled(() => {
    const cleanups: Array<() => void> = [];

    const resolved = props.target ?? resolvedChildren();
    if (!(resolved instanceof HTMLElement)) {
      throw new Error('Tooltip requires a single HTML element child');
    }
    const triggerElement = resolved;
    trigger = triggerElement;
    const previousDescription = triggerElement.getAttribute('aria-describedby');
    const handleFocusOut = (event: FocusEvent) => {
      if (!(event.relatedTarget instanceof Node) || !trigger?.contains(event.relatedTarget)) hide();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') hide();
    };

    triggerElement.setAttribute(
      'aria-describedby',
      previousDescription ? `${previousDescription} ${tooltipId}` : tooltipId
    );
    triggerElement.addEventListener('mouseenter', show);
    triggerElement.addEventListener('mouseleave', hide);
    triggerElement.addEventListener('focusin', show);
    triggerElement.addEventListener('focusout', handleFocusOut);
    triggerElement.addEventListener('keydown', handleKeyDown);
    triggerElement.addEventListener('click', hide);
    const expandedObserver = new MutationObserver(() => {
      if (triggerElement.getAttribute('aria-expanded') === 'true') hide();
    });
    expandedObserver.observe(triggerElement, {
      attributes: true,
      attributeFilter: ['aria-expanded'],
    });
    cleanups.push(() => {
      triggerElement.removeEventListener('mouseenter', show);
      triggerElement.removeEventListener('mouseleave', hide);
      triggerElement.removeEventListener('focusin', show);
      triggerElement.removeEventListener('focusout', handleFocusOut);
      triggerElement.removeEventListener('keydown', handleKeyDown);
      triggerElement.removeEventListener('click', hide);
      expandedObserver.disconnect();
      if (previousDescription) {
        triggerElement.setAttribute('aria-describedby', previousDescription);
      } else {
        triggerElement.removeAttribute('aria-describedby');
      }
    });

    return () => {
      for (const cleanup of cleanups.toReversed()) cleanup();
    };
  });

  onCleanup(hide);

  return (
    <>
      {props.target ? null : resolvedChildren()}
      <Show when={visible()}>
        <Portal>
          <div
            ref={(element) => {
              tooltip = element;
            }}
            id={tooltipId}

            class={[
              'themed-tooltip',
              {
                panel: props.variant === 'panel',
                visible: position() !== null,
                top: position()?.placement === 'top',
                bottom: position()?.placement === 'bottom',
                left: position()?.placement === 'left',
                right: position()?.placement === 'right',
              },
            ]}
            role="tooltip"
            style={{ left: `${position()?.left ?? 0}px`, top: `${position()?.top ?? 0}px` }}
          >
            {props.content}
            <Show when={props.variant !== 'panel'}>
              <span
                class="themed-tooltip-arrow"
                style={{
                  left: `${position()?.arrowLeft ?? 0}px`,
                  top:
                    position()?.arrowTop === undefined
                      ? undefined
                      : `${position()?.arrowTop ?? 0}px`,
                }}
                aria-hidden="true"
              />
            </Show>
          </div>
        </Portal>
      </Show>
    </>
  );
}
