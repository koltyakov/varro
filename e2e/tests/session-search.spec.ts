import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { MessageEntry } from '../../src/webview/types';
import { installPlaybackCapture } from './helpers';

const sessionId = 'session-search';
const created = 1_780_000_000_000;

function history(): MessageEntry[] {
  return Array.from({ length: 130 }, (_, index) => {
    const turn = index + 1;
    const userId = `prompt-${turn}`;
    const assistantId = `answer-${turn}`;
    return [
      {
        info: {
          id: userId,
          sessionID: sessionId,
          role: 'user' as const,
          agent: 'build',
          model: { providerID: 'test', modelID: 'test' },
          time: { created: created + turn * 10 },
        },
        parts: [
          {
            id: `text-${userId}`,
            messageID: userId,
            sessionID: sessionId,
            type: 'text' as const,
            text: turn === 4 ? 'Archival prompt needle' : `Question number ${turn}.`,
          },
        ],
      },
      {
        info: {
          id: assistantId,
          parentID: userId,
          sessionID: sessionId,
          role: 'assistant' as const,
          mode: 'build',
          agent: 'build',
          providerID: 'test',
          modelID: 'test',
          time: { created: created + turn * 10 + 1, completed: created + turn * 10 + 2 },
          finish: 'stop',
          path: { cwd: '/workspace', root: '/workspace' },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
        parts: [
          {
            id: `text-${assistantId}`,
            messageID: assistantId,
            sessionID: sessionId,
            type: 'text' as const,
            text: `${turn === 6 ? 'Archival response needle' : `Response number ${turn}.`}\n\n${'A paragraph of response content that wraps naturally in narrow views. '.repeat(12)}`,
          },
        ],
      },
    ];
  }).flat();
}

async function loadSession(
  page: Page,
  initialMessages = history(),
  theme: 'dark' | 'light' = 'dark'
) {
  await installPlaybackCapture(page, {
    session: {
      id: sessionId,
      projectID: 'test',
      directory: '/workspace',
      title: 'Session search',
      version: '1',
      time: { created, updated: created },
    },
    initialMessages,
  });
  await page.goto(`/e2e/harness/index.html?scenario=session-playback&windowed=1&theme=${theme}`);
  await expect(page.locator(`[data-msg-id="${initialMessages.at(-1)!.info.id}"]`)).toBeVisible();
}

function mixedSearchHistory() {
  return history().filter(({ info }) =>
    info.role === 'user'
      ? info.id === 'prompt-1' || info.id === 'prompt-2'
      : Number(info.id.slice('answer-'.length)) <= 14
  );
}

for (const theme of ['dark', 'light'] as const) {
  test(`browses all prompts and jumps to unloaded history in the ${theme} theme`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 486, height: 850 });
    await loadSession(page, history(), theme);
    const latest = page.locator('[data-msg-id="answer-130"]');
    const before = await latest.evaluate((element) => element.getBoundingClientRect().top);
    await expect(page.locator('[data-msg-id="prompt-4"]')).toHaveCount(0);
    await page.locator('.rich-composer').first().focus();
    await page.keyboard.press('Meta+f');
    await page.getByRole('combobox').fill('archival');
    await expect(page.getByRole('option')).toHaveCount(2);
    const toggle = page.getByRole('button', { name: 'All prompts', exact: true });
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    const input = page.getByRole('combobox', { name: 'Search prompts', exact: true });
    await expect(input).toBeFocused();
    await expect(input).toHaveValue('archival');
    await expect(page.getByRole('option')).toHaveCount(1);
    await page.getByRole('button', { name: 'Clear search' }).click();
    await expect(page.getByRole('option')).toHaveCount(130);
    await expect(
      page.getByRole('search', { name: 'Search this session' }).getByRole('status')
    ).toHaveText('130 prompts');
    await expect(page.getByRole('group', { name: 'Assistant responses' })).toHaveCount(0);
    await expect(page.getByRole('option').first()).toHaveAccessibleName(
      'Prompt: Question number 130.'
    );
    await expect(page.locator('.session-search-result mark')).toHaveCount(0);
    expect(await latest.evaluate((element) => element.getBoundingClientRect().top)).toBeCloseTo(
      before,
      0
    );
    await page.screenshot({ path: testInfo.outputPath(`all-prompts-${theme}.png`) });
    const oldPrompt = page.getByRole('option', {
      name: 'Prompt: Archival prompt needle',
      exact: true,
    });
    await oldPrompt.scrollIntoViewIfNeeded();
    const scrollTop = await page
      .locator('.session-search-results')
      .evaluate((element) => element.scrollTop);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Meta+f');
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(input).toHaveValue('');
    await expect
      .poll(() => page.locator('.session-search-results').evaluate((element) => element.scrollTop))
      .toBe(scrollTop);
    await oldPrompt.click();
    await expect(page.getByRole('search', { name: 'Search this session' })).toHaveCount(0);
    await expect(page.locator('[data-msg-id="prompt-4"]')).toBeVisible();
  });

  test(`search panel uses the shared divider and fades into chat in the ${theme} theme`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 520, height: 800 });
    await loadSession(page, history(), theme);
    await page.locator('.rich-composer').first().focus();
    await page.keyboard.press('Meta+f');
    await page.getByRole('combobox', { name: 'Search prompts and responses' }).fill('archival');
    await expect(page.getByRole('option')).toHaveCount(2);
    const panel = page.getByRole('search', { name: 'Search this session' });
    await expect(panel).toBeVisible();
    const appearance = await panel.evaluate((element) => {
      const style = getComputedStyle(element);
      const divider = document.querySelector('.chat-header')!;
      const inputFadeElement = document.querySelector(
        '.interactive-list-shell > .interactive-list-bottom-fade-wrap .interactive-list-bottom-fade-gradient'
      )!;
      const inputFade = getComputedStyle(inputFadeElement);
      const fadeElement = element.querySelector('.interactive-list-bottom-fade-wrap')!;
      const fade = getComputedStyle(fadeElement);
      const gradientElement = fadeElement.querySelector('.interactive-list-bottom-fade-gradient')!;
      const box = element.getBoundingClientRect();
      const fadeBox = fadeElement.getBoundingClientRect();
      const underneath = document.elementFromPoint(box.x + box.width / 2, box.bottom + 8);
      return {
        border: style.borderBottomColor,
        divider: getComputedStyle(divider).borderBottomColor,
        shadow: style.boxShadow,
        fade: getComputedStyle(gradientElement).backgroundImage,
        inputFade: inputFade.backgroundImage,
        gradientHeight: gradientElement.getBoundingClientRect().height,
        inputFadeHeight: inputFadeElement.getBoundingClientRect().height,
        hasSolidGap: fadeElement.querySelector('.chat-content-fade-solid-gap') !== null,
        fadeHeight: fadeBox.height,
        fadePointerEvents: fade.pointerEvents,
        fadeTop: fadeBox.top,
        panelBottom: box.bottom,
        mirrored: fade.transform,
        gradientTop: gradientElement.getBoundingClientRect().top,
        clipping: getComputedStyle(element.parentElement!).overflow,
        passesPointerThrough: !element.contains(underneath),
      };
    });
    expect(appearance.border).toBe(appearance.divider);
    expect(appearance.shadow).toBe('none');
    expect(appearance.fade).toBe(appearance.inputFade);
    expect(appearance.gradientHeight).toBe(appearance.inputFadeHeight * 2);
    expect(appearance.hasSolidGap).toBe(false);
    expect(appearance.fadeHeight).toBe(appearance.gradientHeight);
    expect(appearance.mirrored).toBe('matrix(-1, 0, 0, -1, 0, 0)');
    expect(appearance.gradientTop).toBeCloseTo(appearance.panelBottom, 2);
    expect(appearance.fadePointerEvents).toBe('none');
    expect(appearance.fadeTop).toBeCloseTo(appearance.panelBottom, 2);
    expect(appearance.clipping).toBe('clip');
    expect(appearance.passesPointerThrough).toBe(true);
    await expect(panel).toHaveCSS('border-top-width', '0px');
    await expect(panel).toHaveCSS('border-bottom-width', '1px');
    await page.screenshot({ path: testInfo.outputPath(`search-panel-${theme}.png`) });
  });
}

