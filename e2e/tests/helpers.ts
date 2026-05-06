import type { Page } from '@playwright/test';

export async function getE2EState<T>(page: Page, selector: () => T) {
  return page.evaluate(selector);
}

export async function getScrollMetrics(page: Page, selector: string) {
  return page.locator(selector).evaluate((element) => ({
    scrollTop: element.scrollTop,
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
    distanceFromBottom: element.scrollHeight - element.clientHeight - element.scrollTop,
  }));
}
