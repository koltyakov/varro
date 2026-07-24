type MeasuredEntranceOptions = {
  animationName: string;
  heightProperty: string;
  onFinish?: () => void;
  skipWithin?: string;
};

const ACTIVE_CLASS = 'measured-entrance-active';

export function prepareMeasuredEntrance(
  element: HTMLElement,
  options: MeasuredEntranceOptions
): () => void {
  let observer: ResizeObserver | null = null;
  let finish: ((event: AnimationEvent) => void) | null = null;
  let cleanedUp = false;

  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    observer?.disconnect();
    observer = null;
    if (finish) {
      element.removeEventListener('animationend', finish);
      element.removeEventListener('animationcancel', finish);
    }
    element.classList.remove(ACTIVE_CLASS);
    element.style.removeProperty(options.heightProperty);
  };

  queueMicrotask(() => {
    if (cleanedUp) return;
    if (!element.isConnected || (options.skipWithin && element.closest(options.skipWithin))) {
      cleanedUp = true;
      return;
    }

    let targetHeight = -1;
    const updateTargetHeight = () => {
      const nextHeight = Math.ceil(
        Math.max(element.scrollHeight, element.getBoundingClientRect().height)
      );
      if (nextHeight <= targetHeight) return;
      targetHeight = nextHeight;
      element.style.setProperty(options.heightProperty, `${targetHeight}px`);
    };
    updateTargetHeight();

    observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => updateTargetHeight());
    observer?.observe(element);

    finish = (event: AnimationEvent) => {
      if (event.target !== element || event.animationName !== options.animationName) return;
      if (cleanedUp) return;
      cleanup();
      options.onFinish?.();
    };

    element.addEventListener('animationend', finish);
    element.addEventListener('animationcancel', finish);
    element.classList.add(ACTIVE_CLASS);
  });

  return cleanup;
}
