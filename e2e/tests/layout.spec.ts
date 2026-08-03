import { expect, test } from '@playwright/test';
import { getE2EState } from './helpers';

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

test('single image messages reserve their preview height before loading', async ({ page }) => {
  await page.setViewportSize({ width: 486, height: 800 });
  await page.goto('/e2e/harness/index.html?scenario=blank');
  await expect(page.locator('.interactive-session')).toBeVisible();

  const trigger = page.locator('.chat-image-preview-trigger');
  await page.locator('.interactive-session').evaluate((root) => {
    const figure = document.createElement('figure');
    figure.className = 'chat-image-figure';
    const button = document.createElement('button');
    button.className = 'chat-image-preview-trigger';
    const image = document.createElement('img');
    image.className = 'chat-image-img';
    button.append(image);
    figure.append(button);
    root.append(figure);
  });

  await expect
    .poll(() => trigger.evaluate((element) => element.getBoundingClientRect().height))
    .toBe(224);
  await trigger.locator('img').evaluate((image: HTMLImageElement) => {
    image.src =
      'data:image/svg+xml,' +
      encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="482" height="485"/>');
    return image.decode();
  });
  await expect
    .poll(() => trigger.evaluate((element) => element.getBoundingClientRect().height))
    .toBe(224);
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

  await page.getByTitle('GitHub Copilot / GPT-5 mini').click();
  await page.getByText('GPT-4.1', { exact: true }).click();
  await expect(page.getByTitle('OpenAI / GPT-4.1')).toBeVisible();

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
      if (request.type === 'api/request' && request.payload?.path?.includes('/prompt_async')) return;
      return sendToExtension(message);
    };
  });
  await page.keyboard.press('Enter');

  const row = page
    .locator('.interactive-request')
    .filter({ hasText: 'Image message appears immediately' })
    .last();
  await expect(row.locator('.chat-image-preview-trigger')).toHaveCSS('height', '224px');
  await expect(row).not.toHaveClass(/interactive-item-entering/);
  await expect
    .poll(() =>
      row.evaluate((element) => {
        const sticky = document.querySelector<HTMLElement>(
          '.latest-user-message-sticky-overlay'
        );
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

  await page.locator('.chat-main-column-shell').evaluate(async (shell) => {
    shell.style.maxWidth = 'none';
    for (let frame = 0; frame <= 20; frame += 1) {
      shell.style.width = `${760 - frame * 7}px`;
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  });
  await page.waitForTimeout(120);
  await expect(sticky).toBeVisible();
  await expect(sticky).toContainText('keep this prompt visible while the answer scrolls');

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

  expect(gaps?.headerGap).toBeGreaterThanOrEqual(0);
  expect(gaps?.promptGap).toBeGreaterThanOrEqual(0);

  await list.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event('scroll'));
  });

  await expect(sticky).toBeVisible();
  await expect(nextPrompt).toBeVisible();
});

test('model picker paints above the sticky prompt', async ({ page }) => {
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
    const topElement = document.elementFromPoint(
      overlapLeft + overlapWidth / 2,
      overlapTop + overlapHeight / 2
    );

    return {
      overlapWidth,
      overlapHeight,
      dropdownIsTopmost: !!topElement?.closest('.dropdown-menu'),
    };
  });

  expect(paintOrder.overlapWidth).toBeGreaterThan(0);
  expect(paintOrder.overlapHeight).toBeGreaterThan(0);
  expect(paintOrder.dropdownIsTopmost).toBe(true);
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

