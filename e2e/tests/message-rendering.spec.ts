/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- SAFETY: These E2E callbacks mutate protocol-shaped messages owned by the controlled harness fixture. */
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { getE2EState } from './helpers';

async function expectSelectionEdgeContinuity(
  page: Page,
  screenshot: Buffer,
  xs: number[],
  ys: number[]
): Promise<void> {
  const colors = await page.evaluate(
    async ({ png, columns, rows }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${png}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Expected screenshot canvas');
      context.drawImage(image, 0, 0);
      return rows.map((y) => columns.map((x) => Array.from(context.getImageData(x, y, 1, 1).data)));
    },
    { png: screenshot.toString('base64'), columns: xs, rows: ys }
  );
  for (const row of colors) {
    for (const color of row) expect(color).toEqual(row[0]);
  }
}

test('a pathological code line preserves text and leaves the browser event loop responsive', async ({
  page,
}) => {
  await page.goto('/e2e/harness/index.html?scenario=message-rendering');
  // Wait for the real lazy-loaded syntax parser so this cannot pass on its loading fallback.
  await expect(page.locator('.rendered-markdown .hljs-keyword').first()).toBeVisible();

  const source = `${'a'.repeat(30_000)}!<&`;
  const longestTaskGap = await page.evaluate(async (text) => {
    let lastTick = performance.now();
    let longestGap = 0;
    const ready = new Promise<number>((resolve, reject) => {
      const started = lastTick;
      const timer = setInterval(() => {
        const now = performance.now();
        longestGap = Math.max(longestGap, now - lastTick);
        lastTick = now;
        const code = document.querySelector('.rendered-markdown pre code');
        if (code?.textContent?.trimEnd() === text) {
          clearInterval(timer);
          resolve(longestGap);
        } else if (now - started > 10_000) {
          clearInterval(timer);
          reject(new Error('The replacement code block never rendered'));
        }
      }, 10);
    });
    window.postMessage(
      {
        type: 'server/event',
        payload: {
          type: 'message.part.updated',
          properties: {
            part: {
              id: 'message-rendering-assistant-part-1',
              sessionID: 'session-message-rendering',
              messageID: 'message-rendering-assistant',
              type: 'text',
              text: `\`\`\`ts\n${text}\n\`\`\``,
            },
          },
        },
      },
      '*'
    );
    return ready;
  }, source);

  expect(longestTaskGap).toBeLessThan(500);
  const block = page.locator('.rendered-markdown .interactive-result-code-block').last();
  await expect(block.locator('code')).toHaveText(source);
  await expect(block.locator('[class^="hljs-"]')).toHaveCount(0);
  expect(
    await block
      .locator('[data-copy-text]')
      .evaluate((button) => decodeURIComponent(button.getAttribute('data-copy-text') ?? ''))
  ).toBe(source.slice(0, 20_000));
  const composer = page.locator('[role="textbox"][aria-multiline="true"]').first();
  await composer.fill('Still responsive');
  await expect(composer).toHaveText('Still responsive');
});

