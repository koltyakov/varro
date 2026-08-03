import type { Locator, Page } from '@playwright/test';

export interface VisibleMessageAnchor {
  id: string;
  top: number;
  scrollTop: number;
}

export async function getE2EState<T>(page: Page, selector: () => T) {
  return page.evaluate(selector);
}

export async function waitForAnimationFrame(page: Page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
}

export async function waitForAnimationFrames(page: Page, count: number) {
  for (let index = 0; index < count; index += 1) {
    await waitForAnimationFrame(page);
  }
}

export async function getScrollMetrics(page: Page, selector: string) {
  return page.locator(selector).evaluate((element) => ({
    scrollTop: element.scrollTop,
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
    distanceFromBottom: element.scrollHeight - element.clientHeight - element.scrollTop,
  }));
}

export async function getVisibleMessageAnchor(
  list: Locator,
  messageId?: string
): Promise<VisibleMessageAnchor> {
  return list.evaluate((element, targetId) => {
    const containerRect = element.getBoundingClientRect();
    const rows = [...element.querySelectorAll<HTMLElement>('[data-msg-id]')];
    const row = targetId
      ? rows.find((candidate) => candidate.dataset.msgId === targetId)
      : rows.find((candidate) => {
          const rect = candidate.getBoundingClientRect();
          return rect.bottom > containerRect.top && rect.top < containerRect.bottom;
        });
    if (!row?.dataset.msgId)
      throw new Error(`Visible message ${targetId ?? 'anchor'} is not mounted`);

    return {
      id: row.dataset.msgId,
      top: row.getBoundingClientRect().top - containerRect.top,
      scrollTop: element.scrollTop,
    };
  }, messageId);
}

export async function sampleMessageTopAcrossFrames(
  list: Locator,
  messageId: string,
  frameCount = 8
): Promise<Array<number | null>> {
  return list.evaluate(
    async (element, args) => {
      const samples: Array<number | null> = [];
      for (let frame = 0; frame < args.frameCount; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const row = [...element.querySelectorAll<HTMLElement>('[data-msg-id]')].find(
          (candidate) => candidate.dataset.msgId === args.messageId
        );
        samples.push(
          row?.isConnected
            ? row.getBoundingClientRect().top - element.getBoundingClientRect().top
            : null
        );
      }
      return samples;
    },
    { messageId, frameCount }
  );
}

export async function getStickyMessageAlignment(card: Locator) {
  return card.evaluate((element) => {
    if (!(element instanceof HTMLElement) || !element.matches('.user-message-card')) {
      throw new Error('Sticky destination must be a mounted .user-message-card');
    }
    const list = element.closest<HTMLElement>('.interactive-list');
    const track = element.closest<HTMLElement>('.interactive-list-track');
    const row = element.closest<HTMLElement>('[data-msg-id]');
    if (!list || !track || !row?.dataset.msgId)
      throw new Error('Sticky destination geometry is missing');

    const stickyGap = Number.parseFloat(
      getComputedStyle(track).getPropertyValue('--latest-user-message-sticky-gap')
    );
    if (!Number.isFinite(stickyGap)) throw new Error('Sticky destination gap is not computed');

    const cardTop = element.getBoundingClientRect().top - list.getBoundingClientRect().top;
    return {
      id: row.dataset.msgId,
      cardTop,
      stickyGap,
      delta: cardTop - stickyGap,
    };
  });
}

export async function installOuterScrollSentinel(page: Page, scrollTop = 40) {
  return page.locator('#root').evaluate((root, targetScrollTop) => {
    root.style.overflowY = 'auto';
    const spacer = document.createElement('div');
    spacer.dataset.testOuterScrollSpacer = 'true';
    spacer.style.height = '160px';
    root.append(spacer);
    root.scrollTop = targetScrollTop;
    return root.scrollTop;
  }, scrollTop);
}
