/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- SAFETY: These E2E callbacks mutate protocol-shaped messages owned by the controlled harness fixture. */
import { expect, test } from '@playwright/test';
import { getE2EState } from './helpers';

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

test('renders real-session file variants as isolated canonical links', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=message-rendering');

  const links = page.locator('.rendered-markdown a.file-path-link');
  await expect(links).toHaveCount(11);
  await expect(links).toHaveText([
    'global.d.ts',
    'README.md',
    'LICENSE',
    '.gitignore',
    'Dockerfile',
    'index.css',
    'suite.cjs',
    '.oxlintrc.json',
    'architecture.md',
    'MarkdownRenderer.tsx (line 1447)',
    'missing-file.ts',
  ]);
  await expect(links.locator('code')).toHaveCount(0);
  await expect(page.locator('.assistant-message-flow-item > .rendered-markdown')).not.toContainText(
    '`'
  );

  const readme = page.getByRole('link', { name: 'README.md' });
  const license = page.getByRole('link', { name: 'LICENSE' });
  await expect(readme).toHaveAttribute('title', '/workspace/varro/README.md');
  await readme.focus();
  await expect
    .poll(() => readme.evaluate((element) => getComputedStyle(element).outlineStyle))
    .toBe('none');
  await readme.click({ button: 'right' });
  await expect
    .poll(() => readme.evaluate((element) => getComputedStyle(element).outlineStyle))
    .toBe('none');

  const hoverTargets = ['suite.cjs', 'architecture.md', '.oxlintrc.json'];
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

  const missingLink = page.locator('a.file-path-link').filter({ hasText: 'missing-file.ts' });
  await missingLink.click();
  await expect(missingLink).toHaveClass(/is-unavailable/);
  await expect(missingLink).toHaveAttribute('aria-disabled', 'true');
  await expect(missingLink).not.toHaveAttribute('href', /.+/);
  await expect(missingLink).toHaveCSS('cursor', 'default');
  await expect(page.locator('.session-action-feedback.is-warning')).toContainText(
    'File not found: missing-file.ts'
  );
  const openCountAfterFailure = await getE2EState(page, () => {
    const value = (
      window as Window & {
        __varroE2E?: { openTargets?: Array<{ path: string }> };
      }
    ).__varroE2E;
    return value?.openTargets?.length ?? 0;
  });
  await missingLink.click({ force: true });
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
      { path: '/workspace/varro/missing-file.ts', kind: 'file' },
      {
        path: '/workspace/varro/MarkdownRenderer.tsx',
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
      { path: '/workspace/varro/missing-file.ts', kind: 'file' },
      {
        path: '/workspace/varro/MarkdownRenderer.tsx',
        kind: 'file',
        line: 1447,
      },
      { path: '/workspace/varro/README.md', kind: 'file' },
    ]);
});
