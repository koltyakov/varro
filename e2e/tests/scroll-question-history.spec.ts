import { expect, test } from '@playwright/test';
import { waitForAnimationFrames } from './helpers';

test('reduced motion hides hydrating history without a visibility transition', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/e2e/harness/index.html?scenario=linked-tool-question&history=1');
  const list = page.locator('.interactive-list');
  await expect(list).toBeVisible();
  await waitForAnimationFrames(page, 30);
  const hydration = await list.evaluate((element) => {
    element.classList.add('is-session-hydrating');
    return {
      visibility: getComputedStyle(element).visibility,
      transitions: element.getAnimations().length,
    };
  });
  expect(hydration.visibility).toBe('hidden');
  expect(hydration.transitions).toBe(0);
});

test('reduced motion applies row-height corrections in the same layout', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/e2e/harness/index.html?scenario=linked-tool-question&history=1');
  const row = page.locator('[data-msg-id="question-history-response"]');
  await expect(row).toBeVisible();
  await waitForAnimationFrames(page, 30);
  const geometry = await row.evaluate((element) => {
    const before = element.getBoundingClientRect().height;
    const correction =
      Number.parseFloat(
        getComputedStyle(element).getPropertyValue('--interactive-item-block-correction')
      ) || 0;
    element.style.setProperty('--interactive-item-block-correction', `${correction + 8}px`);
    return { before, after: element.getBoundingClientRect().height };
  });
  expect(geometry.after - geometry.before).toBe(8);
});

for (const fontSize of [13, 13.5, 14]) {
  test(`opened question history remains stable at ${fontSize}px with reduced motion`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 500, height: 1182 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/e2e/harness/index.html?scenario=linked-tool-question&history=1');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();
    await page.addStyleTag({ content: `:root { --varro-chat-font-size: ${fontSize}px; }` });
    await waitForAnimationFrames(page, 30);
    const samples = await list.evaluate(async (element) => {
      const rows = () => [...element.querySelectorAll<HTMLElement>('[data-msg-id]')];
      const result = [];
      for (let frame = 0; frame < 120; frame++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        result.push({
          scrollTop: element.scrollTop,
          height: element.scrollHeight,
          rows: rows().map((row) => ({
            id: row.dataset.msgId,
            height: row.getBoundingClientRect().height,
            top: row.getBoundingClientRect().top,
            correction: row.style.getPropertyValue('--interactive-item-block-correction'),
          })),
        });
      }
      return result;
    });
    await test.info().attach('stationary-frames', {
      body: JSON.stringify(samples),
      contentType: 'application/json',
    });
    expect(new Set(samples.map((sample) => sample.height)).size).toBe(1);
    expect(new Set(samples.map((sample) => sample.scrollTop)).size).toBe(1);
    const responses = samples.map((sample) =>
      sample.rows.find((row) => row.id === 'question-history-response')
    );
    expect(responses.every((row) => row !== undefined && row.height > 0)).toBe(true);
    const responseHeights = responses.map((row) => row!.height);
    expect(new Set(responseHeights).size).toBe(1);
    expect(new Set(responses.map((row) => row!.top)).size).toBe(1);
    await expect(page.getByRole('status', { name: 'Loading messages', exact: true })).toHaveCount(
      0
    );
    await expect(list).toContainText('Two facts shape the resume:');
    await expect(list.locator('.question-prompt')).toBeVisible();
  });
}
