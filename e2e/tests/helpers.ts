import type { Page } from '@playwright/test';

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
