import { expect, test } from '@playwright/test';
import { waitForHarnessStartup } from './helpers';

for (const [width, isGitWorktree] of [
  [460, false],
  [460, true],
  [1600, false],
  [1600, true],
] as const) {
  test(`aligns header and list location icons at ${width}px with worktree=${isGitWorktree}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/e2e/harness/index.html?scenario=restored-session&locationAlignment=1');
    await waitForHarnessStartup(page);
    await expect(page.locator('.chat-header-location:visible')).toHaveCount(0);
    await page.evaluate((worktree) => {
      window.postMessage(
        {
          type: 'server/event',
          payload: {
            type: 'session.updated',
            properties: {
              info: {
                id: 'session-restored',
                projectID: 'project-varro',
                directory: '/workspace/varro',
                title: 'Fix top three reliability issues',
                version: '1',
                isGitWorktree: worktree,
                transfer: worktree
                  ? undefined
                  : { originDirectory: '/workspace/origin', available: true },
                time: { created: 1, updated: Date.now() + 1_000 },
              },
            },
          },
        },
        '*'
      );
    }, isGitWorktree);
    const header = page.locator('.chat-header-session-meta:visible');
    const location = header.getByRole('button', {
      name: isGitWorktree ? 'Session Git worktree' : 'Session folder',
    });
    await expect(location).toBeVisible();
    const gitMask = await location
      .locator('.ui-icon')
      .evaluate((element) => getComputedStyle(element).getPropertyValue('--ui-icon-mask'));
    expect(gitMask).not.toBe('');
    await header.hover();
    await expect(header.locator('.chat-header-session-duration')).toContainText('5m');
    const centers = await header.evaluate((element) =>
      [
        '.chat-header-title-text',
        '.chat-header-location .ui-icon',
        '.chat-header-session-duration',
      ].map((selector) => {
        const box = element.querySelector(selector)!.getBoundingClientRect();
        return box.top + box.height / 2;
      })
    );
    expect(Math.max(...centers) - Math.min(...centers)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: testInfo.outputPath('header-location.png') });
    await location.hover();
    await expect(page.getByRole('tooltip')).toHaveText('/workspace/varro');
    await location.click({ button: 'right' });
    await expect(page.getByRole('menuitem', { name: 'Open folder', exact: true })).toBeVisible();
    await expect(
      page.getByRole('menuitem', { name: 'Copy folder path', exact: true })
    ).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Merge changes', exact: true })).toHaveCount(
      isGitWorktree ? 1 : 0
    );
    await page.keyboard.press('Escape');
    await location.click({ button: 'right' });
    await expect(page.getByRole('menuitem', { name: 'Migrate changes', exact: true })).toHaveCount(
      isGitWorktree ? 1 : 0
    );
    await page.keyboard.press('Escape');
    if (!isGitWorktree) return;
    if (width < 1400)
      await page.getByRole('button', { name: 'Back to sessions', exact: true }).click();
    const row = page.locator('.session-item[data-session-id="session-restored"]');
    await expect(row.locator('.session-item-folder')).toHaveText(/^varro$/i);
    await expect(row.locator('.session-item-folder [aria-label="Git worktree"]')).toBeVisible();
    await expect(row.locator('.session-item-folder [aria-label="Git worktree"]')).toHaveCSS(
      '--ui-icon-mask',
      gitMask
    );
    const rowCenters = await row.locator('.session-item-folder').evaluate((element) => {
      const icon = element.querySelector('.session-item-folder-meta-icon')!.getBoundingClientRect();
      const text = element.querySelector('span:not(.ui-icon)')!.getBoundingClientRect();
      return [icon.top + icon.height / 2, text.top + text.height / 2];
    });
    expect(Math.abs(rowCenters[0]! - rowCenters[1]!)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: testInfo.outputPath('list-worktree.png') });
  });
}
