/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- SAFETY: These E2E checks inspect controlled question responses exposed by the harness browser global. */
import { expect, test } from '@playwright/test';
import { getE2EState } from './helpers';

for (const width of [480, 1100]) {
  for (const scenario of ['question-prompt', 'native-question-prompt', 'native-question-inputs']) {
    test(`keeps answer typography and layout stable when selecting ${scenario} at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(`/e2e/harness/index.html?scenario=${scenario}`);
      const choices = page
        .locator('.question-option')
        .filter({ has: page.locator('.question-option-label') });
      const first = choices.first();
      const second = choices.nth(1);
      await expect(first).toBeVisible();
      const measure = () =>
        choices.evaluateAll((elements) =>
          elements.map((element) => {
            const row = element.getBoundingClientRect();
            return {
              height: row.height,
              width: row.width,
              text: Array.from(
                element.querySelectorAll('.question-option-label, .question-option-desc')
              ).map((text) => ({
                weight: getComputedStyle(text).fontWeight,
                rects: Array.from(text.getClientRects()).map((rect) => ({
                  x: rect.x - row.x,
                  y: rect.y - row.y,
                  width: rect.width,
                  height: rect.height,
                })),
              })),
            };
          })
        );
      const before = await measure();
      await first.click();
      await expect(first).toHaveClass(/selected/);
      expect(await measure()).toEqual(before);
      await second.click();
      if (scenario === 'native-question-inputs') await first.click();
      await expect(first).not.toHaveClass(/selected/);
      await expect(second).toHaveClass(/selected/);
      expect(await measure()).toEqual(before);
    });
  }
}

test('answers a standalone question prompt', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=question-prompt');

  const submitButton = page.getByRole('button', { name: 'Submit' });
  const canaryOption = page.getByRole('radio', { name: /Canary/ });

  await expect(page.getByText('Rollout choice', { exact: true })).toBeVisible();
  await expect(submitButton).toBeDisabled();

  await canaryOption.click();

  await expect(canaryOption).toHaveAttribute('aria-checked', 'true');
  await expect(submitButton).toBeEnabled();
  await submitButton.click();

  const replyRequest = await getE2EState(page, () => {
    const value = (
      window as Window & {
        __varroE2E?: { requests: Array<{ method: string; path: string; body?: unknown }> };
      }
    ).__varroE2E;
    return (
      value?.requests.find((request) => request.path === '/question/question-prompt-1/reply') ||
      null
    );
  });

  expect(replyRequest).toMatchObject({
    method: 'POST',
    body: { answers: [['Canary']] },
  });
});

test('submits a multiline custom answer with Enter', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=question-prompt');

  const customAnswer = page.getByPlaceholder('Type your own answer');
  await customAnswer.fill('Gradual rollout');
  await customAnswer.press('Shift+Enter');
  await customAnswer.pressSequentially('with extra monitoring');

  await expect(customAnswer).toHaveValue('Gradual rollout\nwith extra monitoring');
  expect(
    await getE2EState(page, () => {
      const value = (
        window as Window & {
          __varroE2E?: { requests: Array<{ path: string }> };
        }
      ).__varroE2E;
      return value?.requests.some(
        (request) => request.path === '/question/question-prompt-1/reply'
      );
    })
  ).toBe(false);

  await customAnswer.press('Enter');

  const replyRequest = await getE2EState(page, () => {
    const value = (
      window as Window & {
        __varroE2E?: { requests: Array<{ method: string; path: string; body?: unknown }> };
      }
    ).__varroE2E;
    return (
      value?.requests.find((request) => request.path === '/question/question-prompt-1/reply') ||
      null
    );
  });

  expect(replyRequest).toMatchObject({
    method: 'POST',
    body: { answers: [['Gradual rollout\nwith extra monitoring']] },
  });
});

test('skips a standalone question prompt', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=question-prompt');

  await page.getByRole('button', { name: 'Skip' }).click();

  const rejectRequest = await getE2EState(page, () => {
    const value = (
      window as Window & {
        __varroE2E?: { requests: Array<{ method: string; path: string }> };
      }
    ).__varroE2E;
    return (
      value?.requests.find((request) => request.path === '/question/question-prompt-1/reject') ||
      null
    );
  });

  expect(rejectRequest).toMatchObject({ method: 'POST' });
});