test('opens read mode for long assistant answers and preserves rendered content', async ({
  page,
}) => {
  await page.goto('/e2e/harness/index.html?scenario=message-rendering');

  await expect(page.locator('.chat-header-title-text').first()).toHaveText(
    'Rendered message actions'
  );
  await expect(page.getByRole('link', { name: 'release notes' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy code' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open read mode' })).toHaveCount(0);

  await page.locator('.interactive-list-track').evaluate((track) => {
    track.classList.add('virtualized');
  });
  const chatContentWidth = await page
    .locator('.interactive-list-track')
    .evaluate((element) => element.getBoundingClientRect().width);
  await page.keyboard.down('Alt');
  await page.getByRole('button', { name: 'Open read mode' }).click();
  await page.keyboard.up('Alt');

  const dialog = page.getByRole('dialog', { name: 'Read mode' });
  await expect(dialog).toBeVisible();
  await expect
    .poll(() =>
      dialog.evaluate((element) => {
        const box = element.getBoundingClientRect();
        return {
          left: box.left,
          top: box.top,
          width: box.width,
          height: box.height,
          contentWidth: element
            .querySelector('.assistant-read-overlay-inner')!
            .getBoundingClientRect().width,
          insideMessageRow: element.closest('.interactive-item-container') !== null,
        };
      })
    )
    .toEqual({
      left: 0,
      top: 0,
      width: await page.evaluate(() => window.innerWidth),
      height: await page.evaluate(() => window.innerHeight),
      contentWidth: chatContentWidth,
      insideMessageRow: false,
    });
  await expect(dialog.getByText('rich assistant message controls')).toBeVisible();
  await expect(dialog.getByText("export const useful = 'e2e coverage';")).toBeVisible();

  await dialog.getByRole('button', { name: 'Exit read mode' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('[role="textbox"][aria-multiline="true"]').first()).toBeVisible();
});

test('closes read mode with escape', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=message-rendering');

  await expect(page.locator('.chat-header-title-text').first()).toHaveText(
    'Rendered message actions'
  );
  await page.keyboard.down('Alt');
  await page.getByRole('button', { name: 'Open read mode' }).click();
  await page.keyboard.up('Alt');
  const dialog = page.getByRole('dialog', { name: 'Read mode' });
  await expect(dialog).toBeVisible();

  await page.keyboard.press('Escape');

  await expect(dialog).toHaveCount(0);
  await expect(page.locator('[role="textbox"][aria-multiline="true"]').first()).toBeVisible();
});

test('keeps final-answer rails visible in virtualized transcripts', async ({ page }) => {
  await page.setViewportSize({ width: 600, height: 720 });
  await page.goto('/e2e/harness/index.html?scenario=large-transcript');

  const list = page.locator('.interactive-list');
  const track = page.locator('.interactive-list-track');
  await expect(track).toHaveClass(/virtualized/);

  const finalRow = page.locator('[data-msg-id="message-large-assistant-239"]');
  const ordinaryRow = page.locator('[data-msg-id="message-large-user-239"]');
  const finalItem = finalRow.locator('.assistant-message-flow-item-final');
  await expect(finalItem).toBeVisible();

  const containment = await finalRow.evaluate((row) => getComputedStyle(row).contain);
  const ordinaryContainment = await ordinaryRow.evaluate((row) => getComputedStyle(row).contain);
  const rail = await finalItem.evaluate((item) => {
    const style = getComputedStyle(item, '::before');
    const itemRect = item.getBoundingClientRect();
    return {
      content: style.content,
      width: style.width,
      backgroundColor: style.backgroundColor,
      left: itemRect.left + Number.parseFloat(style.left),
    };
  });
  const listLeft = await list.evaluate((element) => element.getBoundingClientRect().left);

  expect(containment).toContain('layout');
  expect(containment).not.toBe('content');
  expect(ordinaryContainment).toBe('content');
  expect(rail.content).not.toBe('none');
  expect(rail.width).toBe('1px');
  expect(rail.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
  expect(rail.left).toBeGreaterThanOrEqual(listLeft + 1);
});

test('expands prompt number badges for three-digit turns', async ({ page }) => {
  await page.setViewportSize({ width: 600, height: 720 });
  await page.goto('/e2e/harness/index.html?scenario=large-transcript');

  const finalUserRow = page.locator('[data-msg-id="message-large-user-239"]');
  await finalUserRow.locator('.user-message-card').evaluate((card) => {
    const element = document.createElement('span');
    element.className = 'prompt-number-badge';
    element.textContent = '240';
    card.prepend(element);
  });
  const badge = finalUserRow.locator('.prompt-number-badge');
  await expect(badge).toHaveText('240');

  const geometry = await badge.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return {
      width: box.width,
      height: box.height,
      contentFits: element.scrollWidth <= element.clientWidth,
    };
  });

  expect(geometry.width).toBeGreaterThan(geometry.height);
  expect(geometry.contentFits).toBe(true);
});

test('routes safe external markdown links through the extension bridge', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=message-rendering');

  await page.getByRole('link', { name: 'release notes' }).click();

  await expect
    .poll(() =>
      getE2EState(page, () => {
        const value = (
          window as Window & {
            __varroE2E?: { externalUrls?: string[] };
          }
        ).__varroE2E;
        return value?.externalUrls || [];
      })
    )
    .toEqual(['https://example.com/varro/releases']);
});

