/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type -- Layout scenarios bridge synthetic browser messages and variant-specific message-part records through page.evaluate. */
/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- SAFETY: Assertions access DOM nodes and protocol-shaped fixtures established by each controlled layout scenario. */
import { expect, test } from '@playwright/test';
import {
  getE2EState,
  getStickyMessageAlignment,
  getVisibleMessageAnchor,
  installOuterScrollSentinel,
  sampleMessageTopAcrossFrames,
} from './helpers';

test('resets padding injected by legacy webview hosts', async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 800 });
  await page.goto('/e2e/harness/index.html?scenario=blank&legacy-host-padding');
  await expect(page.locator('.interactive-session')).toBeVisible();

  const layout = await page.evaluate(() => {
    const root = document.getElementById('root');
    if (!root) throw new Error('Root is missing');
    const bodyStyles = getComputedStyle(document.body);
    const rootBox = root.getBoundingClientRect();
    return {
      bodyPaddingLeft: bodyStyles.paddingLeft,
      bodyPaddingRight: bodyStyles.paddingRight,
      rootLeft: rootBox.left,
    };
  });

  expect(layout).toEqual({
    bodyPaddingLeft: '0px',
    bodyPaddingRight: '0px',
    rootLeft: 0,
  });
});

test('bounds active tools and eases completed tools into Explored', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=tool-cards&activeTray=1');
  const tray = page.locator('.assistant-active-activity-tray');
  await expect(tray.locator('.assistant-active-activity-item')).toHaveCount(12);
  const trayItems = tray.locator('.assistant-active-activity-items');
  await trayItems.evaluate(async (element) => {
    await Promise.all(
      [...element.querySelectorAll<HTMLElement>('.assistant-active-activity-item')].flatMap(
        (item) => item.getAnimations().map((animation) => animation.finished)
      )
    );
  });

  const trayGeometry = await trayItems.evaluate((element) => {
    const viewport = element.getBoundingClientRect();
    const visibleItems = [
      ...element.querySelectorAll<HTMLElement>('.assistant-active-activity-item'),
    ]
      .filter((item) => {
        const bounds = item.getBoundingClientRect();
        return bounds.bottom > viewport.top + 1 && bounds.top < viewport.bottom - 1;
      })
      .map((item) => item.dataset.activityPartId);
    return {
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      scrollbarWidth: getComputedStyle(element).scrollbarWidth,
      visibleItems,
    };
  });
  expect(trayGeometry.visibleItems).toHaveLength(3);
  expect(trayGeometry.scrollHeight).toBeGreaterThan(trayGeometry.clientHeight);
  expect(trayGeometry.scrollbarWidth).toBe('none');

  const activeSpacing = await tray.evaluate(async (element) => {
    const summary = element.querySelector<HTMLElement>('.assistant-activity-summary')!;
    const viewport = element.querySelector<HTMLElement>('.assistant-active-activity-items')!;
    const items = [...element.querySelectorAll<HTMLElement>('.assistant-active-activity-item')];
    viewport.scrollTop = 0;
    const summaryBox = summary.getBoundingClientRect();
    const firstBoxBeforeExit = items[0]!
      .querySelector<HTMLElement>('.chat-tool-invocation-part, .chat-thinking-box')!
      .getBoundingClientRect();
    items[1]!.classList.add('is-exiting');
    element.classList.add('is-exiting');
    await new Promise((resolve) => setTimeout(resolve, 450));
    const firstBox = items[0]!
      .querySelector<HTMLElement>('.chat-tool-invocation-part, .chat-thinking-box')!
      .getBoundingClientRect();
    const thirdBox = items[2]!
      .querySelector<HTMLElement>('.chat-tool-invocation-part, .chat-thinking-box')!
      .getBoundingClientRect();
    return {
      summaryToFirst: firstBoxBeforeExit.top - summaryBox.bottom,
      firstToThird: thirdBox.top - firstBox.bottom,
    };
  });
  expect(activeSpacing.summaryToFirst).toBeGreaterThanOrEqual(10);
  expect(activeSpacing.summaryToFirst).toBeLessThanOrEqual(14);
  expect(activeSpacing.firstToThird).toBeGreaterThanOrEqual(10);
  expect(activeSpacing.firstToThird).toBeLessThanOrEqual(14);

  await page.goto(
    '/e2e/harness/index.html?scenario=tool-cards&activeTray=1&activeTrayCount=1&activeTrayPrefix=1'
  );
  const transitionTray = page.locator('.assistant-active-activity-tray');
  const completedItem = transitionTray.locator('[data-activity-part-id="tool-active-0"]');
  const placeholder = transitionTray.locator('.assistant-activity-summary-placeholder');
  const prefixCodeBlock = page.locator('.interactive-result-code-block');
  await expect(placeholder).toHaveText('Exploring');
  await expect(transitionTray.locator('button.assistant-activity-summary')).toHaveCount(0);
  await expect(prefixCodeBlock).toBeVisible();
  expect(
    await transitionTray.evaluate(
      (element, codeBlock) => {
        return (
          element.getBoundingClientRect().top -
          (codeBlock as HTMLElement).getBoundingClientRect().bottom
        );
      },
      await prefixCodeBlock.elementHandle()
    )
  ).toBeCloseTo(12, 0);
  await completedItem.evaluate(async (element) => {
    await Promise.all(element.getAnimations().map((animation) => animation.finished));
  });
  const placeholderTop = (await placeholder.boundingBox())!.y;
  const loadingRow = page.locator('.interactive-loading-row');
  const loadingIndicator = loadingRow.locator('.loading-indicator');
  await expect(loadingIndicator).toBeHidden();
  const loadingTopBefore = await loadingRow.evaluate((element) => {
    const container = element.closest<HTMLElement>('.interactive-list')!;
    return element.getBoundingClientRect().top - container.getBoundingClientRect().top;
  });
  await page.evaluate(() => {
    const harnessWindow = window as typeof window & {
      __varroE2E?: {
        getSessionMessages?: (id: string) => Array<{ parts: Array<Record<string, unknown>> }>;
        updateMessagePart?: (part: Record<string, unknown>) => void;
      };
    };
    const part = harnessWindow.__varroE2E
      ?.getSessionMessages?.('session-tool-cards')
      .flatMap((message) => message.parts)
      .find((candidate) => candidate.id === 'tool-active-0');
    if (!part) throw new Error('Active tool fixture is missing');
    const previousState = part.state as Record<string, unknown>;
    part.state = {
      status: 'completed',
      input: previousState.input,
      output: 'Found matches',
      title: 'Search 0',
      metadata: {},
      time: { start: Date.now() - 1_000, end: Date.now() },
    };
    harnessWindow.__varroE2E?.updateMessagePart?.(part);
  });

  await expect(completedItem).toHaveClass(/is-(?:completed|exiting)/);
  const transition = await completedItem.evaluate(async (element, initialLoadingTop) => {
    await new Promise<void>((resolve) => {
      if (element.classList.contains('is-exiting')) {
        resolve();
        return;
      }
      const observer = new MutationObserver(() => {
        if (!element.classList.contains('is-exiting')) return;
        observer.disconnect();
        resolve();
      });
      observer.observe(element, { attributes: true, attributeFilter: ['class'] });
    });

    const summary = document.querySelector<HTMLElement>('.assistant-activity-summary');
    if (!summary) throw new Error('Explored summary is missing while the tool exits');
    const summaryMask = document.querySelector<HTMLElement>('.assistant-active-activity-summary');
    if (!summaryMask) throw new Error('Explored transition mask is missing');
    const activityTray = element.closest<HTMLElement>('.assistant-active-activity-tray')!;
    const summaryTop = summary.getBoundingClientRect().top;
    const summaryMaskWidth = summaryMask.getBoundingClientRect().width;
    const summaryMaskBackground = getComputedStyle(summaryMask).backgroundColor;
    const trayWidth = activityTray.getBoundingClientRect().width;
    const trayGap = getComputedStyle(activityTray).rowGap;
    const samples: number[] = [];
    const summaryTops = [summaryTop];
    // oxlint-disable-next-line unicorn/consistent-function-scoping
    const getLoadingTop = () => {
      const loading = document.querySelector<HTMLElement>('.interactive-loading-row');
      const container = loading?.closest<HTMLElement>('.interactive-list');
      return loading && container
        ? loading.getBoundingClientRect().top - container.getBoundingClientRect().top
        : null;
    };
    const exitAnimations = [...element.getAnimations(), ...summaryMask.getAnimations()];
    for (const animation of exitAnimations) {
      animation.pause();
      animation.currentTime = 0;
    }
    samples.push(element.getBoundingClientRect().height);
    const loadingTops = [initialLoadingTop, getLoadingTop()].filter(
      (top): top is number => top !== null
    );
    let summaryMissingFrames = 0;
    for (const animation of exitAnimations) animation.play();
    let framesAfterRemoval = 0;
    for (let frame = 0; frame < 80 && framesAfterRemoval < 4; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      samples.push(element.isConnected ? element.getBoundingClientRect().height : 0);
      const currentSummary = document.querySelector<HTMLElement>('.assistant-activity-summary');
      if (currentSummary) summaryTops.push(currentSummary.getBoundingClientRect().top);
      else summaryMissingFrames += 1;
      const loadingTop = getLoadingTop();
      if (loadingTop !== null) loadingTops.push(loadingTop);
      if (!element.isConnected) framesAfterRemoval += 1;
    }
    return {
      heights: samples,
      itemWasRemoved: !element.isConnected,
      loadingTops,
      synchronizedExitAnimationCount: exitAnimations.length,
      summaryMaskBackground,
      summaryMaskWidth,
      summaryMissingFrames,
      summaryTop,
      summaryTops,
      trayGap,
      trayWidth,
    };
  }, loadingTopBefore);
  expect(transition.heights[0]).toBeGreaterThan(0);
  expect(
    transition.heights.every(
      (height, index) => index === 0 || height <= transition.heights[index - 1]! + 1
    )
  ).toBe(true);
  expect(transition.heights.at(-1)).toBeLessThan(transition.heights[0]! - 5);
  expect(transition.itemWasRemoved).toBe(true);
  await expect(loadingIndicator).toBeVisible();
  expect(transition.synchronizedExitAnimationCount).toBeGreaterThanOrEqual(2);
  expect(Math.abs(transition.summaryTop - placeholderTop)).toBeLessThanOrEqual(1);
  expect(transition.summaryMissingFrames).toBe(0);
  expect(
    Math.max(...transition.summaryTops) - Math.min(...transition.summaryTops),
    JSON.stringify(transition.summaryTops)
  ).toBeLessThanOrEqual(0.5);
  expect(transition.summaryMaskBackground).not.toBe('rgba(0, 0, 0, 0)');
  expect(Math.abs(transition.summaryMaskWidth - transition.trayWidth)).toBeLessThanOrEqual(1);
  expect(transition.trayGap).toBe('0px');
  expect(
    transition.loadingTops.every(
      (top, index) => index === 0 || top <= transition.loadingTops[index - 1]! + 1
    ),
    JSON.stringify({ loadingTopBefore, samples: transition.loadingTops })
  ).toBe(true);
  expect(Math.abs(transition.loadingTops[1]! - transition.loadingTops[0]!)).toBeLessThanOrEqual(
    1.5
  );
  expect(
    transition.loadingTops.every(
      (top, index) => index === 0 || transition.loadingTops[index - 1]! - top <= 5
    ),
    JSON.stringify(transition.loadingTops)
  ).toBe(true);
  expect(transition.loadingTops.at(-1)).toBeLessThan(loadingTopBefore - 5);
  await expect(page.locator('.activity-exit-bottom-reserve')).toHaveCount(0);
  await expect(page.locator('.append-scroll-bottom-reserve')).toBeVisible();

  const summary = page.locator('.assistant-activity-summary');
  await expect(summary).toContainText('Explored: 1 search');
  expect(Math.abs((await summary.boundingBox())!.y - transition.summaryTop)).toBeLessThanOrEqual(1);
  const finalSummaryBox = (await summary.boundingBox())!;
  const finalLoadingBox = (await loadingRow.locator('.loading-verb').boundingBox())!;
  const settledGap = finalLoadingBox.y - (finalSummaryBox.y + finalSummaryBox.height);
  expect(settledGap).toBeGreaterThanOrEqual(10);
  expect(settledGap).toBeLessThanOrEqual(14.5);
});

