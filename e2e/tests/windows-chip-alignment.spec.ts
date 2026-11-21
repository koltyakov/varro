import { expect, test } from '@playwright/test';
import type { Page, TestInfo } from '@playwright/test';
import type { MessageEntry, Part, Session } from '../../src/webview/types';
import { waitForHarnessStartup } from './helpers';

const WINDOWS_FONT = '"Segoe WPC", "Segoe UI", sans-serif';
const FILE_NAMES = ['README.md', 'main.ts', 'main.go', 'app.java'];
const INLINE_CASES = [
  ...FILE_NAMES.flatMap((filename, index) =>
    [false, true].map((markdown) => ({
      id: `windows-file-${index}-${markdown}`,
      filename,
      markdown,
      annotation: false,
    }))
  ),
  ...[false, true].map((markdown) => ({
    id: `windows-annotation-${markdown}`,
    filename: 'annotation-12345678.txt',
    markdown,
    annotation: true,
  })),
];

async function openWindowsChips(page: Page) {
  const session: Session = {
    id: 'ses_windows_chip_alignment',
    projectID: 'project-test',
    directory: '/workspace',
    title: 'Native Windows chip alignment',
    version: '2',
    time: { created: 1, updated: 1 },
  };
  const initialMessages: MessageEntry[] = INLINE_CASES.map((item, index) => {
    const base = { sessionID: session.id, messageID: item.id };
    const parts: Part[] = [
      {
        ...base,
        id: `${item.id}-text`,
        type: 'text',
        text: `@${item.filename} text message${item.markdown ? ' **bold**' : ''}`,
      },
      item.annotation
        ? {
            ...base,
            id: `${item.id}-file`,
            type: 'file',
            mime: 'text/plain',
            filename: item.filename,
            url: `varro-content:/part/${item.id}-file`,
            annotation: { selectedText: 'Selected passage', note: 'Review note' },
          }
        : {
            ...base,
            id: `${item.id}-attachment`,
            type: 'text',
            text: `[Attached file: ${item.filename}]`,
          },
    ];
    return {
      info: {
        id: item.id,
        sessionID: session.id,
        role: 'user',
        agent: 'build',
        model: { providerID: 'replay', modelID: 'test' },
        time: { created: index + 1 },
      },
      parts,
    };
  });
  initialMessages.push({
    info: {
      id: 'windows-standalone',
      sessionID: session.id,
      role: 'user',
      agent: 'build',
      model: { providerID: 'replay', modelID: 'test' },
      time: { created: 20 },
    },
    parts: ['12345678', '87654321'].map((suffix, index) => ({
      id: `windows-standalone-${suffix}`,
      sessionID: session.id,
      messageID: 'windows-standalone',
      type: 'file',
      mime: 'text/plain',
      filename: `annotation-${suffix}.txt`,
      url: `varro-content:/part/windows-standalone-${suffix}`,
      annotation: {
        selectedText: 'Selected passage',
        note: index === 0 ? 'Проверь фронт, сейчас такое ограничение мешает работе' : 'Test 234',
      },
    })),
  });
  await page.addInitScript(
    (capture) => {
      // SAFETY: Only the isolated playback harness consumes these generated messages.
      (window as typeof window & { varroPlaybackCapture: typeof capture }).varroPlaybackCapture =
        capture;
    },
    { session, initialMessages, goal: null }
  );
  await page.goto('/e2e/harness/index.html?scenario=session-playback');
  await waitForHarnessStartup(page);
  await page.evaluate(async (family) => {
    document.documentElement.style.setProperty('--vscode-font-family', family);
    // Windows prose adds 0.5px to this setting, matching the reported 13.5px VS Code text.
    document.documentElement.style.setProperty('--varro-chat-font-size', '13px');
    await document.fonts.ready;
  }, WINDOWS_FONT);
}

async function nativeFontEvidence(page: Page, selector: string) {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
    const { root } = await cdp.send('DOM.getDocument');
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector });
    expect(nodeId, 'font probe must target a rendered chip').toBeGreaterThan(0);
    const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
    expect(
      fonts.some(
        (font) => font.familyName === 'Segoe UI' && !font.isCustomFont && font.glyphCount > 0
      ),
      'Segoe UI must actually render glyphs; a CSS family string or fallback is insufficient'
    ).toBe(true);
    return {
      platform: process.platform,
      fonts,
      userAgent: await page.evaluate(() => navigator.userAgent),
    };
  } finally {
    await cdp.detach();
  }
}

