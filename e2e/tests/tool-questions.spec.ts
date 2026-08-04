import { expect, test } from '@playwright/test';
import { getE2EState } from './helpers';

test('renders linked tool questions inline instead of as standalone prompts', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=linked-tool-question');

  await expect(page.getByText('Target environment', { exact: true })).toBeVisible();
  await expect(page.getByText('Which environment should I target?', { exact: true })).toBeVisible();
  await expect(page.locator('.question-prompt-card')).toHaveCount(1);
  await expect(page.locator('.tool-invocation-title')).toHaveCount(0);
});

test('submits answers for linked tool questions', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=linked-tool-question');

  const submitButton = page.getByRole('button', { name: 'Submit' });
  await expect(submitButton).toBeDisabled();

  await page.getByRole('radio', { name: /Staging/ }).click();
  await expect(submitButton).toBeEnabled();
  await submitButton.click();

  const replyRequest = await getE2EState(page, () => {
    const value = (window as Window & {
      __varroE2E?: { requests: Array<{ method: string; path: string; body?: unknown }> };
    }).__varroE2E;
    return value?.requests.find((request) => request.path === '/question/linked-tool-question-1/reply') || null;
  });

  expect(replyRequest).toMatchObject({
    method: 'POST',
    body: { answers: [['Staging']] },
  });
});

test('skips linked tool questions inline', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=linked-tool-question');

  await page.getByRole('button', { name: 'Skip' }).click();

  const rejectRequest = await getE2EState(page, () => {
    const value = (window as Window & {
      __varroE2E?: { requests: Array<{ method: string; path: string }> };
    }).__varroE2E;
    return value?.requests.find((request) => request.path === '/question/linked-tool-question-1/reject') || null;
  });

  expect(rejectRequest).toMatchObject({ method: 'POST' });
});

test('keeps completed question answers stacked at wide and narrow widths', async ({ page }) => {
  for (const viewport of [
    { width: 1000, height: 720 },
    { width: 480, height: 720 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto('/e2e/harness/index.html?scenario=completed-tool-question');

    const summary = page.locator('.question-summary-card');
    await expect(summary).toBeVisible();
    await expect(summary.locator('.question-summary-item')).toHaveCount(4);

    const layout = await summary.evaluate((element) => {
      const rows = [...element.querySelectorAll<HTMLElement>('.question-summary-item')];
      return {
        hasOverflow: element.scrollWidth > element.clientWidth,
        rows: rows.map((row) => {
          const question = row.querySelector<HTMLElement>('.question-summary-question');
          const answer = row.querySelector<HTMLElement>('.question-summary-answer');
          if (!question || !answer) throw new Error('Question summary row is incomplete');

          const questionRect = question.getBoundingClientRect();
          const answerRect = answer.getBoundingClientRect();
          return {
            answerWidth: answerRect.width,
            leftDifference: Math.abs(questionRect.left - answerRect.left),
            textAlign: getComputedStyle(answer).textAlign,
          };
        }),
      };
    });

    expect(layout.hasOverflow).toBe(false);
    expect(layout.rows.every((row) => row.leftDifference < 1)).toBe(true);
    expect(layout.rows.every((row) => row.textAlign === 'left')).toBe(true);
    if (viewport.width === 1000) {
      expect(layout.rows.every((row) => row.answerWidth > 260)).toBe(true);
    }
  }
});
