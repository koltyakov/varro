/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- SAFETY: This E2E callback invokes the provider hook installed by the controlled harness fixture. */
import { expect, test } from '@playwright/test';
import type { WebviewMessage } from '../../src/shared/protocol';

import { appendDeltaToRapidStreaming } from './scroll-helpers';

test('shows usage-limit retry state and lets the user switch providers', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=usage-limit');

  await expect(page.getByText('Usage limit reached', { exact: true })).toBeVisible();
  await expect(page.locator('.chat-usage-limit-meta')).toContainText('messages exhausted');
  await expect(page.locator('.chat-usage-limit-message')).toContainText('429 usage limit reached');
  await expect(page.locator('.toolbar-limit-chip')).toContainText('0%');

  await page.getByRole('button', { name: 'Switch provider' }).click();
  const providerHeaders = page.locator('.model-picker-menu .dropdown-group-header');
  await expect(providerHeaders.filter({ hasText: /^OpenAI/ })).toBeVisible();
  await expect(providerHeaders.filter({ hasText: /^OpenCode Go/ })).toBeVisible();
  await expect(providerHeaders.getByText('OpenCode Go', { exact: true })).toBeVisible();
  await expect(page.getByText('Go Plan', { exact: true })).toBeVisible();
  await expect(page.getByText('Go Build', { exact: true })).toBeVisible();
  await page.getByText('Go Plan', { exact: true }).click();

  await expect(page.getByLabel('OpenCode Go / Go Plan')).toBeVisible();
});

test('stops retrying a usage-limited session', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=usage-limit');

  await page.getByRole('button', { name: 'Stop retrying' }).click();

  const abortRequest = await page.evaluate(() => {
    const value = (
      window as Window & {
        __varroE2E?: { requests: Array<{ method: string; path: string }> };
      }
    ).__varroE2E;
    return (
      value?.requests.find((request) => {
        const url = new URL(request.path, 'http://varro.test');
        return (
          request.method === 'POST' &&
          url.pathname.endsWith('/abort') &&
          url.searchParams.get('directory') === '/workspace/varro'
        );
      }) || null
    );
  });

  expect(abortRequest).toMatchObject({ method: 'POST' });
});

test('keeps the manually selected provider model as the default after reload', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=usage-limit');

  await page.getByRole('button', { name: 'Switch provider' }).click();
  await page.getByText('Go Plan', { exact: true }).click();
  await expect(page.getByLabel('OpenCode Go / Go Plan')).toBeVisible();

  await page.reload();

  await expect(page.getByLabel('OpenCode Go / Go Plan')).toBeVisible();
});

test('supports escape in the provider switcher', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=usage-limit');

  await page.getByRole('button', { name: 'Switch provider' }).click();
  await expect(page.getByText('Go Plan', { exact: true })).toBeVisible();
  const picker = page.locator('.dropdown-menu').first();
  await picker.press('Escape');
  await expect(page.getByText('Go Plan', { exact: true })).toHaveCount(0);
});