test('keeps active-tray wheel input local before outer transcript movement', async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 320 });
  await page.goto('/e2e/harness/index.html?scenario=tool-cards&activeTray=1');
  const list = page.locator('.interactive-list');
  const trayItems = page.locator('.assistant-active-activity-items');
  await expect(trayItems.locator('.assistant-active-activity-item')).toHaveCount(12);
  await trayItems.evaluate(async (element) => {
    await Promise.all(
      [...element.querySelectorAll<HTMLElement>('.assistant-active-activity-item')].flatMap((item) =>
        item.getAnimations().map((animation) => animation.finished)
      )
    );
  });

  const initial = await page.evaluate(() => {
    const transcript = document.querySelector<HTMLElement>('.interactive-list')!;
    const tray = document.querySelector<HTMLElement>('.assistant-active-activity-items')!;
    return {
      transcriptTop: transcript.scrollTop,
      transcriptMax: transcript.scrollHeight - transcript.clientHeight,
      trayTop: tray.scrollTop,
      trayMax: tray.scrollHeight - tray.clientHeight,
    };
  });
  expect(initial.transcriptMax).toBeGreaterThan(0);
  expect(initial.trayMax).toBeGreaterThan(0);
  expect(initial.trayTop).toBeGreaterThan(0);

  await trayItems.hover();
  await page.mouse.wheel(0, -96);
  await expect
    .poll(() => trayItems.evaluate((element) => element.scrollTop))
    .toBeLessThan(initial.trayTop);
  expect(await list.evaluate((element) => element.scrollTop)).toBe(initial.transcriptTop);

  const trayTopAfterNestedWheel = await trayItems.evaluate((element) => element.scrollTop);
  const listBox = await list.boundingBox();
  if (!listBox) throw new Error('Transcript bounds are unavailable');
  await page.mouse.move(listBox.x + listBox.width - 3, listBox.y + listBox.height / 2);
  const outerDelta = initial.transcriptTop > 1 ? -96 : 96;
  await page.mouse.wheel(0, outerDelta);
  await expect
    .poll(() => list.evaluate((element) => element.scrollTop))
    .not.toBe(initial.transcriptTop);
  expect(await trayItems.evaluate((element) => element.scrollTop)).toBe(trayTopAfterNestedWheel);

  const outerDestination = await list.evaluate((element) => element.scrollTop);
  await page.waitForTimeout(250);
  expect(await list.evaluate((element) => element.scrollTop)).toBe(outerDestination);
});

test('keeps the active tool gap fixed through its entrance animation', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=tool-cards&activeTray=1&activeTrayCount=1');
  const activeTool = page.locator('.assistant-active-activity-item .chat-tool-invocation-part');
  await expect(activeTool).toBeVisible();
  const gaps = await activeTool.evaluate((element) => {
    const item = element.closest<HTMLElement>('.assistant-active-activity-item');
    const summary = document.querySelector<HTMLElement>('.assistant-activity-summary');
    const animation = item
      ?.getAnimations()
      .find(
        (candidate) =>
          getComputedStyle(item).animationName === 'assistant-active-activity-in' &&
          candidate.effect instanceof KeyframeEffect
      );
    if (!item || !summary || !animation) throw new Error('Active tool entrance is missing');
    animation.pause();
    return [0, 140, 280].map((currentTime) => {
      animation.currentTime = currentTime;
      return element.getBoundingClientRect().top - summary.getBoundingClientRect().bottom;
    });
  });
  expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThanOrEqual(0.5);
  for (const gap of gaps) expect(gap).toBeCloseTo(12, 0);
});

test('keeps a cross-message active tool adjacent to Explored after entrance', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=tool-cards');
  const summary = page.locator('.assistant-activity-summary').last();
  await expect(summary).toContainText('Explored');

  await page.evaluate(() => {
    const sessionId = 'session-tool-cards';
    const harnessWindow = window as typeof window & {
      __varroE2E?: {
        getSessionMessages?: (id: string) => Array<{ info: Record<string, unknown> }>;
        updateMessageInfo?: (info: Record<string, unknown>) => void;
        updateMessagePart?: (part: Record<string, unknown>) => void;
        updateSessionStatus?: (id: string, status: { type: 'busy' }) => void;
      };
    };
    const original = harnessWindow.__varroE2E
      ?.getSessionMessages?.(sessionId)
      .find((message) => message.info.role === 'assistant');
    if (!original) throw new Error('Cross-message activity fixture is missing');
    const info = {
      ...original.info,
      id: 'message-cross-message-active-tool',
      time: { created: Date.now() },
    };
    const part = {
      id: 'tool-cross-message-active',
      sessionID: sessionId,
      messageID: info.id,
      type: 'tool' as const,
      callID: 'tool-cross-message-active-call',
      tool: 'grep',
      state: {
        status: 'running' as const,
        input: { pattern: 'cross-message activity', path: 'src' },
        title: 'Search cross-message activity',
        time: { start: Date.now() },
      },
    };
    harnessWindow.__varroE2E?.updateMessageInfo?.(info);
    harnessWindow.__varroE2E?.updateMessagePart?.(part);
    harnessWindow.__varroE2E?.updateSessionStatus?.(sessionId, { type: 'busy' });
    for (const [type, properties] of [
      ['message.updated', { info }],
      ['message.part.updated', { part }],
      ['session.status', { sessionID: sessionId, status: { type: 'busy' } }],
    ] as const) {
      window.postMessage({ type: 'server/event', payload: { type, properties } }, '*');
    }
  });

  const row = page.locator('[data-msg-id="message-cross-message-active-tool"]');
  const tray = row.locator('.assistant-active-activity-tray');
  const activeTool = tray.locator('.chat-tool-invocation-part');
  await expect(activeTool).toBeVisible();
  await expect(row).not.toHaveClass(/interactive-item-entering/);
  await expect(tray).not.toHaveClass(/has-active-summary/);
  await expect(row.locator('.assistant-activity-summary')).toHaveCount(0);

  const geometry = await activeTool.evaluate(
    async (element, summaryElement) => {
      const rowElement = element.closest<HTMLElement>('.interactive-item-container');
      const shell = element.closest<HTMLElement>('.assistant-turn-content');
      const trayElement = element.closest<HTMLElement>('.assistant-active-activity-tray');
      if (!summaryElement || !rowElement || !shell || !trayElement) {
        throw new Error('Cross-message activity geometry is missing');
      }
      const entranceAnimationNames = new Set([
        'streamed-message-row-in',
        'assistant-active-activity-in',
        'assistant-active-activity-row-in',
        'assistant-active-activity-shell-in',
      ]);
      await Promise.allSettled(
        rowElement
          .getAnimations({ subtree: true })
          .filter(
            (animation): animation is CSSAnimation =>
              animation instanceof CSSAnimation &&
              entranceAnimationNames.has(animation.animationName)
          )
          .map((animation) => animation.finished)
      );
      if (!element.isConnected) throw new Error('Cross-message active tool was removed');
      const summaryRow = (summaryElement as HTMLElement).closest<HTMLElement>(
        '.interactive-item-container'
      );
      return {
        gap:
          element.getBoundingClientRect().top -
          (summaryElement as HTMLElement).getBoundingClientRect().bottom,
        sourceRowCorrection: Number.parseFloat(
          summaryRow?.style.getPropertyValue('--interactive-item-block-correction') || '0'
        ),
        trayIsOnlyChild: trayElement.parentElement?.children.length === 1,
      };
    },
    await summary.elementHandle()
  );

  expect(geometry.trayIsOnlyChild).toBe(true);
  expect(geometry.sourceRowCorrection).toBeGreaterThanOrEqual(0);
  expect(geometry.sourceRowCorrection).toBeLessThan(1);
  expect(geometry.gap - geometry.sourceRowCorrection).toBeCloseTo(12, 0);
});

test('keeps streamed response text fixed when it follows Explored', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=tool-cards');
  const summary = page.locator('.assistant-activity-summary').first();
  await expect(summary).toContainText('Explored');
  await page.addStyleTag({
    content: '.assistant-activity-group-settling { animation: none !important; }',
  });
  const appendedInfo = await page.evaluate(() => {
    const harnessWindow = window as typeof window & {
      __varroE2E?: {
        getSessionMessages?: (id: string) => Array<{ info: Record<string, unknown> }>;
        updateMessageInfo?: (info: Record<string, unknown>) => void;
        updateMessagePart?: (part: Record<string, unknown>) => void;
      };
    };
    const original = harnessWindow.__varroE2E
      ?.getSessionMessages?.('session-tool-cards')
      .find((message) => message.info.role === 'assistant');
    if (!original) throw new Error('Tool-card assistant fixture is missing');
    const info = {
      ...original.info,
      id: 'message-streamed-after-explored',
      time: { created: Date.now() },
    };
    const part = {
      id: 'text-streamed-after-explored',
      sessionID: 'session-tool-cards',
      messageID: info.id,
      type: 'text',
      text: '',
    };
    harnessWindow.__varroE2E?.updateMessageInfo?.(info);
    harnessWindow.__varroE2E?.updateMessagePart?.(part);
    window.postMessage(
      { type: 'server/event', payload: { type: 'message.updated', properties: { info } } },
      '*'
    );
    window.postMessage(
      { type: 'server/event', payload: { type: 'message.part.updated', properties: { part } } },
      '*'
    );
    window.postMessage(
      {
        type: 'server/event',
        payload: {
          type: 'message.part.delta',
          properties: {
            sessionID: part.sessionID,
            messageID: part.messageID,
            partID: part.id,
            field: 'text',
            delta: 'Streamed response after Explored.',
          },
        },
      },
      '*'
    );
    return info;
  });

  const response = page.getByText('Streamed response after Explored.', { exact: true });
  await expect(response).toBeVisible();
  const row = page.locator('[data-msg-id="message-streamed-after-explored"]');
  await expect(row).not.toHaveClass(/interactive-item-render-empty/);
  const samples = await response.evaluate(async (element, info) => {
    if (!element.closest('.interactive-item-container')) {
      throw new Error('Streamed response row is missing');
    }
    // oxlint-disable-next-line unicorn/consistent-function-scoping
    const measure = () => {
      const currentRow = document.querySelector<HTMLElement>(
        '[data-msg-id="message-streamed-after-explored"]'
      );
      const currentSummary = [
        ...document.querySelectorAll<HTMLElement>('.assistant-activity-summary'),
      ].at(-1);
      if (!currentRow || !currentSummary) throw new Error('Streamed response geometry is missing');
      const current = currentRow.querySelector<HTMLElement>('.rendered-markdown p');
      if (!current) throw new Error('Streamed response content is missing');
      const box = current.getBoundingClientRect();
      const sourceRowCorrection = Number.parseFloat(
        currentSummary
          .closest<HTMLElement>('.interactive-item-container')
          ?.style.getPropertyValue('--interactive-item-block-correction') || '0'
      );
      return {
        top: box.top,
        gap: box.top - currentSummary.getBoundingClientRect().bottom - sourceRowCorrection,
      };
    };
    const collectedSamples = [measure()];
    const part = {
      id: 'text-streamed-after-explored-followup',
      sessionID: 'session-tool-cards',
      messageID: info.id,
      type: 'text',
      text: '',
    };
    const harnessWindow = window as typeof window & {
      __varroE2E?: { updateMessagePart?: (part: Record<string, unknown>) => void };
    };
    harnessWindow.__varroE2E?.updateMessagePart?.(part);
    window.postMessage(
      { type: 'server/event', payload: { type: 'message.part.updated', properties: { part } } },
      '*'
    );
    window.postMessage(
      {
        type: 'server/event',
        payload: {
          type: 'message.part.delta',
          properties: {
            sessionID: part.sessionID,
            messageID: part.messageID,
            partID: part.id,
            field: 'text',
            delta: 'Following streamed block.',
          },
        },
      },
      '*'
    );
    for (let frame = 0; frame < 30; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      collectedSamples.push(measure());
    }
    return collectedSamples;
  }, appendedInfo);

  const tops = samples.map((sample) => sample.top);
  const gaps = samples.map((sample) => sample.gap);
  expect(Math.max(...tops) - Math.min(...tops), JSON.stringify(samples)).toBeLessThanOrEqual(0.5);
  expect(Math.max(...gaps) - Math.min(...gaps), JSON.stringify(samples)).toBeLessThanOrEqual(0.5);
  for (const gap of gaps) expect(gap).toBeCloseTo(12, 0);
});

test('hides sibling active tools while one tool is expanded', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=tool-cards&activeTray=1&activeTrayCount=3');
  const items = page.locator('.assistant-active-activity-item');
  await expect(items).toHaveCount(3);
  const firstItem = items.first();
  const firstHeader = firstItem.locator('.tool-invocation-header');
  await firstHeader.click();
  await expect(firstItem.locator('.tool-invocation-chevron')).toHaveClass(/expanded/);

  const visiblePartIds = () =>
    items.evaluateAll((elements) =>
      elements
        .filter((element) => element.getClientRects().length > 0)
        .map((element) => element.getAttribute('data-activity-part-id'))
    );
  await expect.poll(visiblePartIds).toEqual(['tool-active-0']);

  await firstHeader.click();
  await expect(firstItem.locator('.tool-invocation-chevron')).not.toHaveClass(/expanded/);
  await expect.poll(visiblePartIds).toEqual(['tool-active-0', 'tool-active-1', 'tool-active-2']);
});

