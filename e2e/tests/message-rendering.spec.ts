/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- SAFETY: These E2E callbacks mutate protocol-shaped messages owned by the controlled harness fixture. */
import { expect, test } from '@playwright/test';
import { getE2EState } from './helpers';

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
] as const) {
  test(`selects the icon with ${kind} citation text without copying decoration`, async ({
    page,
  }, testInfo) => {
    await page.goto('/e2e/harness/index.html?scenario=message-rendering');
    const reference = page.locator(selector).filter({ hasText: label });
    await expect(reference).toBeVisible();
    const icon = reference.locator('img.file-path-icon');
    await icon.scrollIntoViewIfNeeded();
    await expect
      .poll(() =>
        icon.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)
      )
      .toBe(true);
    const unselected = await icon.screenshot();
    const selectedText = await reference.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      return selection?.toString();
    });
    expect(selectedText).toBe(label);
    const selected = await icon.screenshot();
    await testInfo.attach(`${kind}-selected-icon`, { body: selected, contentType: 'image/png' });
    expect(
      selected.equals(unselected),
      'The file icon should paint the native selection highlight'
    ).toBe(false);
    await expect(icon).toHaveCSS('user-select', 'text');
    await expect(icon).toHaveCSS('-webkit-user-select', 'text');
  });
}