async function measureInlineChip(page: Page, id: string) {
  const chip = page.locator(`[data-msg-id="${id}"] .user-message-text .inline-chip`);
  await expect(chip).toHaveCount(1);
  await chip.scrollIntoViewIfNeeded();
  return chip.evaluate((element) => {
    const paragraph = element.closest('p');
    if (!paragraph) throw new Error('Missing adjacent paragraph');
    const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const start = node.textContent?.indexOf('text message') ?? -1;
      if (start < 0) continue;
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + 4);
      const text = range.getBoundingClientRect();
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(paragraph);
      return {
        id: element.closest<HTMLElement>('[data-msg-id]')!.dataset.msgId,
        offset: box.top + box.height / 2 - text.top - text.height / 2,
        chip: box.toJSON(),
        text: text.toJSON(),
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
        verticalAlign: getComputedStyle(element).verticalAlign,
        imageHeight: element.querySelector('img')?.getBoundingClientRect().height,
      };
    }
    throw new Error('Missing adjacent text for native alignment measurement');
  });
}

test.describe('native Windows chip alignment', () => {
  test.skip(process.platform !== 'win32', 'Requires Windows and its installed Segoe UI font');
  // Keep the existing 0.5px acceptance threshold. These checks currently expose the
  // native Windows offset rather than accepting 1px or hiding it as an expected failure.

  test('aligns standalone annotation labels and recovers capacity after widening', async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1100, height: 800 });
    await openWindowsChips(page);
    const selector = '[data-msg-id="windows-standalone"] .message-attachment-chip .chip-label';
    const fonts = await nativeFontEvidence(page, selector);
    const rail = page.locator('[data-msg-id="windows-standalone"] .message-file-attachments');
    const chips = rail.locator('.message-attachment-visible .message-attachment-chip');
    const measurements = [];
    for (const width of [1100, 360, 720, 1100]) {
      await page.setViewportSize({ width, height: 800 });
      await expect(chips).toHaveCount(width === 360 ? 1 : 2);
      await chips.first().scrollIntoViewIfNeeded();
      measurements.push({
        width,
        chips: await chips.evaluateAll((elements) =>
          elements.map((element) => {
            const range = document.createRange();
            range.selectNodeContents(element.querySelector('.chip-label')!);
            const text = range.getBoundingClientRect();
            const box = element.getBoundingClientRect();
            return {
              label: element.textContent,
              offset: box.top + box.height / 2 - text.top - text.height / 2,
            };
          })
        ),
      });
    }
    await testInfo.attach('native-annotation-fonts.json', {
      body: JSON.stringify({ fonts, measurements }, null, 2),
      contentType: 'application/json',
    });
    await page.screenshot({ path: testInfo.outputPath('native-annotations.png') });
    for (const measurement of measurements)
      for (const chip of measurement.chips)
        expect
          .soft(Math.abs(chip.offset), `${measurement.width}px ${chip.label}`)
          .toBeLessThanOrEqual(0.5);
  });

  for (const annotation of [true, false]) {
    test(
      annotation
        ? 'aligns annotation chips with adjacent Windows text'
        : 'checks the reported 1 px file chip/text offset',
      async ({ page }, testInfo: TestInfo) => {
        await page.setViewportSize({ width: 1100, height: 800 });
        await openWindowsChips(page);
        const cases = INLINE_CASES.filter((item) => item.annotation === annotation);
        const fonts = await nativeFontEvidence(
          page,
          `[data-msg-id="${cases[0]!.id}"] .user-message-text`
        );
        const measurements = [];
        for (const width of [360, 1100]) {
          await page.setViewportSize({ width, height: 800 });
          for (const item of cases) {
            const measurement = await measureInlineChip(page, item.id);
            expect(measurement.fontFamily).toBe(WINDOWS_FONT);
            expect(measurement.fontSize).toBe('13.5px');
            expect(measurement.verticalAlign).toBe('-1px');
            if (!annotation) expect(measurement.imageHeight).toBe(12);
            measurements.push({ width, ...measurement });
          }
          await page.screenshot({
            path: testInfo.outputPath(`native-${annotation ? 'annotation' : 'file'}-${width}.png`),
          });
        }
        await testInfo.attach('native-inline-alignment.json', {
          body: JSON.stringify({ fonts, measurements }, null, 2),
          contentType: 'application/json',
        });
        for (const measurement of measurements)
          expect
            .soft(Math.abs(measurement.offset), `${measurement.width}px ${measurement.id}`)
            .toBeLessThanOrEqual(0.5);
      }
    );
  }
});
