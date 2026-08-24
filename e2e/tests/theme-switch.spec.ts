/* oxlint-disable unicorn/consistent-function-scoping -- Browser-side contrast helpers must stay inside the serialized page.evaluate callback. */
import { expect, test } from '@playwright/test';

for (const theme of ['dark', 'light'] as const) {
  test(`${theme} chat typography keeps main metrics and readable metadata`, async ({ page }) => {
    await page.goto(`/e2e/harness/index.html?scenario=blank&theme=${theme}`);
    const session = page.locator('.interactive-session');
    await expect(session).toBeVisible();
    await session.evaluate((element) => {
      const probe = document.createElement('div');
      probe.dataset.typographyProbe = 'true';
      probe.innerHTML = `
        <div class="rendered-markdown"><h2>Heading</h2><p>Body <code>inline</code></p></div>
        <button class="assistant-activity-summary"><span class="assistant-activity-summary-counts">3 files</span></button>
        <div class="chat-tool-invocation-part"><span class="tool-invocation-activity-age">21s</span></div>
      `;
      element.append(probe);
    });

    const metrics = await page.evaluate(() => {
      function rgb(value: string): [number, number, number] {
        const hex = /^#([\da-f]{6})$/i.exec(value);
        const digits = hex?.[1];
        if (digits) {
          return [
            Number.parseInt(digits.slice(0, 2), 16),
            Number.parseInt(digits.slice(2, 4), 16),
            Number.parseInt(digits.slice(4, 6), 16),
          ];
        }
        const channels = value
          .match(/[\d.]+/g)
          ?.slice(0, 3)
          .map(Number);
        if (!channels || channels.length !== 3) throw new Error(`Unsupported color: ${value}`);
        // SAFETY: The length check above establishes the RGB tuple shape.
        return channels as [number, number, number];
      }
      function luminance([r, g, b]: [number, number, number]): number {
        const channel = (value: number) => {
          const srgb = value / 255;
          return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
      }
      function contrast(foreground: string, background: string): number {
        const fg = luminance(rgb(foreground));
        const bg = luminance(rgb(background));
        return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
      }
      const bodyBackground = getComputedStyle(document.body).backgroundColor;
      const style = (selector: string) => {
        const element = document.querySelector<HTMLElement>(selector);
        if (!element) throw new Error(`Missing typography probe: ${selector}`);
        return getComputedStyle(element);
      };
      const sessionStyle = style('.interactive-session');
      const markdownStyle = style('[data-typography-probe] .rendered-markdown');
      const codeStyle = style('[data-typography-probe] code');
      return {
        sessionFontSize: sessionStyle.fontSize,
        markdownFontSize: markdownStyle.fontSize,
        markdownFontWeight: markdownStyle.fontWeight,
        markdownLineHeight: markdownStyle.lineHeight,
        codeBorderStyle: codeStyle.borderStyle,
        codeColor: codeStyle.color,
        contrasts: [
          contrast(style('.assistant-activity-summary-counts').color, bodyBackground),
          contrast(style('.tool-invocation-activity-age').color, bodyBackground),
        ],
      };
    });

    expect(metrics.sessionFontSize).toBe('13px');
    expect(metrics.markdownFontSize).toBe('13.5px');
    expect(metrics.markdownFontWeight).toBe('400');
    expect(metrics.markdownLineHeight).toBe('22.275px');
    expect(metrics.codeBorderStyle).toBe('solid');
    expect(metrics.codeColor).toBe(theme === 'dark' ? 'rgb(215, 186, 125)' : 'rgb(163, 21, 21)');
    for (const ratio of metrics.contrasts) {
      expect(ratio, JSON.stringify(metrics)).toBeGreaterThanOrEqual(4.5);
    }
  });
}

test('initial load uses the dark theme from the harness', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=blank');

  await expect(page.locator('[role="textbox"][aria-multiline="true"]').first()).toBeVisible();
  await expect(page.locator('body')).toHaveClass(/\bvscode-dark\b/);
});

test('theme=light query renders the light VSCode variables', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=blank&theme=light');

  await expect(page.locator('[role="textbox"][aria-multiline="true"]').first()).toBeVisible();
  await expect(page.locator('body')).toHaveClass(/\bvscode-light\b/);

  const editorBackground = await page.evaluate(() =>
    getComputedStyle(document.body).getPropertyValue('--vscode-editor-background').trim()
  );
  expect(editorBackground).toBe('#ffffff');
});

test('theme=high-contrast query renders the high-contrast VSCode variables', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=blank&theme=high-contrast');

  await expect(page.locator('[role="textbox"][aria-multiline="true"]').first()).toBeVisible();

  const values = await page.evaluate(() => {
    const styles = getComputedStyle(document.body);
    return {
      editorBackground: styles.getPropertyValue('--vscode-editor-background').trim(),
      contrastBorder: styles.getPropertyValue('--vscode-contrastBorder').trim(),
    };
  });
  expect(values.editorBackground).toBe('#000000');
  expect(values.contrastBorder).toBe('#ffffff');
});

test('high-contrast-light uses the contrast border for thinking and tool cards', async ({
  page,
}) => {
  await page.goto(
    '/e2e/harness/index.html?scenario=tool-cards-large-transcript&theme=high-contrast-light&expandedActivity=1'
  );

  const thinking = page.locator('.chat-thinking-box').first();
  const tool = page.locator('.chat-tool-invocation-part').first();
  await expect(thinking).toBeVisible();
  await expect(tool).toBeVisible();

  await expect(thinking).toHaveCSS('border-top-color', 'rgb(0, 0, 0)');
  await expect(tool).toHaveCSS('border-top-color', 'rgb(0, 0, 0)');
});

test('theme/update message switches body to light theme', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=blank');

  await expect(page.locator('[role="textbox"][aria-multiline="true"]').first()).toBeVisible();

  await page.evaluate(() => {
    window.postMessage({ type: 'theme/update', payload: { theme: 'light' } }, '*');
  });

  await expect(page.locator('body')).toHaveClass(/\bvscode-light\b/);
  await expect(page.locator('body')).not.toHaveClass(/\bvscode-dark\b/);
  await expect.poll(() => page.evaluate(() => document.body.dataset.vscodeThemeKind)).toBe('light');
});