for (const destination of [
  { query: 'archival prompt', id: 'prompt-4', role: 'Prompt', shortcut: 'Meta+f' },
  { query: 'archival response', id: 'answer-6', role: 'Response', shortcut: 'Control+f' },
]) {
  test(`search navigates to an unloaded ${destination.role.toLowerCase()} without moving while typing`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize({ width: 486, height: 850 });
    await loadSession(page);
    const list = page.locator('.interactive-list');
    const latest = page.locator('[data-msg-id="answer-130"]');
    await expect(latest).toBeVisible();
    await expect(page.locator('.interactive-list-track')).toHaveClass(/virtualized/);
    await expect(page.locator(`[data-msg-id="${destination.id}"]`)).toHaveCount(0);
    const composer = page.locator('.rich-composer').first();
    await composer.focus();
    const before = await latest.evaluate((element) => element.getBoundingClientRect().top);
    const mountedBefore = await page.locator('[data-msg-id]').count();
    await page.keyboard.press(destination.shortcut);
    const input = page.getByRole('combobox', { name: 'Search prompts and responses' });
    await expect(input).toBeFocused();
    const panel = page.getByRole('search', { name: 'Search this session' });
    const panelBox = await panel.boundingBox();
    const shellBox = await page.locator('.interactive-list-shell').boundingBox();
    expect(panelBox!.width).toBeCloseTo(shellBox!.width, 0);
    expect(panelBox!.x).toBeCloseTo(shellBox!.x, 0);
    await input.fill(destination.query);
    const result = page.getByRole('option', { name: new RegExp(`^${destination.role}:`) });
    await expect(result).toHaveCount(1);
    await expect(page.locator('.session-search-status')).not.toContainText('Searching history');
    expect(await latest.evaluate((element) => element.getBoundingClientRect().top)).toBeCloseTo(
      before,
      0
    );
    expect(await page.locator('[data-msg-id]').count()).toBe(mountedBefore);
    if (destination.role === 'Response') {
      await input.press('ArrowDown');
      await input.press('Enter');
    } else {
      await result.click();
    }
    await expect(panel).toHaveCount(0);
    const target = page.locator(`[data-msg-id="${destination.id}"]`);
    await expect(target).toBeVisible();
    await expect(
      target
        .locator('.session-search-destination')
        .or(target.and(page.locator('.session-search-destination')))
    ).toBeVisible();
    const offset = () =>
      target
        .locator('.chat-turn-content')
        .first()
        .evaluate(
          (element) =>
            element.getBoundingClientRect().top -
            element.closest('.interactive-list')!.getBoundingClientRect().top
        );
    await expect.poll(offset).toBeCloseTo(8, 0);
    const arrived = await target.evaluate((element) => element.getBoundingClientRect().top);
    await page.waitForTimeout(1100);
    expect(await target.evaluate((element) => element.getBoundingClientRect().top)).toBeCloseTo(
      arrived,
      0
    );
    await expect(composer).toBeFocused();
    await page.keyboard.press(destination.shortcut);
    await expect(input).toBeFocused();
    await expect(input).toHaveValue(destination.query);
    await expect(result).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(page.locator('.session-search')).toHaveCount(0);
    await expect(composer).toBeFocused();
    expect(await target.evaluate((element) => element.getBoundingClientRect().top)).toBeCloseTo(
      arrived,
      0
    );
    await page.keyboard.press(destination.shortcut);
    await expect(input).toHaveValue(destination.query);
    const composerBox = await composer.boundingBox();
    await page.mouse.click(composerBox!.x + 20, composerBox!.y + composerBox!.height / 2);
    await expect(panel).toHaveCount(0);
    await expect(composer).toBeFocused();
    await page.keyboard.press(destination.shortcut);
    await expect(input).toHaveValue(destination.query);
    await page.keyboard.press('Escape');
    await expect(list).toBeVisible();
    expect(errors).toEqual([]);
  });
}