test('keeps active tools outside an expanded Explored group', async ({ page }) => {
  await page.clock.install();
  await page.clock.pauseAt(new Date('2030-01-01T00:00:00Z'));
  await page.goto('/e2e/harness/index.html?scenario=tool-cards&compactToolOutput=1');
  await page.evaluate(() => {
    const sessionId = 'session-tool-cards';
    const harnessWindow = window as typeof window & {
      __varroE2E?: {
        getSessionMessages?: (id: string) => Array<{ info: Record<string, unknown> }>;
        updateMessageInfo?: (info: Record<string, unknown>) => void;
        updateSessionStatus?: (id: string, status: { type: 'busy' }) => void;
      };
    };
    const assistant = harnessWindow.__varroE2E
      ?.getSessionMessages?.(sessionId)
      .find((message) => message.info.id === 'message-tool-cards-assistant');
    if (!assistant) throw new Error('Expanded activity fixture is missing');
    const info = { ...assistant.info, time: { created: Date.now() } };
    harnessWindow.__varroE2E?.updateMessageInfo?.(info);
    harnessWindow.__varroE2E?.updateSessionStatus?.(sessionId, { type: 'busy' });
    for (const [type, properties] of [
      ['message.updated', { info }],
      ['session.status', { sessionID: sessionId, status: { type: 'busy' } }],
    ] as const) {
      window.postMessage({ type: 'server/event', payload: { type, properties } }, '*');
    }
  });

  const summaries = page.locator('.assistant-activity-summary');
  await expect(summaries).toHaveCount(2);
  const summary = summaries.last();
  await summary.click();
  await expect(summary).toHaveAttribute('aria-expanded', 'true');
  const details = page.locator('.assistant-activity-detail');
  const initialDetailCount = await details.count();
  const initialSummary = await summary.textContent();

  await page.evaluate(() => {
    const sessionId = 'session-tool-cards';
    const messageId = 'message-tool-cards-assistant';
    const harnessWindow = window as typeof window & {
      __varroE2E?: {
        updateMessagePart?: (part: Record<string, unknown>) => void;
      };
    };
    const part = {
      id: 'tool-expanded-running',
      sessionID: sessionId,
      messageID: messageId,
      type: 'tool' as const,
      callID: 'tool-expanded-running-call',
      tool: 'grep',
      state: {
        status: 'running' as const,
        input: { pattern: 'expanded activity', path: 'src' },
        title: 'Search expanded activity',
        time: { start: Date.now() },
      },
    };
    harnessWindow.__varroE2E?.updateMessagePart?.(part);
    window.postMessage(
      { type: 'server/event', payload: { type: 'message.part.updated', properties: { part } } },
      '*'
    );
  });

  await expect(details).toHaveCount(initialDetailCount);
  await expect(summary).toHaveText(initialSummary || '');
  await page.clock.fastForward(500);
  const activeItem = page.locator('[data-activity-part-id="tool-expanded-running"]');
  await expect(page.locator('.assistant-active-activity-tray')).toHaveCount(1);
  await expect(activeItem).toBeVisible();
  await expect(
    activeItem.locator('xpath=ancestor::*[contains(@class, "assistant-activity-details")]')
  ).toHaveCount(0);
});

test('hides Thinking while an apply_patch tool is shown inline', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=diff-preview-large-transcript');
  await page.evaluate(() => {
    const sessionId = 'session-diff-preview-large-transcript';
    const harnessWindow = window as typeof window & {
      __varroE2E?: {
        getSessionMessages?: (id: string) => Array<{ info: Record<string, unknown> }>;
        updateMessageInfo?: (info: Record<string, unknown>) => void;
        updateSessionStatus?: (id: string, status: { type: 'busy' }) => void;
      };
    };
    const assistant = harnessWindow.__varroE2E
      ?.getSessionMessages?.(sessionId)
      .find((message) => message.info.id === 'message-diff-preview-assistant-59');
    if (!assistant) throw new Error('Inline apply_patch fixture is missing');
    const info = { ...assistant.info, time: { created: Date.now() } };
    harnessWindow.__varroE2E?.updateMessageInfo?.(info);
    harnessWindow.__varroE2E?.updateSessionStatus?.(sessionId, { type: 'busy' });
    window.postMessage(
      {
        type: 'server/event',
        payload: { type: 'message.updated', properties: { info } },
      },
      '*'
    );
    window.postMessage(
      {
        type: 'server/event',
        payload: {
          type: 'session.status',
          properties: { sessionID: sessionId, status: { type: 'busy' } },
        },
      },
      '*'
    );
  });

  const latestRow = page.locator('[data-msg-id="message-diff-preview-assistant-59"]');
  await expect(latestRow.locator('.chat-tool-invocation-part.file-change-card')).toBeVisible();
  await expect(page.locator('.interactive-loading-row .loading-indicator')).toBeHidden();
});

test('keeps the inline diff-to-next-block gap consistent', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 1600 });
  await page.goto(
    '/e2e/harness/index.html?scenario=diff-preview-large-transcript&multiFileDiff=1&spacingBoundary=1'
  );

  const row = page.locator('[data-msg-id="message-diff-preview-assistant-59"]');
  await row.locator('.assistant-activity-summary').click();
  const details = row.locator('.assistant-activity-detail');
  const lastDiff = details
    .first()
    .locator('.file-change-inline-diffs-unwrapped .diff-view-file')
    .last();
  const nextBlock = details.last().locator('.chat-tool-invocation-part');
  await expect(lastDiff).toBeVisible();
  await expect(nextBlock).toBeVisible();
  expect(
    await nextBlock.evaluate(
      (element, diff) => {
        return (
          element.getBoundingClientRect().top - (diff as HTMLElement).getBoundingClientRect().bottom
        );
      },
      await lastDiff.elementHandle()
    )
  ).toBeCloseTo(12, 0);
});

test('matches collapsed activity-to-event spacing to expanded detail spacing', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 1600 });
  await page.goto('/e2e/harness/index.html?scenario=tool-cards');
  const summary = page.locator('.assistant-activity-summary').first();
  await expect(summary).toContainText('Explored');
  await page.evaluate(() => {
    window.postMessage(
      {
        type: 'server/event',
        payload: {
          type: 'message.part.updated',
          properties: {
            part: {
              id: 'tool-task-spacing',
              sessionID: 'session-tool-cards',
              messageID: 'message-tool-cards-assistant',
              type: 'tool',
              callID: 'tool-task-spacing-call',
              tool: 'task',
              state: {
                status: 'completed',
                input: { description: 'Verify activity spacing' },
                output: 'Verified',
                title: 'Verify activity spacing',
                metadata: {},
                time: { start: Date.now(), end: Date.now() + 1 },
              },
            },
          },
        },
      },
      '*'
    );
    window.postMessage(
      {
        type: 'server/event',
        payload: {
          type: 'message.part.updated',
          properties: {
            part: {
              id: 'tool-read-spacing',
              sessionID: 'session-tool-cards',
              messageID: 'message-tool-cards-assistant',
              type: 'tool',
              callID: 'tool-read-spacing-call',
              tool: 'read',
              state: {
                status: 'completed',
                input: { file_path: '/workspace/spacing.ts' },
                output: 'export const spacing = 16;',
                title: 'Read spacing fixture',
                metadata: {},
                time: { start: Date.now(), end: Date.now() + 1 },
              },
            },
          },
        },
      },
      '*'
    );
    window.postMessage(
      {
        type: 'server/event',
        payload: {
          type: 'message.part.updated',
          properties: {
            part: {
              id: 'text-spacing-boundary',
              sessionID: 'session-tool-cards',
              messageID: 'message-tool-cards-assistant',
              type: 'text',
              text: 'Spacing prose boundary.',
            },
          },
        },
      },
      '*'
    );
    window.postMessage(
      {
        type: 'server/event',
        payload: {
          type: 'message.part.updated',
          properties: {
            part: {
              id: 'tool-task-spacing-followup',
              sessionID: 'session-tool-cards',
              messageID: 'message-tool-cards-assistant',
              type: 'tool',
              callID: 'tool-task-spacing-followup-call',
              tool: 'task',
              state: {
                status: 'completed',
                input: { description: 'Verify prose spacing' },
                output: 'Verified',
                title: 'Verify prose spacing',
                metadata: {},
                time: { start: Date.now(), end: Date.now() + 1 },
              },
            },
          },
        },
      },
      '*'
    );
  });
  const taskCard = page.locator('.tool-invocation-task').first();
  await expect(taskCard).toBeVisible();
  const trailingSummary = page.locator('.assistant-activity-summary').nth(1);
  await expect(trailingSummary).toContainText('Explored');
  await trailingSummary.evaluate(async (element) => {
    const item = element.closest('.assistant-message-flow-item');
    if (!item) throw new Error('Activity flow item is missing');
    await Promise.all(item.getAnimations({ subtree: true }).map((animation) => animation.finished));
  });
  const collapsedGap = await summary.evaluate((element) => {
    const card = document.querySelector<HTMLElement>('.tool-invocation-task');
    if (!card) throw new Error('Task card is missing');
    return card.getBoundingClientRect().top - element.getBoundingClientRect().bottom;
  });
  const incomingGap = await trailingSummary.evaluate((element) => {
    const card = document.querySelector<HTMLElement>('.tool-invocation-task');
    if (!card) throw new Error('Task card is missing');
    return element.getBoundingClientRect().top - card.getBoundingClientRect().bottom;
  });
  const prose = page.getByText('Spacing prose boundary.', { exact: true });
  const followingTask = page
    .locator('.tool-invocation-task')
    .filter({ hasText: 'Verify prose spacing' });
  await expect(prose).toBeVisible();
  await expect(followingTask).toBeVisible();
  const proseGaps = await prose.evaluate((element) => {
    const summaries = document.querySelectorAll<HTMLElement>('.assistant-activity-summary');
    const card = [...document.querySelectorAll<HTMLElement>('.tool-invocation-task')].find((item) =>
      item.textContent?.includes('Verify prose spacing')
    );
    const precedingSummary = summaries[1];
    if (!precedingSummary || !card) throw new Error('Prose boundary fixtures are missing');
    const proseBox = element.getBoundingClientRect();
    return {
      summaryToProse: proseBox.top - precedingSummary.getBoundingClientRect().bottom,
      proseToEvent: card.getBoundingClientRect().top - proseBox.bottom,
    };
  });
  await page.evaluate(() => {
    const harnessWindow = window as typeof window & {
      __varroE2E?: {
        getSessionMessages?: (id: string) => Array<{ info: Record<string, unknown> }>;
      };
    };
    const original = harnessWindow.__varroE2E
      ?.getSessionMessages?.('session-tool-cards')
      .find((message) => message.info.role === 'assistant');
    if (!original) throw new Error('Tool-card assistant fixture is missing');
    // oxlint-disable-next-line unicorn/consistent-function-scoping
    const postEvent = (type: string, properties: Record<string, unknown>) => {
      window.postMessage({ type: 'server/event', payload: { type, properties } }, '*');
    };
    const proseInfo = {
      ...original.info,
      id: 'message-spacing-prose-followup',
      time: { created: Date.now(), completed: Date.now() + 1 },
    };
    postEvent('message.updated', { info: proseInfo });
    postEvent('message.part.updated', {
      part: {
        id: 'text-spacing-followup',
        sessionID: 'session-tool-cards',
        messageID: proseInfo.id,
        type: 'text',
        text: 'Cross-message prose boundary.',
      },
    });
    postEvent('message.updated', {
      info: {
        ...original.info,
        id: 'message-spacing-empty-followup',
        time: { created: Date.now() + 2, completed: Date.now() + 3 },
      },
    });
    const activityInfo = {
      ...original.info,
      id: 'message-spacing-activity-followup',
      time: { created: Date.now() + 4, completed: Date.now() + 5 },
    };
    postEvent('message.updated', { info: activityInfo });
    postEvent('message.part.updated', {
      part: {
        id: 'tool-spacing-followup',
        sessionID: 'session-tool-cards',
        messageID: activityInfo.id,
        type: 'tool',
        callID: 'tool-spacing-followup-call',
        tool: 'read',
        state: {
          status: 'completed',
          input: { file_path: '/workspace/cross-message-spacing.ts' },
          output: 'export const spacing = 16;',
          title: 'Read cross-message spacing fixture',
          metadata: {},
          time: { start: Date.now(), end: Date.now() + 1 },
        },
      },
    });
    postEvent('message.updated', {
      info: {
        ...original.info,
        id: 'message-spacing-empty-activity-followup',
        time: { created: Date.now() + 6, completed: Date.now() + 7 },
      },
    });
    const continuedActivityInfo = {
      ...original.info,
      id: 'message-spacing-continued-activity-followup',
      time: { created: Date.now() + 8, completed: Date.now() + 9 },
    };
    postEvent('message.updated', { info: continuedActivityInfo });
    postEvent('message.part.updated', {
      part: {
        id: 'tool-spacing-continued-followup',
        sessionID: 'session-tool-cards',
        messageID: continuedActivityInfo.id,
        type: 'tool',
        callID: 'tool-spacing-continued-followup-call',
        tool: 'read',
        state: {
          status: 'completed',
          input: { file_path: '/workspace/continued-spacing.ts' },
          output: 'export const continuedSpacing = 12;',
          title: 'Read continued spacing fixture',
          metadata: {},
          time: { start: Date.now(), end: Date.now() + 1 },
        },
      },
    });
  });
  const crossMessageProse = page.getByText('Cross-message prose boundary.', { exact: true });
  const crossMessageSummary = page.locator('.assistant-activity-summary').last();
  await expect(crossMessageProse).toBeVisible();
  await expect(crossMessageSummary).toContainText('Explored: 2 files');
  await page
    .locator(
      '[data-msg-id="message-spacing-prose-followup"], [data-msg-id="message-spacing-activity-followup"], [data-msg-id="message-spacing-continued-activity-followup"]'
    )
    .evaluateAll(async (rows) => {
      await Promise.allSettled(
        rows
          .flatMap((row) => row.getAnimations({ subtree: true }))
          .map((animation) => animation.finished)
      );
    });
  const crossMessageGaps = await crossMessageProse.evaluate((element) => {
    const precedingCard = [...document.querySelectorAll<HTMLElement>('.tool-invocation-task')].find(
      (item) => item.textContent?.includes('Verify prose spacing')
    );
    const followingSummary = document.querySelector<HTMLElement>(
      '[data-msg-id="message-spacing-activity-followup"] .assistant-activity-summary'
    );
    if (!precedingCard || !followingSummary) {
      throw new Error('Cross-message spacing fixtures are missing');
    }
    const proseBox = element.getBoundingClientRect();
    return {
      eventToProse: proseBox.top - precedingCard.getBoundingClientRect().bottom,
      proseToSummary: followingSummary.getBoundingClientRect().top - proseBox.bottom,
    };
  });
  await page.addStyleTag({
    content: '.assistant-activity-group-settling { animation: none !important; }',
  });
  const continuedActivityRow = page.locator(
    '[data-msg-id="message-spacing-continued-activity-followup"]'
  );
  await expect(continuedActivityRow).toHaveClass(/interactive-item-render-empty/);
  const collapsedActivityRowHeight = await continuedActivityRow.evaluate(
    (element) => element.getBoundingClientRect().height
  );
  expect(collapsedActivityRowHeight).toBe(0);

  await crossMessageSummary.click();
  await expect(continuedActivityRow).toHaveClass(/interactive-response-continues-activity-group/);
  const firstCrossMessageDetail = page.locator(
    '[data-msg-id="message-spacing-activity-followup"] .assistant-activity-detail .chat-tool-invocation-part'
  );
  const continuedCrossMessageDetail = page.locator(
    '[data-msg-id="message-spacing-continued-activity-followup"] .assistant-activity-detail .chat-tool-invocation-part'
  );
  await expect(firstCrossMessageDetail).toBeVisible();
  await expect(continuedCrossMessageDetail).toBeVisible();
  const continuedActivityGap = await continuedCrossMessageDetail.evaluate((element) => {
    const previous = document.querySelector<HTMLElement>(
      '[data-msg-id="message-spacing-activity-followup"] .assistant-activity-detail .chat-tool-invocation-part'
    );
    if (!previous) throw new Error('Previous cross-message activity detail is missing');
    return element.getBoundingClientRect().top - previous.getBoundingClientRect().bottom;
  });

  await summary.click();
  const firstDetail = page.locator('.assistant-activity-detail .chat-tool-invocation-part').first();
  await expect(firstDetail).toBeVisible();
  const expandedGap = await summary.evaluate((element) => {
    const card = document.querySelector<HTMLElement>(
      '.assistant-activity-detail .chat-tool-invocation-part'
    );
    if (!card) throw new Error('Expanded detail card is missing');
    return card.getBoundingClientRect().top - element.getBoundingClientRect().bottom;
  });

  expect(incomingGap).toBe(12);
  expect(collapsedGap).toBe(12);
  expect(expandedGap).toBe(12);
  expect(proseGaps).toEqual({ summaryToProse: 12, proseToEvent: 12 });
  expect(crossMessageGaps.eventToProse).toBeCloseTo(12, 0);
  expect(crossMessageGaps.proseToSummary).toBe(12);
  expect(continuedActivityGap).toBeCloseTo(12, 0);
});

