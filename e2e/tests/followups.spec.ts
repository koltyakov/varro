import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import type { AssistantMessage, MessageEntry } from '../../src/webview/types';
import type { ServerEvent, WebviewMessage } from '../../src/shared/protocol';

const sessionId = 'followups-fixture';
const created = 1_780_000_000_000;
function assistant(id: string, parentID: string): AssistantMessage {
  return {
    id,
    parentID,
    sessionID: sessionId,
    role: 'assistant',
    mode: 'build',
    agent: 'build',
    providerID: 'test',
    modelID: 'test',
    time: { created, completed: created + 1 },
    finish: 'stop',
    path: { cwd: '/workspace', root: '/workspace' },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
}
function history(): MessageEntry[] {
  return Array.from({ length: 31 }, (_, i) => {
    const userId = i === 30 ? 'prompt' : `user-${i}`;
    const assistantId = i === 30 ? 'answer' : `assistant-${i}`;
    const user: MessageEntry = {
      info: {
        id: userId,
        sessionID: sessionId,
        role: 'user',
        agent: 'build',
        model: { providerID: 'test', modelID: 'test' },
        time: { created: created + i * 10 },
      },
      parts: [
        {
          id: `text-${userId}`,
          messageID: userId,
          sessionID: sessionId,
          type: 'text',
          text: 'Fix the parser and report any unresolved issues.',
        },
      ],
    };
    const answer: MessageEntry = {
      info:
        i === 30
          ? {
              ...assistant(assistantId, userId),
              time: { created: created + 300 },
              finish: undefined,
            }
          : assistant(assistantId, userId),
      parts: [
        {
          id: `text-${assistantId}`,
          messageID: assistantId,
          sessionID: sessionId,
          type: 'text',
          text:
            i === 30
              ? 'The empty-token parser issue remains unresolved.'
              : `Completed task ${i}.\n\n${'Verified the focused behavior and kept unrelated code unchanged. '.repeat(8)}`,
        },
      ],
    };
    return [user, answer];
  }).flat();
}

for (const width of [480, 1280]) {
  for (const position of ['followed', 'detached', 'near-bottom']) {
    const detached = position !== 'followed';
    test(`follow-ups preserve ${position} geometry at ${width}px and send or dismiss directly`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 850 });
      await page.addInitScript(
        (capture) => {
          // SAFETY: Only the isolated playback harness consumes this generated fixture.
          (
            window as typeof window & { varroPlaybackCapture: typeof capture }
          ).varroPlaybackCapture = capture;
        },
        {
          session: {
            id: sessionId,
            projectID: 'test',
            directory: '/workspace',
            title: 'Follow-ups fixture',
            version: '1',
            time: { created, updated: created },
          },
          initialMessages: history(),
        }
      );
      await page.goto('/e2e/harness/index.html?scenario=session-playback');
      const composer = page.getByRole('textbox', { name: 'Message composer' }).first();
      await expect(composer).toBeVisible();
      await page.evaluate(() => {
        // SAFETY: These hooks belong only to the fake extension transport and replay fixture.
        const harness = window as {
          __sendToExtension?: (message: WebviewMessage) => void;
        };
        const send = harness.__sendToExtension;
        harness.__sendToExtension = (message) => {
          if (
            message.type === 'api/request' &&
            /\/prompt_async(?:\?|$)/.test(message.payload.path)
          ) {
            document.documentElement.dataset.followupSentBody = JSON.stringify(
              message.payload.body
            );
            // Keep admission slow enough to paint the optimistic-to-canonical handoff.
            window.setTimeout(() => send?.(message), 120);
            return;
          }
          if (
            message.type === 'api/request' &&
            /\/followups\/dismiss(?:\?|$)/.test(message.payload.path)
          ) {
            document.documentElement.dataset.followupDismissed = 'true';
            window.dispatchEvent(
              new MessageEvent('message', {
                data: { type: 'api/response', payload: { id: message.payload.id, data: true } },
              })
            );
            return;
          }
          if (message.type === 'api/request' && /\/followups(?:\?|$)/.test(message.payload.path)) {
            // SAFETY: This intercepted request is emitted only by the typed follow-ups client.
            const allowGenerate = (message.payload.body as { allowGenerate?: boolean })
              .allowGenerate;
            const cached = document.documentElement.dataset.followupCachedSuggestions;
            if (cached && !allowGenerate) {
              window.dispatchEvent(
                new MessageEvent('message', {
                  data: {
                    type: 'api/response',
                    payload: { id: message.payload.id, data: JSON.parse(cached) },
                  },
                })
              );
              return;
            }
            document.documentElement.dataset.followupRequestId = String(message.payload.id);
            document.documentElement.dataset.followupGenerate = String(allowGenerate);
            return;
          }
          send?.(message);
        };
        window.dispatchEvent(
          new MessageEvent('message', {
            data: {
              type: 'server/status',
              payload: { state: 'running', url: 'mock://opencode', apiVersion: 2 },
            },
          })
        );
        window.dispatchEvent(
          new MessageEvent('message', {
            data: {
              type: 'config/update',
              payload: {
                followupModel: 'test/small',
                desktopSessionPaneSide: 'right',
                defaultPermissionMode: 'default',
                chatFontSize: 13,
                chatEditorFontSize: 12,
                chatFontFamily: 'default',
              },
            },
          })
        );
      });
      await expect(page.locator('[data-msg-id="answer"]')).toBeVisible();
      await expect(page.locator('html')).not.toHaveAttribute('data-followup-request-id');
      await composer.fill('Keep this unrelated draft');
      await page.evaluate(() => {
        // SAFETY: Replay status events update only the generated fixture.
        const harness = (
          window as typeof window & { __varroE2E: { replayServerEvent(event: ServerEvent): void } }
        ).__varroE2E;
        harness.replayServerEvent({
          type: 'session.status',
          properties: { sessionID: 'followups-fixture', status: { type: 'busy' } },
        });
      });
      await expect(
        page.locator('[data-msg-id="answer"] .assistant-message-flow-item-final')
      ).toHaveCount(0);
      await page.evaluate(
        (info) => {
          // SAFETY: Settle the observed live turn in the fake backend, without running any model.
          const harness = (
            window as typeof window & {
              __varroE2E: { replayServerEvent(event: ServerEvent): void };
            }
          ).__varroE2E;
          harness.replayServerEvent({ type: 'message.updated', properties: { info } });
          harness.replayServerEvent({
            type: 'session.status',
            properties: { sessionID: 'followups-fixture', status: { type: 'idle' } },
          });
        },
        assistant('answer', 'prompt')
      );
      await expect(page.locator('html')).toHaveAttribute('data-followup-request-id', /\d+/);
      await expect(page.locator('html')).toHaveAttribute('data-followup-generate', 'true');
      const list = page.locator('.interactive-list');
      if (detached) {
        await list.hover();
        await page.mouse.wheel(0, -600);
        await expect(page.getByRole('button', { name: 'Scroll to latest message' })).toBeVisible();
        await page.waitForTimeout(300);
      }
      const before = await list.evaluate((element) => {
        const row = Array.from(element.querySelectorAll<HTMLElement>('[data-msg-id]')).find(
          (candidate) =>
            candidate.getBoundingClientRect().top >= element.getBoundingClientRect().top
        );
        return { id: row?.dataset.msgId, top: row?.getBoundingClientRect().top };
      });
      await page.evaluate(() => {
        const suggestions = {
          summary:
            'The empty-token parser issue is still unresolved, and focused regression coverage is missing. Investigating the failure and adding a test would address the reported gaps.',
          actions: [
            {
              title: 'Inspect parser failures',
              prompt:
                'Investigate the reported empty-token parser issue without unrelated changes.',
            },
            {
              title: 'Add regression coverage',
              prompt: 'Add focused regression tests for empty tokens.',
            },
            {
              title: 'Explain the blocker',
              prompt: 'Explain the remaining parser blocker without editing.',
            },
          ],
        };
        // Send validation reads the same result without admitting another generation.
        document.documentElement.dataset.followupCachedSuggestions = JSON.stringify(suggestions);
        window.dispatchEvent(
          new MessageEvent('message', {
            data: {
              type: 'api/response',
              payload: {
                id: Number(document.documentElement.dataset.followupRequestId),
                data: suggestions,
              },
            },
          })
        );
      });
      const suggestions = page.getByRole('group', { name: 'Suggested next actions' });
      await expect(suggestions).toBeVisible();
      await expect(suggestions.locator('.followup-suggestions-actions button')).toHaveCount(3);
      await expect(suggestions.locator('.followup-suggestions-summary')).toContainText(
        'The empty-token parser issue is still unresolved'
      );
      const close = suggestions.getByRole('button', { name: 'Dismiss follow-ups' });
      await expect(close.locator('.ui-icon')).toHaveCount(1);
      await expect(close).toHaveText('');
      const closeOffsets = await suggestions.evaluate((card) => {
        const cardBox = card.getBoundingClientRect();
        const closeBox = card.querySelector('.followup-dismiss')!.getBoundingClientRect();
        return { top: closeBox.y - cardBox.y, right: cardBox.right - closeBox.right };
      });
      expect(Math.abs(closeOffsets.top - 5)).toBeLessThanOrEqual(1);
      expect(Math.abs(closeOffsets.right - 5)).toBeLessThanOrEqual(1);
      const firstAction = suggestions.getByRole('button', {
        name: 'Inspect parser failures',
        exact: true,
      });
      await expect(firstAction).not.toHaveAttribute('title');
      await expect(composer).toHaveText('Keep this unrelated draft');
      if (detached && before.id) {
        const after = await list
          .locator(`[data-msg-id="${before.id}"]`)
          .evaluate((element) => element.getBoundingClientRect().top);
        expect(Math.abs(after - before.top!)).toBeLessThanOrEqual(1);
      } else {
        await expect
          .poll(() =>
            list.evaluate(
              (element) => element.scrollHeight - element.scrollTop - element.clientHeight
            )
          )
          .toBeLessThanOrEqual(1);
      }
      await firstAction.hover();
      await expect(page.getByRole('tooltip')).toContainText(
        'Investigate the reported empty-token parser issue'
      );
      await composer.hover();
      await expect(page.getByRole('tooltip')).not.toBeVisible();
      await page.screenshot({ path: testInfo.outputPath('followup-summary.png') });
      if (position === 'followed') {
        for (const [index, title] of [
          'Inspect parser failures',
          'Add regression coverage',
        ].entries()) {
          await suggestions
            .getByRole('button', { name: title, exact: true })
            .click({ button: 'right' });
          const menu = page.getByRole('menu', { name: 'Follow-up actions' });
          await expect(menu.getByRole('menuitem', { name: 'Copy description' })).toBeVisible();
          const bounds = await menu.boundingBox();
          expect(bounds).not.toBeNull();
          expect(bounds!.x).toBeGreaterThanOrEqual(8);
          expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width - 8);
          expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(850 - 8);
          await menu.getByRole('menuitem', { name: 'Add to queue (paused)', exact: true }).click();
          const queue = page.getByRole('list', { name: 'Queued messages', exact: true });
          await expect(queue.locator('.chat-queue-item.is-paused')).toHaveCount(index + 1);
          await expect(
            queue.getByRole('button', { name: 'Play queued message', exact: true })
          ).toHaveCount(index + 1);
          await expect(suggestions).toBeVisible();
          await expect(composer).toHaveText('Keep this unrelated draft');
          await expect(page.locator('html')).not.toHaveAttribute('data-followup-sent-body');
          await expect(page.locator('html')).not.toHaveAttribute('data-followup-dismissed');
        }
        await page.screenshot({ path: testInfo.outputPath('followup-paused-queue.png') });
      }
      if (position === 'near-bottom') {
        await list.hover();
        await page.mouse.wheel(0, 1600);
        await expect
          .poll(() =>
            list.evaluate(
              (element) => element.scrollHeight - element.clientHeight - element.scrollTop
            )
          )
          .toBeLessThanOrEqual(1);
        await page.waitForTimeout(250);
        await list.hover({ position: { x: 16, y: 60 } });
        await page.mouse.wheel(0, -32);
        await expect
          .poll(() =>
            list.evaluate(
              (element) => element.scrollHeight - element.clientHeight - element.scrollTop
            )
          )
          .toBeGreaterThan(16);
        const marker = page.getByText('The empty-token parser issue remains unresolved.', {
          exact: true,
        });
        await expect(marker).toBeVisible();
        const beforeTop = await marker.evaluate((element) => element.getBoundingClientRect().top);
        const closeBox = await close.boundingBox();
        expect(closeBox).not.toBeNull();
        // Locator clicks may scroll a detached transcript before pointer input. Exercise the
        // already-painted close control without Playwright changing the reading position.
        await page.mouse.click(
          closeBox!.x + closeBox!.width / 2,
          closeBox!.y + closeBox!.height / 2
        );
        await expect(suggestions).not.toBeVisible();
        const tops = await marker.evaluate(
          (element) =>
            new Promise<number[]>((resolve) => {
              const values: number[] = [];
              const sample = () => {
                values.push(element.getBoundingClientRect().top);
                if (values.length === 20) resolve(values);
                else requestAnimationFrame(sample);
              };
              requestAnimationFrame(sample);
            })
        );
        await writeFile(
          testInfo.outputPath('near-bottom-dismissal.json'),
          JSON.stringify({ beforeTop, tops }, null, 2)
        );
        expect(Math.max(...tops.map((top) => Math.abs(top - beforeTop)))).toBeLessThanOrEqual(1);
        await list.hover({ position: { x: 16, y: 60 } });
        await page.mouse.wheel(0, -96);
        await expect
          .poll(() => marker.evaluate((element) => element.getBoundingClientRect().top))
          .toBeGreaterThan(beforeTop + 80);
        const detachedTop = await marker.evaluate((element) => element.getBoundingClientRect().top);
        await page.waitForTimeout(250);
        expect(
          Math.abs(
            (await marker.evaluate((element) => element.getBoundingClientRect().top)) - detachedTop
          )
        ).toBeLessThanOrEqual(1);
        return;
      }
      await page.evaluate(() => {
        const frames: Array<{ card: boolean; action: number; rawPrompt: boolean }> = [];
        const nodes = new Map<Element, number>();
        const start = performance.now();
        const sample = () => {
          const action = document.querySelector('.followup-action');
          if (action && !nodes.has(action)) nodes.set(action, nodes.size + 1);
          frames.push({
            card: !!document.querySelector('.followup-suggestions'),
            action: action ? nodes.get(action)! : 0,
            rawPrompt: Array.from(document.querySelectorAll('.user-message-text')).some((element) =>
              element.textContent?.includes('Investigate the reported empty-token parser issue')
            ),
          });
          if (performance.now() - start < 650) requestAnimationFrame(sample);
          else document.documentElement.dataset.followupSendFrames = JSON.stringify(frames);
        };
        requestAnimationFrame(sample);
      });
      await page.getByRole('button', { name: 'Inspect parser failures', exact: true }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(page.locator('html')).toHaveAttribute(
        'data-followup-sent-body',
        /Investigate the reported empty-token parser issue without unrelated changes\./
      );
      await expect(composer).toHaveText('Keep this unrelated draft');
      await expect(suggestions).not.toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-followup-dismissed', 'true');
      const action = page.locator('.followup-action');
      await expect(action).toBeVisible();
      await expect(action).toHaveText('Inspect parser failures');
      await expect(action).toHaveClass(/user-message-card-wrapperless/);
      await expect(action).not.toHaveClass(/user-message-card-editable/);
      await expect(action).toHaveCSS('border-top-width', '0px');
      await expect(action.locator('.user-message-text-scroll, .prompt-number-badge')).toHaveCount(
        0
      );
      await page.screenshot({ path: testInfo.outputPath('followup-action.png') });
      await expect(page.locator('html')).toHaveAttribute('data-followup-send-frames', /./);
      const frames: Array<{ card: boolean; action: number; rawPrompt: boolean }> = JSON.parse(
        (await page.locator('html').getAttribute('data-followup-send-frames'))!
      );
      await testInfo.attach('followup-send-frames', {
        body: JSON.stringify(frames),
        contentType: 'application/json',
      });
      await writeFile(
        testInfo.outputPath('followup-send-frames.json'),
        JSON.stringify(frames, null, 2)
      );
      expect(frames.some((frame) => frame.action > 0 && frame.card)).toBe(false);
      expect(frames.some((frame) => frame.rawPrompt)).toBe(false);
      const firstActionFrame = frames.findIndex((frame) => frame.action > 0);
      expect(firstActionFrame).toBeGreaterThanOrEqual(0);
      expect(new Set(frames.slice(firstActionFrame).map((frame) => frame.action)).size).toBe(1);
    });
  }
}