test('groups prompt matches first with distinct full-width cards at narrow and wide sizes', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 486, height: 850 });
  await loadSession(page);
  await page.locator('.rich-composer').first().focus();
  await page.keyboard.press('Meta+f');
  await page.getByRole('combobox', { name: 'Search prompts and responses' }).fill('archival');
  const options = page.getByRole('option');
  await expect(options).toHaveCount(2);
  await expect(options.first()).toHaveClass(/is-prompt/);
  await expect(options.first()).toContainText('Archival prompt');
  await expect(options.last()).toContainText('Archival response');
  await expect(options.first()).toHaveAccessibleName(/^Prompt: /);
  await expect(options.last()).toHaveAccessibleName(/^Response: /);
  await expect(page.locator('.session-search-result .ui-icon')).toHaveCount(2);
  await expect(page.locator('.session-search-role')).toHaveCount(0);
  await expect(page.locator('.session-search-group')).toHaveText([
    'Your prompts1',
    'Assistant responses1',
  ]);
  const groupIconColors = await page
    .locator('.session-search-group-label .ui-icon')
    .evaluateAll((elements) => elements.map((element) => getComputedStyle(element).color));
  expect(groupIconColors).toHaveLength(2);
  expect(groupIconColors[0]).toBe(groupIconColors[1]);
  await expect(options.first()).toHaveCSS('border-width', '1px');
  await expect(options.first()).toHaveCSS('box-shadow', 'none');
  const backgrounds = await options.evaluateAll((elements) =>
    elements.map((element) => getComputedStyle(element).backgroundColor)
  );
  expect(backgrounds[0]).not.toBe(backgrounds[1]);
  const resultStyles = await options.evaluateAll((elements) =>
    elements.map((element) => {
      const style = getComputedStyle(element);
      return { radius: style.borderRadius, weight: style.fontWeight };
    })
  );
  expect(resultStyles[0]?.radius).not.toBe(resultStyles[1]?.radius);
  expect(resultStyles[0]?.weight).toBe('400');
  expect(resultStyles[1]?.weight).toBe('400');
  await options.last().hover();
  await expect(options.last()).toHaveAttribute('aria-selected', 'true');
  await expect(options.last().locator('.session-search-open-icon')).toHaveCSS('opacity', '1');
  await page.keyboard.press('ArrowUp');
  await expect(options.first()).toHaveAttribute('aria-selected', 'true');
  await expect(options.last().locator('.session-search-open-icon')).toHaveCSS('opacity', '0');
  await page.keyboard.press('ArrowDown');
  await expect(options.last()).toHaveAttribute('aria-selected', 'true');
  await expect(options.last()).toHaveCSS('border-width', '1px');
  await expect(options.last()).toHaveCSS('box-shadow', 'none');
  await page.keyboard.press('ArrowUp');
  await expect(options.first()).toHaveAttribute('aria-selected', 'true');
  await page.locator('.session-search-heading').hover();
  const panel = page.getByRole('search', { name: 'Search this session' });
  await expect(page.getByRole('button', { name: 'Close session search' })).toHaveCount(0);
  const clear = panel.getByRole('button', { name: 'Clear search' });
  await expect(clear).toHaveClass('session-list-search-clear');
  const clearBox = await clear.boundingBox();
  expect(clearBox!.width).toBe(20);
  expect(clearBox!.height).toBe(20);
  await panel.screenshot({ path: testInfo.outputPath('search-panel.png') });
  for (const width of [360, 760, 960, 970, 1280, 1440, 1673]) {
    await page.setViewportSize({ width, height: 850 });
    await expect
      .poll(async () => {
        const panelBox = await panel.boundingBox();
        const columnBox = await page.locator('.interactive-input-part').first().boundingBox();
        return Math.max(
          Math.abs(panelBox!.width - columnBox!.width),
          Math.abs(panelBox!.x - columnBox!.x)
        );
      })
      .toBeLessThan(1);
    const overflow = await panel.evaluate((element) => element.scrollWidth - element.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    expect(await panel.evaluate((element) => getComputedStyle(element).borderTopWidth)).toBe('0px');
    const panelBox = await panel.boundingBox();
    const shellBox = await page.locator('.interactive-list-shell').boundingBox();
    expect(panelBox!.y).toBeCloseTo(shellBox!.y, 0);
    const searchControlBox = await panel.locator('.session-search-controls').boundingBox();
    expect(searchControlBox!.height).toBe(30);
    if (width >= 1400) {
      const sessionsSearch = page.locator('.chat-session-sidebar .session-list-search-input');
      await expect(sessionsSearch).toBeVisible();
      const sessionsSearchBox = await sessionsSearch.boundingBox();
      expect(searchControlBox!.height).toBe(sessionsSearchBox!.height);
    }
  }
  await clear.click();
  await expect(page.getByRole('combobox', { name: 'Search prompts and responses' })).toHaveValue(
    ''
  );
  await expect(page.getByRole('combobox', { name: 'Search prompts and responses' })).toBeFocused();
  await expect(panel).toBeVisible();
  await expect(options).toHaveCount(0);
  await expect(clear).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
});

