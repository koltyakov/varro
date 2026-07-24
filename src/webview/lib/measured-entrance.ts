type MeasuredEntranceOptions = {
  animationName: string;
  heightProperty: string;
  onFinish?: () => void;
  skipWithin?: string;
};

const ACTIVE_CLASS = 'measured-entrance-active';

export function prepareMeasuredEntrance(element: HTMLElement, options: MeasuredEntranceOptions) {
  queueMicrotask(() => {
    if (!element.isConnected || (options.skipWithin && element.closest(options.skipWithin))) return;

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

    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => updateTargetHeight());
    observer?.observe(element);

    let finished = false;
    const finish = (event: AnimationEvent) => {
      if (event.target !== element || event.animationName !== options.animationName) return;
      if (finished) return;
      finished = true;
      observer?.disconnect();
      element.classList.remove(ACTIVE_CLASS);
      element.style.removeProperty(options.heightProperty);
      element.removeEventListener('animationend', finish);
      element.removeEventListener('animationcancel', finish);
      options.onFinish?.();
    };

    element.addEventListener('animationend', finish);
    element.addEventListener('animationcancel', finish);
    element.classList.add(ACTIVE_CLASS);
  });
}
