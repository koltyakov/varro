import { expect, test } from '@playwright/test';
import { formatSkillAttachment } from '../../src/shared/skill-reference';
import type { MessageEntry, Part, Session } from '../../src/webview/types';
import { waitForHarnessStartup } from './helpers';

for (const width of [360, 1100]) {
  for (const markdown of [false, true]) {
    test(`aligns inline chips with ${markdown ? 'Markdown' : 'plain'} text at ${width}px`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 800 });
      const session: Session = {
        id: 'ses_chip_alignment',
        projectID: 'project-test',
        directory: '/workspace',
        title: 'Inline chip alignment',
        version: '2',
        time: { created: 1, updated: 1 },
      };
      const cases = [
        { id: 'goal', text: '/goal text message' },
        { id: 'skill', text: 'Use $[review] text message' },
        { id: 'image', text: 'See [Image 1] text message' },
        { id: 'file', text: 'Read @README.md text message' },
        { id: 'agent', text: 'Ask @build text message' },
      ];
      const initialMessages: MessageEntry[] = cases.map((item, index) => {
        const messageID = `msg_${item.id}`;
        const base = { sessionID: session.id, messageID };
        const parts: Part[] = [
          {
            ...base,
            id: `${messageID}_text`,
            type: 'text',
            text: markdown ? item.text.replace('text message', 'text message **bold**') : item.text,
          },
        ];
        if (item.id === 'skill' || item.id === 'file') {
          parts.push({
            ...base,
            id: `${messageID}_attachment`,
            type: 'text',
            text:
              item.id === 'skill' ? formatSkillAttachment('review') : '[Attached file: README.md]',
          });
        }
        if (item.id === 'image') {
          parts.push({
            ...base,
            id: `${messageID}_image`,
            type: 'file',
            filename: 'Image 1',
            mime: 'image/png',
            url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
          });
        }
        if (item.id === 'agent') {
          parts.push({ ...base, id: `${messageID}_agent`, type: 'agent', name: 'build' });
        }
        return {
          info: {
            id: messageID,
            sessionID: session.id,
            role: 'user',
            agent: 'build',
            model: { providerID: 'openai', modelID: 'test' },
            time: { created: index + 1 },
          },
          parts,
        };
      });
      await page.addInitScript(
        (capture) => {
          // SAFETY: These fixtures are consumed only by the isolated browser harness.
          (
            window as typeof window & { varroPlaybackCapture: typeof capture }
          ).varroPlaybackCapture = capture;
        },
        { session, initialMessages, goal: null }
      );
      await page.goto('/e2e/harness/index.html?scenario=session-playback');
      await waitForHarnessStartup(page);
      for (const item of cases) {
        const card = page.locator(`[data-msg-id="msg_${item.id}"] .user-message-card`);
        await card.scrollIntoViewIfNeeded();
        const chip = card.locator('.user-message-text .inline-chip');
        await expect(chip).toHaveCount(1);
        await expect(chip).toHaveCSS('vertical-align', '-1px');
        const offset = await chip.evaluate((element) => {
          const paragraph = element.closest('p')!;
          const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
          let node: Node | null;
          while ((node = walker.nextNode())) {
            const start = node.textContent?.indexOf('text message') ?? -1;
            if (start < 0) continue;
            const range = document.createRange();
            range.setStart(node, start);
            range.setEnd(node, start + 'text'.length);
            const text = range.getBoundingClientRect();
            const box = element.getBoundingClientRect();
            return box.top + box.height / 2 - text.top - text.height / 2;
          }
          throw new Error('Missing adjacent text for chip alignment');
        });
        expect(Math.abs(offset), `${item.id} chip vertical offset`).toBeLessThanOrEqual(0.5);
      }
      await page.screenshot({ path: testInfo.outputPath('inline-chip-alignment.png') });
    });
  }
}