test('keeps Explored spacing consistent beside user blocks', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 1000 });
  await page.goto('/e2e/harness/index.html?scenario=tool-cards');
  const summary = page.locator('.assistant-activity-summary');
  await expect(summary).toContainText('Explored');
  await page.addStyleTag({ content: '.assistant-dialog-summary { display: none !important; }' });
  await page.getByRole('textbox', { name: 'Message composer' }).fill('Spacing user boundary.');
  await page.getByRole('button', { name: 'Send (Enter)' }).click();
  const followingUser = page.getByText('Spacing user boundary.', { exact: true });
  await expect(followingUser).toBeVisible();
  const followingUserRow = page.locator('.interactive-request').filter({ has: followingUser });
  await expect(followingUserRow).not.toHaveClass(/interactive-item-entering/);
  const gaps = await summary.evaluate((element) => {
    const precedingUser = document.querySelector<HTMLElement>(
      '[data-msg-id="message-tool-cards-user"] .user-message-card'
    );
    const nextUser = [...document.querySelectorAll<HTMLElement>('.user-message-card')].find(
      (card) => card.textContent?.includes('Spacing user boundary.')
    );
    if (!precedingUser || !nextUser) {
      throw new Error('Explored user-boundary fixtures are missing');
    }
    return {
      userToSummary:
        element.getBoundingClientRect().top - precedingUser.getBoundingClientRect().bottom,
      summaryToUser: nextUser.getBoundingClientRect().top - element.getBoundingClientRect().bottom,
    };
  });
  expect(gaps.userToSummary).toBeCloseTo(12, 0);
  expect(gaps.summaryToUser).toBeCloseTo(12, 0);

  await page.keyboard.down('Alt');
  const precedingTimestamp = page.locator(
    '[data-msg-id="message-tool-cards-user"] .message-sent-time'
  );
  await expect(precedingTimestamp).toBeVisible();
  const revealedGeometry = await precedingTimestamp.evaluate((element) => {
    const precedingUser = document.querySelector<HTMLElement>(
      '[data-msg-id="message-tool-cards-user"] .user-message-card'
    );
    const activitySummary = document.querySelector<HTMLElement>('.assistant-activity-summary');
    if (!precedingUser || !activitySummary) {
      throw new Error('Revealed timestamp boundary fixtures are missing');
    }
    const userBox = precedingUser.getBoundingClientRect();
    const timestampBox = element.getBoundingClientRect();
    const summaryBox = activitySummary.getBoundingClientRect();
    const activityGroup = activitySummary.closest<HTMLElement>('.assistant-activity-group');
    if (!activityGroup) throw new Error('Explored activity group is missing');
    return {
      userToSummary: summaryBox.top - userBox.bottom,
      timestampGap: timestampBox.top - userBox.bottom,
      timestampOverlap: timestampBox.bottom - summaryBox.top,
      timestampZIndex: Number(getComputedStyle(element).zIndex),
      activityGroupZIndex: Number(getComputedStyle(activityGroup).zIndex),
    };
  });
  await page.keyboard.up('Alt');
  expect(revealedGeometry.userToSummary).toBeCloseTo(12, 0);
  expect(revealedGeometry.timestampGap).toBeCloseTo(2, 0);
  expect(revealedGeometry.timestampOverlap).toBeCloseTo(2, 0);
  expect(revealedGeometry.timestampZIndex).toBeGreaterThan(revealedGeometry.activityGroupZIndex);
});

test('keeps revealed timestamps above Explored in virtualized rows', async ({ page }) => {
  await page.setViewportSize({ width: 410, height: 800 });
  await page.goto('/e2e/harness/index.html?scenario=tool-cards-large-transcript');
  await expect(page.locator('.interactive-list-track')).toHaveClass(/virtualized/);

  const userRow = page.locator('[data-msg-id="message-tool-cards-user-69"]');
  const timestamp = userRow.locator('.message-sent-time');
  await page.keyboard.down('Alt');
  await expect(timestamp).toBeVisible();
  const stacking = await timestamp.evaluate((element) => {
    const row = element.closest<HTMLElement>('.interactive-item-container');
    const followingActivity = row?.nextElementSibling?.querySelector<HTMLElement>(
      '.assistant-activity-group'
    );
    if (!row || !followingActivity) throw new Error('Virtualized timestamp fixtures are missing');
    return {
      rowContain: getComputedStyle(row).contain,
      rowZIndex: Number(getComputedStyle(row).zIndex),
      activityZIndex: Number(getComputedStyle(followingActivity).zIndex),
      extendsPastRow:
        element.getBoundingClientRect().bottom > row.getBoundingClientRect().bottom,
    };
  });
  await page.keyboard.up('Alt');

  expect(stacking.extendsPastRow).toBe(true);
  expect(stacking.rowContain).not.toContain('paint');
  expect(stacking.rowZIndex).toBeGreaterThan(stacking.activityZIndex);
});

test('matches the visual incoming Thinking gap to markdown', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 1000 });
  await page.goto('/e2e/harness/index.html?scenario=tool-cards');
  await page.addStyleTag({
    content: '.assistant-active-activity-item.is-entering { animation: none !important; }',
  });
  await expect(page.locator('.assistant-activity-summary')).toHaveCount(1);
  await page.evaluate(() => {
    const harnessWindow = window as typeof window & {
      __varroE2E?: {
        getSessionMessages?: (id: string) => Array<{ info: Record<string, unknown> }>;
        updateMessageInfo?: (info: Record<string, unknown>) => void;
        updateSessionStatus?: (id: string, status: { type: 'busy' }) => void;
      };
    };
    const assistant = harnessWindow.__varroE2E
      ?.getSessionMessages?.('session-tool-cards')
      .find((message) => message.info.role === 'assistant');
    if (!assistant) throw new Error('Tool-card assistant fixture is missing');
    // oxlint-disable-next-line unicorn/consistent-function-scoping
    const postEvent = (type: string, properties: Record<string, unknown>) => {
      window.postMessage({ type: 'server/event', payload: { type, properties } }, '*');
    };
    harnessWindow.__varroE2E?.updateSessionStatus?.('session-tool-cards', { type: 'busy' });
    const updatedInfo = { ...assistant.info, time: { created: Date.now() } };
    harnessWindow.__varroE2E?.updateMessageInfo?.(updatedInfo);
    postEvent('message.updated', {
      info: updatedInfo,
    });
    postEvent('session.status', { sessionID: 'session-tool-cards', status: { type: 'busy' } });
    postEvent('message.part.updated', {
      part: {
        id: 'text-thinking-spacing',
        sessionID: 'session-tool-cards',
        messageID: assistant.info.id,
        type: 'text',
        text: 'Thinking spacing reference.',
      },
    });
    postEvent('message.part.updated', {
      part: {
        id: 'tool-thinking-spacing',
        sessionID: 'session-tool-cards',
        messageID: assistant.info.id,
        type: 'tool',
        callID: 'tool-thinking-spacing-call',
        tool: 'grep',
        state: {
          status: 'completed',
          input: { pattern: 'spacing', path: 'src' },
          output: 'src/spacing.ts:1:export const spacing = true;',
          title: 'Search thinking spacing fixture',
          metadata: {},
          time: { start: Date.now() - 2, end: Date.now() - 1 },
        },
      },
    });
    postEvent('message.part.updated', {
      part: {
        id: 'reasoning-thinking-spacing',
        sessionID: 'session-tool-cards',
        messageID: assistant.info.id,
        type: 'reasoning',
        text: [
          'Examining',
          ...Array.from(
            { length: 24 },
            (_, index) => `Detailed reasoning line ${index + 1} keeps the active card overheight.`
          ),
        ].join('\n\n'),
        time: { start: Date.now() },
      },
    });
  });

  const summaries = page.locator('.assistant-activity-summary');
  const markdown = page.getByText('Thinking spacing reference.', { exact: true });
  const thinkingBox = page.locator('.assistant-active-activity-item .chat-thinking-box');
  await expect(summaries).toHaveCount(3);
  await expect(markdown).toBeVisible();
  await expect(thinkingBox.locator('.thinking-label-text')).toHaveText('Thinking');
  await thinkingBox.locator('.thinking-header').click();
  await expect(thinkingBox.locator('.thinking-header')).toHaveAttribute('aria-expanded', 'true');
  const gaps = await thinkingBox.evaluate(async (element) => {
    const activitySummaries = document.querySelectorAll<HTMLElement>('.assistant-activity-summary');
    const reference = document.querySelector<HTMLElement>(
      '.assistant-message-flow-item .rendered-markdown'
    );
    const tray = element.closest<HTMLElement>('.assistant-active-activity-tray');
    const viewport = tray?.querySelector<HTMLElement>('.assistant-active-activity-items');
    if (!activitySummaries[1] || !activitySummaries[2] || !reference || !tray || !viewport) {
      throw new Error('Thinking spacing fixtures are missing');
    }
    const samples: Array<{ boxTop: number; scrollTop: number; trayTop: number }> = [];
    for (let frame = 0; frame < 30 && element.isConnected; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      samples.push({
        boxTop: element.getBoundingClientRect().top,
        scrollTop: viewport.scrollTop,
        trayTop: viewport.getBoundingClientRect().top,
      });
    }
    return {
      boxTop: element.getBoundingClientRect().top,
      clientHeight: viewport.clientHeight,
      markdown:
        reference.getBoundingClientRect().top - activitySummaries[1].getBoundingClientRect().bottom,
      scrollHeight: viewport.scrollHeight,
      scrollTop: viewport.scrollTop,
      samples,
      thinking:
        element.getBoundingClientRect().top - activitySummaries[2].getBoundingClientRect().bottom,
      trayTop: viewport.getBoundingClientRect().top,
    };
  });
  expect(gaps.thinking).toBeCloseTo(gaps.markdown, 0);
  expect(gaps.scrollHeight).toBeGreaterThan(gaps.clientHeight);
  expect(gaps.scrollTop).toBe(0);
  expect(gaps.boxTop).toBeGreaterThanOrEqual(gaps.trayTop - 0.5);
  expect(gaps.samples.length).toBeGreaterThan(0);
  expect(gaps.samples.every((sample) => sample.scrollTop === 0)).toBe(true);
  expect(gaps.samples.every((sample) => sample.boxTop >= sample.trayTop - 0.5)).toBe(true);
});