test('plain and image prompt right edges align with the composer through desktop scrollbar gutters', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1673, height: 1307 });
  await page.goto('/e2e/harness/index.html?scenario=mixed-image-tiles');
  await expect(page.locator('.user-message-image-text-bubble')).toBeVisible();
  for (const width of [1673, 1280, 980, 970, 960, 486]) {
    await page.setViewportSize({ width, height: 1307 });
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const composer = document.querySelector('.chat-input-shell')!.getBoundingClientRect();
          const image = document
            .querySelector('.user-message-image-text-bubble')!
            .getBoundingClientRect();
          const track = document.querySelector('.interactive-list-track')!;
          const row = document
            .querySelector('.user-message-image-text-bubble')!
            .closest('.interactive-item-container')!
            .getBoundingClientRect();
          const plain = [...document.querySelectorAll('.chat-turn-user .user-message-card')]
            .findLast((element) => !element.querySelector('.user-message-image-text-bubble'))!
            .getBoundingClientRect();
          return Math.max(
            Math.abs(composer.right - image.right),
            Math.abs(composer.right - plain.right),
            Math.abs(composer.left - row.left),
            Math.abs(composer.right - row.right),
            Math.max(0, track.scrollWidth - track.clientWidth)
          );
        })
      )
      .toBeLessThanOrEqual(1);
  }
});

