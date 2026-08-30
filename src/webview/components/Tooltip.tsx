import {
  children,
  createEffect,
  createSignal,
  createUniqueId,
  onCleanup,
  onMount,
  Show,
} from 'solid-js';
import type { JSX } from 'solid-js';
import { Portal } from 'solid-js/web';
import { onComposerOverlayDismiss } from './chat-input/composer-overlay-dismiss';

export const DEFAULT_TOOLTIP_DELAY = 1000;

type TooltipPosition = {
  left: number;
  top: number;
  arrowLeft: number;
  arrowTop?: number;
  placement: 'top' | 'bottom' | 'left';
};

export function Tooltip(props: {
  content: JSX.Element;
  children: JSX.Element;
  placement?: 'top' | 'bottom' | 'left';
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

  const hide = () => {
    if (showTimer) clearTimeout(showTimer);
    showTimer = undefined;
    setVisible(false);
    setPosition(null);
  };

  const updatePosition = () => {
    if (!trigger || !tooltip) return;

    const triggerBox = trigger.getBoundingClientRect();
    const tooltipBox = tooltip.getBoundingClientRect();
    const viewportMargin = 8;
    const gap = 6;
    if (props.placement === 'left') {
      const left = Math.max(viewportMargin, triggerBox.left - tooltipBox.width - gap);
      const top = Math.min(
        Math.max(viewportMargin, window.innerHeight - tooltipBox.height - viewportMargin),
        Math.max(viewportMargin, triggerBox.top + (triggerBox.height - tooltipBox.height) / 2)
      );
      setPosition({
        left: Math.round(left),
        top: Math.round(top),
        arrowLeft: tooltipBox.width,
        arrowTop: Math.round(triggerBox.top + triggerBox.height / 2 - top),
        placement: 'left',
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
    if (props.disabled || trigger?.getAttribute('aria-expanded') === 'true') return;
    if (showTimer) clearTimeout(showTimer);
    showTimer = setTimeout(() => {
      showTimer = undefined;
      setVisible(true);
      queueMicrotask(updatePosition);
    }, props.delay ?? DEFAULT_TOOLTIP_DELAY);
  };

  onComposerOverlayDismiss(hide);

  createEffect(() => {
    if (props.disabled) {
      hide();
      return;
    }
    if (!visible()) return;
    const reposition = () => updatePosition();
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    onCleanup(() => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    });
  });

  onMount(() => {
    const resolved = resolvedChildren();
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
    onCleanup(() => {
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
  });

  onCleanup(hide);

  return (
    <>
      {resolvedChildren()}
      <Show when={visible()}>
        <Portal>
          <div
            ref={(element) => {
              tooltip = element;
            }}
            id={tooltipId}
            class="themed-tooltip"
            classList={{
              visible: position() !== null,
              top: position()?.placement === 'top',
              bottom: position()?.placement === 'bottom',
              left: position()?.placement === 'left',
            }}
            role="tooltip"
            style={{ left: `${position()?.left ?? 0}px`, top: `${position()?.top ?? 0}px` }}
          >
            {props.content}
            <span
              class="themed-tooltip-arrow"
              style={{
                left: `${position()?.arrowLeft ?? 0}px`,
                top:
                  position()?.arrowTop === undefined ? undefined : `${position()?.arrowTop ?? 0}px`,
              }}
              aria-hidden="true"
            />
          </div>
        </Portal>
      </Show>
    </>
  );
}
