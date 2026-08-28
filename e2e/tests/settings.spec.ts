import { expect, test } from '@playwright/test';
import { getE2EState, getVisibleMessageAnchor, sampleMessageTopAcrossFrames } from './helpers';

test('toggling /thinking hides and shows reasoning blocks', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=plan-ready&expandedActivity=1');

  const thinkingBoxes = page.locator('.chat-thinking-box');
  await expect(thinkingBoxes).toBeVisible();

  const composer = page.locator('[role="textbox"][aria-multiline="true"]').first();
  await composer.click();
  await composer.fill('/thinking');
  await page.keyboard.press('Enter');

  await expect(thinkingBoxes).toHaveCount(0);

  await composer.click();
  await composer.fill('/thinking');
  await page.keyboard.press('Enter');

  await expect(thinkingBoxes).toBeVisible();
});

test('thinking visibility preserves a detached virtualized anchor', async ({ page }) => {
  await page.goto(
    '/e2e/harness/index.html?scenario=heterogeneous-large-transcript&expandedActivity=1'
  );
  const list = page.locator('.interactive-list');
  await list.evaluate((element) => {
    element.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
    element.scrollTop = element.scrollHeight * 0.5;
    element.dispatchEvent(new Event('scroll'));
  });
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  );
  const anchor = await list.evaluate((element) => {
    const viewport = element.getBoundingClientRect();
    const candidates = Array.from(
      element.querySelectorAll<HTMLElement>(
        '[data-assistant-render-key] .rendered-markdown :is(p, li, pre, table, blockquote, h1, h2, h3, h4, h5, h6)'
      )
    ).filter((candidate) => {
      const rect = candidate.getBoundingClientRect();
      return rect.top >= viewport.top + 8 && rect.bottom <= viewport.bottom - 8;
    });
    const selected = candidates.toSorted(
      (left, right) => left.getBoundingClientRect().top - right.getBoundingClientRect().top
    )[0]!;
    const renderItem = selected.closest<HTMLElement>('[data-assistant-render-key]')!;
    const sameTag = Array.from(renderItem.querySelectorAll<HTMLElement>(selected.tagName));
    return {
      renderKey: renderItem.dataset.assistantRenderKey!,
      tag: selected.tagName.toLowerCase(),
      ordinal: sameTag.indexOf(selected),
      top: selected.getBoundingClientRect().top,
    };
  });
  const anchorElement = page
    .locator(`[data-assistant-render-key="${anchor.renderKey}"] ${anchor.tag}`)
    .nth(anchor.ordinal);
  const composer = page.locator('[role="textbox"][aria-multiline="true"]').first();

  for (const expectedThinkingCount of [0, 1]) {
    await composer.fill('/thinking');
    await page.keyboard.press('Enter');
    if (expectedThinkingCount === 0) {
      await expect(page.locator('.chat-thinking-box')).toHaveCount(0);
    } else {
      await expect.poll(() => page.locator('.chat-thinking-box').count()).toBeGreaterThan(0);
    }
    const samples = await anchorElement.evaluate(async (element) => {
      const values: number[] = [];
      for (let frame = 0; frame < 12; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        values.push(element.getBoundingClientRect().top);
      }
      return values;
    });
    for (const top of samples) {
      expect(Math.abs(top - anchor.top)).toBeLessThan(1.5);
    }
  }
});

