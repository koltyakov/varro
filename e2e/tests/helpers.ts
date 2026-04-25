import type { Page } from '@playwright/test';

export async function getE2EState<T>(page: Page, selector: () => T) {
  return page.evaluate(selector);
}