test('keeps the hidden Thinking slot fixed while an active tool is visible', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.goto('/e2e/harness/index.html?scenario=tool-cards&activeTray=1&activeTrayCount=1');

  const activeTool = page.locator('.assistant-active-activity-item .chat-tool-invocation-part');
  const loading = page.locator('.interactive-loading-row .loading-indicator');
  await expect(activeTool).toBeVisible();
  await expect(loading).toBeHidden();
  await activeTool.evaluate(async (element) => {
    const item = element.closest('.assistant-active-activity-item');
    const row = element.closest('.interactive-item-container');
    await Promise.all(
      [...(item?.getAnimations() ?? []), ...(row?.getAnimations() ?? [])].map(
        (animation) => animation.finished
      )
    );
  });
  const measureGap = () =>
    activeTool.evaluate((element) => {
      const loadingVerb = document.querySelector<HTMLElement>(
        '.interactive-loading-row .loading-verb'
      );
      if (!loadingVerb) throw new Error('Thinking indicator is missing');
      return loadingVerb.getBoundingClientRect().top - element.getBoundingClientRect().bottom;
    });
  expect(await measureGap()).toBe(12);
  expect(
    await page.locator('.interactive-loading-row').evaluate((element) => element.clientHeight)
  ).toBe(24);
  const loadingSlotStyle = await page.locator('.interactive-loading-row').evaluate((element) => {
    const style = getComputedStyle(element);
    return { flexShrink: style.flexShrink, minHeight: style.minHeight };
  });
  expect(loadingSlotStyle).toEqual({ flexShrink: '0', minHeight: '24px' });

  await page.evaluate(() => {
    const harnessWindow = window as typeof window & {
      __varroE2E?: {
        getSessionMessages?: (id: string) => Array<{ info: Record<string, unknown> }>;
      };
    };
    const original = harnessWindow.__varroE2E
      ?.getSessionMessages?.('session-tool-cards')
      .find((message) => message.info.role === 'assistant');
    if (!original) throw new Error('Tool-card assistant fixture is missing');
    window.postMessage(
      {
        type: 'server/event',
        payload: {
          type: 'message.updated',
          properties: {
            info: {
              ...original.info,
              id: 'message-tool-cards-empty-assistant',
              time: { created: Date.now() },
            },
          },
        },
      },
      '*'
    );
  });

  const emptyRow = page.locator('[data-msg-id="message-tool-cards-empty-assistant"]');
  await expect(emptyRow).toBeAttached();
  await expect(emptyRow).toHaveClass(/interactive-item-render-empty/);
  expect((await emptyRow.boundingBox())?.height).toBe(0);
  expect(await measureGap()).toBe(12);
});

test('keeps a debounced trailing tool row at zero height until the tool is visible', async ({
  page,
}) => {
  await page.clock.install();
  await page.clock.pauseAt(new Date('2030-01-01T00:00:00Z'));
  await page.goto(
    '/e2e/harness/index.html?scenario=tool-cards-large-transcript&activeTray=1&activeTrayIndex=69'
  );
  const row = page.locator('[data-msg-id="message-tool-cards-assistant-69"]');
  const activeItem = page.locator('[data-activity-part-id="message-tool-cards-assistant-69-tool"]');
  await expect(row).toHaveClass(/interactive-item-render-empty/);
  expect((await row.boundingBox())?.height).toBe(0);
  await expect(activeItem).toHaveCount(0);

  await page.clock.fastForward(499);
  await expect(row).toHaveClass(/interactive-item-render-empty/);
  expect((await row.boundingBox())?.height).toBe(0);

  await page.clock.fastForward(1);
  await expect(row).not.toHaveClass(/interactive-item-render-empty/);
  await expect(activeItem).toHaveCount(1);
});

test('image previews reserve stable 16:9 frames before loading', async ({ page }) => {
  await page.setViewportSize({ width: 486, height: 800 });
  await page.goto('/e2e/harness/index.html?scenario=blank');
  await expect(page.locator('.interactive-session')).toBeVisible();

  await page.locator('.interactive-session').evaluate((root) => {
    for (const isCarousel of [false, true]) {
      const figure = document.createElement('figure');
      figure.className = `chat-image-figure${isCarousel ? ' message-image-carousel-figure' : ''}`;
      const button = document.createElement('button');
      button.className = `chat-image-preview-trigger${isCarousel ? ' message-image-carousel-preview-trigger' : ''}`;
      const image = document.createElement('img');
      image.className = 'chat-image-img';
      button.append(image);
      figure.append(button);
      root.append(figure);
    }
  });

  const triggers = page.locator('.chat-image-preview-trigger');
  const measureFrames = () =>
    triggers.evaluateAll((elements) =>
      elements.map((element) => {
        const box = element.getBoundingClientRect();
        return { width: box.width, height: box.height };
      })
    );
  const beforeLoad = await measureFrames();
  expect(beforeLoad).toHaveLength(2);
  for (const frame of beforeLoad) {
    expect(frame.width / frame.height).toBeCloseTo(16 / 9, 2);
  }

  await triggers.locator('img').evaluateAll((images: HTMLImageElement[]) =>
    Promise.all(
      images.map((image) => {
        image.src =
          'data:image/svg+xml,' +
          encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="482" height="485"/>');
        return image.decode();
      })
    )
  );
  expect(await measureFrames()).toEqual(beforeLoad);
  const imageBoxes = await triggers.locator('img').evaluateAll((images) =>
    images.map((image) => {
      const box = image.getBoundingClientRect();
      return { width: box.width, height: box.height };
    })
  );
  expect(imageBoxes).toEqual(beforeLoad);

  await page.setViewportSize({ width: 1000, height: 800 });
  const resizedFrames = await measureFrames();
  const resizedFrame = resizedFrames[0];
  if (!resizedFrame) throw new Error('Image preview frame is missing');
  expect(resizedFrame.width).toBeGreaterThan(498);
  expect(resizedFrame.width / resizedFrame.height).toBeCloseTo(16 / 9, 2);
});

test('the first image message does not overlap the sticky prompt', async ({ page }) => {
  await page.setViewportSize({ width: 486, height: 800 });
  await page.goto('/e2e/harness/index.html?scenario=sticky-preview');
  await page.addStyleTag({
    content:
      '.interactive-item-entering.measured-entrance-active { animation-play-state: paused !important; }',
  });
  const list = page.locator('.interactive-list');
  await list.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event('scroll'));
  });
  await expect(page.locator('.latest-user-message-sticky')).toBeVisible();

  await page.getByLabel('GitHub Copilot / GPT-5 mini').click();
  await page.getByText('GPT-4.1', { exact: true }).click();
  await expect(page.getByLabel('OpenAI / GPT-4.1')).toBeVisible();

  const composer = page.locator('[role="textbox"][aria-multiline="true"]').first();
  await composer.click();
  await composer.evaluate((node) => {
    const file = new File(
      ['<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"/>'],
      'message.svg',
      { type: 'image/svg+xml' }
    );
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(event, 'clipboardData', { value: dataTransfer });
    node.dispatchEvent(event);
  });
  await expect(page.locator('.chat-attachment-chip').filter({ hasText: 'Image' })).toBeVisible();

  await composer.fill('Image message appears immediately');
  await page.evaluate(() => {
    const bridgeWindow = window as Window & {
      __sendToExtension?: (message: unknown) => void | Promise<void>;
    };
    const sendToExtension = bridgeWindow.__sendToExtension;
    if (!sendToExtension) throw new Error('Extension bridge is missing');
    bridgeWindow.__sendToExtension = (message) => {
      const request = message as { type?: string; payload?: { path?: string } };
      if (request.type === 'api/request' && request.payload?.path?.includes('/prompt_async'))
        return;
      return sendToExtension(message);
    };
  });
  await page.keyboard.press('Enter');

  const row = page
    .locator('.interactive-request')
    .filter({ hasText: 'Image message appears immediately' })
    .last();
  const previewRatio = await row.locator('.chat-image-preview-trigger').evaluate((element) => {
    const box = element.getBoundingClientRect();
    return box.width / box.height;
  });
  expect(previewRatio).toBeCloseTo(16 / 9, 2);
  await expect(row).not.toHaveClass(/interactive-item-entering/);
  await expect
    .poll(() =>
      row.evaluate((element) => {
        const sticky = document.querySelector<HTMLElement>('.latest-user-message-sticky-overlay');
        const prompt = element.querySelector<HTMLElement>('.user-message-card');
        if (!sticky || !prompt) return 0;
        const stickyBox = sticky.getBoundingClientRect();
        return stickyBox.bottom - prompt.getBoundingClientRect().top;
      })
    )
    .toBeLessThanOrEqual(0);
});

test('sticky preview hides before the next prompt can overlap it', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=sticky-preview');

  const list = page.locator('.interactive-list');
  const sticky = page.locator('.latest-user-message-sticky');
  const nextPrompt = page.locator('[data-msg-id="message-sticky-user-2"] .user-message-card');

  await list.evaluate((element) => {
    const nextPromptElement = element.querySelector(
      '[data-msg-id="message-sticky-user-2"] .user-message-card'
    );
    if (!nextPromptElement) throw new Error('Next prompt is not mounted');
    element.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
    element.scrollTop +=
      nextPromptElement.getBoundingClientRect().top -
      element.getBoundingClientRect().top -
      element.clientHeight -
      20;
    element.dispatchEvent(new Event('scroll'));
  });

  await expect(sticky).toBeVisible();
  await expect(sticky).toContainText('keep this prompt visible while the answer scrolls');
  const textClip = sticky.locator('.latest-user-message-sticky-text-clip');
  await expect(textClip).toHaveClass(/has-more-below/);
  const overflowFade = await textClip.evaluate((element) => {
    const text = element.querySelector('.latest-user-message-sticky-text');
    return {
      maskImage: text ? getComputedStyle(text).maskImage : 'none',
      overlayContent: getComputedStyle(element, '::after').content,
    };
  });
  expect(overflowFade.maskImage).not.toBe('none');
  expect(overflowFade.overlayContent).toBe('none');

  const resizeSamples = await page.locator('.chat-main-column-shell').evaluate(async (shell) => {
    const samples: Array<{
      stickyVisible: boolean;
      stickyBottom: number | null;
      lastStickyBottom: number;
      nextPromptTop: number;
    }> = [];
    let lastStickyBottom = Number.NEGATIVE_INFINITY;
    shell.style.maxWidth = 'none';
    for (let frame = 0; frame <= 20; frame += 1) {
      shell.style.width = `${760 - frame * 7}px`;
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const stickyElement = document.querySelector<HTMLElement>(
        '.latest-user-message-sticky-overlay'
      );
      const nextPromptElement = document.querySelector<HTMLElement>(
        '[data-msg-id="message-sticky-user-2"] .user-message-card'
      );
      if (!nextPromptElement) throw new Error('Next prompt is missing during resize');
      const stickyBottom = stickyElement?.getBoundingClientRect().bottom ?? null;
      if (stickyBottom !== null) lastStickyBottom = stickyBottom;
      samples.push({
        stickyVisible: stickyElement !== null,
        stickyBottom,
        lastStickyBottom,
        nextPromptTop: nextPromptElement.getBoundingClientRect().top,
      });
    }
    return samples;
  });
  await page.waitForTimeout(120);
  const firstHiddenResizeFrame = resizeSamples.findIndex((sample) => !sample.stickyVisible);
  if (firstHiddenResizeFrame >= 0) {
    expect(
      resizeSamples.slice(firstHiddenResizeFrame).every((sample) => !sample.stickyVisible),
      JSON.stringify(resizeSamples)
    ).toBe(true);
    const hiddenSample = resizeSamples[firstHiddenResizeFrame]!;
    expect(hiddenSample.nextPromptTop, JSON.stringify(resizeSamples)).toBeLessThanOrEqual(
      hiddenSample.lastStickyBottom
    );
  }
  for (const sample of resizeSamples.filter((entry) => entry.stickyVisible)) {
    expect(sample.nextPromptTop, JSON.stringify(resizeSamples)).toBeGreaterThanOrEqual(
      sample.stickyBottom!
    );
  }

  const gaps = await getE2EState(page, () => {
    const header = document.querySelector(
      '.interactive-session > .chat-header'
    ) as HTMLElement | null;
    const stickyElement = document.querySelector(
      '.latest-user-message-sticky-overlay'
    ) as HTMLElement | null;
    const nextPromptElement = document.querySelector(
      '[data-msg-id="message-sticky-user-2"] .user-message-card'
    ) as HTMLElement | null;
    if (!header || !stickyElement || !nextPromptElement) return null;
    const headerBox = header.getBoundingClientRect();
    const stickyBox = stickyElement.getBoundingClientRect();
    const promptBox = nextPromptElement.getBoundingClientRect();
    return {
      headerGap: stickyBox.top - headerBox.bottom,
      promptGap: promptBox.top - stickyBox.bottom,
    };
  });

  if (gaps) {
    expect(gaps.headerGap).toBeGreaterThanOrEqual(0);
    expect(gaps.promptGap).toBeGreaterThanOrEqual(0);
  }

  await list.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event('scroll'));
  });

  await expect(sticky).toBeVisible();
  await expect(nextPrompt).toBeVisible();
});

test('model picker does not paint behind the sticky prompt', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=sticky-preview');

  const list = page.locator('.interactive-list');
  const sticky = page.locator('.latest-user-message-sticky');
  await list.evaluate((element) => {
    const nextPrompt = element.querySelector(
      '[data-msg-id="message-sticky-user-2"] .user-message-card'
    );
    if (!nextPrompt) throw new Error('Next prompt is not mounted');
    element.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
    element.scrollTop +=
      nextPrompt.getBoundingClientRect().top -
      element.getBoundingClientRect().top -
      element.clientHeight -
      20;
    element.dispatchEvent(new Event('scroll'));
  });
  await expect(sticky).toBeVisible();

  await page.locator('.model-picker-btn').click();
  const menu = page.locator('.dropdown-menu');
  await expect(menu).toBeVisible();

  const paintOrder = await page.evaluate(() => {
    const menuElement = document.querySelector<HTMLElement>('.dropdown-menu');
    const stickyElement = document.querySelector<HTMLElement>('.latest-user-message-sticky');
    if (!menuElement || !stickyElement) throw new Error('Layered surfaces are missing');

    const menuBox = menuElement.getBoundingClientRect();
    const stickyBox = stickyElement.getBoundingClientRect();
    const overlapLeft = Math.max(menuBox.left, stickyBox.left);
    const overlapRight = Math.min(menuBox.right, stickyBox.right);
    const overlapTop = Math.max(menuBox.top, stickyBox.top);
    const overlapBottom = Math.min(menuBox.bottom, stickyBox.bottom);
    const overlapWidth = overlapRight - overlapLeft;
    const overlapHeight = overlapBottom - overlapTop;
    const surfacesOverlap = overlapWidth > 0 && overlapHeight > 0;
    const topElement = surfacesOverlap
      ? document.elementFromPoint(
          overlapLeft + overlapWidth / 2,
          overlapTop + overlapHeight / 2
        )
      : null;

    return {
      dropdownIsNotObscured: !surfacesOverlap || !!topElement?.closest('.dropdown-menu'),
    };
  });

  expect(paintOrder.dropdownIsNotObscured).toBe(true);
});