test('chat font changes preserve main typography proportions and a detached anchor', async ({
  page,
}) => {
  await page.goto('/e2e/harness/index.html?scenario=heterogeneous-large-transcript');
  const list = page.locator('.interactive-list');
  await list.evaluate((element) => {
    element.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
    element.scrollTop = element.scrollHeight * 0.5;
    element.dispatchEvent(new Event('scroll'));
  });
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  );
  const anchor = await list.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const row = [...element.querySelectorAll<HTMLElement>('[data-msg-id]')].find((candidate) => {
      const rect = candidate.getBoundingClientRect();
      return rect.bottom > bounds.top && rect.top < bounds.bottom;
    });
    if (!row?.dataset.msgId) throw new Error('Visible message anchor is not mounted');

    const blocks = [
      ...row.querySelectorAll<HTMLElement>(
        '.rendered-markdown :is(p, li, pre, table, blockquote, h1, h2, h3, h4, h5, h6)'
      ),
    ];
    let block = blocks.find((candidate) => candidate.getBoundingClientRect().bottom > bounds.top);
    while (block && block.getBoundingClientRect().top < bounds.top) {
      const next = blocks[blocks.indexOf(block) + 1];
      if (!next || next.getBoundingClientRect().top >= bounds.bottom) break;
      block = next;
    }
    if (!block) throw new Error('Visible Markdown anchor is not mounted');

    return {
      messageId: row.dataset.msgId,
      text: block.innerText,
      top: block.getBoundingClientRect().top - bounds.top,
    };
  });
  const session = page.locator('.interactive-session');
  await session.evaluate((element) => {
    const probe = document.createElement('div');
    probe.dataset.typographyProbe = 'true';
    probe.style.position = 'fixed';
    probe.style.visibility = 'hidden';
    probe.innerHTML =
      '<div class="chat-tool-invocation-part"><button class="tool-invocation-header">Tool</button></div>';
    element.append(probe);
  });
  const markdown = page.locator('.rendered-markdown').first();
  const toolHeader = page.locator('[data-typography-probe] .tool-invocation-header');
  await expect(markdown).toBeAttached();
  await expect(toolHeader).toBeAttached();

  const before = await page.evaluate(() => {
    const sessionStyle = getComputedStyle(document.querySelector('.interactive-session')!);
    const markdownStyle = getComputedStyle(document.querySelector('.rendered-markdown')!);
    const toolStyle = getComputedStyle(
      document.querySelector('[data-typography-probe] .tool-invocation-header')!
    );
    return {
      sessionFontSize: sessionStyle.fontSize,
      markdownFontSize: markdownStyle.fontSize,
      markdownLineHeight: markdownStyle.lineHeight,
      toolFontSize: toolStyle.fontSize,
      toolLineHeight: toolStyle.lineHeight,
    };
  });
  expect(before).toEqual({
    sessionFontSize: '13px',
    markdownFontSize: '13.5px',
    markdownLineHeight: '22.275px',
    toolFontSize: '12.5px',
    toolLineHeight: '15px',
  });

  const samples = await list.evaluate(async (element, target) => {
    // SAFETY: The E2E harness owns this protocol-shaped bootstrap snapshot.
    const initial = (
      window as Window & {
        __initialWebviewState?: {
          desktopSessionPaneSide?: 'left' | 'right';
          defaultPermissionMode?: 'default' | 'edits' | 'auto' | 'full';
          chatEditorFontSize?: number;
        };
      }
    ).__initialWebviewState;
    const readTop = () => {
      const row = [...element.querySelectorAll<HTMLElement>('[data-msg-id]')].find(
        (candidate) => candidate.dataset.msgId === target.messageId
      );
      const block = [
        ...(row?.querySelectorAll<HTMLElement>(
          '.rendered-markdown :is(p, li, pre, table, blockquote, h1, h2, h3, h4, h5, h6)'
        ) ?? []),
      ].find((candidate) => candidate.innerText === target.text);
      return block?.isConnected
        ? block.getBoundingClientRect().top - element.getBoundingClientRect().top
        : null;
    };
    const result: Array<number | null> = [];
    result.push(readTop());
    window.postMessage(
      {
        type: 'config/update',
        payload: {
          desktopSessionPaneSide: initial?.desktopSessionPaneSide ?? 'left',
          defaultPermissionMode: initial?.defaultPermissionMode ?? 'default',
          chatFontSize: 17,
          chatEditorFontSize: initial?.chatEditorFontSize ?? 12,
          chatFontFamily: 'monospace',
        },
      },
      '*'
    );
    for (let frame = 0; frame < 16; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      result.push(readTop());
    }
    return result;
  }, anchor);
  await expect(session).toHaveCSS('font-size', '17px');
  await expect(session).toHaveCSS('font-family', 'monospace');
  await expect(markdown).toHaveCSS('font-size', '17.5px');
  await expect(markdown).toHaveCSS('line-height', '28.875px');
  await expect(toolHeader).toHaveCSS('font-size', '12.5px');
  await expect(toolHeader).toHaveCSS('line-height', '15px');
  for (const top of samples) {
    expect(top).not.toBeNull();
    expect(Math.abs(top! - anchor.top), JSON.stringify({ anchor, samples })).toBeLessThan(1.5);
  }
});