test('grows to the available chat height with square top corners', async ({ page }) => {
  await page.setViewportSize({ width: 520, height: 1250 });
  await loadSession(page);
  await page.locator('.rich-composer').first().focus();
  await page.keyboard.press('Meta+f');
  await page.getByRole('combobox', { name: 'Search prompts and responses' }).fill('number');
  await expect(page.getByRole('option')).toHaveCount(200);
  const panel = page.getByRole('search', { name: 'Search this session' });
  const corners = await panel.evaluate((element) => {
    const style = getComputedStyle(element);
    return [style.borderTopLeftRadius, style.borderTopRightRadius];
  });
  expect(corners).toEqual(['0px', '0px']);
  for (const height of [1250, 700]) {
    await page.setViewportSize({ width: 520, height });
    await expect
      .poll(async () => {
        const panelBox = await panel.boundingBox();
        const chatBox = await page.locator('.interactive-list-shell').boundingBox();
        return Math.abs(panelBox!.height - chatBox!.height);
      })
      .toBeLessThan(1);
    expect(
      await page
        .locator('.session-search-results')
        .evaluate((element) => element.scrollHeight > element.clientHeight)
    ).toBe(true);
    await expect(panel.getByRole('combobox')).toBeVisible();
    await expect(panel.locator('.session-search-footer')).toBeVisible();
  }
});

