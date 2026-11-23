import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';

// Repeated streaming checks should not pay the default polling backoff for every chunk.
// Keep the normal assertion timeout and tolerances; only sample settlement more often.
export const STREAMING_SCROLL_POLL_OPTIONS = { intervals: [16, 32, 50] };

export async function waitForHarnessStartup(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => {
        // SAFETY: The isolated harness exposes its read-only startup state.
        const harness = (
          window as typeof window & {
            __varroE2E?: { getStartupState?: () => { initialized: boolean; loading: boolean } };
          }
        ).__varroE2E;
        return harness?.getStartupState?.() ?? { initialized: false, loading: true };
      })
    )
    .toEqual({ initialized: true, loading: false });
}

export async function selectConversationTurn(page: Page, turnNumber: number) {
  const rail = page.getByRole('navigation', { name: 'Conversation turns' });
  await expect(rail).toBeVisible();
  const target = rail.getByRole('button', { name: new RegExp(`^Go to turn ${turnNumber}:`) });
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (await target.count()) {
      await target.click();
      return;
    }
    const first = rail.locator('.turn-navigation-marker').first();
    const label = await first.getAttribute('aria-label');
    const firstNumber = Number(label?.match(/^Go to turn (\d+):/)?.[1]);
    if (!Number.isFinite(firstNumber)) throw new Error(`Invalid turn navigation label: ${label}`);
    const direction = rail.getByRole('button', {
      name: firstNumber > turnNumber ? 'Earlier turns' : 'Later turns',
      exact: true,
    });
    await expect(direction).toBeEnabled();
    await direction.click();
    await expect(first).not.toHaveAttribute('aria-label', label!);
  }
  throw new Error(`Turn ${turnNumber} was not found after paging the navigation rail 20 times`);
}

export interface VisibleMessageAnchor {
  id: string;
  top: number;
  scrollTop: number;
}

export async function getE2EState<T>(page: Page, selector: () => T) {
  return page.evaluate(selector);
}

/** Reads the parts of the first recorded `prompt_async` POST, or `undefined` before one is sent. */
export async function getFirstPromptParts<Part = { type: string; text?: string }>(page: Page) {
  const parts = await page.evaluate(() => {
    // SAFETY: The isolated harness records request bodies exactly as the webview sent them.
    const harness = (
      window as Window & {
        __varroE2E?: {
          requests: Array<{ method: string; path: string; body?: { parts?: unknown[] } }>;
        };
      }
    ).__varroE2E;
    return harness?.requests.find(
      (request) => request.method === 'POST' && request.path.includes('prompt_async')
    )?.body?.parts;
  });
  // SAFETY: Each caller names the part fields it inspects from the controlled harness request.
  return parts as Part[] | undefined;
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

/** Reads how far the transcript list is scrolled above its bottom edge. */
export async function getListDistanceFromBottom(page: Page) {
  return (await getScrollMetrics(page, '.interactive-list')).distanceFromBottom;
}

/** Pins a scroller to its bottom and emits the scroll event that a user scroll would produce. */
export async function scrollToBottom(scroller: Locator) {
  await scroller.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event('scroll'));
  });
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

/** Delivers one host message to the webview, exactly as the extension host would post it. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Tests deliberately post partial or out-of-schema host payloads.
export async function postWebviewMessage(page: Page, message: unknown) {
  await page.evaluate((value) => window.postMessage(value, '*'), message);
}

/** Seeds the fixture that the isolated `session-playback` scenario reads before mounting. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Fixtures are synthetic and validated by the harness when it mounts.
export async function installPlaybackCapture(page: Page, capture: unknown) {
  await page.addInitScript((fixture) => {
    // SAFETY: The isolated playback harness reads this fixture before mounting.
    (window as typeof window & { varroPlaybackCapture: unknown }).varroPlaybackCapture = fixture;
  }, capture);
}