test('opens manage models from the picker and filters the model catalog', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=blank');

  await page.getByLabel('GitHub Copilot / GPT-5 mini').click();
  await expect(page.getByRole('button', { name: 'Manage models', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Manage models', exact: true }).click();

  await expect(page.getByText('Models', { exact: true })).toBeVisible();
  const filter = page.getByLabel('Filter providers or models');
  await filter.fill('openai');
  await expect(page.getByText('OpenAI', { exact: true })).toBeVisible();
  await expect(page.getByText('GPT-4.1', { exact: true })).toBeVisible();
  await expect(page.getByText('GitHub Copilot', { exact: true })).toHaveCount(0);
});

test('returns to the same draft when the Models module cannot load', async ({ page }, testInfo) => {
  let failedImports = 0;
  await page.route('**/src/webview/components/ModelsPanel.tsx*', (route) => {
    failedImports += 1;
    return route.abort('failed');
  });
  await page.goto('/e2e/harness/index.html?scenario=blank');
  const composer = page.locator('[role="textbox"][aria-multiline="true"]').first();
  await composer.fill('Keep my unsent draft');
  await page.getByLabel('GitHub Copilot / GPT-5 mini').click();
  expect(failedImports).toBe(0);
  await page.getByRole('button', { name: 'Manage models', exact: true }).click();

  const errorPanel = page.getByRole('region', { name: 'Models', exact: true });
  await expect(errorPanel.getByRole('alert')).toContainText('Models could not load');
  await expect(errorPanel).toContainText('updated or reinstalled');
  await expect(errorPanel.getByRole('button', { name: 'Reload sidebar' })).toBeVisible();
  await expect(errorPanel.getByRole('heading', { name: 'Models could not load' })).toBeVisible();
  const actions = errorPanel.locator('.settings-panel-error-actions');
  await expect(actions.getByRole('button').first()).toHaveText('Reload sidebar');
  for (const viewport of [
    { width: 496, height: 981 },
    { width: 320, height: 640 },
    { width: 240, height: 360 },
  ]) {
    await page.setViewportSize(viewport);
    await expect(actions.getByRole('button', { name: 'Back to chat' })).toBeInViewport();
    await expect(actions.getByRole('button', { name: 'Reload sidebar' })).toBeInViewport();
    const labelOffsets = await actions.getByRole('button').evaluateAll((buttons) =>
      buttons.map((button) => {
        const bounds = button.getBoundingClientRect();
        const label = button.querySelector('span')!.getBoundingClientRect();
        return Math.abs(label.y + label.height / 2 - (bounds.y + bounds.height / 2));
      })
    );
    for (const offset of labelOffsets) expect(offset).toBeLessThanOrEqual(0.5);
    const heading = errorPanel.getByRole('heading', { name: 'Models could not load' });
    const icon = await heading.locator('.settings-panel-error-icon').boundingBox();
    const title = await heading.locator('span:not(.ui-icon)').boundingBox();
    expect(icon).not.toBeNull();
    expect(title).not.toBeNull();
    expect(icon!.x + icon!.width).toBeLessThan(title!.x);
    expect(
      Math.abs(icon!.y + icon!.height / 2 - (title!.y + title!.height / 2))
    ).toBeLessThanOrEqual(0.5);
    const card = errorPanel.locator('.settings-panel-error-card');
    const bounds = await card.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
    await page.screenshot({ path: testInfo.outputPath(`models-error-${viewport.width}.png`) });
  }
  expect(failedImports).toBe(1);
  await expect(page.getByText('Something went wrong', { exact: true })).toHaveCount(0);
  await errorPanel.getByRole('button', { name: 'Back to chat' }).click();

  await expect(composer).toBeVisible();
  await expect(composer).toHaveText('Keep my unsent draft');
  await composer.fill('I can still edit this draft');

  await page.getByLabel('GitHub Copilot / GPT-5 mini').click();
  await page.getByRole('button', { name: 'Manage models', exact: true }).click();
  await expect(errorPanel.getByRole('alert')).toContainText('Models could not load');
  await errorPanel.getByRole('button', { name: 'Back to chat' }).click();
  await expect(composer).toHaveText('I can still edit this draft');
});

test('refreshes global vision tags and offers the same vision menu without a project agent', async ({
  page,
}) => {
  await page.goto('/e2e/harness/index.html?scenario=blank');
  await expect(page.getByLabel('GitHub Copilot / GPT-5 mini')).toBeVisible();
  await page.evaluate(() => {
    // SAFETY: This isolated harness exposes the typed bridge hook and the test-owned refresh hook.
    const target = window as {
      __sendToExtension?: (message: WebviewMessage) => void;
      setGlobalVisionForTest?: () => void;
    };
    const previous = target.__sendToExtension;
    let visionAssigned = false;
    target.__sendToExtension = (message) => {
      if (
        message.type === 'api/request' &&
        message.payload.method === 'GET' &&
        message.payload.path === '/varro/opencode-config'
      ) {
        queueMicrotask(() =>
          window.postMessage(
            {
              type: 'api/response',
              payload: {
                id: message.payload.id,
                data: {
                  smallModel: { providerID: 'copilot', modelID: 'gpt-5-mini' },
                  agentModels: visionAssigned
                    ? { vision: { providerID: 'openai', modelID: 'gpt-4.1' } }
                    : {},
                  commitMessageModel: null,
                  autoApproveModel: null,
                },
              },
            },
            '*'
          )
        );
        return;
      }
      previous?.(message);
    };
    target.setGlobalVisionForTest = () => {
      visionAssigned = true;
      window.postMessage({ type: 'providers/refresh' }, '*');
    };
  });
  await page.getByLabel('GitHub Copilot / GPT-5 mini').click();
  await page.getByRole('button', { name: 'Manage models', exact: true }).click();
  await expect(page.getByLabel('Small model', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Agent model: vision', { exact: true })).toHaveCount(0);
  await page.evaluate(() => {
    // SAFETY: The test installed this hook before opening Models.
    const target = window as { setGlobalVisionForTest?: () => void };
    target.setGlobalVisionForTest?.();
  });
  await expect(page.getByLabel('Agent model: vision', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Small model', { exact: true })).toBeVisible();
  const visionRow = page
    .locator('.models-model-row')
    .filter({ has: page.getByText('GPT-4.1', { exact: true }) });
  await visionRow.click({ button: 'right' });
  const assigned = page.getByRole('button', { name: "Don't use for vision agent", exact: true });
  await expect(assigned).toBeEnabled();
  await expect(assigned).toHaveAttribute('title', 'Global vision agent model');
  await page.getByLabel('Filter providers or models').click();
  const textRow = page.locator('.models-model-row').filter({ hasText: 'GPT-5 mini' });
  await textRow.click({ button: 'right' });
  await expect(
    page.getByRole('button', { name: 'Use for vision agent', exact: true })
  ).toBeDisabled();
});

test('keeps a running chat out of the model dialog backdrop', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=rapid-streaming-jitter');
  await page.evaluate(() => {
    localStorage.setItem(
      'varro.addedModels',
      JSON.stringify(['openai:*', 'openai:gpt-4.1', 'openai:gpt-4.1-mini'])
    );
  });
  await page.reload();

  const workspace = page.locator('.chat-workspace');
  await expect(workspace).toBeVisible();
  await page.getByLabel('GitHub Copilot / GPT-5 mini').click();
  await page.getByRole('button', { name: 'Manage models', exact: true }).click();

  await expect(page.getByText('Models', { exact: true })).toBeVisible();
  await expect(workspace).toHaveCSS('visibility', 'hidden');

  const openAIProvider = page.locator('.models-provider').filter({ hasText: 'OpenAI' });
  await openAIProvider.getByRole('button', { name: 'Add models' }).click();

  const overlay = page.locator('.provider-connect-overlay');
  await expect(overlay).toBeVisible();
  await expect(overlay).toHaveCSS('backdrop-filter', 'blur(2px)');

  const streamedText = 'Updated while the Models panel was open.';
  await appendDeltaToRapidStreaming(page, ` ${streamedText}`);
  await expect(workspace).toContainText(streamedText);
  await expect(workspace).toHaveCSS('visibility', 'hidden');

  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Back', exact: true }).click();

  await expect(workspace).toBeVisible();
  await expect(workspace).toContainText(streamedText);
});

test('keeps provider headers equal without shrinking Add models', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=blank');
  await page.evaluate(() => {
    localStorage.setItem('varro.addedModels', JSON.stringify(['openai:*']));
    localStorage.setItem(
      'varro.removedModels',
      JSON.stringify(['openai:gpt-4.1', 'openai:gpt-4.1-mini'])
    );
    localStorage.setItem('varro.hiddenProviders', JSON.stringify(['copilot']));
  });
  await page.reload();
  await page.getByLabel('Z.ai / GLM 5.1').click();
  await page.getByRole('button', { name: 'Manage models', exact: true }).click();

  const catalogHeader = page.locator('.models-provider-header').filter({ hasText: 'OpenAI' });
  const hiddenHeader = page
    .locator('.models-provider-header')
    .filter({ hasText: 'GitHub Copilot' });
  await expect(catalogHeader.getByRole('button', { name: 'Add models' })).toBeVisible();
  await expect(hiddenHeader.locator('.models-provider-hidden-marker')).toBeVisible();
  await expect(hiddenHeader.getByRole('button', { name: 'Add models' })).toHaveCount(0);

  for (const width of [480, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await expect(catalogHeader).toHaveCSS('height', '32px');
    await expect(hiddenHeader).toHaveCSS('height', '32px');
    await expect(catalogHeader.getByRole('button', { name: 'Add models' })).toHaveCSS(
      'height',
      '20px'
    );
  }
});

test('centers model route tags within their fixed height', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=blank&commitModel=1');

  await page.getByLabel('GitHub Copilot / GPT-5 mini').click();
  await page.getByRole('button', { name: 'Manage models', exact: true }).click();

  const tag = page.getByLabel('Commit message model', { exact: true });
  await expect(tag).toBeVisible();
  // Exercise a real row remount instead of appending a probe that refresh can discard.
  const filter = page.getByLabel('Filter providers or models');
  await filter.fill('gpt-4.1');
  await expect(tag).toHaveCount(0);
  await filter.clear();

  await expect(tag).toHaveText('commit');
  await expect(tag).toHaveCSS('height', '16px');
  await expect(tag).toHaveCSS('line-height', '14px');
  await expect(tag).toHaveCSS('align-items', 'center');
});

test('prevents text selection across model rows', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=blank');

  await page.getByLabel('GitHub Copilot / GPT-5 mini').click();
  await page.getByRole('button', { name: 'Manage models', exact: true }).click();

  const modelNames = page.locator('.models-model-name');
  await expect(modelNames.first()).toBeVisible();
  await expect(page.locator('.models-model-row').first()).toHaveCSS('user-select', 'none');

  // Resolve live rows during the gesture; the catalog refresh can replace earlier measurements.
  await modelNames.nth(0).dragTo(modelNames.nth(1));

  expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('');
});