test('renders real-session explicit and inferred file links', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=message-rendering');
  // Wait for syntax highlighting to finish replacing the initial markdown before focusing links.
  await expect(page.locator('.rendered-markdown .hljs-keyword').first()).toBeVisible();

  const links = page.locator('.rendered-markdown a.file-path-link');
  await expect(links).toHaveCount(10);
  await expect(links).toHaveText([
    'global.d.ts',
    'README.md',
    'LICENSE',
    '.gitignore',
    'Dockerfile',
    'index.css',
    'scripts/vscode-sandbox/suite.cjs',
    '.oxlintrc.json',
    'docs/architecture.md',
    'MarkdownRenderer.tsx (line 1447)',
  ]);
  await expect(links.locator('code')).toHaveCount(0);
  await expect(page.locator('.assistant-message-flow-item > .rendered-markdown')).not.toContainText(
    '`'
  );

  const readme = page.getByRole('link', { name: 'README.md' });
  const license = page.getByRole('link', { name: 'LICENSE' });
  await expect(readme).toHaveAttribute('href', '/workspace/varro/README.md');
  await expect(readme).not.toHaveAttribute('title');
  await readme.focus();
  const tooltip = page.getByRole('tooltip');
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toHaveText('/workspace/varro/README.md');
  await expect(readme).toHaveAccessibleDescription('/workspace/varro/README.md');
  await expect
    .poll(() => readme.evaluate((element) => getComputedStyle(element).outlineStyle))
    .toBe('none');
  await readme.click({ button: 'right' });
  await expect
    .poll(() => readme.evaluate((element) => getComputedStyle(element).outlineStyle))
    .toBe('none');

  const hoverTargets = [
    'scripts/vscode-sandbox/suite.cjs',
    'docs/architecture.md',
    '.oxlintrc.json',
  ];
  for (const name of hoverTargets) {
    await page.getByRole('link', { name }).hover();
    await expect
      .poll(() =>
        links.evaluateAll((elements) =>
          elements
            .filter((element) => getComputedStyle(element).borderBottomColor !== 'rgba(0, 0, 0, 0)')
            .map((element) => element.textContent)
        )
      )
      .toEqual([name]);
  }

  await expect(license).toHaveCSS('border-bottom-color', 'rgba(0, 0, 0, 0)');

  const missingCode = page.locator('code.citation-path').filter({ hasText: 'missing-file.ts' });
  await expect(missingCode).toBeVisible();
  await expect(missingCode.locator('.file-path-icon')).toBeVisible();
  await expect
    .poll(() =>
      missingCode
        .locator('img.file-path-icon')
        .evaluate((icon: HTMLImageElement) => icon.naturalWidth)
    )
    .toBeGreaterThan(0);
  await expect(missingCode).not.toHaveAttribute('href', /.+/);
  const openCountAfterFailure = await getE2EState(page, () => {
    const value = (
      window as Window & {
        __varroE2E?: { openTargets?: Array<{ path: string }> };
      }
    ).__varroE2E;
    return value?.openTargets?.length ?? 0;
  });
  await missingCode.click();
  await expect
    .poll(() =>
      getE2EState(page, () => {
        const value = (
          window as Window & {
            __varroE2E?: { openTargets?: Array<{ path: string }> };
          }
        ).__varroE2E;
        return value?.openTargets?.length ?? 0;
      })
    )
    .toBe(openCountAfterFailure);

  const lineReference = page.getByRole('link', { name: 'MarkdownRenderer.tsx (line 1447)' });
  await lineReference.click();
  await expect
    .poll(() =>
      getE2EState(page, () => {
        const value = (
          window as Window & {
            __varroE2E?: { openTargets?: Array<{ path: string; kind?: string; line?: number }> };
          }
        ).__varroE2E;
        return value?.openTargets || [];
      })
    )
    .toEqual([
      {
        path: '/workspace/varro/src/webview/components/MarkdownRenderer.tsx',
        kind: 'file',
        line: 1447,
      },
    ]);

  await readme.click();
  await expect
    .poll(() =>
      getE2EState(page, () => {
        const value = (
          window as Window & {
            __varroE2E?: { openTargets?: Array<{ path: string; kind?: string; line?: number }> };
          }
        ).__varroE2E;
        return value?.openTargets || [];
      })
    )
    .toEqual([
      {
        path: '/workspace/varro/src/webview/components/MarkdownRenderer.tsx',
        kind: 'file',
        line: 1447,
      },
      { path: '/workspace/varro/README.md', kind: 'file' },
    ]);
});