test('first image prompt dismisses its sticky preview during slow upward scrolling', async ({
  page,
}) => {
  await page.setViewportSize({ width: 486, height: 800 });
  await page.goto('/e2e/harness/index.html?scenario=sticky-preview-first-image');

  const list = page.locator('.interactive-list');
  const sticky = page.locator('.latest-user-message-sticky');
  await expect(sticky).toBeVisible();

  const result = await list.evaluate(async (element) => {
    const sourceSelector =
      '[data-msg-id="message-sticky-first-image-user"] .user-message-card';
    let sawSticky = false;
    let overlapFrames = 0;
    let maxVisibleSourceHeight = 0;
    for (let frame = 0; frame < 1_000 && element.scrollTop > 0; frame += 1) {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -2, bubbles: true }));
      element.scrollTop = Math.max(0, element.scrollTop - 2);
      element.dispatchEvent(new Event('scroll'));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

      const overlay = document.querySelector<HTMLElement>('.latest-user-message-sticky-overlay');
      const source = document.querySelector<HTMLElement>(sourceSelector);
      if (!source) return { hidden: false, overlap: true, reason: 'source prompt unmounted' };
      if (overlay) sawSticky = true;

      const listTop = element.getBoundingClientRect().top;
      const sourceBottom = source.getBoundingClientRect().bottom;
      if (sourceBottom > listTop) {
        maxVisibleSourceHeight = Math.max(maxVisibleSourceHeight, sourceBottom - listTop);
        if (overlay) overlapFrames += 1;
        else
          return {
            hidden: true,
            overlap: overlapFrames > 0,
            overlapFrames,
            maxVisibleSourceHeight,
            sawSticky,
            scrollTop: element.scrollTop,
          };
      }
    }

    return {
      hidden: !document.querySelector('.latest-user-message-sticky-overlay'),
      overlap: overlapFrames > 0,
      overlapFrames,
      maxVisibleSourceHeight,
      sawSticky,
      scrollTop: element.scrollTop,
    };
  });

  expect(result.sawSticky, JSON.stringify(result)).toBe(true);
  expect(result.overlap, JSON.stringify(result)).toBe(false);
  expect(result.hidden, JSON.stringify(result)).toBe(true);
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
    for (let frame = 0; frame < 500; frame += 1) {
      element.scrollTop += 2;
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
  expect(Math.abs(result.hideGapFromOverlay ?? Number.POSITIVE_INFINITY)).toBeLessThanOrEqual(24);
  await expect(nextPrompt).toContainText('Continue if you have next steps');
});

test('terminal attachment sticky preview navigates to its original message', async ({ page }) => {
  await page.setViewportSize({ width: 486, height: 800 });
  await page.goto('/e2e/harness/index.html?scenario=sticky-preview-terminal-attachment');

  const list = page.locator('.interactive-list');
  const sticky = page.locator('.latest-user-message-sticky');
  const terminalCard = page.locator(
    '[data-msg-id="message-sticky-terminal-user"] .user-message-card'
  );
  const laterAssistant = page.locator('[data-msg-id="message-sticky-terminal-assistant-13"]');
  await expect(page.locator('.interactive-list-track')).toHaveClass(/virtualized/);

  await list.evaluate((element) => {
    const target = document.querySelector<HTMLElement>(
      '[data-msg-id="message-sticky-terminal-assistant-13"]'
    );
    if (!target) throw new Error('Later assistant is not mounted');
    element.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
    element.scrollTop += target.getBoundingClientRect().top - element.getBoundingClientRect().top;
    element.dispatchEvent(new Event('scroll'));
  });
  await expect(laterAssistant).toBeInViewport();
  await expect(sticky).toContainText('Terminal: zsh');
  await expect(terminalCard).toHaveCount(0);

  await sticky.click();
  await expect
    .poll(() =>
      terminalCard.evaluate((card) => {
        const scrollList = card.closest<HTMLElement>('.interactive-list')!;
        return card.getBoundingClientRect().top - scrollList.getBoundingClientRect().top;
      })
    )
    .toBeGreaterThanOrEqual(6);
  await expect
    .poll(() =>
      terminalCard.evaluate((card) => {
        const scrollList = card.closest<HTMLElement>('.interactive-list')!;
        return card.getBoundingClientRect().top - scrollList.getBoundingClientRect().top;
      })
    )
    .toBeLessThanOrEqual(10);
  await expect(terminalCard).toBeInViewport();
  await page.waitForTimeout(500);
  await expect(terminalCard).toBeInViewport();

  await terminalCard.evaluate((card) => (card as HTMLElement).click());
  await expect(list).toHaveClass(/editing-message/);
  const editedRow = page.locator('[data-msg-id="message-sticky-terminal-user"]');
  await expect(page.locator('.inline-edit-composer-slot .interactive-input-part')).toBeVisible();
  await expect
    .poll(() =>
      editedRow.evaluate((row) => {
        const scrollList = row.closest<HTMLElement>('.interactive-list')!;
        return row.getBoundingClientRect().top - scrollList.getBoundingClientRect().top;
      })
    )
    .toBeGreaterThanOrEqual(6);
});