test('sticky preview follows live prompt geometry when the assistant row grows', async ({
  page,
}) => {
  await page.goto('/e2e/harness/index.html?scenario=sticky-preview');

  const list = page.locator('.interactive-list');
  const sticky = page.locator('.latest-user-message-sticky');
  const nextPrompt = page.locator('[data-msg-id="message-sticky-user-2"] .user-message-card');

  await page.locator('[data-msg-id="message-sticky-assistant-2"]').evaluate((row) => {
    row.setAttribute('style', 'padding-bottom: 600px');
  });
  await list.evaluate((element) => {
    element.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
    element.scrollTop = Math.max(0, element.scrollTop - 100);
    element.dispatchEvent(new Event('scroll'));
  });
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  );
  await list.evaluate((element) => {
    const prompt = element.querySelector(
      '[data-msg-id="message-sticky-user-2"] .user-message-card'
    );
    if (!prompt) throw new Error('Next prompt is not mounted');
    element.scrollTop +=
      prompt.getBoundingClientRect().top - element.getBoundingClientRect().top - 70;
    element.dispatchEvent(new Event('scroll'));
  });
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  await expect
    .poll(() =>
      nextPrompt.evaluate((prompt) => {
        const scrollList = prompt.closest('.interactive-list');
        if (!scrollList) throw new Error('Message list is missing');
        return prompt.getBoundingClientRect().top - scrollList.getBoundingClientRect().top;
      })
    )
    .toBeCloseTo(70, 0);
  await expect(sticky).toHaveCount(0);

  await page.locator('[data-msg-id="message-sticky-assistant-1"]').evaluate((row) => {
    row.setAttribute('style', 'padding-bottom: 700px');
  });
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  );

  const promptTop = await nextPrompt.evaluate((prompt) => {
    const scrollList = prompt.closest('.interactive-list');
    if (!scrollList) throw new Error('Message list is missing');
    return prompt.getBoundingClientRect().top - scrollList.getBoundingClientRect().top;
  });
  expect(promptTop).toBeGreaterThan(600);
  await expect(sticky).toBeVisible();
  await expect(sticky).toContainText('keep this prompt visible while the answer scrolls');
});

test('turn navigation marks the user prompt it navigates to as active', async ({ page }) => {
  await page.setViewportSize({ width: 1099, height: 800 });
  await page.goto('/e2e/harness/index.html?scenario=sticky-preview');

  const list = page.locator('.interactive-list');
  const rail = page.locator('.turn-navigation');
  const markers = page.locator('.turn-navigation-marker');
  const secondPrompt = page.locator('[data-msg-id="message-sticky-user-2"] .user-message-card');
  await expect(markers).toHaveCount(2);
  await expect(rail).toBeHidden();

  await page.setViewportSize({ width: 1100, height: 800 });
  await expect(rail).toBeVisible();
  const railClearance = await rail.evaluate((element) => {
    const shell = element.closest<HTMLElement>('.interactive-list-shell');
    const track = shell?.querySelector<HTMLElement>('.interactive-list-track');
    if (!shell || !track) throw new Error('Message list geometry is missing');
    const shellBounds = shell.getBoundingClientRect();
    const trackBounds = track.getBoundingClientRect();
    const railBounds = element.getBoundingClientRect();
    const dotRadius = 3.5;
    const dotCenter = railBounds.left + railBounds.width / 2;
    return {
      railInset: railBounds.left - shellBounds.left,
      edgeGap: dotCenter - dotRadius - shellBounds.left,
      accentGap: trackBounds.left - dotCenter - dotRadius,
    };
  });
  expect(railClearance.railInset).toBeCloseTo(8, 0);
  expect(railClearance.accentGap).toBeGreaterThanOrEqual(railClearance.edgeGap - 1);

  await list.evaluate((element) => {
    const firstAssistant = element.querySelector<HTMLElement>(
      '[data-msg-id="message-sticky-assistant-1"] .chat-turn-content'
    );
    if (!firstAssistant) throw new Error('First assistant bubble is missing');
    element.scrollTop +=
      firstAssistant.getBoundingClientRect().top - element.getBoundingClientRect().top - 12;
    element.dispatchEvent(new Event('scroll'));
  });
  await expect(markers.nth(0)).toHaveAttribute('aria-current', 'step');

  await markers.nth(1).click();

  await expect(secondPrompt).toBeInViewport();
  await expect(markers.nth(1)).toHaveAttribute('aria-current', 'step');
  await expect(markers.nth(0)).not.toHaveAttribute('aria-current', 'step');
});

test('virtualized sticky preview remains visible through active tool layout changes', async ({
  page,
}) => {
  await page.setViewportSize({ width: 482, height: 1006 });
  await page.goto(
    '/e2e/harness/index.html?scenario=sticky-preview-large-transcript&longActiveTurn=1'
  );

  const sticky = page.locator('.latest-user-message-sticky');
  const source = page.locator('[data-msg-id="message-sticky-large-user-2"] .user-message-card');
  await expect(page.locator('.interactive-list-track')).toHaveClass(/virtualized/);
  await expect(source).toBeAttached();
  expect(
    await source.evaluate((element) => {
      const list = element.closest<HTMLElement>('.interactive-list');
      if (!list) throw new Error('Message list is missing');
      return element.getBoundingClientRect().bottom - list.getBoundingClientRect().top;
    })
  ).toBeLessThanOrEqual(0);
  await expect(sticky).toBeVisible();
  await expect(sticky).toContainText('Run a variety of virtualization verifications');
  const stickyText = await sticky.textContent();

  const samples = await page
    .locator('.interactive-list')
    .evaluate(async (element, expectedText) => {
      const sessionID = 'session-sticky-preview-large';
      const messageID = 'sticky-live-assistant';
      const reasoning = {
        id: 'sticky-live-reasoning',
        sessionID,
        messageID,
        type: 'reasoning' as const,
        text: '',
        time: { start: Date.now() },
      };
      const tool = {
        id: 'sticky-live-tool',
        sessionID,
        messageID,
        type: 'tool' as const,
        callID: 'sticky-live-tool-call',
        tool: 'bash',
        state: {
          status: 'running' as const,
          input: { command: 'npm run verification' },
          title: 'npm run verification',
          time: { start: Date.now() },
        },
      };
      // oxlint-disable-next-line unicorn/consistent-function-scoping
      const postEvent = (type: string, properties: Record<string, unknown>) => {
        window.postMessage({ type: 'server/event', payload: { type, properties } }, '*');
      };
      postEvent('session.status', { sessionID, status: { type: 'busy' } });
      postEvent('message.updated', {
        info: {
          id: messageID,
          sessionID,
          role: 'assistant',
          parentID: 'message-sticky-large-user-2',
          time: { created: Date.now() },
          modelID: 'model-test',
          providerID: 'provider-test',
          mode: 'primary',
          path: { cwd: '/workspace', root: '/workspace' },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      });
      postEvent('message.part.updated', { part: reasoning });
      postEvent('message.part.delta', {
        sessionID,
        messageID,
        partID: reasoning.id,
        field: 'text',
        delta: 'Analyzing the virtualized transcript.',
      });

      const result: Array<string | null> = [];
      for (let frame = 0; frame < 720; frame += 1) {
        if (frame === 180) postEvent('message.part.updated', { part: tool });
        if (frame === 360) {
          postEvent('message.part.updated', {
            part: { ...reasoning, time: { ...reasoning.time, end: Date.now() } },
          });
        }
        if (frame === 540) {
          postEvent('message.part.updated', {
            part: {
              ...tool,
              state: {
                status: 'completed',
                input: tool.state.input,
                output: 'Passed',
                title: tool.state.title,
                metadata: {},
                time: { start: tool.state.time.start, end: Date.now() },
              },
            },
          });
        }
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const current = document.querySelector<HTMLElement>('.latest-user-message-sticky');
        result.push(
          current?.textContent?.includes(expectedText || '') ? current.textContent : null
        );
      }
      return result;
    }, stickyText);

  expect(
    samples.every((sample) => sample !== null),
    JSON.stringify(samples)
  ).toBe(true);
  await expect(sticky).toBeVisible();
});

test('first image prompt keeps its sticky preview until the source clears the overlay', async ({
  page,
}) => {
  await page.setViewportSize({ width: 486, height: 800 });
  await page.goto('/e2e/harness/index.html?scenario=sticky-preview-first-image&windowed=1');

  const list = page.locator('.interactive-list');
  const sticky = page.locator('.latest-user-message-sticky');
  await expect(sticky).toBeVisible();

  const result = await list.evaluate(async (element) => {
    const sourceSelector = '[data-msg-id="message-sticky-first-image-user"] .user-message-card';
    let sawSticky = false;
    let maxVisibleSourceHeight = 0;
    let maxSourceBeyondOverlay = 0;
    let lastStickyTop = 0;
    let lastStickyBottom = 0;
    for (let frame = 0; frame < 1_000; frame += 1) {
      const source = document.querySelector<HTMLElement>(sourceSelector);
      const listTop = element.getBoundingClientRect().top;
      const nearSource = !!source && source.getBoundingClientRect().bottom > listTop - 300;
      const delta = nearSource ? 2 : 80;
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -delta, bubbles: true }));
      element.scrollTop = Math.max(0, element.scrollTop - delta);
      element.dispatchEvent(new Event('scroll'));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

      const overlay = document.querySelector<HTMLElement>('.latest-user-message-sticky-overlay');
      const currentSource = document.querySelector<HTMLElement>(sourceSelector);
      if (overlay?.textContent?.includes('Sticky message overlap with message containing image')) {
        sawSticky = true;
        lastStickyTop =
          document
            .querySelector<HTMLElement>('.latest-user-message-sticky')
            ?.getBoundingClientRect().top ?? 0;
        lastStickyBottom = overlay.getBoundingClientRect().bottom;
      }
      if (!sawSticky) continue;
      if (sawSticky && !overlay && !currentSource) {
        return {
          hidden: true,
          seamless: false,
          reason: 'sticky hidden before source mounted',
          maxVisibleSourceHeight,
          maxSourceBeyondOverlay,
          sawSticky,
          scrollTop: element.scrollTop,
        };
      }
      if (!currentSource) continue;

      const sourceRect = currentSource.getBoundingClientRect();
      if (!overlay) {
        return {
          hidden: true,
          seamless: sourceRect.bottom >= lastStickyBottom - 4,
          reason:
            sourceRect.bottom >= lastStickyBottom - 4
              ? 'source cleared overlay'
              : 'sticky hidden before source cleared overlay',
          maxVisibleSourceHeight,
          maxSourceBeyondOverlay,
          sawSticky,
          scrollTop: element.scrollTop,
        };
      }
      if (sourceRect.bottom > listTop) {
        maxVisibleSourceHeight = Math.max(maxVisibleSourceHeight, sourceRect.bottom - listTop);
      }
      maxSourceBeyondOverlay = Math.max(
        maxSourceBeyondOverlay,
        sourceRect.bottom - overlay.getBoundingClientRect().bottom
      );
    }

    return {
      hidden: !document.querySelector('.latest-user-message-sticky-overlay'),
      seamless: false,
      maxVisibleSourceHeight,
      maxSourceBeyondOverlay,
      sawSticky,
      scrollTop: element.scrollTop,
      sourceTop: document.querySelector<HTMLElement>(sourceSelector)?.getBoundingClientRect().top,
      lastStickyTop,
      lastStickyBottom,
    };
  });

  expect(result.sawSticky, JSON.stringify(result)).toBe(true);
  expect(result.seamless, JSON.stringify(result)).toBe(true);
  expect(result.hidden, JSON.stringify(result)).toBe(true);
  expect(result.maxVisibleSourceHeight, JSON.stringify(result)).toBeGreaterThan(0);
  expect(result.maxSourceBeyondOverlay, JSON.stringify(result)).toBeLessThanOrEqual(0);
});