test('delayed symbol resolution preserves code geometry and opens only verified definitions', async ({
  page,
}) => {
  await page.setViewportSize({ width: 486, height: 900 });
  await page.goto(
    '/e2e/harness/index.html?scenario=message-rendering&symbolCitations&citationCheckDelayMs=1500'
  );
  const code = page.locator('code[data-citation-symbol]').filter({ hasText: 'loss_weights()' });
  await expect(code).toBeVisible();
  await expect(page.getByRole('link', { name: 'loss_weights()', exact: true })).toHaveCount(0);
  const geometry = () =>
    code.evaluate((element) => ({
      width: element.getBoundingClientRect().width,
      height: element.getBoundingClientRect().height,
      rowHeight: element.closest('.rendered-markdown')!.getBoundingClientRect().height,
    }));
  const before = await geometry();
  const link = page.getByRole('link', { name: 'loss_weights()', exact: true });
  await expect(link).toBeVisible();
  expect(await geometry()).toEqual(before);
  await expect(
    page.getByRole('link', { name: 'CustomMultiTaskRLBenchEnv', exact: true })
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'soft_updates()', exact: true })).toHaveCount(0);
  await expect(
    page.getByRole('link', { name: 'transporter / franka / clip', exact: true })
  ).toHaveCount(0);
  await link.focus();
  await expect(page.getByRole('tooltip')).toHaveText('/workspace/varro/src/loss.py:12');
  await link.press('Enter');
  await expect
    .poll(() =>
      getE2EState(page, () => {
        const value = (
          window as Window & {
            __varroE2E?: { openTargets?: Array<{ path: string; line?: number; kind?: string }> };
          }
        ).__varroE2E;
        return value?.openTargets ?? [];
      })
    )
    .toEqual([{ path: '/workspace/varro/src/loss.py', line: 12, kind: 'file' }]);
});

test('delayed citation validation preserves wrapping and row height', async ({ page }) => {
  await page.setViewportSize({ width: 486, height: 900 });
  await page.goto('/e2e/harness/index.html?scenario=message-rendering&citationCheckDelayMs=1500');
  await expect(page.locator('.rendered-markdown .hljs-keyword').first()).toBeVisible();
  const candidate = page.locator('code.citation-path').filter({ hasText: 'README.md' });
  await expect(candidate).toBeVisible();
  await expect(candidate.locator('.file-path-icon')).toBeVisible();
  const before = await candidate.evaluate((element) => ({
    width: element.getBoundingClientRect().width,
    height: element.closest('.rendered-markdown')!.getBoundingClientRect().height,
  }));
  const link = page.getByRole('link', { name: 'README.md', exact: true });
  await expect(link).toBeVisible();
  await expect(link.locator('.file-path-icon')).toBeVisible();
  const after = await link.evaluate((element) => ({
    width: element.getBoundingClientRect().width,
    height: element.closest('.rendered-markdown')!.getBoundingClientRect().height,
  }));
  expect(Math.abs(after.width - before.width)).toBeLessThan(1);
  expect(Math.abs(after.height - before.height)).toBeLessThan(1);
  await expect(
    page.locator('code.citation-path').filter({ hasText: 'missing-file.ts' })
  ).toBeVisible();
  await expect(
    page
      .locator('code.citation-path')
      .filter({ hasText: 'missing-file.ts' })
      .locator('.file-path-icon')
  ).toBeVisible();
});