test('keeps role headings visible and keyboard targets unobscured while scrolling results', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 520, height: 800 });
  await loadSession(page, mixedSearchHistory());
  await page.locator('.rich-composer').first().focus();
  await page.keyboard.press('Meta+f');
  const input = page.getByRole('combobox', { name: 'Search prompts and responses' });
  await input.fill('number');
  await expect(page.getByRole('option')).toHaveCount(15);
  const results = page.getByRole('listbox', { name: 'Matching messages' });
  const promptHeader = page
    .getByRole('group', { name: 'Your prompts' })
    .locator('.session-search-group');
  const responseHeader = page
    .getByRole('group', { name: 'Assistant responses' })
    .locator('.session-search-group');
  await expect(promptHeader).toBeVisible();
  await page
    .getByRole('search', { name: 'Search this session' })
    .screenshot({ path: testInfo.outputPath('search-results-dense.png') });
  await input.press('ArrowUp');
  const selected = page.getByRole('option', { selected: true });
  await expect(selected).toHaveAccessibleName(/^Response: /);
  await expect
    .poll(async () => {
      const header = await responseHeader.boundingBox();
      const list = await results.boundingBox();
      return Math.abs(header!.y - list!.y);
    })
    .toBeLessThan(1);
  const headerBox = await responseHeader.boundingBox();
  const selectedBox = await selected.boundingBox();
  expect(selectedBox!.y).toBeGreaterThanOrEqual(headerBox!.y + headerBox!.height);
  await expect(results).toHaveAttribute('id', (await input.getAttribute('aria-controls')) ?? '');
  expect(await selected.getAttribute('id')).toBe(await input.getAttribute('aria-activedescendant'));
  await input.press('ArrowDown');
  await expect(selected).toHaveAccessibleName(/^Prompt: /);
  await expect
    .poll(async () => {
      const header = await promptHeader.boundingBox();
      const list = await results.boundingBox();
      return Math.abs(header!.y - list!.y);
    })
    .toBeLessThan(1);
});

test('keyboard navigation removes the highlight under a stationary mouse until the pointer moves', async ({
  page,
}) => {
  await page.setViewportSize({ width: 520, height: 800 });
  await loadSession(page, mixedSearchHistory());
  await page.locator('.rich-composer').first().focus();
  await page.keyboard.press('Meta+f');
  const input = page.getByRole('combobox', { name: 'Search prompts and responses' });
  await input.fill('number');
  await expect(page.getByRole('option')).toHaveCount(15);
  const responses = page.getByRole('group', { name: 'Assistant responses' }).getByRole('option');
  const hovered = responses.nth(1);
  const baseline = await hovered.evaluate((element) => ({
    background: getComputedStyle(element).backgroundColor,
    border: getComputedStyle(element).borderColor,
  }));
  await hovered.hover();
  await expect(hovered).toHaveAttribute('aria-selected', 'true');
  await input.press('ArrowUp');
  await expect(responses.first()).toHaveAttribute('aria-selected', 'true');
  expect(await hovered.evaluate((element) => element.matches(':hover'))).toBe(true);
  await expect(hovered).toHaveAttribute('aria-selected', 'false');
  await expect(hovered).toHaveCSS('background-color', baseline.background);
  await expect(hovered).toHaveCSS('border-color', baseline.border);
  await expect(hovered.locator('.session-search-open-icon')).toHaveCSS('opacity', '0');
  const box = await hovered.boundingBox();
  await page.mouse.move(box!.x + box!.width / 2 + 2, box!.y + box!.height / 2);
  await expect(hovered).toHaveAttribute('aria-selected', 'true');
  await expect(responses.first()).toHaveAttribute('aria-selected', 'false');
  for (let step = 0; step < 4; step += 1) await input.press('ArrowUp');
  await expect(page.getByRole('option').last()).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('option', { selected: true })).toHaveCount(1);
});
