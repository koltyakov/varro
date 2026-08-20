/* oxlint-disable anti-slop/no-known-value-widening, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type -- The init-script callback deliberately merges opaque persisted Ralph fixture state into a synthetic browser store. */
/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- SAFETY: The asserted state is supplied directly by this test's controlled init-script fixture. */
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { getE2EState } from './helpers';

async function openRalphForm(page: Page) {
  await expect(page.locator('.chat-workspace')).toBeVisible();
  const composer = page.locator('[role="textbox"][aria-multiline="true"]').first();
  await composer.click();
  await composer.fill('/ralph');
  await expect(page.getByText('Start a Ralph loop on a plan document')).toBeVisible();
  await composer.press('Enter');
  await expect(page.locator('.ralph-form-card')).toBeVisible();
  return composer;
}

test('start form behaves as a modal and restores focus on Escape', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=slash-commands');
  const composer = await openRalphForm(page);

  const dialog = page.getByRole('dialog', { name: 'Start Ralph loop' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Close' })).toBeFocused();

  await page.keyboard.press('Escape');

  await expect(dialog).toHaveCount(0);
  await expect(composer).toBeFocused();
});

test('start form keeps actions reachable while its model picker is open at short heights', async ({
  page,
}) => {
  await page.setViewportSize({ width: 600, height: 360 });
  await page.goto('/e2e/harness/index.html?scenario=slash-commands');
  await openRalphForm(page);

  await page.getByRole('button', { name: /Advanced/ }).click();
  await page.locator('.ralph-form-card .model-picker-btn').click();
  await expect(page.locator('.ralph-form-card .dropdown-menu')).toBeVisible();

  const layout = await page.locator('.ralph-form-card').evaluate((card) => {
    const body = card.querySelector<HTMLElement>('.ralph-form-body');
    const footer = card.querySelector<HTMLElement>('.ralph-form-footer');
    if (!body || !footer) throw new Error('Ralph form layout is incomplete');
    const cardBox = card.getBoundingClientRect();
    const footerBox = footer.getBoundingClientRect();
    return {
      bodyOverflowY: getComputedStyle(body).overflowY,
      bodyHasOverflow: body.scrollHeight > body.clientHeight,
      cardTop: cardBox.top,
      cardBottom: cardBox.bottom,
      footerTop: footerBox.top,
      footerBottom: footerBox.bottom,
      viewportHeight: window.innerHeight,
    };
  });

  expect(layout.bodyOverflowY).toBe('auto');
  expect(layout.bodyHasOverflow).toBe(true);
  expect(layout.cardTop).toBeGreaterThanOrEqual(0);
  expect(layout.cardBottom).toBeLessThanOrEqual(layout.viewportHeight);
  expect(layout.footerTop).toBeGreaterThanOrEqual(layout.cardTop);
  expect(layout.footerBottom).toBeLessThanOrEqual(layout.viewportHeight);
  await expect(page.getByRole('button', { name: 'Cancel' })).toBeInViewport();
  await expect(page.getByRole('button', { name: 'Start loop' })).toBeInViewport();
});

test('start form overlay leaves the wide desktop sessions pane uncovered', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.addInitScript(() => {
    let initialState: unknown;
    Object.defineProperty(window, '__initialWebviewState', {
      configurable: true,
      get: () => initialState,
      set: (value: unknown) => {
        initialState = {
          ...(value as Record<string, unknown>),
          desktopSessionPaneSide: 'right',
        };
      },
    });
  });
  await page.goto('/e2e/harness/index.html?scenario=slash-commands');
  await expect(page.locator('.chat-workspace')).toHaveClass(/chat-workspace-pane-right/);
  await openRalphForm(page);

  const overlay = page.locator('.ralph-form-overlay');
  const sessionsPane = page.getByRole('complementary', { name: 'Sessions' });
  const geometry = await page.evaluate(() => {
    const overlayElement = document.querySelector<HTMLElement>('.ralph-form-overlay');
    const sessionsElement = document.querySelector<HTMLElement>(
      '.chat-session-sidebar[aria-label="Sessions"]'
    );
    if (!overlayElement || !sessionsElement) throw new Error('Desktop layout is incomplete');
    const overlayBox = overlayElement.getBoundingClientRect();
    const sessionsBox = sessionsElement.getBoundingClientRect();
    return {
      overlayRight: overlayBox.right,
      sessionsLeft: sessionsBox.left,
      sessionsWidth: sessionsBox.width,
    };
  });

  await expect(overlay).toBeVisible();
  await expect(sessionsPane).toBeVisible();
  expect(geometry.sessionsWidth).toBeGreaterThan(0);
  expect(Math.abs(geometry.overlayRight - geometry.sessionsLeft)).toBeLessThanOrEqual(1);
});

test('start form overlay leaves the default left sessions pane uncovered', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto('/e2e/harness/index.html?scenario=slash-commands');
  await expect(page.locator('.chat-workspace')).not.toHaveClass(/chat-workspace-pane-right/);
  await openRalphForm(page);

  const overlay = page.locator('.ralph-form-overlay');
  const sessionsPane = page.getByRole('complementary', { name: 'Sessions' });
  const geometry = await page.evaluate(() => {
    const overlayElement = document.querySelector<HTMLElement>('.ralph-form-overlay');
    const sessionsElement = document.querySelector<HTMLElement>(
      '.chat-session-sidebar[aria-label="Sessions"]'
    );
    if (!overlayElement || !sessionsElement) throw new Error('Desktop layout is incomplete');
    const overlayBox = overlayElement.getBoundingClientRect();
    const sessionsBox = sessionsElement.getBoundingClientRect();
    return {
      overlayLeft: overlayBox.left,
      sessionsRight: sessionsBox.right,
      sessionsWidth: sessionsBox.width,
    };
  });

  await expect(overlay).toBeVisible();
  await expect(sessionsPane).toBeVisible();
  expect(geometry.sessionsWidth).toBeGreaterThan(0);
  expect(Math.abs(geometry.overlayLeft - geometry.sessionsRight)).toBeLessThanOrEqual(1);
});

test('start form blocks the uncovered sessions pane and restores it on close', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto('/e2e/harness/index.html?scenario=command-events');
  const composer = await openRalphForm(page);

  const dialog = page.getByRole('dialog', { name: 'Start Ralph loop' });
  const sessionsPane = page.getByRole('complementary', { name: 'Sessions' });
  const targetSession = sessionsPane
    .locator('.session-item')
    .filter({ hasText: 'Build approval required' })
    .getByRole('button')
    .first();
  await expect(targetSession).toBeVisible();
  const targetCenter = await targetSession.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  });

  await page.mouse.click(targetCenter.x, targetCenter.y);

  await expect(dialog).toBeVisible();
  await expect(page.locator('.chat-header-title-text').first()).toHaveText('Host command events');
  await expect(page.locator('.interactive-session')).toHaveAttribute('inert', '');

  await dialog.getByRole('button', { name: 'Cancel' }).click();

  await expect(page.locator('.interactive-session')).not.toHaveAttribute('inert', '');
  await expect(composer).toBeFocused();
  await targetSession.click();
  await expect(page.locator('.chat-header-title-text').first()).toHaveText(
    'Build approval required'
  );
});

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
  await expect(page.locator('.ralph-dashboard-stop-reason')).toHaveCount(0);

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