test('keeps PDF icons visible before and after exact-path validation', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=message-rendering&citationCheckDelayMs=1500');
  await expect(page.getByRole('link', { name: 'README.md', exact: true })).toBeVisible();
  await page.evaluate(() => {
    window.postMessage(
      {
        type: 'server/event',
        payload: {
          type: 'message.part.updated',
          properties: {
            part: {
              id: 'message-rendering-assistant-part-1',
              sessionID: 'session-message-rendering',
              messageID: 'message-rendering-assistant',
              type: 'text',
              text: "I'll copy `pdf-source/65129.pdf` to `pdf-source/__65129.pdf`.\n\nCopied to dev `pdf-source/__65129.pdf`.",
            },
          },
        },
      },
      '*'
    );
  });
  const pendingIcons = page.locator('code.citation-path img.file-path-icon');
  await expect(pendingIcons).toHaveCount(3);
  for (const icon of await pendingIcons.all()) await expect(icon).toBeVisible();
  await expect
    .poll(() =>
      pendingIcons.evaluateAll((icons: HTMLImageElement[]) =>
        icons.every((icon) => icon.complete && icon.naturalWidth > 0)
      )
    )
    .toBe(true);
  const links = page.locator('a.file-path-link');
  await expect(links).toHaveCount(3);
  for (const icon of await links.locator('img.file-path-icon').all())
    await expect(icon).toBeVisible();
});