test('hiding thinking preserves visible markdown inside the same clipped assistant row', async ({
  page,
}) => {
  await page.goto(
    '/e2e/harness/index.html?scenario=heterogeneous-large-transcript&expandedActivity=1&tallThinkingAnchor=1'
  );
  const list = page.locator('.interactive-list');
  await list.evaluate((element) => {
    element.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
    element.scrollTop = element.scrollHeight * 0.5;
    element.dispatchEvent(new Event('scroll'));
  });
  const row = page.locator('[data-msg-id="message-heterogeneous-assistant-60-a"]');
  await expect(row).toBeAttached();
  await row.evaluate((element) => {
    const transcript = element.closest<HTMLElement>('.interactive-list')!;
    transcript.scrollTop +=
      element.getBoundingClientRect().top - transcript.getBoundingClientRect().top + 100;
    transcript.dispatchEvent(new Event('scroll'));
  });
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  );
  const anchor = row.locator('[data-assistant-render-key] .rendered-markdown li').nth(40);
  await expect(anchor).toBeAttached();
  await anchor.evaluate((element) => {
    const transcript = element.closest<HTMLElement>('.interactive-list')!;
    transcript.scrollTop +=
      element.getBoundingClientRect().top - transcript.getBoundingClientRect().top - 16;
    transcript.dispatchEvent(new Event('scroll'));
  });
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  );

  await expect(anchor).toBeVisible();
  const before = await anchor.evaluate((element) => element.getBoundingClientRect().top);
  const composer = page.locator('[role="textbox"][aria-multiline="true"]').first();
  await composer.fill('/thinking');
  await page.keyboard.press('Enter');
  await expect(row.locator('.chat-thinking-box')).toHaveCount(0);

  const samples = await anchor.evaluate(async (element) => {
    const values: number[] = [];
    for (let frame = 0; frame < 12; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      values.push(element.getBoundingClientRect().top);
    }
    return values;
  });
  for (const top of samples) {
    expect(Math.abs(top - before), JSON.stringify({ before, samples })).toBeLessThan(1.5);
  }
});

test('hiding an expanded offscreen activity group preserves the bottom viewport', async ({
  page,
}) => {
  await page.goto(
    '/e2e/harness/index.html?scenario=thinking-expanded-virtualized-anchor&expandedActivity=1'
  );
  const list = page.locator('.interactive-list');
  const summary = page.locator('.assistant-activity-summary', { hasText: '9 thoughts' });
  for (let step = 0; step <= 20 && (await summary.count()) === 0; step += 1) {
    await list.evaluate((element, ratio) => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -200, bubbles: true }));
      element.scrollTop = (element.scrollHeight - element.clientHeight) * ratio;
      element.dispatchEvent(new Event('scroll'));
    }, step / 20);
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    );
  }
  await expect(summary).toHaveAttribute('aria-expanded', 'true');
  await summary.evaluate((element) => element.scrollIntoView({ block: 'center' }));
  await expect.poll(() => page.locator('.chat-thinking-box').count()).toBe(9);
  await list.evaluate(async (element) => {
    const target = element.scrollHeight - element.clientHeight - 120;
    while (element.scrollTop < target - 1) {
      const movement = Math.min(100, target - element.scrollTop);
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: movement, bubbles: true }));
      element.scrollTop += movement;
      element.dispatchEvent(new Event('scroll'));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  });
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  );

  const anchor = await getVisibleMessageAnchor(list);
  const composer = page.locator('[role="textbox"][aria-multiline="true"]').first();
  await composer.fill('/thinking');
  await page.keyboard.press('Enter');
  await expect(page.locator('.chat-thinking-box')).toHaveCount(0);

  const samples = await sampleMessageTopAcrossFrames(list, anchor.id, 12);
  for (const top of samples) {
    expect(top).not.toBeNull();
    expect(Math.abs(top! - anchor.top), JSON.stringify({ anchor, samples })).toBeLessThan(1.5);
  }
});

