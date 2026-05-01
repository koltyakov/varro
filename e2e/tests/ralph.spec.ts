import { expect, test } from '@playwright/test';
import { getE2EState } from './helpers';

test('running dashboard shows status and iteration count', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=ralph-dashboard');

  const dashboard = page.locator('.ralph-dashboard');
  await expect(dashboard).toBeVisible();

  await expect(page.locator('.ralph-dashboard-tag')).toContainText('Ralph');
  await expect(page.locator('.ralph-dashboard-plan')).toContainText('plan-abc123.md');
  await expect(page.locator('.ralph-dashboard-status-running')).toContainText('running');
  await expect(page.locator('.ralph-dashboard-meta')).toContainText('Iterations: 3 / 5');
});

test('iteration cards show verification verdicts for passed iteration', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=ralph-dashboard');

  const passedCard = page.locator('.ralph-iter-card.ralph-iter-passed');
  await expect(passedCard).toBeVisible();
  await expect(passedCard.locator('.ralph-iter-index')).toContainText('#1');
  await expect(passedCard.locator('.ralph-iter-status')).toContainText('Passed');

  const passVerdicts = passedCard.locator('.ralph-iter-verdict-pass');
  await expect(passVerdicts).toHaveCount(3);

  const runningCard = page.locator('.ralph-iter-card.ralph-iter-running');
  await expect(runningCard).toBeVisible();
  await expect(runningCard.locator('.ralph-iter-index')).toContainText('#2');

  const pendingCard = page.locator('.ralph-iter-card.ralph-iter-pending');
  await expect(pendingCard).toBeVisible();
  await expect(pendingCard.locator('.ralph-iter-index')).toContainText('#3');
});

test('stop button transitions run to stopped with manual_stop reason', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=ralph-dashboard');

  await expect(page.locator('.ralph-dashboard-status-running')).toBeVisible();

  await page.getByRole('button', { name: 'Stop' }).click();

  await expect(page.locator('.ralph-dashboard-status-stopped')).toBeVisible();
  await expect(page.locator('.ralph-dashboard-stop-reason')).toContainText('stopped manually');

  await expect
    .poll(() =>
      getE2EState(page, () => {
        const raw = localStorage.getItem('varro.ralph.runs');
        const runs = raw ? JSON.parse(raw) : {};
        const run = runs['session-ralph-1'];
        return { status: run?.status, stopReason: run?.stopReason };
      })
    )
    .toEqual({ status: 'stopped', stopReason: 'manual_stop' });
});

test('pause button transitions to paused and shows resume', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=ralph-dashboard');

  await page.getByRole('button', { name: 'Pause' }).click();

  await expect(page.locator('.ralph-dashboard-status-paused')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Resume' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible();
});

test('incomplete runs show add-runs-and-continue action', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=ralph-dashboard');

  await page.evaluate(() => {
    const raw = window.localStorage.getItem('varro.ralph.runs');
    const runs = raw ? JSON.parse(raw) : {};
    const run = runs['session-ralph-1'];
    runs['session-ralph-1'] = {
      ...run,
      status: 'incomplete',
      stopReason: 'iteration_limit_with_gap',
      currentIteration: 5,
      iterations: Array.from({ length: 5 }, (_, index) => ({
        index: index + 1,
        childSessionId: `session-ralph-child-${index + 1}`,
        status: 'passed',
        startedAt: run.updatedAt - (5 - index) * 100,
        endedAt: run.updatedAt - (5 - index) * 50,
        filesChanged: [],
        verification: { lint: 'pass', typecheck: 'pass', test: 'pass' },
      })),
    };
    window.localStorage.setItem('varro.ralph.runs', JSON.stringify(runs));
  });

  await page.reload();

  await expect(page.locator('.ralph-dashboard-status-incomplete')).toBeVisible();
  await expect(page.locator('.ralph-dashboard-meta')).toContainText('Iterations: 5 / 5');
  await expect(page.getByRole('button', { name: 'Add 5 runs & continue' })).toBeVisible();
});
