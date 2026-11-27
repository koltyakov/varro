import { expect, test } from '@playwright/test';
import type { ServerEvent } from '../../src/shared/protocol';
import type { AssistantMessage, MessageEntry, Part, ToolPart } from '../../src/webview/types';
import { installPlaybackCapture, waitForAnimationFrames } from './helpers';

// A short transcript is not virtualized, so the incoming edit card plays its measured entrance.
const CONTEXT_MESSAGES = 8;

for (const handoff of ['collapsed-tray', 'retained-tray'] as const) {
  const run = handoff === 'retained-tray' ? test.fail : test;
  // Known issue: the retained reasoning tray's collapse reserve counts the incoming card at its
  // final height. Its measured entrance then starts at 0 px, so the range shrinks and clamps.
  run(
    `keeps content fixed when a reasoning tray hands off to an edit card (${handoff})`,
    async ({ page }) => {
      await page.setViewportSize({ width: 490, height: 640 });
      const sessionID = 'tray-edit-entrance';
      const created = 1_780_000_000_000;
      const info: AssistantMessage = {
        id: 'tray-edit-context',
        sessionID,
        role: 'assistant',
        parentID: 'tray-edit-user',
        time: { created },
        providerID: 'claude-agent',
        modelID: 'opus',
        mode: 'build',
        agent: 'build',
        path: { cwd: '/workspace', root: '/workspace' },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      };
      const messages: MessageEntry[] = Array.from({ length: CONTEXT_MESSAGES }, (_, index) => ({
        info: {
          ...info,
          id: `tray-edit-context-${index}`,
          time: { created, completed: created + 1 },
        },
        parts: [
          {
            id: `tray-edit-context-${index}-text`,
            messageID: `tray-edit-context-${index}`,
            sessionID,
            type: 'text',
            text: 'The build passed. The next step edits a source file after some reasoning. '.repeat(
              6
            ),
          },
        ],
      }));
      messages.unshift({
        info: {
          id: 'tray-edit-user',
          sessionID,
          role: 'user',
          time: { created: created - 1 },
          agent: 'build',
          model: { providerID: 'claude-agent', modelID: 'opus' },
        },
        parts: [
          {
            id: 'tray-edit-prompt',
            messageID: 'tray-edit-user',
            sessionID,
            type: 'text',
            text: 'Go.',
          },
        ],
      });
      await installPlaybackCapture(page, {
        session: {
          id: sessionID,
          projectID: 'project-test',
          directory: '/workspace',
          title: 'Tray to edit entrance',
          version: '1.0.0',
          time: { created, updated: created },
        },
        initialMessages: messages,
      });
      await page.goto('/e2e/harness/index.html?scenario=session-playback');
      const markerId = `tray-edit-context-${CONTEXT_MESSAGES - 1}`;
      await expect(page.locator(`[data-msg-id="${markerId}"]`)).toBeVisible();

      const messageID = 'tray-edit-step';
      const reasoning = (text: string, ended: boolean): Part => ({
        id: 'tray-edit-reasoning',
        messageID,
        sessionID,
        type: 'reasoning',
        text,
        time: ended ? { start: 1, end: 2 } : { start: 1 },
      });
      const edit: ToolPart = {
        id: 'tray-edit-call',
        messageID,
        sessionID,
        type: 'tool',
        tool: 'edit',
        callID: 'tray-edit-call',
        state: {
          status: 'running',
          input: { path: '/workspace/packages/util/src/bom.ts', oldString: 'a', newString: 'b' },
          title: 'edit',
          time: { start: 1 },
        },
      };
      const replay = (events: ServerEvent[]) =>
        page.evaluate((serverEvents) => {
          // SAFETY: The isolated E2E page installs this fixture-only transport.
          const harness = (
            window as Window & { __varroE2E?: { replayServerEvent(event: ServerEvent): void } }
          ).__varroE2E!;
          for (const event of serverEvents) harness.replayServerEvent(event);
        }, events);

      let text = 'I need the two edits to anchor on different text, or they will collide.';
      await replay([
        { type: 'session.status', properties: { sessionID, status: { type: 'busy' } } },
        {
          type: 'message.updated',
          properties: { info: { ...info, id: messageID, time: { created: Date.now() } } },
        },
        { type: 'message.part.updated', properties: { part: reasoning(text, false) } },
      ]);
      await expect(page.locator('.assistant-active-activity-tray')).toBeVisible();
      // Stream the reasoning as the provider does, then end it.
      for (let step = 0; step < 6; step++) {
        text += ' Then I will verify the line placement before moving on.';
        await replay([
          { type: 'message.part.updated', properties: { part: reasoning(text, false) } },
        ]);
        await waitForAnimationFrames(page, 3);
      }
      await replay([{ type: 'message.part.updated', properties: { part: reasoning(text, true) } }]);
      if (handoff === 'retained-tray') {
        // The edit arrives inside the completed reasoning's preview window.
        await waitForAnimationFrames(page, 4);
        await expect(page.locator('.assistant-active-activity-tray')).toBeVisible();
      } else {
        // The preview window ends first, so Thinking owns the slot when the edit arrives.
        await expect(page.locator('.assistant-active-activity-tray')).toHaveCount(0);
        await waitForAnimationFrames(page, 30);
      }

      const samples = await page.evaluate(
        async ({ part, marker }) => {
          // SAFETY: The isolated E2E page installs this fixture-only transport.
          const harness = (
            window as Window & { __varroE2E?: { replayServerEvent(event: ServerEvent): void } }
          ).__varroE2E!;
          const list = document.querySelector<HTMLElement>('.interactive-list')!;
          const markerRow = document.querySelector<HTMLElement>(`[data-msg-id="${marker}"]`)!;
          const sample = () => ({
            top: markerRow.getBoundingClientRect().top,
            scrollTop: list.scrollTop,
            range: list.scrollHeight - list.clientHeight,
          });
          const result = [sample()];
          harness.replayServerEvent({ type: 'message.part.updated', properties: { part } });
          for (let frame = 0; frame < 45; frame++) {
            await new Promise<void>((resolve) =>
              requestAnimationFrame(() => setTimeout(resolve, 0))
            );
            result.push(sample());
          }
          return result;
        },
        { part: edit, marker: markerId }
      );
      await expect(page.locator(`[data-msg-id="${messageID}"] .file-change-card`)).toHaveCount(1);
      expect(
        Math.max(...samples.slice(1).map((sample, index) => sample.top - samples[index]!.top)),
        JSON.stringify(samples)
      ).toBeLessThanOrEqual(0.5);
    }
  );
}
