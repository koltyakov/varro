import { expect, test } from '@playwright/test';
import type { ServerEvent } from '../../src/shared/protocol';
import type { MessageEntry } from '../../src/webview/types';

for (const source of ['metadata', 'events'] as const) {
  test(`shows idle session compaction as running with a static compress icon via ${source}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 650, height: 900 });
    await page.goto('/e2e/harness/index.html?scenario=status-filters');
    const row = page
      .locator('.session-item:visible')
      .filter({ hasText: 'Plan awaiting implementation' });
    await expect(row.locator('.is-plan-completed')).toBeVisible();

    const replayCompaction = async (compacting: boolean) => {
      const event: ServerEvent =
        source === 'metadata'
          ? {
              type: 'session.updated',
              properties: {
                info: {
                  id: 'session-plan-filter',
                  projectID: 'project-varro',
                  directory: '/workspace/varro',
                  title: 'Plan awaiting implementation',
                  version: '1',
                  time: {
                    created: Date.now() - 30_000,
                    updated: Date.now(),
                    compacting: compacting ? Date.now() : undefined,
                  },
                },
              },
            }
          : {
              type: compacting
                ? 'session.next.compaction.started'
                : 'session.next.compaction.ended',
              properties: { sessionID: 'session-plan-filter', reason: 'manual' },
            };
      await page.evaluate((nextEvent) => {
        // SAFETY: The isolated session-list fixture installs this event transport.
        const harness = (
          window as typeof window & {
            __varroE2E: { replayServerEvent: (event: ServerEvent) => void };
          }
        ).__varroE2E;
        harness.replayServerEvent(nextEvent);
      }, event);
    };

    await replayCompaction(true);
    const indicator = row.locator('.session-status-indicator.is-compacting');
    await expect(indicator).toBeVisible();
    await expect(indicator).toHaveAttribute('aria-label', 'Compacting');
    await expect(indicator).toHaveCSS('animation-name', 'none');
    await expect(indicator).toHaveCSS('width', '12px');
    await expect(indicator.locator('.ui-icon')).not.toHaveCSS('mask-image', 'none');
    const centerOffset = await indicator.evaluate((element) => {
      const indicatorBox = element.getBoundingClientRect();
      const iconBox = element.querySelector('.ui-icon')!.getBoundingClientRect();
      return Math.abs(
        iconBox.top + iconBox.height / 2 - (indicatorBox.top + indicatorBox.height / 2)
      );
    });
    expect(centerOffset).toBeLessThan(0.5);
    await expect(row.locator('.is-plan-completed')).toHaveCount(0);
    await page.getByRole('button', { name: '2 running sessions' }).click();
    await expect(row).toBeVisible();

    await replayCompaction(false);
    await expect(indicator).toHaveCount(0);
    await expect(row).toHaveCount(0);
    await page.getByRole('button', { name: 'Clear Running filter' }).click();
    await expect(row.locator('.is-plan-completed')).toBeVisible();
  });
}

test('clears manual compaction activity when the completed action arrives without an idle event', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto('/e2e/harness/index.html?scenario=status-filters');
  const history: MessageEntry[] = [
    {
      info: {
        id: 'prompt-before-compaction',
        sessionID: 'session-plan-filter',
        role: 'user',
        time: { created: Date.now() - 5_000 },
        agent: 'plan',
        model: { providerID: 'openai', modelID: 'gpt-4o' },
      },
      parts: [
        {
          id: 'prompt-text',
          messageID: 'prompt-before-compaction',
          sessionID: 'session-plan-filter',
          type: 'text',
          text: 'Fix the layout.',
        },
      ],
    },
    {
      info: {
        id: 'response-before-compaction',
        sessionID: 'session-plan-filter',
        role: 'assistant',
        parentID: 'prompt-before-compaction',
        time: { created: Date.now() - 4_000, completed: Date.now() - 1_000 },
        providerID: 'openai',
        modelID: 'gpt-4o',
        mode: 'plan',
        agent: 'plan',
        path: { cwd: '/workspace/varro', root: '/workspace/varro' },
        cost: 0,
        tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
        finish: 'stop',
      },
      parts: [
        {
          id: 'response-text',
          messageID: 'response-before-compaction',
          sessionID: 'session-plan-filter',
          type: 'text',
          text: 'Layout fixed.',
        },
      ],
    },
  ];
  await page.evaluate((messages) => {
    // SAFETY: The isolated fixture exposes its backend transcript for setup.
    const harness = (
      window as typeof window & {
        __varroE2E: {
          updateMessageInfo(info: MessageEntry['info']): void;
          updateMessagePart(part: MessageEntry['parts'][number]): void;
        };
      }
    ).__varroE2E;
    for (const message of messages) {
      harness.updateMessageInfo(message.info);
      for (const part of message.parts) harness.updateMessagePart(part);
    }
  }, history);
  const row = page
    .locator('.session-item:visible')
    .filter({ hasText: 'Plan awaiting implementation' });
  await row.click();
  await expect(page.getByText('Layout fixed.', { exact: true })).toBeVisible();
  const compaction: MessageEntry = {
    info: {
      id: 'manual-compaction-message',
      sessionID: 'session-plan-filter',
      role: 'user',
      time: { created: Date.now() },
      agent: 'plan',
      model: { providerID: 'openai', modelID: 'gpt-4o' },
    },
    parts: [
      {
        id: 'manual-compaction-part',
        sessionID: 'session-plan-filter',
        messageID: 'manual-compaction-message',
        type: 'compaction',
        auto: false,
        status: 'running',
      },
    ],
  };
  const replayCompaction = async (completed: boolean) => {
    await page.evaluate(
      ({ message, completed: isComplete }) => {
        // SAFETY: The isolated fixture installs this event and transcript transport.
        const harness = (
          window as typeof window & {
            __varroE2E: {
              replayServerEvent(event: ServerEvent, message: MessageEntry): void;
            };
          }
        ).__varroE2E;
        harness.replayServerEvent(
          {
            type: isComplete ? 'session.next.compaction.ended' : 'session.next.compaction.started',
            properties: { sessionID: message.info.sessionID, reason: 'manual' },
          },
          message
        );
      },
      { message: compaction, completed }
    );
  };
  await replayCompaction(false);
  await expect(row.locator('.is-compacting')).toBeVisible();
  await expect(page.locator('.manual-compaction-action')).toContainText('Compacting context');

  const part = compaction.parts[0];
  if (part?.type !== 'compaction') throw new Error('Missing compaction fixture part');
  part.status = 'completed';
  await replayCompaction(true);
  await expect(page.locator('.manual-compaction-action')).toContainText(
    'Context compacted manually'
  );
  await expect(row.locator('.is-compacting, .is-running')).toHaveCount(0);
  await expect(page.locator('.interactive-session .loading-indicator')).toHaveCount(0);
  await expect(page.locator('.message-compaction-divider')).toHaveCount(0);
  const summary = page.locator(
    '[data-msg-id="response-before-compaction"] > .assistant-dialog-summary'
  );
  const action = page.locator('.manual-compaction-action');
  await expect(summary).toBeVisible();
  const summaryBox = await summary.boundingBox();
  const actionBox = await action.boundingBox();
  expect(actionBox!.y).toBeGreaterThanOrEqual(summaryBox!.y + summaryBox!.height);
  await expect(action.locator('.ui-icon')).not.toHaveCSS('mask-image', 'none');
  await page.screenshot({ path: testInfo.outputPath('manual-compaction-completed.png') });
});

test('shows an unseen plan in the narrow header after switching to another chat', async ({
  page,
}) => {
  await page.setViewportSize({ width: 400, height: 900 });
  await page.goto('/e2e/harness/index.html?scenario=status-filters');
  const planRow = page
    .locator('.session-item:visible')
    .filter({ hasText: 'Plan awaiting implementation' });
  await expect(planRow.locator('.is-plan-completed')).toBeVisible();
  await page.evaluate(() => {
    // SAFETY: The isolated session-list fixture installs this event transport.
    const harness = (
      window as typeof window & {
        __varroE2E: { replayServerEvent: (event: ServerEvent) => void };
      }
    ).__varroE2E;
    harness.replayServerEvent({
      type: 'session.status',
      properties: { sessionID: 'session-plan-filter', status: { type: 'busy' } },
    });
  });
  await planRow.click();
  await expect(
    page.locator('.interactive-session > .chat-header .chat-header-title-text')
  ).toHaveText('Plan awaiting implementation');
  await page.getByLabel('Back to sessions').click();
  await page
    .locator('.session-item:visible')
    .filter({ hasText: 'Completed sticky cleanup' })
    .click();
  const header = page.locator('.interactive-session > .chat-header');
  await expect(header.locator('.chat-header-title-text')).toHaveText('Completed sticky cleanup');
  await expect(header.locator('.chat-header-plan-badge')).toHaveCount(0);
  await page.evaluate(() => {
    // SAFETY: The isolated session-list fixture installs this event transport.
    const harness = (
      window as typeof window & {
        __varroE2E: { replayServerEvent: (event: ServerEvent) => void };
      }
    ).__varroE2E;
    harness.replayServerEvent({
      type: 'session.status',
      properties: { sessionID: 'session-plan-filter', status: { type: 'idle' } },
    });
  });
  await expect(header.locator('.chat-header-plan-badge')).toBeVisible();
  await page.getByLabel('Back to sessions').click();
  await expect(planRow.locator('.is-plan-completed')).toBeVisible();
  await page
    .locator('.session-item:visible')
    .filter({ hasText: 'Completed sticky cleanup' })
    .click();
  await header.locator('.chat-header-plan-badge').click();
  await expect(header.locator('.chat-header-title-text')).toHaveText(
    'Plan awaiting implementation'
  );
  await page.getByLabel('Back to sessions').click();
  await expect(planRow.locator('.is-plan-completed')).toHaveCount(0);
});

test('keeps large-list search, status filtering, and session switching working', async ({
  page,
}) => {
  await page.setViewportSize({ width: 650, height: 900 });
  await page.goto('/e2e/harness/index.html?scenario=session-list-load');
  const search = page.getByRole('textbox', { name: 'Search sessions' });
  await expect(search).toBeVisible();
  await expect.poll(() => page.locator('.session-item').count()).toBeLessThan(50);
  await search.fill('Load session 001');
  await expect(page.locator('.session-item')).toHaveCount(10);
  await search.fill('');
  await page.evaluate(() => {
    // SAFETY: The isolated session-list fixture installs this event transport.
    const harness = (
      window as typeof window & {
        __varroE2E: { replayServerEvent: (event: ServerEvent) => void };
      }
    ).__varroE2E;
    for (let index = 0; index < 100; index += 1) {
      harness.replayServerEvent({
        type: 'session.status',
        properties: {
          sessionID: `load-${250 + index}`,
          status: { type: index % 2 ? 'idle' : 'busy' },
        },
      });
    }
    harness.replayServerEvent({
      type: 'session.status',
      properties: { sessionID: 'load-0', status: { type: 'busy' } },
    });
  });
  await page.getByRole('button', { name: /\d+ running sessions?/ }).click();
  await expect(page.locator('.session-item')).toHaveCount(50);
  await page.getByRole('button', { name: 'Clear Running filter' }).click();
  await search.fill('Load session 0019');
  await expect(page.locator('.session-item')).toHaveCount(1);
  await page.locator('.session-item').click();
  await expect(page.locator('.chat-header-title-text').first()).toHaveText('Load session 0019');
  await expect(page.getByText('Response 19', { exact: true })).toBeVisible();
  await page.getByLabel('Back to sessions').click();
  await search.fill('Load session 0018');
  await expect(page.locator('.session-item')).toHaveCount(1);
  await search.press('ArrowDown');
  await search.press('Enter');
  await expect(page.getByText('Response 18', { exact: true })).toBeVisible();
});

test('windows a large session list while preserving keyboard wrap and visible coverage', async ({
  page,
}) => {
  await page.setViewportSize({ width: 650, height: 900 });
  await page.goto('/e2e/harness/index.html?scenario=session-list-load');
  const search = page.getByRole('textbox', { name: 'Search sessions' });
  await expect(search).toBeVisible();
  await search.press('ArrowUp');
  const focused = page.locator('.session-item.keyboard-focus');
  await expect(focused).toBeInViewport();
  await expect.poll(() => page.locator('.session-item').count()).toBeLessThan(50);
  const scroll = page.locator('.session-list-scroll:visible').first();
  await scroll.evaluate((element) => {
    element.scrollTop = element.scrollHeight / 2;
  });
  await expect
    .poll(() =>
      scroll.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const center = (bounds.top + bounds.bottom) / 2;
        return [...element.querySelectorAll('.session-item')].some((row) => {
          const rect = row.getBoundingClientRect();
          return rect.top <= center && rect.bottom >= center;
        });
      })
    )
    .toBe(true);
  await expect.poll(() => page.locator('.session-item').count()).toBeLessThan(50);
  await search.press('ArrowDown');
  await expect(focused).toBeInViewport();
});

test('keeps session row geometry unchanged with empty and hover-only metadata', async ({
  page,
}) => {
  await page.goto('/e2e/harness/index.html?scenario=status-filters');
  const rows = page.locator('.session-item:visible');
  await expect(rows).toHaveCount(5);
  const row = rows.first();
  const meta = row.locator('.session-item-stats-meta');
  await row.evaluate((element) => {
    const sessionId = element.getAttribute('data-session-id');
    if (!sessionId) throw new Error('Session row has no ID');
    window.postMessage(
      {
        type: 'session-models/sync',
        payload: {
          models: { [sessionId]: { providerID: 'openai', modelID: 'gpt-6-astra' } },
        },
      },
      '*'
    );
  });
  await expect(row).toHaveClass(/has-model-details/);
  const geometry = () =>
    rows.evaluateAll((elements) =>
      elements.map((element) => {
        const box = element.getBoundingClientRect();
        return { top: box.top, height: box.height };
      })
    );

  await meta.evaluate((element) => {
    element.textContent = '4 files · +35 -13 · 80k tokens · 5m 32s';
  });
  const populated = await geometry();
  await meta.evaluate((element) => element.replaceChildren());
  expect(await geometry()).toEqual(populated);

  await meta.evaluate((element) => {
    const details = document.createElement('span');
    details.className = 'session-item-model-meta';
    details.textContent = 'GPT-6 Astra · High';
    element.append(details);
  });
  await page.mouse.move(0, 0);
  expect(await geometry()).toEqual(populated);
  await row.hover();
  await expect(meta.locator('.session-item-model-meta')).toBeVisible();
  expect(await geometry()).toEqual(populated);
  await page.mouse.move(0, 0);
  await page.keyboard.down('Alt');
  await expect(meta.locator('.session-item-model-meta')).toBeVisible();
  expect(await geometry()).toEqual(populated);
  await page.keyboard.up('Alt');
  expect(await geometry()).toEqual(populated);
});

test('uses duty-cycled animations only for persistent session statuses', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=status-filters');

  const statusIndicator = (title: string) =>
    page.locator('.session-item').filter({ hasText: title }).locator('.session-item-indicator');

  for (const title of [
    'Plan awaiting implementation',
    'Waiting on permission',
    'Failing provider sync',
  ]) {
    await expect(statusIndicator(title)).toHaveCSS('animation-name', 'status-pulse');
    await expect(statusIndicator(title)).toHaveCSS('animation-duration', '2s');
  }

  await expect(statusIndicator('Running lint repair')).toHaveCSS('animation-name', 'spin');
  await page.locator('body').evaluate((body) => {
    const indicator = document.createElement('span');
    indicator.className = 'session-item-indicator session-status-indicator is-completed';
    indicator.dataset.testCompletedIndicator = 'true';
    body.append(indicator);
  });
  await expect(page.locator('[data-test-completed-indicator]')).toHaveCSS('animation-name', 'none');

  for (const selector of [
    '.chat-header-plan-dot',
    '.chat-header-attention-dot',
    '.chat-header-failed-dot',
  ]) {
    await expect(page.locator(selector)).toHaveCSS('animation-name', 'status-pulse');
  }
  await expect(page.locator('.chat-header-running-spinner')).toHaveCSS('animation-name', 'spin');
});

test('centers the running-session counter across font metrics', async ({ page }) => {
  await page.setViewportSize({ width: 490, height: 800 });
  await page.goto('/e2e/harness/index.html?scenario=status-filters');
  const counter = page.locator('.chat-header-running-count');
  await expect(counter).toBeVisible();
  await expect(counter).toHaveCSS('text-box-trim', 'trim-both');
  await expect(counter).toHaveCSS('text-box-edge', 'cap alphabetic');
  await expect(counter).toHaveCSS('transform', 'none');

  for (const fontFamily of ['var(--font-mono)', 'Arial, sans-serif', 'serif', 'monospace']) {
    for (const count of ['1', '12', '99']) {
      const geometry = await counter.evaluate(
        (element, options) => {
          element.style.fontFamily = options.fontFamily;
          element.textContent = options.count;
          const badge = element.closest('.chat-header-running-badge');
          if (!badge) throw new Error('Expected the running-session badge');
          const badgeBox = badge.getBoundingClientRect();
          const textBox = element.getBoundingClientRect();
          return {
            badgeWidth: badgeBox.width,
            badgeHeight: badgeBox.height,
            verticalOffset: textBox.top + textBox.height / 2 - (badgeBox.top + badgeBox.height / 2),
            horizontalOffset:
              textBox.left + textBox.width / 2 - (badgeBox.left + badgeBox.width / 2),
            textHeight: textBox.height,
            lineHeight: Number.parseFloat(getComputedStyle(element).lineHeight),
          };
        },
        { fontFamily, count }
      );
      const context = `${fontFamily}, count ${count}`;
      expect(geometry.badgeWidth, context).toBe(20);
      expect(geometry.badgeHeight, context).toBe(20);
      expect(Math.abs(geometry.verticalOffset), context).toBeLessThan(0.1);
      expect(Math.abs(geometry.horizontalOffset), context).toBeLessThan(0.1);
      expect(geometry.textHeight, context).toBeLessThan(geometry.lineHeight);
    }
  }
});

test('keeps running-session spinners rotating with reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/e2e/harness/index.html?scenario=status-filters');

  const rowSpinner = page
    .locator('.session-item')
    .filter({ hasText: 'Running lint repair' })
    .locator('.session-item-indicator');
  const headerSpinner = page.locator('.chat-header-running-spinner');
  const count = page.locator('.chat-header-running-count');
  for (const spinner of [rowSpinner, headerSpinner]) {
    await expect(spinner).toBeVisible();
    await expect(spinner).toHaveCSS('animation-name', 'spin');
    await expect(spinner).toHaveCSS('animation-iteration-count', 'infinite');
  }

  for (const reducedMotion of ['reduce', 'no-preference'] as const) {
    await page.emulateMedia({ reducedMotion });
    for (const [spinner, durationMs] of [
      [rowSpinner, 850],
      [headerSpinner, 900],
    ] as const) {
      await expect(spinner).toHaveCSS('animation-name', 'spin');
      await expect(spinner).toHaveCSS('animation-duration', `${durationMs / 1000}s`);
      await expect(spinner).toHaveCSS('animation-iteration-count', 'infinite');
      await expect(spinner).toHaveCSS('animation-timing-function', 'linear');
      expect(await spinner.evaluate((element) => element.getAnimations()[0]!.playState)).toBe(
        'running'
      );
      for (const [progress, transform] of [
        [0, 'matrix(1, 0, 0, 1, 0, 0)'],
        [0.25, 'matrix(0, 1, -1, 0, 0, 0)'],
        [0.5, 'matrix(-1, 0, 0, -1, 0, 0)'],
        [1, 'matrix(1, 0, 0, 1, 0, 0)'],
      ] as const) {
        await spinner.evaluate((element, currentTime) => {
          const animation = element.getAnimations()[0]!;
          animation.pause();
          animation.currentTime = currentTime;
        }, progress * durationMs);
        await expect(spinner).toHaveCSS('transform', transform);
        await expect(spinner).toHaveCSS('opacity', '1');
        await expect(count).toHaveCSS('opacity', '1');
        await expect(count).toHaveCSS('transform', 'none');
      }
      await spinner.evaluate((element) => element.getAnimations()[0]!.play());
    }
  }
});

test('keeps persistent statuses static and visible with reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/e2e/harness/index.html?scenario=status-filters');

  const indicator = page
    .locator('.session-item')
    .filter({ hasText: 'Waiting on permission' })
    .locator('.session-item-indicator');

  await expect(indicator).toBeVisible();
  await expect(indicator).toHaveAttribute('aria-label', 'Permission request pending');
  await expect(indicator).toHaveCSS('animation-iteration-count', '1');
  await expect(indicator).toHaveCSS('opacity', '1');

  for (const selector of [
    '.session-item-indicator.is-attention',
    '.session-item-indicator.is-failed',
    '.session-item-indicator.is-plan-completed',
    '.chat-header-attention-dot',
    '.chat-header-failed-dot',
    '.chat-header-plan-dot',
  ]) {
    await expect(page.locator(selector)).toHaveCSS('animation-iteration-count', '1');
    await expect(page.locator(selector)).toHaveCSS('opacity', '1');
  }
});

test('restores a persisted active session', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=restored-session');

  await expect(
    page.getByLabel('Back to sessions').locator('..').getByText('Restored Session')
  ).toBeVisible();
  await expect(page.getByText('Review the refactor status', { exact: true })).toBeVisible();
  await expect(
    page.getByText('Refactor status looks good. The latest cleanup is ready for review.', {
      exact: true,
    })
  ).toBeVisible();
});

test('shows queued message counts in the desktop session list', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/e2e/harness/index.html?scenario=todo-queue');

  const composer = page.locator('[role="textbox"][aria-multiline="true"]').first();
  await composer.fill('Queue this follow-up');
  await page.getByLabel('Add to queue (Enter)').click();

  const sessionRow = page.locator('.session-item').filter({ hasText: 'Queued follow-up coverage' });
  await expect(sessionRow.getByLabel('1 queued message')).toBeVisible();

  await page.getByLabel('Remove from queue').focus();
  await page.keyboard.press('Enter');
  await expect(sessionRow.locator('.session-item-queued-counter')).toHaveCount(0);
});

test('centers the session history scope in the desktop search field', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/e2e/harness/index.html?scenario=todo-queue');

  const sessionsPane = page.getByRole('complementary', { name: 'Sessions' });
  const search = sessionsPane.getByLabel('Search sessions');
  const scope = sessionsPane.getByLabel('Session history: Folder');
  await expect(scope).toBeVisible();

  const centers = await Promise.all([
    search.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return box.top + box.height / 2;
    }),
    scope.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return box.top + box.height / 2;
    }),
  ]);
  expect(Math.abs(centers[0] - centers[1])).toBeLessThanOrEqual(1);
});

test('filters sessions by running, failed, attention, and plan ready status', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=status-filters');

  await page.locator('.session-item').filter({ hasText: 'Completed sticky cleanup' }).click();
  await expect(
    page.getByLabel('Back to sessions').locator('..').getByText('Completed sticky cleanup')
  ).toBeVisible();
  await page.getByLabel('Back to sessions').click();
  await expect(page.getByText('Sessions', { exact: false })).toBeVisible();

  const visibleSessionTitles = page.locator('.session-item:visible .session-item-title-text');
  await expect(visibleSessionTitles).toHaveText([
    'Completed sticky cleanup',
    'Plan awaiting implementation',
    'Waiting on permission',
    'Failing provider sync',
    'Running lint repair',
  ]);

  await page.getByRole('button', { name: '1 running session' }).click();
  await expect(page.getByText('Filtered:')).toBeVisible();
  await expect(page.getByText('Running', { exact: true })).toBeVisible();
  await expect(page.locator('.session-item:visible .session-item-title-text')).toHaveText([
    'Waiting on permission',
    'Running lint repair',
  ]);
  await expect(page.locator('.session-item')).toHaveCount(2);
  await page.getByRole('button', { name: 'Clear Running filter' }).click();
  await expect(page.getByRole('button', { name: 'Failed sessions' })).toBeVisible();

  await page.getByRole('button', { name: 'Failed sessions' }).click();
  await expect(page.getByText('Failed', { exact: true })).toBeVisible();
  await expect(page.locator('.session-item:visible .session-item-title-text')).toHaveText([
    'Failing provider sync',
  ]);
  await expect(page.locator('.session-item')).toHaveCount(1);
  await page.getByRole('button', { name: 'Clear Failed filter' }).click();
  await expect(
    page.getByRole('button', { name: 'Sessions waiting for input or permission' })
  ).toBeVisible();

  await page.getByRole('button', { name: 'Sessions waiting for input or permission' }).click();
  await expect(page.getByText('Needs attention', { exact: true })).toBeVisible();
  await expect(page.locator('.session-item:visible .session-item-title-text')).toHaveText([
    'Waiting on permission',
  ]);
  await expect(page.locator('.session-item')).toHaveCount(1);
  await page.getByRole('button', { name: 'Clear Needs attention filter' }).click();
  await expect(
    page.getByRole('button', { name: 'Completed plans ready in another chat' })
  ).toBeVisible();

  await page.getByRole('button', { name: 'Completed plans ready in another chat' }).click();
  await expect(page.getByText('Plan ready', { exact: true })).toBeVisible();
  await expect(page.locator('.session-item:visible .session-item-title-text')).toHaveText([
    'Plan awaiting implementation',
  ]);
  await expect(page.locator('.session-item')).toHaveCount(1);
  await page.getByRole('button', { name: 'Clear Plan ready filter' }).click();
  await expect(page.getByRole('button', { name: 'Completed sessions' })).toHaveCount(0);
});
