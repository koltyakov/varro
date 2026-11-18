// Runs in the verified application world. No scroll setters or product state changes.
export function installNativePaintProbe() {
  const list = document.querySelector('.interactive-list');
  if (!list) throw new Error('Transcript unavailable');
  const ids = new WeakMap();
  let nextID = 0;
  const identity = (node) => {
    if (!ids.has(node)) ids.set(node, ++nextID);
    return ids.get(node);
  };
  const rect = (element) => {
    const r = element.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  };
  const probe = (globalThis['__nativePaint'] = {
    label: '',
    samples: [],
    events: [],
    mutations: [],
    stopped: false,
  });
  const stamp = () => ({ epoch: performance.timeOrigin + performance.now(), label: probe.label });
  const snapshot = () => {
    const viewport = rect(list);
    // Hit testing does not see the sticky prompt's pointer-events:none solid gap.
    // Keep its actual paint geometry, including when a wrapped prompt is taller.
    const stickyOccluders = [
      ...list.querySelectorAll(
        '.latest-user-message-sticky-top, .latest-user-message-sticky-shell, .latest-user-message-sticky-bottom-solid'
      ),
    ].flatMap((element) => {
      const bounds = rect(element);
      if (bounds.width <= 0 || bounds.height <= 0) return [];
      for (let parent = element; parent && parent !== list; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        if (
          style.display === 'none' ||
          style.visibility !== 'visible' ||
          Number(style.opacity) === 0
        )
          return [];
      }
      return [{ ...bounds, class: element.className }];
    });
    const rows = [...list.querySelectorAll('[data-msg-id]')].map((row) => ({
      id: row.dataset.msgId,
      node: identity(row),
      ...rect(row),
      placeholder: row.classList.contains('interactive-item-virtual-placeholder'),
    }));
    const markers = [...list.querySelectorAll('.rendered-markdown p')].flatMap((p) => {
      const r = rect(p);
      if (
        r.y < viewport.y + 8 ||
        r.y + r.height > viewport.y + viewport.height - 15 ||
        r.height > 30 ||
        r.width < 100
      )
        return [];
      const range = document.createRange();
      range.selectNodeContents(p);
      const text = rect(range);
      const styles = [];
      for (let e = p; e && e !== list; e = e.parentElement) {
        const s = getComputedStyle(e);
        styles.push({
          opacity: s.opacity,
          visibility: s.visibility,
          display: s.display,
          contain: s.contain,
          clip: s.clipPath,
          transform: s.transform,
          rect: rect(e),
        });
      }
      return [
        {
          node: identity(p),
          row: p.closest('[data-msg-id]')?.dataset.msgId,
          text: p.textContent,
          rect: text,
          styles,
          hits: document
            .elementsFromPoint(text.x + text.width / 2, text.y + text.height / 2)
            .slice(0, 5)
            .map((element) => ({
              tag: element.tagName,
              class: element.className,
              row: element.closest('[data-msg-id]')?.dataset.msgId,
              containsParagraph: element.contains(p),
            })),
        },
      ];
    });
    return {
      ...stamp(),
      top: list.scrollTop,
      height: list.scrollHeight,
      viewport,
      stickyOccluders,
      rows,
      markers,
      held: list.hasAttribute('data-pointer-scroll-owned'),
      banner: !!list.querySelector('.message-history-banner'),
      firstLoadedMessageId: list.dataset.firstLoadedMessageId ?? null,
      previews: list.querySelectorAll('.file-change-inline-diffs').length,
      diffLines: list.querySelectorAll('.diff-view-lines').length,
    };
  };
  const onScroll = () => probe.events.push({ ...stamp(), type: 'scroll', top: list.scrollTop });
  list.addEventListener('scroll', onScroll, { capture: true, passive: true });
  const observer = new MutationObserver((records) => {
    if (!probe.label) return;
    probe.mutations.push({
      ...stamp(),
      records: records.map((record) => ({
        target: identity(record.target),
        attribute: record.attributeName,
        added: [...record.addedNodes].map(identity),
        removed: [...record.removedNodes].map(identity),
      })),
    });
  });
  observer.observe(list, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['style', 'class'],
  });
  const tick = () => {
    if (probe.stopped) return;
    if (probe.label) probe.samples.push(snapshot());
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  probe.snapshot = snapshot;
  probe.begin = (label) => {
    probe.label = label;
    // oxlint-disable-next-line no-console -- Correlate DOM epoch and compositor trace clocks.
    console.timeStamp(`native-paint:${label}:${Date.now()}`);
    probe.samples.push(snapshot());
  };
  probe.stop = () => {
    probe.stopped = true;
    observer.disconnect();
    list.removeEventListener('scroll', onScroll, true);
    return { samples: probe.samples, events: probe.events, mutations: probe.mutations };
  };
}