test('image sticky remains stable after a fractional upward wheel tick reveals its source', async ({
  page,
}) => {
  await page.setViewportSize({ width: 486, height: 800 });
  await page.goto('/e2e/harness/index.html?scenario=sticky-preview-first-image&windowed=1');

  const list = page.locator('.interactive-list');
  const sticky = page.locator('.latest-user-message-sticky');
  await expect(sticky).toContainText('A later image prompt');

  const result = await list.evaluate(async (element) => {
    const sourceSelector = '[data-msg-id="message-sticky-later-image-user"] .user-message-card';
    for (let frame = 0; frame < 200; frame += 1) {
      const source = document.querySelector<HTMLElement>(sourceSelector);
      const listTop = element.getBoundingClientRect().top;
      if (source && source.getBoundingClientRect().bottom <= listTop) {
        const targetBottom = listTop - 0.5;
        element.scrollTop += source.getBoundingClientRect().bottom - targetBottom;
        element.dispatchEvent(new Event('scroll'));
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        let settledSource = document.querySelector<HTMLElement>(sourceSelector);
        if (!settledSource) continue;
        element.scrollTop += settledSource.getBoundingClientRect().bottom - targetBottom;
        element.dispatchEvent(new Event('scroll'));
        settledSource = document.querySelector<HTMLElement>(sourceSelector);
        if (!settledSource) continue;
        const sourceBottomBefore = settledSource.getBoundingClientRect().bottom;
        const delta = 0.75;
        element.dispatchEvent(new WheelEvent('wheel', { deltaY: -delta, bubbles: true }));
        element.scrollTop = Math.max(0, element.scrollTop - delta);
        element.dispatchEvent(new Event('scroll'));
        const sourceBottomAfter = settledSource.getBoundingClientRect().bottom;
        let stickyVisibleFrames = 0;
        for (let settleFrame = 0; settleFrame < 6; settleFrame += 1) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          if (document.querySelector('.latest-user-message-sticky-overlay')) {
            stickyVisibleFrames += 1;
          }
        }
        return {
          sourceBottomBefore,
          sourceBottomAfter,
          listTop,
          stickyVisible: !!document.querySelector('.latest-user-message-sticky-overlay'),
          stickyVisibleFrames,
        };
      }

      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -20, bubbles: true }));
      element.scrollTop = Math.max(0, element.scrollTop - 20);
      element.dispatchEvent(new Event('scroll'));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    return null;
  });

  expect(result).not.toBeNull();
  expect(result?.sourceBottomBefore).toBeLessThanOrEqual(result?.listTop ?? 0);
  expect(result?.sourceBottomAfter).toBeGreaterThanOrEqual(
    result?.listTop ?? Number.POSITIVE_INFINITY
  );
  expect(result?.stickyVisible, JSON.stringify(result)).toBe(true);
  expect(result?.stickyVisibleFrames, JSON.stringify(result)).toBe(6);
});

test('previous sticky returns during slow upward scrolling after the image prompt clears it', async ({
  page,
}) => {
  await page.setViewportSize({ width: 486, height: 800 });
  await page.goto('/e2e/harness/index.html?scenario=sticky-preview-first-image&windowed=1');

  const list = page.locator('.interactive-list');
  const sticky = page.locator('.latest-user-message-sticky');
  await expect(sticky).toContainText('A later image prompt');

  const result = await list.evaluate(async (element) => {
    const selector = '[data-msg-id="message-sticky-later-image-user"] .user-message-card';
    let source: HTMLElement | null = null;
    for (let frame = 0; frame < 200; frame += 1) {
      source = document.querySelector<HTMLElement>(selector);
      if (source) break;

      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -20, bubbles: true }));
      element.scrollTop = Math.max(0, element.scrollTop - 20);
      element.dispatchEvent(new Event('scroll'));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    if (!source) return null;

    const initialListRect = element.getBoundingClientRect();
    const overlay = document.querySelector<HTMLElement>('.latest-user-message-sticky-overlay');
    const stickyText = overlay?.querySelector<HTMLElement>('.latest-user-message-sticky-text');
    if (!overlay || !stickyText) return null;
    const textHeight = stickyText.getBoundingClientRect().height;
    const maximumTextHeight = Number.parseFloat(getComputedStyle(stickyText).maxHeight);
    const releaseTop =
      overlay.getBoundingClientRect().bottom -
      initialListRect.top +
      Math.max(0, maximumTextHeight - textHeight);

    element.scrollTop = Math.max(
      0,
      element.scrollTop + source.getBoundingClientRect().bottom - initialListRect.top + 4
    );
    element.dispatchEvent(new Event('scroll'));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    let safeFrames = 0;
    let previousStickyFrames = 0;
    let missingPreviousStickyFrames = 0;
    let sourceTop = Number.NEGATIVE_INFINITY;
    for (let frame = 0; frame < 300; frame += 1) {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -4, bubbles: true }));
      element.scrollTop = Math.max(0, element.scrollTop - 4);
      element.dispatchEvent(new Event('scroll'));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

      const currentSource = document.querySelector<HTMLElement>(selector);
      if (!currentSource) return null;
      sourceTop = currentSource.getBoundingClientRect().top - element.getBoundingClientRect().top;
      if (sourceTop > releaseTop + 8) {
        safeFrames += 1;
        const visibleStickyText = document.querySelector<HTMLElement>(
          '.latest-user-message-sticky-overlay'
        )?.textContent;
        if (visibleStickyText?.includes('Sticky message overlap with message containing image')) {
          previousStickyFrames += 1;
        } else if (safeFrames > 2) {
          missingPreviousStickyFrames += 1;
        }
      }
      if (sourceTop >= releaseTop + 120) break;
    }

    return {
      missingPreviousStickyFrames,
      previousStickyFrames,
      releaseTop,
      safeFrames,
      sourceTop,
    };
  });

  expect(result).not.toBeNull();
  expect(result?.sourceTop).toBeGreaterThan((result?.releaseTop ?? 0) + 100);
  expect(result?.safeFrames).toBeGreaterThan(20);
  expect(result?.previousStickyFrames, JSON.stringify(result)).toBeGreaterThan(0);
  expect(result?.missingPreviousStickyFrames, JSON.stringify(result)).toBe(0);
  await expect(sticky).toBeVisible();
  await expect(sticky).toContainText('Sticky message overlap with message containing image');
});

test('sticky collision handoff does not blink across user message render variants', async ({
  page,
}) => {
  await page.setViewportSize({ width: 486, height: 800 });
  await page.goto('/e2e/harness/index.html?scenario=sticky-preview-render-variants');

  const list = page.locator('.interactive-list');
  const variants = ['plain', 'markdown', 'svg', 'terminal', 'selection', 'image', 'agent'];

  for (const variant of variants) {
    const messageId = `message-sticky-variant-${variant}-user`;
    const result = await list.evaluate(async (element, targetId) => {
      const selector = `[data-msg-id="${targetId}"] .user-message-card`;
      const source = document.querySelector<HTMLElement>(selector);
      if (!source) return { error: 'source missing' };

      element.scrollTop +=
        source.getBoundingClientRect().bottom - element.getBoundingClientRect().top + 8;
      element.dispatchEvent(new Event('scroll'));
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      );

      const initialOverlay = document.querySelector<HTMLElement>(
        `.latest-user-message-sticky-overlay[data-sticky-msg-id="${targetId}"]`
      );
      if (!initialOverlay) return { error: 'sticky missing' };

      let hidden = false;
      let reappeared = false;
      let prematureHide = false;
      let maxSourceBeyondOverlay = Number.NEGATIVE_INFINITY;
      let lastOverlayBottom = initialOverlay.getBoundingClientRect().bottom;
      const visibility: boolean[] = [];

      for (let frame = 0; frame < 160; frame += 1) {
        element.dispatchEvent(new WheelEvent('wheel', { deltaY: -4, bubbles: true }));
        element.scrollTop = Math.max(0, element.scrollTop - 4);
        element.dispatchEvent(new Event('scroll'));
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

        const currentSource = document.querySelector<HTMLElement>(selector);
        if (!currentSource) return { error: 'source unmounted' };
        const overlay = document.querySelector<HTMLElement>(
          `.latest-user-message-sticky-overlay[data-sticky-msg-id="${targetId}"]`
        );
        const sourceRect = currentSource.getBoundingClientRect();
        const isVisible = !!overlay;
        visibility.push(isVisible);

        if (overlay) {
          const overlayBottom = overlay.getBoundingClientRect().bottom;
          lastOverlayBottom = overlayBottom;
          maxSourceBeyondOverlay = Math.max(
            maxSourceBeyondOverlay,
            sourceRect.bottom - overlayBottom
          );
          if (hidden) reappeared = true;
        } else if (!hidden) {
          hidden = true;
          prematureHide = sourceRect.bottom < lastOverlayBottom - 1;
        }

        if (hidden && sourceRect.top > lastOverlayBottom + 8) break;
      }

      return {
        hidden,
        maxSourceBeyondOverlay,
        prematureHide,
        reappeared,
        transitions: visibility.reduce(
          (count, visible, index) =>
            index > 0 && visibility[index - 1] !== visible ? count + 1 : count,
          0
        ),
      };
    }, messageId);

    expect(result, variant).not.toHaveProperty('error');
    expect(result.hidden, JSON.stringify({ variant, result })).toBe(true);
    expect(result.prematureHide, JSON.stringify({ variant, result })).toBe(false);
    expect(result.reappeared, JSON.stringify({ variant, result })).toBe(false);
    expect(result.transitions, JSON.stringify({ variant, result })).toBe(1);
    expect(result.maxSourceBeyondOverlay, JSON.stringify({ variant, result })).toBeLessThanOrEqual(0);
  }
});

test('active streaming never covers the mounted first prompt with a sticky copy', async ({ page }) => {
  await page.setViewportSize({ width: 486, height: 800 });
  await page.goto(
    '/e2e/harness/index.html?scenario=sticky-preview-large-transcript&longActiveTurn=1'
  );

  const list = page.locator('.interactive-list');
  const firstPrompt = page.locator(
    '[data-msg-id="message-sticky-large-history-user"] .user-message-card'
  );
  await list.evaluate((element) => {
    element.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
    element.scrollTop = 0;
    element.dispatchEvent(new Event('scroll'));
  });
  await expect(firstPrompt).toBeInViewport();
  await expect(page.locator('.latest-user-message-sticky-overlay')).toHaveCount(0);
  await page.waitForTimeout(600);

  const samples = await page.evaluate(async () => {
    const sessionID = 'session-sticky-preview-large';
    const messageID = 'message-sticky-first-prompt-live-assistant';
    // oxlint-disable-next-line unicorn/consistent-function-scoping
    const postEvent = (type: string, properties: Record<string, unknown>) => {
      window.postMessage({ type: 'server/event', payload: { type, properties } }, '*');
    };
    postEvent('session.status', { sessionID, status: { type: 'busy' } });
    postEvent('message.updated', {
      info: {
        id: messageID,
        sessionID,
        role: 'assistant',
        parentID: 'message-sticky-large-user-2',
        time: { created: Date.now() },
        modelID: 'model-test',
        providerID: 'provider-test',
        mode: 'primary',
        path: { cwd: '/workspace', root: '/workspace' },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    });
    postEvent('message.part.updated', {
      part: {
        id: `${messageID}-text`,
        sessionID,
        messageID,
        type: 'text',
        text: 'Streaming below the viewport must not cover the mounted first prompt.',
      },
    });

    const result: Array<{
      firstPromptBottom: number | null;
      listTop: number;
      stickyVisible: boolean;
    }> = [];
    for (let frame = 0; frame < 60; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const scrollList = document.querySelector<HTMLElement>('.interactive-list')!;
      const source = document.querySelector<HTMLElement>(
        '[data-msg-id="message-sticky-large-history-user"] .user-message-card'
      );
      result.push({
        firstPromptBottom: source?.getBoundingClientRect().bottom ?? null,
        listTop: scrollList.getBoundingClientRect().top,
        stickyVisible: !!document.querySelector('.latest-user-message-sticky-overlay'),
      });
    }
    return result;
  });

  expect(samples.some((sample) => sample.firstPromptBottom !== null), JSON.stringify(samples)).toBe(
    true
  );
  expect(
    samples.every(
      (sample) =>
        sample.firstPromptBottom === null ||
        sample.firstPromptBottom <= sample.listTop ||
        !sample.stickyVisible
    ),
    JSON.stringify(samples)
  ).toBe(true);

  const slowApproach = await list.evaluate(async (element) => {
    element.dispatchEvent(new WheelEvent('wheel', { deltaY: 300, bubbles: true }));
    element.scrollTop = 300;
    element.dispatchEvent(new Event('scroll'));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    const result: Array<{
      firstPromptTop: number | null;
      listTop: number;
      scrollTop: number;
      stickyVisible: boolean;
    }> = [];
    for (let frame = 0; frame < 80; frame += 1) {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -4, bubbles: true }));
      element.scrollTop = Math.max(0, element.scrollTop - 4);
      element.dispatchEvent(new Event('scroll'));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const source = document.querySelector<HTMLElement>(
        '[data-msg-id="message-sticky-large-history-user"] .user-message-card'
      );
      result.push({
        firstPromptTop: source?.getBoundingClientRect().top ?? null,
        listTop: element.getBoundingClientRect().top,
        scrollTop: element.scrollTop,
        stickyVisible: !!document.querySelector('.latest-user-message-sticky-overlay'),
      });
      if (element.scrollTop === 0) break;
    }
    return result;
  });
  expect(slowApproach.at(-1)?.scrollTop, JSON.stringify(slowApproach)).toBe(0);
  expect(
    slowApproach.every(
      (sample) =>
        sample.firstPromptTop === null ||
        sample.firstPromptTop < sample.listTop ||
        !sample.stickyVisible
    ),
    JSON.stringify(slowApproach)
  ).toBe(true);
});