for (const [kind, selector, label] of [
  ['validated', 'a.file-path-link', 'README.md'],
  ['missing', 'code.citation-path', 'missing-file.ts'],
  ['PDF', 'a.file-path-link', 'pdf-source/__65129.pdf'],
] as const) {
  test(`selects the icon with ${kind} citation text without copying decoration`, async ({
    page,
  }, testInfo) => {
    await page.goto('/e2e/harness/index.html?scenario=message-rendering');
    if (kind === 'PDF') {
      await expect(page.getByRole('link', { name: 'README.md', exact: true })).toBeVisible();
      await page.evaluate(() =>
        window.postMessage(
          {
            type: 'server/event',
            payload: {
              type: 'message.part.updated',
              properties: {
                part: {
                  id: 'message-rendering-assistant-part-1',
                  sessionID: 'session-message-rendering',
                  messageID: 'message-rendering-assistant',
                  type: 'text',
                  text: 'Copied to dev `pdf-source/__65129.pdf` using the server credentials. Verified its SHA-256 matches the original.\n\nThe scheduled sync may delete it on the next run.',
                },
              },
            },
          },
          '*'
        )
      );
    }
    const reference = page.locator(selector).filter({ hasText: label });
    await expect(reference).toBeVisible();
    if (kind === 'PDF')
      await reference.evaluate((element) => {
        if (element.parentElement) element.parentElement.style.width = '365px';
      });
    const icon = reference.locator('img.file-path-icon');
    await icon.scrollIntoViewIfNeeded();
    await expect
      .poll(() =>
        icon.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)
      )
      .toBe(true);
    const leading = reference.locator('.link-leading-content');
    const beforeLayout = await reference.evaluate((element) => {
      const row = element.closest('.assistant-message-flow-item');
      return [element, element.querySelector('img'), row].map((node) =>
        node?.getBoundingClientRect().toJSON()
      );
    });
    const unselected = await icon.screenshot();
    const selectedText = await reference.evaluate((element, fullParagraph) => {
      const range = document.createRange();
      const target = fullParagraph ? (element.parentElement ?? element) : element;
      range.selectNodeContents(target);
      if (fullParagraph && target.firstChild instanceof Text) {
        range.setStart(target.firstChild, target.firstChild.data.indexOf('dev'));
      }
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      return selection?.toString();
    }, kind === 'PDF');
    expect(selectedText).toBe(
      kind === 'PDF'
        ? `dev ${label} using the server credentials. Verified its SHA-256 matches the original.`
        : label
    );
    await expect(leading).toHaveClass(/file-icon-selected/);
    const selected = await icon.screenshot();
    const geometry = await leading.evaluate((element) => {
      const labelElement = element.querySelector('.link-leading-label');
      if (!labelElement) throw new Error('Expected citation label');
      const range = document.createRange();
      range.selectNodeContents(labelElement);
      const textBox = range.getBoundingClientRect();
      const wrapperBox = element.getBoundingClientRect();
      const layer = getComputedStyle(element, '::before');
      return {
        top: wrapperBox.top + parseFloat(layer.top),
        height: parseFloat(layer.height),
        right: wrapperBox.left + parseFloat(layer.width),
        textLeft: textBox.left,
        wrapperTop: wrapperBox.top,
        wrapperLeft: wrapperBox.left,
        wrapperHeight: wrapperBox.height,
        color: layer.backgroundColor,
        textColor: getComputedStyle(labelElement, '::selection').backgroundColor,
      };
    });
    expect(geometry.top).toBeCloseTo(geometry.wrapperTop, 2);
    expect(geometry.height).toBeCloseTo(geometry.wrapperHeight, 2);
    expect(geometry.right).toBeCloseTo(geometry.textLeft, 2);
    expect(geometry.color).toBe(geometry.textColor);
    const edgeRows = [1, Math.floor(geometry.wrapperHeight) - 1];
    const textX = Math.round(geometry.textLeft - geometry.wrapperLeft);
    if (kind === 'PDF') {
      const paragraph = reference.locator('..');
      const paragraphBox = await paragraph.boundingBox();
      if (!paragraphBox) throw new Error('Expected selected paragraph');
      const screenshot = await paragraph.screenshot({
        path: testInfo.outputPath('PDF-selected-paragraph.png'),
      });
      const iconX = Math.round(geometry.wrapperLeft - paragraphBox.x);
      const labelX = Math.round(geometry.textLeft - paragraphBox.x);
      const referenceRight = await reference.evaluate(
        (element) => element.getBoundingClientRect().right
      );
      await expectSelectionEdgeContinuity(
        page,
        screenshot,
        [
          iconX - 1,
          iconX + 1,
          labelX - 1,
          labelX + 1,
          Math.round(referenceRight - paragraphBox.x) + 1,
        ],
        edgeRows
      );
    }
    // Check both edges of the line box, not just the smaller glyph bounds.
    await expectSelectionEdgeContinuity(
      page,
      await leading.screenshot(),
      [1, textX - 1, textX + 1],
      edgeRows
    );
    expect(
      await reference.evaluate((element) => {
        const row = element.closest('.assistant-message-flow-item');
        return [element, element.querySelector('img'), row].map((node) =>
          node?.getBoundingClientRect().toJSON()
        );
      })
    ).toEqual(beforeLayout);
    await testInfo.attach(`${kind}-selected-reference`, {
      body: await reference.screenshot({
        path: testInfo.outputPath(`${kind}-selected-reference.png`),
      }),
      contentType: 'image/png',
    });
    await testInfo.attach(`${kind}-selected-icon`, { body: selected, contentType: 'image/png' });
    expect(
      selected.equals(unselected),
      'The file icon should paint the continuous selection highlight'
    ).toBe(false);
    await expect(icon).toHaveCSS('user-select', 'none');
    await expect(icon).toHaveCSS('-webkit-user-select', 'none');

    for (const backward of [false, true]) {
      const firstCharacter = await reference.evaluate((element, reverse) => {
        const text = element.querySelector('.link-leading-label')?.firstChild;
        if (!(text instanceof Text)) throw new Error('Expected citation text');
        const end = Array.from(text.data)[0]?.length ?? 1;
        window.getSelection()?.setBaseAndExtent(text, reverse ? end : 0, text, reverse ? 0 : end);
        return window.getSelection()?.toString();
      }, backward);
      expect(firstCharacter).toBe(label[0]);
      await expect(leading).toHaveClass(/file-icon-selected/);
      await expectSelectionEdgeContinuity(
        page,
        await leading.screenshot(),
        [1, textX - 1, textX + 1],
        edgeRows
      );
    }
    // Selecting a suffix must not paint the unselected icon.
    await reference.evaluate((element) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let last: Text | undefined;
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (node instanceof Text && node.length) last = node;
      }
      if (!last) throw new Error('Expected citation text');
      window.getSelection()?.setBaseAndExtent(last, last.length - 1, last, last.length);
    });
    await expect(leading).not.toHaveClass(/file-icon-selected/);
    await reference.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
    });
    await expect(leading).toHaveClass(/file-icon-selected/);
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    await expect(leading).not.toHaveClass(/file-icon-selected/);
    expect(await leading.getAttribute('style')).toBe('');
  });
}