test('hiding thinking after a real expansion preserves a mid-transcript anchor', async ({
  page,
}) => {
  await page.goto('/e2e/harness/index.html?scenario=thinking-expanded-virtualized-anchor');
  const list = page.locator('.interactive-list');
  const summary = page.locator('.assistant-activity-summary', { hasText: '9 thoughts' });
  await expect(summary).toHaveAttribute('aria-expanded', 'false');
  await summary.click();
  await expect.poll(() => page.locator('.chat-thinking-box').count()).toBe(9);
  await list.evaluate((element) => {
    element.dispatchEvent(new WheelEvent('wheel', { deltaY: 920, bubbles: true }));
    element.scrollTop = 920;
    element.dispatchEvent(new Event('scroll'));
  });
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  );
  const anchor = await getVisibleMessageAnchor(list);
  const composer = page.locator('[role="textbox"][aria-multiline="true"]').first();

  await composer.fill('/thinking');
  await page.keyboard.press('Enter');
  await expect(page.locator('.chat-thinking-box')).toHaveCount(0);

  const samples = await sampleMessageTopAcrossFrames(list, anchor.id, 12);
  for (const top of samples) {
    expect(top).not.toBeNull();
    expect(Math.abs(top! - anchor.top), JSON.stringify({ anchor, samples })).toBeLessThan(1.5);
  }
});

test('/thinking description reflects current visibility state', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=plan-ready&expandedActivity=1');

  const composer = page.locator('[role="textbox"][aria-multiline="true"]').first();
  await composer.click();
  await composer.fill('/thinking');

  await expect(page.getByText('Hide thinking blocks')).toBeVisible();
  await page.keyboard.press('Escape');

  await composer.click();
  await composer.fill('/thinking');
  await page.keyboard.press('Enter');

  await composer.click();
  await composer.fill('/thinking');
  await expect(page.getByText('Show thinking blocks')).toBeVisible();
});

test('thinking preference persists across reload', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=plan-ready&expandedActivity=1');

  await expect(page.locator('.chat-thinking-box')).toBeVisible();

  const composer = page.locator('[role="textbox"][aria-multiline="true"]').first();
  await composer.click();
  await composer.fill('/thinking');
  await page.keyboard.press('Enter');

  await expect(page.locator('.chat-thinking-box')).toHaveCount(0);

  await expect
    .poll(() =>
      getE2EState(page, () => ({
        showThinking: localStorage.getItem('varro.showThinking'),
      }))
    )
    .toEqual({ showThinking: 'false' });

  await page.reload();

  await expect(page.locator('.chat-thinking-box')).toHaveCount(0);

  await composer.click();
  await composer.fill('/thinking');
  await page.keyboard.press('Enter');

  await expect(page.locator('.chat-thinking-box')).toBeVisible();
});

test('sticky prompt ignores a legacy disabled preference', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('varro.showStickyUserPrompt', 'false');
  });
  await page.goto('/e2e/harness/index.html?scenario=sticky-preview');

  const list = page.locator('.interactive-list');
  await list.evaluate((el) => {
    el.scrollTop = el.scrollHeight / 2;
    el.dispatchEvent(new Event('scroll'));
  });
  await expect(page.locator('.latest-user-message-sticky')).toBeVisible();
});