test('virtualized long sticky preview yields while scrolling at narrow width', async ({ page }) => {
  await page.setViewportSize({ width: 460, height: 800 });
  await page.goto('/e2e/harness/index.html?scenario=sticky-preview-large-transcript');

  const list = page.locator('.interactive-list');
  const nextPromptSelector = '[data-msg-id="message-sticky-large-user-2"] .user-message-card';
  const nextPrompt = page.locator(nextPromptSelector);
  await expect(page.locator('.interactive-list-track')).toHaveClass(/virtualized/);
  await expect(nextPrompt).toBeAttached();

  await list.evaluate((element, selector) => {
    const prompt = element.querySelector(selector);
    if (!prompt) throw new Error('Next prompt is not mounted');
    element.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
    element.scrollTop +=
      prompt.getBoundingClientRect().top -
      element.getBoundingClientRect().top -
      element.clientHeight -
      100;
    element.dispatchEvent(new Event('scroll'));
  }, nextPromptSelector);

  const result = await list.evaluate(async (element, selector) => {
    let sawSticky = false;
    let lastSafeGap: number | null = null;
    for (let frame = 0; frame < 1_000; frame += 1) {
      element.scrollTop += 4;
      element.dispatchEvent(new Event('scroll'));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

      const overlay = document.querySelector<HTMLElement>('.latest-user-message-sticky-overlay');
      const prompt = document.querySelector<HTMLElement>(selector);
      if (!prompt)
        return {
          overlap: true,
          stickyHidden: false,
          sawSticky,
          hideGapFromOverlay: null,
          reason: 'next prompt unmounted',
        };
      if (!overlay) {
        if (sawSticky) {
          return {
            overlap: false,
            stickyHidden: true,
            sawSticky,
            hideGapFromOverlay: lastSafeGap,
          };
        }
        continue;
      }
      sawSticky = true;

      const overlayBottom = overlay.getBoundingClientRect().bottom;
      const promptTop = prompt.getBoundingClientRect().top;
      const gap = promptTop - overlayBottom;
      if (promptTop < overlayBottom) {
        return {
          overlap: true,
          stickyHidden: false,
          sawSticky,
          hideGapFromOverlay: gap,
          overlayBottom,
          promptTop,
        };
      }
      lastSafeGap = gap;
    }
    return {
      overlap: false,
      stickyHidden: false,
      sawSticky,
      hideGapFromOverlay: null,
    };
  }, nextPromptSelector);

  expect(result.overlap, JSON.stringify(result)).toBe(false);
  expect(result.sawSticky, JSON.stringify(result)).toBe(true);
  expect(result.stickyHidden, JSON.stringify(result)).toBe(true);
  expect(result.hideGapFromOverlay, JSON.stringify(result)).not.toBeNull();
  expect(result.hideGapFromOverlay ?? Number.NEGATIVE_INFINITY).toBeGreaterThan(0);
  expect(result.hideGapFromOverlay ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(13);
  await expect(nextPrompt).toContainText('Continue if you have next steps');
});

test('sticky preview yields before a synthetic compaction boundary', async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 800 });
  await page.goto('/e2e/harness/index.html?scenario=sticky-preview-large-transcript');

  const list = page.locator('.interactive-list');
  const compactionSelector = '[data-msg-id="message-sticky-large-compaction-user"]';
  await expect(page.locator(compactionSelector)).toBeAttached();
  await page.locator('[data-msg-id="message-sticky-large-assistant-1"]').evaluate((row) => {
    (row as HTMLElement).style.paddingBottom = '80px';
  });
  await list.evaluate((element, selector) => {
    const compaction = element.querySelector(selector);
    if (!compaction) throw new Error('Compaction boundary is not mounted');
    element.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
    element.scrollTop +=
      compaction.getBoundingClientRect().top -
      element.getBoundingClientRect().top -
      element.clientHeight -
      100;
    element.dispatchEvent(new Event('scroll'));
  }, compactionSelector);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
      )
  );
  await expect(page.locator(compactionSelector)).toBeAttached();
  await list.evaluate(async (element, selector) => {
    let stableFrames = 0;
    for (let frame = 0; frame < 30; frame += 1) {
      const compaction = element.querySelector<HTMLElement>(selector);
      if (!compaction) throw new Error('Compaction boundary is not mounted');
      const delta =
        compaction.getBoundingClientRect().top - element.getBoundingClientRect().top - 140;
      if (Math.abs(delta) < 1) {
        stableFrames += 1;
        if (stableFrames >= 4) return;
      } else {
        stableFrames = 0;
        element.scrollTop += delta;
        element.dispatchEvent(new Event('scroll'));
      }
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, compactionSelector);
  await expect(page.locator('.latest-user-message-sticky-overlay')).toBeVisible();
  const setupGeometry = await list.evaluate((element, selector) => {
    const compaction = document.querySelector<HTMLElement>(selector);
    const source = document.querySelector<HTMLElement>(
      '[data-msg-id="message-sticky-large-user-1"] .user-message-card'
    );
    const overlay = document.querySelector<HTMLElement>('.latest-user-message-sticky-overlay');
    const listTop = element.getBoundingClientRect().top;
    return {
      compactionTop: compaction ? compaction.getBoundingClientRect().top - listTop : null,
      sourceBottom: source ? source.getBoundingClientRect().bottom - listTop : null,
      stickyBottom: overlay ? overlay.getBoundingClientRect().bottom - listTop : null,
    };
  }, compactionSelector);
  expect(setupGeometry.stickyBottom, JSON.stringify(setupGeometry)).not.toBeNull();

  const result = await list.evaluate(async (element, selector) => {
    const initialOverlay = document.querySelector<HTMLElement>(
      '.latest-user-message-sticky-overlay'
    );
    const initialCompaction = document.querySelector<HTMLElement>(selector);
    let sawSticky = !!initialOverlay;
    let lastSafeGap =
      initialOverlay && initialCompaction
        ? initialCompaction.getBoundingClientRect().top -
          initialOverlay.getBoundingClientRect().bottom
        : null;
    for (let frame = 0; frame < 100; frame += 1) {
      element.scrollTop += 32;
      element.dispatchEvent(new Event('scroll'));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

      const overlay = document.querySelector<HTMLElement>('.latest-user-message-sticky-overlay');
      const compaction = document.querySelector<HTMLElement>(selector);
      if (!compaction) return { overlap: true, sawSticky, lastSafeGap, reason: 'unmounted' };
      if (!overlay) {
        if (sawSticky) return { overlap: false, sawSticky, lastSafeGap };
        continue;
      }
      sawSticky = true;
      const gap = compaction.getBoundingClientRect().top - overlay.getBoundingClientRect().bottom;
      if (gap < 0) return { overlap: true, sawSticky, lastSafeGap, gap };
      lastSafeGap = gap;
    }
    return { overlap: false, sawSticky, lastSafeGap, reason: 'sticky remained' };
  }, compactionSelector);

  expect(result.sawSticky, JSON.stringify(result)).toBe(true);
  expect(result.overlap, JSON.stringify(result)).toBe(false);
  expect(result.lastSafeGap, JSON.stringify(result)).not.toBeNull();
  expect(Math.abs(result.lastSafeGap ?? Number.POSITIVE_INFINITY)).toBeLessThanOrEqual(24);
});

test('sticky and visible-row geometry survive inline-file-change values and width reflow', async ({
  page,
}) => {
  await page.setViewportSize({ width: 800, height: 900 });
  await page.goto('/e2e/harness/index.html?scenario=diff-preview-large-transcript&multiFileDiff=1');
  const list = page.locator('.interactive-list');
  await list.evaluate((element) => {
    element.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
    element.scrollTop = element.scrollHeight * 0.55;
    element.dispatchEvent(new Event('scroll'));
  });
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  );
  const layouts = [
    { inline: true, width: 720 },
    { inline: false, width: 480 },
    { inline: true, width: 360 },
    { inline: false, width: 720 },
  ];
  for (const layout of layouts) {
    await page.evaluate((nextLayout) => {
      const initial = (
        window as Window & {
          __initialWebviewState?: {
            desktopSessionPaneSide?: 'left' | 'right';
            defaultPermissionMode?: 'default' | 'edits' | 'auto' | 'full';
          };
        }
      ).__initialWebviewState;
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'config/update',
            payload: {
              showInlineFileChanges: nextLayout.inline,
              showChangedFiles: false,
              desktopSessionPaneSide: initial?.desktopSessionPaneSide ?? 'right',
              defaultPermissionMode: initial?.defaultPermissionMode ?? 'auto',
            },
          },
        })
      );
      const shell = document.querySelector<HTMLElement>('.chat-main-column-shell');
      if (!shell) throw new Error('Chat shell is missing');
      shell.style.maxWidth = 'none';
      shell.style.width = `${nextLayout.width}px`;
    }, layout);

    const samples = await list.evaluate(async (element) => {
      const result: Array<{
        stickyTop: number | null;
        collisionGap: number | null;
        mountedRows: number;
      }> = [];
      for (let frame = 0; frame < 12; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const listRect = element.getBoundingClientRect();
        const overlay = document.querySelector<HTMLElement>('.latest-user-message-sticky-overlay');
        const nextPrompt = [...element.querySelectorAll<HTMLElement>('.user-message-card')].find(
          (candidate) => candidate.getBoundingClientRect().top > listRect.top
        );
        result.push({
          stickyTop: overlay ? overlay.getBoundingClientRect().top - listRect.top : null,
          collisionGap:
            overlay && nextPrompt
              ? nextPrompt.getBoundingClientRect().top - overlay.getBoundingClientRect().bottom
              : null,
          mountedRows: element.querySelectorAll('[data-msg-id]').length,
        });
      }
      return result;
    });

    for (const sample of samples) {
      if (sample.stickyTop !== null) {
        expect(Math.abs(sample.stickyTop), JSON.stringify({ layout, sample })).toBeLessThan(1);
      }
      if (sample.collisionGap !== null) {
        expect(sample.collisionGap, JSON.stringify({ layout, sample })).toBeGreaterThanOrEqual(-1);
      }
      expect(sample.mountedRows).toBeLessThan(120);
    }

    await page.waitForTimeout(180);
    const modeAnchor = await getVisibleMessageAnchor(list);
    await list.evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -32, bubbles: true }));
      element.scrollTop -= 32;
      element.dispatchEvent(new Event('scroll'));
    });
    const movementSamples = await sampleMessageTopAcrossFrames(list, modeAnchor.id, 6);
    for (const top of movementSamples) {
      expect(top, JSON.stringify({ layout, modeAnchor, movementSamples })).not.toBeNull();
      expect(
        Math.abs(top! - (modeAnchor.top + 32)),
        JSON.stringify({ layout, modeAnchor, movementSamples })
      ).toBeLessThan(2);
    }
  }
});

test('terminal attachment sticky preview navigates to its original message', async ({ page }) => {
  await page.setViewportSize({ width: 486, height: 1064 });
  await page.goto('/e2e/harness/index.html?scenario=sticky-preview-terminal-attachment&windowed=1');

  const list = page.locator('.interactive-list');
  const sticky = page.locator('.latest-user-message-sticky');
  const terminalCard = page.locator(
    '[data-msg-id="message-sticky-terminal-user"] .user-message-card'
  );
  const laterAssistant = page.locator('[data-msg-id="message-sticky-terminal-assistant-32"]');
  await expect(page.locator('.interactive-list-track')).toHaveClass(/virtualized/);
  await expect(page.locator('[data-msg-id="message-sticky-terminal-older-user"]')).toHaveCount(0);

  await expect(laterAssistant).toBeInViewport();
  await expect(sticky).toContainText('Terminal: zsh');
  const outerScrollTop = await installOuterScrollSentinel(page);

  const clickFrames = await sticky.evaluate(async (card) => {
    (card as HTMLElement).click();
    const samples: Array<{
      scrollTop: number;
      stickyVisible: boolean;
      targetTop: number | null;
      stickyGap: number;
    }> = [];
    for (let frame = 0; frame < 30; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const scrollList = document.querySelector<HTMLElement>('.interactive-list')!;
      const target = document.querySelector<HTMLElement>(
        '[data-msg-id="message-sticky-terminal-user"] .user-message-card'
      );
      const track = scrollList.querySelector<HTMLElement>('.interactive-list-track')!;
      samples.push({
        scrollTop: scrollList.scrollTop,
        stickyVisible: !!document.querySelector('.latest-user-message-sticky-overlay'),
        targetTop: target
          ? target.getBoundingClientRect().top - scrollList.getBoundingClientRect().top
          : null,
        stickyGap: Number.parseFloat(
          getComputedStyle(track).getPropertyValue('--latest-user-message-sticky-gap')
        ),
      });
    }
    return samples;
  });
  expect(
    clickFrames.every(
      ({ stickyVisible, targetTop, stickyGap }) =>
        !stickyVisible && targetTop !== null && Math.abs(targetTop - stickyGap) <= 1
    ),
    JSON.stringify(clickFrames)
  ).toBe(true);
  await expect
    .poll(() =>
      getStickyMessageAlignment(terminalCard).then((geometry) => Math.abs(geometry.delta))
    )
    .toBeLessThanOrEqual(1);
  expect(await page.locator('#root').evaluate((root) => root.scrollTop)).toBe(outerScrollTop);
  await expect(terminalCard).toBeInViewport();

  await terminalCard.evaluate((card) => (card as HTMLElement).click());
  await expect(list).toHaveClass(/editing-message/);
  const editedRow = page.locator('[data-msg-id="message-sticky-terminal-user"]');
  await expect(page.locator('.inline-edit-composer-slot .interactive-input-part')).toBeVisible();
  // Editing owns visibility after the aligned card is clicked; this is not a sticky-gap assertion.
  await expect
    .poll(() =>
      editedRow.evaluate((row) => {
        const scrollList = row.closest<HTMLElement>('.interactive-list')!;
        return row.getBoundingClientRect().top - scrollList.getBoundingClientRect().top;
      })
    )
    .toBeGreaterThanOrEqual(0);
});
