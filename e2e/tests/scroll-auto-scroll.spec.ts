import { expect, test } from '@playwright/test';
import {
  getScrollMetrics,
  getVisibleMessageAnchor,
  sampleMessageTopAcrossFrames,
  waitForAnimationFrame,
  waitForAnimationFrames,
} from './helpers';
import { appendDeltaToLastLargeAssistant, appendDeltaToRapidStreaming } from './scroll-helpers';

test.describe('auto-scroll', () => {
  test('starts at the bottom of the conversation', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=large-transcript');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);
  });

  test('starts an active reasoning row without a full-shell jump', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('varro.showThinking', 'true'));
    await page.goto('/e2e/harness/index.html?scenario=large-transcript&activeReasoningEntrance=1');
    const previousMessage = page.locator('[data-msg-id="message-large-assistant-238"]');
    await expect(page.locator('.interactive-list-track')).toHaveClass(/virtualized/);
    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(2);
    await expect(page.locator('.interactive-loading-row .loading-indicator')).toBeVisible();
    await waitForAnimationFrames(page, 4);

    const previousTop = await previousMessage.evaluate((element) => {
      const container = element.closest<HTMLElement>('.interactive-list')!;
      return element.getBoundingClientRect().top - container.getBoundingClientRect().top;
    });
    await page.evaluate(() => {
      const container = document.querySelector<HTMLElement>('.interactive-list')!;
      const anchor = container.querySelector<HTMLElement>(
        '[data-msg-id="message-large-assistant-238"]'
      )!;
      const samples: Array<{
        top: number;
        entering: boolean;
        rowHeight: number;
      }> = [];
      const sample = () => {
        const item = container.querySelector<HTMLElement>(
          '[data-activity-part-id="reasoning-bottom-follow"]'
        );
        const row = item?.closest<HTMLElement>('[data-msg-id]');
        samples.push({
          top: anchor.getBoundingClientRect().top - container.getBoundingClientRect().top,
          entering: item?.classList.contains('is-entering') ?? false,
          rowHeight: row?.getBoundingClientRect().height ?? 0,
        });
        if (samples.length < 16) requestAnimationFrame(sample);
        else {
          (
            window as typeof window & { reasoningEntranceSamples?: typeof samples }
          ).reasoningEntranceSamples = samples;
        }
      };
      const observer = new MutationObserver(() => {
        if (!container.querySelector('[data-activity-part-id="reasoning-bottom-follow"]')) {
          return;
        }
        observer.disconnect();
        sample();
      });
      observer.observe(container, { childList: true, subtree: true });
    });

    await page.evaluate(() => {
      const sessionID = 'session-large-transcript';
      const messageID = 'message-large-assistant-active';
      const harnessWindow = window as typeof window & {
        __varroE2E?: { updateMessagePart?: (part: Record<string, unknown>) => void };
      };
      const part = {
        id: 'reasoning-bottom-follow',
        sessionID,
        messageID,
        type: 'reasoning' as const,
        text: 'Planning offscreen message expansion',
        time: { start: Date.now() },
      };
      harnessWindow.__varroE2E?.updateMessagePart?.(part);
      window.postMessage(
        { type: 'server/event', payload: { type: 'message.part.updated', properties: { part } } },
        '*'
      );
    });

    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as typeof window & { reasoningEntranceSamples?: unknown })
              .reasoningEntranceSamples
        )
      )
      .not.toBeUndefined();
    const samples = await page.evaluate(
      () =>
        (
          window as typeof window & {
            reasoningEntranceSamples?: Array<{
              top: number;
              entering: boolean;
              rowHeight: number;
            }>;
          }
        ).reasoningEntranceSamples ?? []
    );
    expect(samples.some((sample) => sample.entering)).toBe(true);
    expect(samples[0]!.rowHeight).toBeLessThanOrEqual(1);
    expect(Math.abs(samples[0]!.top - previousTop)).toBeLessThanOrEqual(1);
    for (let index = 1; index < samples.length; index += 1) {
      const movement = samples[index - 1]!.top - samples[index]!.top;
      expect(movement, JSON.stringify({ previousTop, samples })).toBeGreaterThanOrEqual(-1);
      expect(movement, JSON.stringify({ previousTop, samples })).toBeLessThan(30);
    }
  });

  test('keeps the transcript fixed when Thinking becomes Worked', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=large-transcript&activeReasoningEntrance=1');
    await expect(page.locator('.interactive-list-track')).toHaveClass(/virtualized/);
    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(2);

    await page.evaluate(() => {
      const sessionID = 'session-large-transcript';
      const messageID = 'message-large-assistant-active';
      const harness = (
        window as Window & {
          __varroE2E?: { updateMessagePart?: (part: Record<string, unknown>) => void };
        }
      ).__varroE2E;
      const part = {
        id: 'text-bottom-follow-final',
        sessionID,
        messageID,
        type: 'text',
        text: 'Final response before completion.',
        time: { start: Date.now(), end: Date.now() },
      };
      harness?.updateMessagePart?.(part);
      window.postMessage(
        { type: 'server/event', payload: { type: 'message.part.updated', properties: { part } } },
        '*'
      );
    });
    await expect(
      page.getByText('Final response before completion.', { exact: true })
    ).toBeVisible();
    await waitForAnimationFrames(page, 15);
    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(2);

    await page.evaluate(() => {
      const sessionID = 'session-large-transcript';
      const messageID = 'message-large-assistant-active';
      const harnessWindow = window as Window & {
        completionSlotSamples?: Array<{ top: number; slotHeight: number }>;
        __varroE2E?: {
          getSessionMessages?: (sessionId: string) => Array<{ info: Record<string, unknown> }>;
          updateMessageInfo?: (info: Record<string, unknown>) => void;
          updateSessionStatus?: (sessionId: string, status: { type: string }) => void;
        };
      };
      const harness = harnessWindow.__varroE2E;
      const container = document.querySelector<HTMLElement>('.interactive-list')!;
      const anchor = container.querySelector<HTMLElement>(
        '[data-msg-id="message-large-assistant-238"]'
      )!;
      const samples: Array<{ top: number; slotHeight: number }> = [];
      const sample = () => {
        samples.push({
          top: anchor.getBoundingClientRect().top - container.getBoundingClientRect().top,
          slotHeight:
            container
              .querySelector<HTMLElement>('.interactive-loading-row')
              ?.getBoundingClientRect().height ?? 0,
        });
        if (samples.length < 12) requestAnimationFrame(sample);
        else harnessWindow.completionSlotSamples = samples;
      };
      sample();

      const current = harness
        ?.getSessionMessages?.(sessionID)
        .find((entry) => entry.info.id === messageID)?.info;
      if (!current) throw new Error('Active assistant message is missing');
      const info = {
        ...current,
        time: { ...(current.time as object), completed: Date.now() },
      };
      harness?.updateMessageInfo?.(info);
      harness?.updateSessionStatus?.(sessionID, { type: 'idle' });
      window.postMessage(
        { type: 'server/event', payload: { type: 'message.updated', properties: { info } } },
        '*'
      );
      window.postMessage(
        {
          type: 'server/event',
          payload: {
            type: 'session.status',
            properties: { sessionID, status: { type: 'idle' } },
          },
        },
        '*'
      );
    });

    await expect
      .poll(() =>
        page.evaluate(
          () => (window as Window & { completionSlotSamples?: unknown }).completionSlotSamples
        )
      )
      .not.toBeUndefined();
    const samples = await page.evaluate(
      () =>
        (
          window as Window & {
            completionSlotSamples?: Array<{ top: number; slotHeight: number }>;
          }
        ).completionSlotSamples ?? []
    );
    expect(
      samples.every((sample) => Math.abs(sample.top - samples[0]!.top) <= 1),
      JSON.stringify(samples)
    ).toBe(true);
    expect(new Set(samples.map((sample) => Math.round(sample.slotHeight))).size).toBe(1);
    await expect(page.locator('.trailing-assistant-summary-row')).toContainText('Worked for');
  });

  test('keeps the transcript fixed while an edited message is replaced', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=large-transcript');
    await expect(page.locator('.interactive-list-track')).toHaveClass(/virtualized/);
    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(2);

    const prompt = 'Review large transcript section 239 and keep the UI responsive.';
    await page
      .locator('[data-msg-id="message-large-user-239"]')
      .getByText(prompt, { exact: true })
      .click();
    const inlineComposer = page.locator(
      '.inline-edit-composer-slot [role="textbox"][aria-multiline="true"]'
    );
    await expect(inlineComposer).toBeVisible();
    await inlineComposer.fill('Corrected final prompt without a viewport jump.');
    await waitForAnimationFrames(page, 6);

    await page.evaluate(() => {
      const harness = window as Window & {
        __sendToExtension?: (message: unknown) => void | Promise<void>;
        editReplacementSamples?: Array<{
          top: number;
          editing: boolean;
          reserveHeight: number;
          replacementVisible: boolean;
        }>;
      };
      const originalSend = harness.__sendToExtension;
      let delayedDelete = false;
      let replacementMessageId: string | null = null;
      harness.__sendToExtension = async (message) => {
        const request = message as {
          type?: string;
          payload?: {
            method?: string;
            path?: string;
            body?: { messageID?: string };
          };
        };
        const isMessageDelete =
          request.type === 'api/request' &&
          request.payload?.method === 'DELETE' &&
          request.payload.path?.includes('/message/');
        if (!delayedDelete && isMessageDelete) {
          delayedDelete = true;
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        if (
          request.type === 'api/request' &&
          request.payload?.method === 'POST' &&
          request.payload.path?.endsWith('/prompt_async')
        ) {
          replacementMessageId = request.payload.body?.messageID ?? null;
        }
        await originalSend?.(message);
        if (isMessageDelete) {
          const match = request.payload?.path?.match(/^\/session\/([^/]+)\/message\/([^/]+)$/);
          if (!match) throw new Error('Edited-message delete path is invalid');
          window.postMessage(
            {
              type: 'server/event',
              payload: {
                type: 'message.removed',
                properties: {
                  sessionID: decodeURIComponent(match[1]!),
                  messageID: decodeURIComponent(match[2]!),
                },
              },
            },
            '*'
          );
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
      };

      const container = document.querySelector<HTMLElement>('.interactive-list')!;
      const anchor = container.querySelector<HTMLElement>(
        '[data-msg-id="message-large-assistant-238"]'
      )!;
      const samples: Array<{
        top: number;
        editing: boolean;
        reserveHeight: number;
        replacementVisible: boolean;
      }> = [];
      let replacementVisibleFrames = 0;
      const scheduleSample = () => {
        // Sample after all frame callbacks so pre-paint anchor corrections are included.
        requestAnimationFrame(() => setTimeout(sample, 0));
      };
      const sample = () => {
        const replacementVisible =
          replacementMessageId !== null &&
          [...container.querySelectorAll<HTMLElement>('[data-msg-id]')].some(
            (element) => element.dataset.msgId === replacementMessageId
          );
        const reserveHeight =
          container
            .querySelector<HTMLElement>('.append-scroll-bottom-reserve')
            ?.getBoundingClientRect().height ?? 0;
        samples.push({
          top: anchor.getBoundingClientRect().top - container.getBoundingClientRect().top,
          editing: container.classList.contains('editing-message'),
          reserveHeight,
          replacementVisible,
        });
        replacementVisibleFrames = replacementVisible ? replacementVisibleFrames + 1 : 0;
        if (samples.length < 120 && replacementVisibleFrames < 12) scheduleSample();
        else harness.editReplacementSamples = samples;
      };
      sample();
    });

    await inlineComposer.press('Enter');
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as Window & { editReplacementSamples?: unknown }).editReplacementSamples
        )
      )
      .not.toBeUndefined();
    const samples = await page.evaluate(
      () =>
        (
          window as Window & {
            editReplacementSamples?: Array<{
              top: number;
              editing: boolean;
              reserveHeight: number;
              replacementVisible: boolean;
            }>;
          }
        ).editReplacementSamples ?? []
    );
    expect(
      samples.every((sample) => Math.abs(sample.top - samples[0]!.top) <= 1),
      JSON.stringify(samples)
    ).toBe(true);
    expect(samples[0]?.editing).toBe(true);
    expect(
      samples.some((sample) => sample.replacementVisible),
      JSON.stringify(samples)
    ).toBe(true);
    expect(
      samples.every((sample) => sample.editing || sample.replacementVisible),
      JSON.stringify(samples)
    ).toBe(true);
    await expect(
      page.getByText('Corrected final prompt without a viewport jump.', { exact: true })
    ).toBeVisible();
    await expect(page.locator('.interactive-list')).not.toHaveClass(/editing-message/);
    await expect(page.locator('.append-scroll-bottom-reserve')).toHaveCount(0);
    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(2);
  });

  test('keeps the transcript fixed when streamed text moves reasoning into Explored', async ({
    page,
  }) => {
    await page.addInitScript(() => localStorage.setItem('varro.showThinking', 'true'));
    await page.goto('/e2e/harness/index.html?scenario=large-transcript&activeReasoningEntrance=1');
    const anchor = page.locator('[data-msg-id="message-large-assistant-238"]');
    const activeReasoning = page.locator('[data-activity-part-id="reasoning-stream-to-text"]');
    await expect(page.locator('.interactive-list-track')).toHaveClass(/virtualized/);
    await expect
      .poll(() =>
        getScrollMetrics(page, '.interactive-list').then((metrics) => metrics.distanceFromBottom)
      )
      .toBeLessThan(2);

    await page.evaluate(() => {
      const part = {
        id: 'reasoning-stream-to-text',
        sessionID: 'session-large-transcript',
        messageID: 'message-large-assistant-active',
        type: 'reasoning' as const,
        text: 'Preparing the streamed response.',
        time: { start: Date.now() },
      };
      const harness = (
        window as typeof window & {
          __varroE2E?: { updateMessagePart?: (updatedPart: Record<string, unknown>) => void };
        }
      ).__varroE2E;
      harness?.updateMessagePart?.(part);
      window.postMessage(
        { type: 'server/event', payload: { type: 'message.part.updated', properties: { part } } },
        '*'
      );
    });

    await expect(activeReasoning).toBeVisible();
    await activeReasoning.evaluate(async (element) => {
      await Promise.all(element.getAnimations().map((animation) => animation.finished));
    });
    const beforeTop = await anchor.evaluate((element) => {
      const container = element.closest<HTMLElement>('.interactive-list')!;
      return element.getBoundingClientRect().top - container.getBoundingClientRect().top;
    });

    const samples = await anchor.evaluate(async (element) => {
      const container = element.closest<HTMLElement>('.interactive-list')!;
      const harness = (
        window as typeof window & {
          __varroE2E?: {
            getSessionMessages?: (
              sessionId: string
            ) => Array<{ parts: Array<Record<string, unknown>> }>;
            updateMessagePart?: (updatedPart: Record<string, unknown>) => void;
          };
        }
      ).__varroE2E;
      const reasoning = harness
        ?.getSessionMessages?.('session-large-transcript')
        .flatMap((message) => message.parts)
        .find((part) => part.id === 'reasoning-stream-to-text');
      if (!reasoning) throw new Error('Active reasoning fixture is missing');

      const textPart = {
        id: 'text-stream-after-reasoning',
        sessionID: 'session-large-transcript',
        messageID: 'message-large-assistant-active',
        type: 'text' as const,
        text: '',
      };
      harness?.updateMessagePart?.(textPart);
      window.postMessage(
        {
          type: 'server/event',
          payload: { type: 'message.part.updated', properties: { part: textPart } },
        },
        '*'
      );
      window.postMessage(
        {
          type: 'server/event',
          payload: {
            type: 'message.part.delta',
            properties: {
              sessionID: textPart.sessionID,
              messageID: textPart.messageID,
              partID: textPart.id,
              field: 'text',
              delta: 'Answer.',
            },
          },
        },
        '*'
      );
      const completedReasoning = {
        ...reasoning,
        time: { ...(reasoning.time as object), end: Date.now() },
      };
      harness?.updateMessagePart?.(completedReasoning);
      window.postMessage(
        {
          type: 'server/event',
          payload: {
            type: 'message.part.updated',
            properties: { part: completedReasoning },
          },
        },
        '*'
      );

      const tops: number[] = [];
      for (let frame = 0; frame < 90; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        tops.push(element.getBoundingClientRect().top - container.getBoundingClientRect().top);
      }
      return tops;
    });

    expect(
      samples.every((top) => Math.abs(top - beforeTop) <= 1.5),
      JSON.stringify({ beforeTop, samples })
    ).toBe(true);
    await expect(activeReasoning).toHaveCount(0);
    await expect(page.locator('.assistant-activity-summary').last()).toContainText('Explored');
  });

  test('does not push a full transcript backward when send-time panels collapse', async ({
    page,
  }) => {
    await page.goto('/e2e/harness/index.html?scenario=large-transcript');
    const composer = page.locator('[role="textbox"][aria-multiline="true"]').first();
    await expect(page.locator('.interactive-list-track')).toHaveClass(/virtualized/);
    await expect
      .poll(() =>
        getScrollMetrics(page, '.interactive-list').then((metrics) => metrics.distanceFromBottom)
      )
      .toBeLessThan(2);

    await page.evaluate(() => {
      window.postMessage(
        {
          type: 'server/event',
          payload: {
            type: 'todo.updated',
            properties: {
              sessionID: 'session-large-transcript',
              todos: [
                {
                  content: 'Completed work from the previous turn',
                  status: 'completed',
                  priority: 'medium',
                },
              ],
            },
          },
        },
        '*'
      );
    });
    await expect(page.getByRole('button', { name: /Todos/i })).toBeVisible();
    await expect
      .poll(() =>
        getScrollMetrics(page, '.interactive-list').then((metrics) => metrics.distanceFromBottom)
      )
      .toBeLessThan(2);
    await waitForAnimationFrames(page, 6);

    await composer.fill(
      Array.from(
        { length: 8 },
        (_, index) => `Keep the full transcript stable while sending, line ${index + 1}.`
      ).join('\n')
    );
    await expect
      .poll(() =>
        getScrollMetrics(page, '.interactive-list').then((metrics) => metrics.distanceFromBottom)
      )
      .toBeLessThan(2);
    await waitForAnimationFrames(page, 6);
    await page.evaluate(() => {
      const harness = window as Window & {
        __sendToExtension?: (message: unknown) => void | Promise<void>;
        sendTransitionSamples?: Array<{ previousTop: number; entering: boolean }>;
      };
      const originalSend = harness.__sendToExtension;
      harness.__sendToExtension = async (message) => {
        const request = message as { type?: string; payload?: { path?: string } };
        if (request.type === 'api/request' && request.payload?.path?.endsWith('/prompt_async')) {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        await originalSend?.(message);
      };

      const container = document.querySelector<HTMLElement>('.interactive-list')!;
      const previousMessage = container.querySelector<HTMLElement>(
        '[data-msg-id="message-large-assistant-239"]'
      )!;
      const previousIds = new Set(
        [...container.querySelectorAll<HTMLElement>('[data-msg-id]')].map(
          (row) => row.dataset.msgId
        )
      );
      const samples: Array<{ previousTop: number; entering: boolean }> = [
        {
          previousTop:
            previousMessage.getBoundingClientRect().top - container.getBoundingClientRect().top,
          entering: false,
        },
      ];
      const observer = new MutationObserver(() => {
        const appended = [...container.querySelectorAll<HTMLElement>('[data-msg-id]')].find(
          (row) => !previousIds.has(row.dataset.msgId)
        );
        if (!appended) return;
        observer.disconnect();

        const sample = () => {
          samples.push({
            previousTop:
              previousMessage.getBoundingClientRect().top - container.getBoundingClientRect().top,
            entering: appended.classList.contains('measured-entrance-active'),
          });
          if (samples.length < 25) requestAnimationFrame(sample);
          else harness.sendTransitionSamples = samples;
        };
        requestAnimationFrame(sample);
      });
      observer.observe(container, { childList: true, subtree: true });
    });

    await page.getByTitle('Send (Enter)').click();
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as Window & { sendTransitionSamples?: unknown }).sendTransitionSamples
        )
      )
      .not.toBeUndefined();

    const samples = await page.evaluate(
      () =>
        (
          window as Window & {
            sendTransitionSamples?: Array<{ previousTop: number; entering: boolean }>;
          }
        ).sendTransitionSamples ?? []
    );
    const previousTops = samples.map((sample) => sample.previousTop);
    for (let index = 1; index < previousTops.length; index += 1) {
      expect(previousTops[index]!).toBeLessThanOrEqual(previousTops[index - 1]! + 1);
      expect(previousTops[index - 1]! - previousTops[index]!).toBeLessThan(30);
    }
    expect(samples.every((sample) => !sample.entering)).toBe(true);
    await expect(page.locator('.chat-turn-user').last()).toContainText(
      'Keep the full transcript stable while sending, line 1.'
    );
    await expect(page.locator('.append-scroll-bottom-reserve')).toHaveCount(0);
    await expect
      .poll(() =>
        getScrollMetrics(page, '.interactive-list').then((metrics) => metrics.distanceFromBottom)
      )
      .toBeLessThan(15);
  });

  test('keeps the transcript anchored when the todo list collapses', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=large-transcript');
    const list = page.locator('.interactive-list');
    const previousMessage = page.locator('[data-msg-id="message-large-assistant-239"]');
    await expect(page.locator('.interactive-list-track')).toHaveClass(/virtualized/);

    await page.evaluate(() => {
      window.postMessage(
        {
          type: 'server/event',
          payload: {
            type: 'todo.updated',
            properties: {
              sessionID: 'session-large-transcript',
              todos: Array.from({ length: 7 }, (_, index) => ({
                content: `Remaining work item ${index + 1}`,
                status: index === 0 ? 'in_progress' : 'pending',
                priority: 'medium',
              })),
            },
          },
        },
        '*'
      );
    });

    const todoBlock = page.locator('.todo-block:not(.changed-files-block)');
    const todoToggle = page.getByRole('button', { name: /Todos/i });
    const getTodoListGeometry = () =>
      todoBlock.evaluate((block) => {
        const todoList = block.querySelector<HTMLElement>('.todo-block-list');
        if (!todoList) throw new Error('Expanded todo list is missing');
        return {
          rightInset: block.getBoundingClientRect().right - todoList.getBoundingClientRect().right,
          clientHeight: todoList.clientHeight,
          scrollHeight: todoList.scrollHeight,
        };
      });
    await expect(todoToggle).toHaveAttribute('aria-expanded', 'true');
    const initialTodoGeometry = await getTodoListGeometry();
    expect(initialTodoGeometry.scrollHeight).toBeGreaterThan(initialTodoGeometry.clientHeight);
    expect(initialTodoGeometry.rightInset).toBeCloseTo(2, 1);
    await expect
      .poll(() =>
        getScrollMetrics(page, '.interactive-list').then((metrics) => metrics.distanceFromBottom)
      )
      .toBeLessThan(2);
    await waitForAnimationFrames(page, 6);

    const previousTop = await previousMessage.evaluate(
      (element) =>
        element.getBoundingClientRect().top -
        element.closest('.interactive-list')!.getBoundingClientRect().top
    );
    await todoToggle.click();

    const samples = await sampleMessageTopAcrossFrames(list, 'message-large-assistant-239', 12);
    expect(
      samples.every((sample) => sample !== null && Math.abs(sample - previousTop) <= 1),
      JSON.stringify({ previousTop, samples })
    ).toBe(true);
    await expect(todoToggle).toHaveAttribute('aria-expanded', 'false');
    const reserve = page.locator('.append-scroll-bottom-reserve');
    await expect(reserve).toBeVisible();
    const firstReserveHeight = await reserve.evaluate(
      (element) => element.getBoundingClientRect().height
    );

    await todoToggle.click();
    await expect(todoToggle).toHaveAttribute('aria-expanded', 'true');
    const reopenedTodoGeometry = await getTodoListGeometry();
    expect(reopenedTodoGeometry.scrollHeight).toBeGreaterThan(reopenedTodoGeometry.clientHeight);
    expect(reopenedTodoGeometry.rightInset).toBeCloseTo(2, 1);
    const expansionSamples = await sampleMessageTopAcrossFrames(
      list,
      'message-large-assistant-239',
      12
    );
    expect(
      expansionSamples.every((sample) => sample !== null && Math.abs(sample - previousTop) <= 1)
    ).toBe(true);
    await expect(reserve).toHaveCount(0);
    await expect
      .poll(() =>
        getScrollMetrics(page, '.interactive-list').then((metrics) => metrics.distanceFromBottom)
      )
      .toBeLessThan(2);

    await todoToggle.click();
    await expect(todoToggle).toHaveAttribute('aria-expanded', 'false');
    await expect(reserve).toBeVisible();
    const secondReserveHeight = await reserve.evaluate(
      (element) => element.getBoundingClientRect().height
    );
    expect(Math.abs(secondReserveHeight - firstReserveHeight)).toBeLessThanOrEqual(1);

    await todoToggle.click();
    await expect(todoToggle).toHaveAttribute('aria-expanded', 'true');
    await expect(reserve).toHaveCount(0);
    await todoToggle.click();
    await expect(todoToggle).toHaveAttribute('aria-expanded', 'false');
    await expect(reserve).toBeVisible();
    const thirdReserveHeight = await reserve.evaluate(
      (element) => element.getBoundingClientRect().height
    );
    expect(Math.abs(thirdReserveHeight - firstReserveHeight)).toBeLessThanOrEqual(1);

    const detachedAnchor = await list.evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -300, bubbles: true }));
      element.scrollTop = Math.max(0, element.scrollTop - 300);
      const containerRect = element.getBoundingClientRect();
      const row = [...element.querySelectorAll<HTMLElement>('[data-msg-id]')].find((candidate) => {
        const rect = candidate.getBoundingClientRect();
        return rect.bottom > containerRect.top && rect.top < containerRect.bottom;
      });
      if (!row?.dataset.msgId) throw new Error('Detached todo anchor is missing');
      const anchor = {
        id: row.dataset.msgId,
        top: row.getBoundingClientRect().top - containerRect.top,
      };
      element.dispatchEvent(new Event('scroll'));
      return anchor;
    });
    await expect(reserve).toHaveCount(0);
    const detachedSamples = await sampleMessageTopAcrossFrames(list, detachedAnchor.id, 3);
    expect(
      detachedSamples.every((top) => top !== null && Math.abs(top - detachedAnchor.top) <= 1),
      JSON.stringify({ detachedAnchor, detachedSamples })
    ).toBe(true);
  });

  test('reuses free transcript space when the todo list collapses', async ({ page }) => {
    await page.setViewportSize({ width: 480, height: 800 });
    await page.goto('/e2e/harness/index.html?scenario=restored-session');
    await expect(page.locator('[data-msg-id="message-restored-assistant"]')).toBeVisible();

    await page.evaluate(() => {
      window.postMessage(
        {
          type: 'server/event',
          payload: {
            type: 'todo.updated',
            properties: {
              sessionID: 'session-restored',
              todos: Array.from({ length: 4 }, (_, index) => ({
                content: `Remaining work item ${index + 1}`,
                status: index === 0 ? 'in_progress' : 'pending',
                priority: 'medium',
              })),
            },
          },
        },
        '*'
      );
    });

    const todoToggle = page.getByRole('button', { name: /Todos/i });
    const list = page.locator('.interactive-list');
    await expect(todoToggle).toHaveAttribute('aria-expanded', 'true');
    const expandedOverflow = await list.evaluate(async (element) => {
      const track = element.querySelector<HTMLElement>('.interactive-list-track');
      if (!track) throw new Error('Message track is missing');
      track.style.minHeight = `${element.clientHeight + 30}px`;
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event('scroll'));
      return element.scrollHeight - element.clientHeight;
    });
    expect(expandedOverflow).toBeGreaterThan(5);
    expect(expandedOverflow).toBeLessThan(60);

    await todoToggle.click();
    await expect(todoToggle).toHaveAttribute('aria-expanded', 'false');
    await waitForAnimationFrames(page, 3);
    await expect(page.locator('.append-scroll-bottom-reserve')).toHaveCount(0);

    await todoToggle.click();
    await expect(todoToggle).toHaveAttribute('aria-expanded', 'true');
    await todoToggle.click();
    await expect(todoToggle).toHaveAttribute('aria-expanded', 'false');
    await waitForAnimationFrames(page, 3);
    await expect(page.locator('.append-scroll-bottom-reserve')).toHaveCount(0);
  });

  test('manual scroll up disengages auto-scroll', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=large-transcript');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    await waitForAnimationFrame(page);

    await list.evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
      element.scrollTop = Math.max(0, element.scrollTop - 300);
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrame(page);

    const metrics = await getScrollMetrics(page, '.interactive-list');
    expect(metrics.distanceFromBottom).toBeGreaterThan(190);
  });

  test('small upward wheel from bottom does not snap back', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=large-transcript');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);

    const anchor = await getVisibleMessageAnchor(list);

    await list.evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -48, bubbles: true }));
      element.scrollTop = Math.max(0, element.scrollTop - 48);
      element.dispatchEvent(new Event('scroll'));
    });

    await page.waitForTimeout(260);
    const samples = await sampleMessageTopAcrossFrames(list, anchor.id, 3);
    expect(
      samples.every((top) => top !== null && Math.abs(top - anchor.top - 48) < 3),
      JSON.stringify({ anchor, samples })
    ).toBe(true);
    expect((await getScrollMetrics(page, '.interactive-list')).distanceFromBottom).toBeGreaterThan(
      30
    );
  });

  test('scrolls upward through a large transcript without virtualized content jumps', async ({
    page,
  }) => {
    await page.goto('/e2e/harness/index.html?scenario=large-transcript');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);

    for (let index = 0; index < 60; index += 1) {
      const anchor = await getVisibleMessageAnchor(list);
      if (anchor.scrollTop < 180) break;

      await list.evaluate((element) => {
        const target = Math.max(0, element.scrollTop - 180);
        element.dispatchEvent(new WheelEvent('wheel', { deltaY: -180, bubbles: true }));
        element.scrollTop = target;
        element.dispatchEvent(new Event('scroll'));
      });
      const samples = await sampleMessageTopAcrossFrames(list, anchor.id, 3);
      expect(
        samples.every((top) => top !== null),
        JSON.stringify({ index, anchor, samples })
      ).toBe(true);
      const settledTop = samples.at(-1)!;
      expect(Math.abs(settledTop! - anchor.top - 180), `wheel step ${index}`).toBeLessThan(4);
      for (const top of samples.slice(1)) {
        expect(Math.abs(top! - settledTop!), `settling step ${index}`).toBeLessThan(1.5);
      }
    }
  });

  test('mouse wheel upward from mid transcript never jumps backward', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=large-transcript');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    await list.evaluate((element) => {
      element.scrollTop = Math.floor(element.scrollHeight / 2);
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrames(page, 3);

    const box = await list.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);

    for (let index = 0; index < 18; index += 1) {
      const anchor = await getVisibleMessageAnchor(list);
      if (anchor.scrollTop < 180) break;
      await page.mouse.wheel(0, -180);
      const samples = await sampleMessageTopAcrossFrames(list, anchor.id, 3);
      expect(
        samples.every((top) => top !== null),
        JSON.stringify({ index, anchor, samples })
      ).toBe(true);
      const settledTop = samples.at(-1)!;
      expect(Math.abs(settledTop! - anchor.top - 180), `wheel step ${index}`).toBeLessThan(4);
      for (const top of samples.slice(1)) {
        expect(Math.abs(top! - settledTop!), `settling step ${index}`).toBeLessThan(1.5);
      }
    }
  });

  test('heterogeneous long chat scrolls upward without screen-sized jumps', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=heterogeneous-large-transcript');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);

    const box = await list.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);

    for (let index = 0; index < 35; index += 1) {
      await waitForAnimationFrames(page, 2);
      const before = await getVisibleMessageAnchor(list);
      if (before.scrollTop < 180) break;

      await page.mouse.wheel(0, -180);
      const tops = await sampleMessageTopAcrossFrames(list, before.id, 4);
      expect(
        tops.every((top) => top !== null),
        JSON.stringify({ index, before, tops })
      ).toBe(true);
      const settledTop = tops.at(-1)!;
      expect(Math.abs(settledTop! - before.top - 180), `wheel step ${index}`).toBeLessThan(4);
      for (const top of tops.slice(1)) {
        expect(Math.abs(top! - settledTop!), `settling step ${index}`).toBeLessThan(1.5);
      }
    }
  });

  test('restores the same compact tool row after measured reflow settles', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=tool-cards-large-transcript');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();
    await expect(page.locator('.interactive-list-track')).toHaveClass(/virtualized/);
    await expect
      .poll(() => list.evaluate((element) => element.querySelectorAll('[data-msg-id]').length))
      .toBeLessThan(60);

    await list.evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, bubbles: true }));
      element.scrollTop = Math.floor((element.scrollHeight - element.clientHeight) * 0.7);
      element.dispatchEvent(new Event('scroll'));
    });

    await waitForAnimationFrames(page, 2);
    const beforeReflow = await getVisibleMessageAnchor(list);
    await page.addStyleTag({
      content: `
        .tool-invocation-header,
        .file-read-card-header,
        .file-change-card-header,
        .thinking-header {
          padding-block: 9px !important;
        }
      `,
    });
    const reflowSamples = await sampleMessageTopAcrossFrames(list, beforeReflow.id, 8);
    expect(
      reflowSamples.every((top) => top !== null),
      JSON.stringify(reflowSamples)
    ).toBe(true);
    // The first RAF callback can precede the coalesced measurement correction in the same
    // pre-paint turn; the settled frames must restore the original visible position.
    for (const top of reflowSamples.slice(1)) {
      expect(Math.abs(top! - beforeReflow.top)).toBeLessThan(1.5);
    }

    for (let step = 0; step < 20; step += 1) {
      await list.evaluate((element) => {
        element.dispatchEvent(new WheelEvent('wheel', { deltaY: -180, bubbles: true }));
        element.scrollTop = Math.max(0, element.scrollTop - 180);
        element.dispatchEvent(new Event('scroll'));
      });
      const anchor = await getVisibleMessageAnchor(list);
      const samples = await sampleMessageTopAcrossFrames(list, anchor.id, 6);
      for (const top of samples) {
        expect(top).not.toBeNull();
        expect(Math.abs(top! - anchor.top)).toBeLessThan(1.5);
      }
    }
  });

  test('keeps a detached anchor stable when an offscreen active tool joins Explored', async ({
    page,
  }) => {
    await page.goto('/e2e/harness/index.html?scenario=tool-cards-large-transcript&activeTray=1');
    const list = page.locator('.interactive-list');
    await expect(page.locator('.interactive-list-track')).toHaveClass(/virtualized/);
    await expect
      .poll(() => list.evaluate((element) => element.querySelectorAll('[data-msg-id]').length))
      .toBeLessThan(60);

    await list.evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, bubbles: true }));
      element.scrollTop = Math.floor((element.scrollHeight - element.clientHeight) * 0.7);
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrames(page, 2);
    const anchor = await getVisibleMessageAnchor(list);

    await page.evaluate(() => {
      const harnessWindow = window as typeof window & {
        __varroE2E?: {
          getSessionMessages?: (id: string) => Array<{ parts: Array<Record<string, unknown>> }>;
          updateMessagePart?: (part: Record<string, unknown>) => void;
        };
      };
      const part = harnessWindow.__varroE2E
        ?.getSessionMessages?.('session-tool-cards-large-transcript')
        .flatMap((message) => message.parts)
        .find((candidate) => candidate.id === 'message-tool-cards-assistant-20-tool');
      if (!part) throw new Error('Virtualized active tool fixture is missing');
      const previousState = part.state as Record<string, unknown>;
      part.state = {
        status: 'completed',
        input: previousState.input,
        output: 'Found matches',
        title: 'Search virtualized activity',
        metadata: {},
        time: { start: Date.now() - 1_000, end: Date.now() },
      };
      harnessWindow.__varroE2E?.updateMessagePart?.(part);
    });

    // Cover the full active hold, exit animation, and grouped settle window.
    const samples = await sampleMessageTopAcrossFrames(list, anchor.id, 200);
    expect(
      samples.every((top) => top !== null),
      JSON.stringify({ anchor, samples })
    ).toBe(true);
    expect(
      samples.every((top) => Math.abs(top! - anchor.top) < 1.5),
      JSON.stringify({ anchor, samples })
    ).toBe(true);
  });

  test('keeps trailing active-tool space until streamed content replaces it', async ({ page }) => {
    await page.goto(
      '/e2e/harness/index.html?scenario=tool-cards-large-transcript&activeTray=1&activeTrayIndex=69'
    );
    const activeItem = page.locator(
      '[data-activity-part-id="message-tool-cards-assistant-69-tool"]'
    );
    const loadingRow = page.locator('.interactive-loading-row');
    await expect(page.locator('.interactive-list-track')).toHaveClass(/virtualized/);
    await expect(activeItem).toBeVisible();
    await activeItem.evaluate(async (element) => {
      await Promise.all(element.getAnimations().map((animation) => animation.finished));
    });
    await expect
      .poll(() =>
        getScrollMetrics(page, '.interactive-list').then((metrics) => metrics.distanceFromBottom)
      )
      .toBeLessThan(2);
    await page.waitForTimeout(1_250);
    const anchor = await getVisibleMessageAnchor(page.locator('.interactive-list'));
    const exploredTop = await page.locator('.assistant-activity-summary').last().evaluate((summary) => {
      const container = summary.closest<HTMLElement>('.interactive-list');
      if (!container) throw new Error('Activity summary container is missing');
      return summary.getBoundingClientRect().top - container.getBoundingClientRect().top;
    });

    await page.evaluate(() => {
      const harnessWindow = window as typeof window & {
        __varroE2E?: {
          getSessionMessages?: (id: string) => Array<{ parts: Array<Record<string, unknown>> }>;
          updateMessagePart?: (part: Record<string, unknown>) => void;
        };
      };
      const part = harnessWindow.__varroE2E
        ?.getSessionMessages?.('session-tool-cards-large-transcript')
        .flatMap((message) => message.parts)
        .find((candidate) => candidate.id === 'message-tool-cards-assistant-69-tool');
      if (!part) throw new Error('Trailing active tool fixture is missing');
      const previousState = part.state as Record<string, unknown>;
      part.state = {
        status: 'completed',
        input: previousState.input,
        output: 'Found matches',
        title: 'Search virtualized activity',
        metadata: {},
        time: { start: Date.now() - 1_000, end: Date.now() },
      };
      harnessWindow.__varroE2E?.updateMessagePart?.(part);
    });

    const [exitSamples, exploredSamples] = await Promise.all([
      sampleMessageTopAcrossFrames(page.locator('.interactive-list'), anchor.id, 90),
      page.locator('.interactive-list').evaluate(async (element) => {
        const tops: Array<number | null> = [];
        for (let frame = 0; frame < 90; frame += 1) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          const summaries = element.querySelectorAll<HTMLElement>('.assistant-activity-summary');
          const summary = summaries[summaries.length - 1];
          tops.push(
            summary
              ? summary.getBoundingClientRect().top - element.getBoundingClientRect().top
              : null
          );
        }
        return tops;
      }),
    ]);
    expect(
      exitSamples.every((top) => top !== null && Math.abs(top - anchor.top) <= 1.5),
      JSON.stringify({ anchor, exitSamples })
    ).toBe(true);
    expect(
      exploredSamples.every((top) => top !== null && Math.abs(top - exploredTop) <= 0.1),
      JSON.stringify({ exploredTop, exploredSamples })
    ).toBe(true);
    await expect(activeItem).toHaveCount(0, { timeout: 5_000 });
    await expect(page.locator('.activity-exit-bottom-reserve')).toHaveCount(0);
    const appendReserve = page.locator('.append-scroll-bottom-reserve');
    await expect(appendReserve).toBeVisible();
    expect(
      await appendReserve.evaluate((element) => element.getBoundingClientRect().height)
    ).toBeGreaterThan(5);

    const settledGap = await page
      .locator('.assistant-activity-summary')
      .last()
      .evaluate(
        (summary, loading) => {
          const summaryBox = summary.getBoundingClientRect();
          const loadingBox = (loading as HTMLElement)
            .querySelector<HTMLElement>('.loading-verb')!
            .getBoundingClientRect();
          return loadingBox.top - summaryBox.bottom;
        },
        await loadingRow.elementHandle()
      );
    expect(settledGap).toBeGreaterThanOrEqual(10);
    expect(settledGap).toBeLessThanOrEqual(14.5);

    await page.evaluate(() => {
      const part = {
        id: 'message-tool-cards-assistant-69-text-streaming',
        sessionID: 'session-tool-cards-large-transcript',
        messageID: 'message-tool-cards-assistant-69',
        type: 'text' as const,
        text: '',
      };
      const harnessWindow = window as typeof window & {
        __varroE2E?: { updateMessagePart?: (updatedPart: unknown) => void };
      };
      harnessWindow.__varroE2E?.updateMessagePart?.(part);
      window.postMessage(
        {
          type: 'server/event',
          payload: { type: 'message.part.updated', properties: { part } },
        },
        '*'
      );
      window.postMessage(
        {
          type: 'server/event',
          payload: {
            type: 'message.part.delta',
            properties: {
              sessionID: part.sessionID,
              messageID: part.messageID,
              partID: part.id,
              field: 'text',
              delta: Array.from(
                { length: 12 },
                (_, index) => `Streamed replacement line ${index + 1}.`
              ).join('\n\n'),
            },
          },
        },
        '*'
      );
    });

    await expect(appendReserve).toHaveCount(0);
  });

  test('keeps first-turn Explored fixed across mixed multi-activity exits', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 504, height: 800 });
    await page.goto('/e2e/harness/index.html?scenario=blank');
    await page.evaluate(() => {
      const harnessWindow = window as typeof window & {
        __sendToExtension?: (message: unknown) => void | Promise<void>;
        __varroE2E?: {
          getSessionMessages?: (sessionId: string) => Array<{
            info: Record<string, unknown>;
            parts: Array<Record<string, unknown>>;
          }>;
          updateMessageInfo?: (info: Record<string, unknown>) => void;
          updateMessagePart?: (part: Record<string, unknown>) => void;
          updateSessionStatus?: (sessionId: string, status: { type: 'busy' | 'idle' }) => void;
        };
        firstTurnActivityFixture?: {
          sessionId: string;
          info: Record<string, unknown>;
          running: Array<Record<string, unknown>>;
        };
      };
      const originalSend = harnessWindow.__sendToExtension;
      harnessWindow.__sendToExtension = async (message) => {
        const request = message as {
          type?: string;
          payload?: { path?: string; body?: Record<string, unknown> };
        };
        const match = request.payload?.path?.match(/^\/session\/([^/]+)\/prompt_async$/);
        if (request.type !== 'api/request' || !match) {
          await originalSend?.(message);
          return;
        }

        const sessionId = decodeURIComponent(match[1]!);
        await originalSend?.(message);
        const assistant = harnessWindow.__varroE2E
          ?.getSessionMessages?.(sessionId)
          .findLast((entry) => entry.info.role === 'assistant');
        if (!assistant) throw new Error('Persisted first-turn assistant is missing');
        const info: Record<string, unknown> = {
          ...assistant.info,
          time: { created: Date.now() },
        };
        delete info.finish;
        const completed = {
          id: 'message-first-turn-activity-read',
          sessionID: sessionId,
          messageID: String(info.id),
          type: 'tool',
          callID: 'message-first-turn-activity-read-call',
          tool: 'read',
          state: {
            status: 'completed',
            input: { filePath: 'src/webview/components/MessageList.tsx' },
            output: 'source',
            title: 'Read MessageList',
            metadata: {},
            time: { start: Date.now() - 2, end: Date.now() - 1 },
          },
        };
        const running = Array.from({ length: 3 }, (_, index) => ({
          id: `message-first-turn-activity-command-${index}`,
          sessionID: sessionId,
          messageID: String(info.id),
          type: 'tool',
          callID: `message-first-turn-activity-command-${index}-call`,
          tool: 'bash',
          state: {
            status: 'running',
            input: { command: `npm run test:${index}` },
            title: `npm run test:${index}`,
            time: { start: Date.now() + index },
          },
        }));
        harnessWindow.firstTurnActivityFixture = { sessionId, info, running };
        harnessWindow.__varroE2E?.updateSessionStatus?.(sessionId, { type: 'busy' });
        harnessWindow.__varroE2E?.updateMessageInfo?.(info);
        harnessWindow.__varroE2E?.updateMessagePart?.(completed);
        for (const part of running) harnessWindow.__varroE2E?.updateMessagePart?.(part);
        for (const payload of [
          { type: 'session.status', properties: { sessionID: sessionId, status: { type: 'busy' } } },
          { type: 'message.updated', properties: { info } },
          { type: 'message.part.updated', properties: { part: completed } },
          ...running.map((part) => ({
            type: 'message.part.updated',
            properties: { part },
          })),
        ]) {
          window.postMessage({ type: 'server/event', payload }, '*');
        }
      };
    });

    const composer = page.locator('[role="textbox"][aria-multiline="true"]').first();
    await composer.fill(
      Array.from(
        { length: 10 },
        (_, index) => `Keep Explored fixed through first-turn completion, line ${index + 1}.`
      ).join('\n')
    );
    await page.getByTitle('Send (Enter)').click();

    const list = page.locator('.interactive-list');
    const summary = page.locator('.assistant-activity-summary').last();
    const activeItems = page.locator(
      '[data-activity-part-id^="message-first-turn-activity-command-"]'
    );
    await expect(summary).toContainText('Explored: 1 file');
    await expect(activeItems).toHaveCount(3);
    await activeItems.last().evaluate(async (element) => {
      await Promise.all(element.getAnimations().map((animation) => animation.finished));
    });
    await expect(page.locator('.append-scroll-bottom-reserve')).toBeVisible();
    const before = await summary.evaluate((element) => {
      const container = element.closest<HTMLElement>('.interactive-list');
      if (!container) throw new Error('Explored container is missing');
      return element.getBoundingClientRect().top - container.getBoundingClientRect().top;
    });
    const completeAndSample = (indexes: number[]) =>
      list.evaluate(async (element, completedIndexes) => {
        const harnessWindow = window as typeof window & {
          __varroE2E?: { updateMessagePart?: (part: Record<string, unknown>) => void };
          firstTurnActivityFixture?: { running: Array<Record<string, unknown>> };
        };
        const fixture = harnessWindow.firstTurnActivityFixture;
        if (!fixture) throw new Error('First-turn activity fixture is missing');
        for (const index of completedIndexes) {
          const running = fixture.running[index];
          if (!running) throw new Error(`Running activity ${index} is missing`);
          const previousState = running.state as Record<string, unknown>;
          const completed = {
            ...running,
            state: {
              status: 'completed',
              input: previousState.input,
              output: 'Passed',
              title: previousState.title,
              metadata: {},
              time: { start: Date.now() - 1_000, end: Date.now() },
            },
          };
          fixture.running[index] = completed;
          harnessWindow.__varroE2E?.updateMessagePart?.(completed);
          window.postMessage(
            {
              type: 'server/event',
              payload: { type: 'message.part.updated', properties: { part: completed } },
            },
            '*'
          );
        }

        const tops: Array<number | null> = [];
        for (let frame = 0; frame < 150; frame += 1) {
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => setTimeout(resolve, 0))
          );
          const summaries = element.querySelectorAll<HTMLElement>('.assistant-activity-summary');
          const explored = summaries[summaries.length - 1];
          tops.push(
            explored
              ? explored.getBoundingClientRect().top - element.getBoundingClientRect().top
              : null
          );
        }
        return tops;
      }, indexes);

    const shuffledSamples = await completeAndSample([2]);
    expect(
      shuffledSamples.every((top) => top !== null && Math.abs(top - before) <= 0.5),
      JSON.stringify({ before, shuffledSamples })
    ).toBe(true);
    await expect(activeItems).toHaveCount(2);

    const groupedSamples = await completeAndSample([0, 1]);
    expect(
      groupedSamples.every((top) => top !== null && Math.abs(top - before) <= 0.5),
      JSON.stringify({ before, groupedSamples })
    ).toBe(true);
    await expect(activeItems).toHaveCount(0);

    await page.evaluate(() => {
      const harnessWindow = window as typeof window & {
        __varroE2E?: { updateMessagePart?: (part: Record<string, unknown>) => void };
        firstTurnActivityFixture?: {
          sessionId: string;
          info: Record<string, unknown>;
          running: Array<Record<string, unknown>>;
        };
      };
      const fixture = harnessWindow.firstTurnActivityFixture;
      if (!fixture) throw new Error('First-turn activity fixture is missing');
      const next = Array.from({ length: 3 }, (_, offset) => {
        const index = fixture.running.length + offset;
        return {
          id: `message-first-turn-activity-command-${index}`,
          sessionID: fixture.sessionId,
          messageID: String(fixture.info.id),
          type: 'tool',
          callID: `message-first-turn-activity-command-${index}-call`,
          tool: 'bash',
          state: {
            status: 'running',
            input: { command: `npm run test:${index}` },
            title: `npm run test:${index}`,
            time: { start: Date.now() + offset },
          },
        };
      });
      fixture.running.push(...next);
      for (const part of next) {
        harnessWindow.__varroE2E?.updateMessagePart?.(part);
        window.postMessage(
          {
            type: 'server/event',
            payload: { type: 'message.part.updated', properties: { part } },
          },
          '*'
        );
      }
    });

    await expect(activeItems).toHaveCount(3);
    await activeItems.last().evaluate(async (element) => {
      await Promise.all(element.getAnimations().map((animation) => animation.finished));
    });
    const allAtOnceSamples = await completeAndSample([3, 4, 5]);
    expect(
      allAtOnceSamples.every((top) => top !== null && Math.abs(top - before) <= 0.5),
      JSON.stringify({ before, allAtOnceSamples })
    ).toBe(true);
    await expect(activeItems).toHaveCount(0);

    const reserve = page.locator('.append-scroll-bottom-reserve');
    await expect(reserve).toBeVisible();

    const samples = await list.evaluate(async (element) => {
      const harnessWindow = window as typeof window & {
        __varroE2E?: {
          updateMessageInfo?: (info: Record<string, unknown>) => void;
          updateSessionStatus?: (sessionId: string, status: { type: 'idle' }) => void;
        };
        firstTurnActivityFixture?: {
          sessionId: string;
          info: Record<string, unknown>;
        };
      };
      const fixture = harnessWindow.firstTurnActivityFixture;
      if (!fixture) throw new Error('First-turn activity fixture is missing');
      const completedInfo = {
        ...fixture.info,
        time: { created: Date.now() - 2_000, completed: Date.now() },
        finish: 'stop',
      };
      harnessWindow.__varroE2E?.updateMessageInfo?.(completedInfo);
      harnessWindow.__varroE2E?.updateSessionStatus?.(fixture.sessionId, { type: 'idle' });
      window.postMessage(
        {
          type: 'server/event',
          payload: { type: 'message.updated', properties: { info: completedInfo } },
        },
        '*'
      );
      window.postMessage(
        {
          type: 'server/event',
          payload: {
            type: 'session.status',
            properties: { sessionID: fixture.sessionId, status: { type: 'idle' } },
          },
        },
        '*'
      );

      const result: Array<{ top: number | null; reserveHeight: number }> = [];
      for (let frame = 0; frame < 30; frame += 1) {
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => setTimeout(resolve, 0))
        );
        const summaries = element.querySelectorAll<HTMLElement>('.assistant-activity-summary');
        const explored = summaries[summaries.length - 1];
        result.push({
          top: explored
            ? explored.getBoundingClientRect().top - element.getBoundingClientRect().top
            : null,
          reserveHeight:
            element
              .querySelector<HTMLElement>('.append-scroll-bottom-reserve')
              ?.getBoundingClientRect().height ?? 0,
        });
      }
      return result;
    });

    expect(
      samples.every((sample) => sample.top !== null && Math.abs(sample.top - before) <= 0.5),
      JSON.stringify({ before, samples })
    ).toBe(true);
    expect(
      samples.every((sample) => sample.reserveHeight > 0.5),
      JSON.stringify(samples)
    ).toBe(true);
  });

  test('uses trailing activity reserve for the next active tool', async ({ page }) => {
    await page.goto(
      '/e2e/harness/index.html?scenario=tool-cards-large-transcript&activeTray=1&activeTrayIndex=69'
    );
    const list = page.locator('.interactive-list');
    const initialItem = page.locator(
      '[data-activity-part-id="message-tool-cards-assistant-69-tool"]'
    );
    await expect(initialItem).toBeVisible();
    await initialItem.evaluate(async (element) => {
      await Promise.all(element.getAnimations().map((animation) => animation.finished));
    });
    await page.evaluate(() => {
      const harnessWindow = window as typeof window & {
        __varroE2E?: { updateMessagePart?: (updatedPart: unknown) => void };
      };
      for (let index = 1; index <= 2; index += 1) {
        const part = {
          id: `message-tool-cards-assistant-69-initial-tool-${index}`,
          sessionID: 'session-tool-cards-large-transcript',
          messageID: 'message-tool-cards-assistant-69',
          type: 'tool' as const,
          callID: `message-tool-cards-assistant-69-initial-tool-${index}-call`,
          tool: 'bash',
          state: {
            status: 'running' as const,
            input: { command: `npm run initial-check-${index}` },
            title: `npm run initial-check-${index}`,
            time: { start: Date.now() + index },
          },
        };
        harnessWindow.__varroE2E?.updateMessagePart?.(part);
        window.postMessage(
          {
            type: 'server/event',
            payload: { type: 'message.part.updated', properties: { part } },
          },
          '*'
        );
      }
    });
    const activeItems = page.locator('.assistant-active-activity-item');
    await expect(activeItems).toHaveCount(3);
    await page.waitForTimeout(1_250);

    await page.evaluate(() => {
      const harnessWindow = window as typeof window & {
        __varroE2E?: {
          getSessionMessages?: (id: string) => Array<{ parts: Array<Record<string, unknown>> }>;
          updateMessagePart?: (part: Record<string, unknown>) => void;
        };
      };
      const parts = harnessWindow.__varroE2E
        ?.getSessionMessages?.('session-tool-cards-large-transcript')
        .flatMap((message) => message.parts)
        .filter(
          (candidate) =>
            candidate.id === 'message-tool-cards-assistant-69-tool' ||
            String(candidate.id).startsWith('message-tool-cards-assistant-69-initial-tool-')
        );
      if (parts?.length !== 3) throw new Error('Trailing active tool fixtures are missing');
      for (const part of parts) {
        const previousState = part.state as Record<string, unknown>;
        part.state = {
          status: 'completed',
          input: previousState.input,
          output: 'Completed',
          title: previousState.title,
          metadata: {},
          time: { start: Date.now() - 1_000, end: Date.now() },
        };
        harnessWindow.__varroE2E?.updateMessagePart?.(part);
      }
    });

    await expect(activeItems).toHaveCount(0, { timeout: 5_000 });
    const reserve = page.locator('.append-scroll-bottom-reserve');
    await expect(reserve).toBeVisible();
    await waitForAnimationFrames(page, 3);
    const summary = page.locator('.assistant-activity-summary').last();
    const loadingRow = page.locator('.interactive-loading-row');
    const before = await list.evaluate((element) => {
      const summaries = element.querySelectorAll<HTMLElement>('.assistant-activity-summary');
      const summaryElement = summaries[summaries.length - 1];
      const loading = element.querySelector<HTMLElement>('.interactive-loading-row');
      if (!summaryElement || !loading) throw new Error('Trailing activity geometry is missing');
      const containerTop = element.getBoundingClientRect().top;
      return {
        scrollTop: element.scrollTop,
        reserveHeight: Number.parseFloat(
          getComputedStyle(element.querySelector<HTMLElement>('.append-scroll-bottom-reserve')!)
            .height
        ),
        summaryTop: summaryElement.getBoundingClientRect().top - containerTop,
        loadingTop: loading.getBoundingClientRect().top - containerTop,
      };
    });

    await page.evaluate(() => {
      const part = {
        id: 'message-tool-cards-assistant-69-next-tool',
        sessionID: 'session-tool-cards-large-transcript',
        messageID: 'message-tool-cards-assistant-69',
        type: 'tool' as const,
        callID: 'message-tool-cards-assistant-69-next-tool-call',
        tool: 'bash',
        state: {
          status: 'running' as const,
          input: { command: 'npm run next-check' },
          title: 'npm run next-check',
          time: { start: Date.now() },
        },
      };
      const harnessWindow = window as typeof window & {
        __varroE2E?: { updateMessagePart?: (updatedPart: unknown) => void };
      };
      harnessWindow.__varroE2E?.updateMessagePart?.(part);
      window.postMessage(
        {
          type: 'server/event',
          payload: { type: 'message.part.updated', properties: { part } },
        },
        '*'
      );
    });

    const summarySamples = await summary.evaluate(async (element) => {
      const container = element.closest<HTMLElement>('.interactive-list')!;
      const tops: number[] = [];
      for (let frame = 0; frame < 40; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        tops.push(element.getBoundingClientRect().top - container.getBoundingClientRect().top);
      }
      return tops;
    });
    const nextItem = page.locator(
      '[data-activity-part-id="message-tool-cards-assistant-69-next-tool"]'
    );
    await expect(nextItem).toBeVisible();
    expect(
      summarySamples.every((top) => Math.abs(top - before.summaryTop) <= 1.5),
      JSON.stringify({ before, summarySamples })
    ).toBe(true);
    expect(
      Math.abs((await list.evaluate((element) => element.scrollTop)) - before.scrollTop)
    ).toBeLessThan(1.5);
    const summaryBox = (await summary.boundingBox())!;
    const nextItemBox = (await nextItem.boundingBox())!;
    expect(before.reserveHeight).toBeGreaterThanOrEqual(nextItemBox.height);
    expect(nextItemBox.y).toBeGreaterThanOrEqual(summaryBox.y + summaryBox.height - 1);
    const loadingTop = await loadingRow.evaluate((element) => {
      const container = element.closest<HTMLElement>('.interactive-list')!;
      return element.getBoundingClientRect().top - container.getBoundingClientRect().top;
    });
    expect(loadingTop).toBeGreaterThan(before.loadingTop);
  });

  test('keeps the transcript fixed when every active tool moves into Explored', async ({
    page,
  }) => {
    await page.goto(
      '/e2e/harness/index.html?scenario=tool-cards-large-transcript&activeTray=1&activeTrayIndex=69'
    );
    const list = page.locator('.interactive-list');
    const activeItems = page.locator('.assistant-active-activity-item');
    await expect(page.locator('.interactive-list-track')).toHaveClass(/virtualized/);

    await page.evaluate(() => {
      const harnessWindow = window as typeof window & {
        __varroE2E?: { updateMessagePart?: (updatedPart: unknown) => void };
      };
      for (let index = 1; index < 8; index += 1) {
        const part = {
          id: `message-tool-cards-assistant-69-tool-${index}`,
          sessionID: 'session-tool-cards-large-transcript',
          messageID: 'message-tool-cards-assistant-69',
          type: 'tool' as const,
          callID: `message-tool-cards-assistant-69-tool-${index}-call`,
          tool: index % 2 === 0 ? 'grep' : 'bash',
          state: {
            status: 'running' as const,
            input:
              index % 2 === 0
                ? { pattern: `activity-${index}`, path: 'src/webview' }
                : { command: `npm run check-${index}` },
            title: index % 2 === 0 ? `Search ${index}` : `Command ${index}`,
            time: { start: Date.now() - 1_000 + index },
          },
        };
        harnessWindow.__varroE2E?.updateMessagePart?.(part);
        window.postMessage(
          {
            type: 'server/event',
            payload: { type: 'message.part.updated', properties: { part } },
          },
          '*'
        );
      }
    });

    await expect(activeItems).toHaveCount(8);
    await expect
      .poll(() =>
        getScrollMetrics(page, '.interactive-list').then((metrics) => metrics.distanceFromBottom)
      )
      .toBeLessThan(2);
    await page.waitForTimeout(1_250);
    await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrames(page, 4);
    const anchor = await getVisibleMessageAnchor(list);

    await page.evaluate(() => {
      const harnessWindow = window as typeof window & {
        __varroE2E?: {
          getSessionMessages?: (id: string) => Array<{ parts: Array<Record<string, unknown>> }>;
          updateMessagePart?: (updatedPart: unknown) => void;
        };
      };
      const part = harnessWindow.__varroE2E
        ?.getSessionMessages?.('session-tool-cards-large-transcript')
        .flatMap((message) => message.parts)
        .find((candidate) => candidate.id === 'message-tool-cards-assistant-69-tool');
      if (!part) throw new Error('Leading active tool is missing');
      const previousState = part.state as Record<string, unknown>;
      const completed = {
        ...part,
        state: {
          status: 'completed' as const,
          input: previousState.input,
          output: 'Completed',
          title: previousState.title,
          metadata: {},
          time: { start: Date.now() - 1_000, end: Date.now() },
        },
      };
      harnessWindow.__varroE2E?.updateMessagePart?.(completed);
      window.postMessage(
        {
          type: 'server/event',
          payload: { type: 'message.part.updated', properties: { part: completed } },
        },
        '*'
      );
    });

    const leadingExitSamples = await sampleMessageTopAcrossFrames(list, anchor.id, 150);
    expect(
      leadingExitSamples.every((top) => top !== null && Math.abs(top - anchor.top) <= 0.1),
      JSON.stringify({ anchor, leadingExitSamples })
    ).toBe(true);
    await expect(activeItems).toHaveCount(7);
    const collapseAnchor = await getVisibleMessageAnchor(list);
    const exploredTop = await page.locator('.assistant-activity-summary').last().evaluate((summary) => {
      const container = summary.closest<HTMLElement>('.interactive-list');
      if (!container) throw new Error('Activity summary container is missing');
      return summary.getBoundingClientRect().top - container.getBoundingClientRect().top;
    });

    await page.evaluate(() => {
      const sessionId = 'session-tool-cards-large-transcript';
      const harnessWindow = window as typeof window & {
        __varroE2E?: {
          updateSessionStatus?: (id: string, status: { type: 'idle' }) => void;
        };
      };
      harnessWindow.__varroE2E?.updateSessionStatus?.(sessionId, { type: 'idle' });
      window.postMessage(
        {
          type: 'server/event',
          payload: {
            type: 'session.status',
            properties: { sessionID: sessionId, status: { type: 'idle' } },
          },
        },
        '*'
      );
    });

    const [samples, exploredSamples] = await Promise.all([
      sampleMessageTopAcrossFrames(list, collapseAnchor.id, 120),
      list.evaluate(async (element) => {
        const tops: Array<number | null> = [];
        for (let frame = 0; frame < 120; frame += 1) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          const summaries = element.querySelectorAll<HTMLElement>('.assistant-activity-summary');
          const summary = summaries[summaries.length - 1];
          tops.push(
            summary
              ? summary.getBoundingClientRect().top - element.getBoundingClientRect().top
              : null
          );
        }
        return tops;
      }),
    ]);
    expect(
      samples.every((top) => top !== null && Math.abs(top - collapseAnchor.top) <= 0.1),
      JSON.stringify({ collapseAnchor, samples })
    ).toBe(true);
    expect(
      exploredSamples.every((top) => top !== null && Math.abs(top - exploredTop) <= 0.1),
      JSON.stringify({ exploredTop, exploredSamples })
    ).toBe(true);
    await expect(activeItems).toHaveCount(0);
    await expect(page.locator('.assistant-activity-summary').last()).toContainText('Explored');
    await expect(page.locator('.append-scroll-bottom-reserve')).toBeVisible();
  });

  test('reserves an empty follower row when an earlier message owns Explored', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=tool-cards-large-transcript');
    const list = page.locator('.interactive-list');
    const follower = page.locator('[data-msg-id="tool-follower-assistant"]');
    const activeItem = page.locator('[data-activity-part-id="tool-follower-running"]');
    await expect(page.locator('.interactive-list-track')).toHaveClass(/virtualized/);

    await page.evaluate(() => {
      const sessionID = 'session-tool-cards-large-transcript';
      const info = {
        id: 'tool-follower-assistant',
        sessionID,
        role: 'assistant' as const,
        parentID: 'message-tool-cards-user-69',
        time: { created: Date.now() },
        modelID: 'model-test',
        providerID: 'provider-test',
        mode: 'primary' as const,
        path: { cwd: '/workspace', root: '/workspace' },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      };
      const part = {
        id: 'tool-follower-running',
        sessionID,
        messageID: info.id,
        type: 'tool' as const,
        callID: 'tool-follower-running-call',
        tool: 'bash',
        state: {
          status: 'running' as const,
          input: { command: 'npm run follower' },
          title: 'npm run follower',
          time: { start: Date.now() },
        },
      };
      const harnessWindow = window as typeof window & {
        __varroE2E?: {
          updateSessionStatus?: (id: string, status: { type: 'busy' }) => void;
        };
      };
      harnessWindow.__varroE2E?.updateSessionStatus?.(sessionID, { type: 'busy' });
      window.postMessage(
        {
          type: 'server/event',
          payload: {
            type: 'session.status',
            properties: { sessionID, status: { type: 'busy' } },
          },
        },
        '*'
      );
      window.postMessage(
        {
          type: 'server/event',
          payload: { type: 'message.updated', properties: { info } },
        },
        '*'
      );
      window.postMessage(
        {
          type: 'server/event',
          payload: { type: 'message.part.updated', properties: { part } },
        },
        '*'
      );
    });

    await expect(activeItem).toBeVisible();
    await activeItem.evaluate(async (element) => {
      await Promise.all(element.getAnimations().map((animation) => animation.finished));
    });
    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(2);
    await expect(page.locator('.append-scroll-bottom-reserve')).toHaveCount(0);
    const sourceGeometry = await follower.evaluate((element) => {
      const tray = element.querySelector<HTMLElement>('.assistant-active-activity-tray');
      return {
        rowHeight: element.getBoundingClientRect().height,
        trayHeight: tray?.getBoundingClientRect().height ?? null,
        hasSummary: !!tray?.querySelector('.assistant-active-activity-summary'),
        flowItems: tray?.parentElement?.children.length ?? null,
      };
    });
    const anchor = await getVisibleMessageAnchor(list);
    const exploredTop = await page.locator('.assistant-activity-summary').last().evaluate((summary) => {
      const container = summary.closest<HTMLElement>('.interactive-list');
      if (!container) throw new Error('Activity summary container is missing');
      return summary.getBoundingClientRect().top - container.getBoundingClientRect().top;
    });

    await page.evaluate(() => {
      const sessionID = 'session-tool-cards-large-transcript';
      const harnessWindow = window as typeof window & {
        __varroE2E?: { updateSessionStatus?: (id: string, status: { type: 'idle' }) => void };
      };
      harnessWindow.__varroE2E?.updateSessionStatus?.(sessionID, { type: 'idle' });
      window.postMessage(
        {
          type: 'server/event',
          payload: {
            type: 'session.status',
            properties: { sessionID, status: { type: 'idle' } },
          },
        },
        '*'
      );
    });

    const [samples, exploredSamples] = await Promise.all([
      sampleMessageTopAcrossFrames(list, anchor.id, 12),
      list.evaluate(async (element) => {
        const tops: Array<number | null> = [];
        for (let frame = 0; frame < 12; frame += 1) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          const summaries = element.querySelectorAll<HTMLElement>('.assistant-activity-summary');
          const summary = summaries[summaries.length - 1];
          tops.push(
            summary
              ? summary.getBoundingClientRect().top - element.getBoundingClientRect().top
              : null
          );
        }
        return tops;
      }),
    ]);
    await expect(activeItem).toHaveCount(0);
    const reserveHeight = await page
      .locator('.append-scroll-bottom-reserve')
      .evaluate((element) => element.getBoundingClientRect().height);
    expect(
      samples.every((top) => top !== null && Math.abs(top - anchor.top) <= 1.5),
      JSON.stringify({ anchor, samples, reserveHeight, sourceGeometry })
    ).toBe(true);
    expect(
      exploredSamples.every((top) => top !== null && Math.abs(top - exploredTop) <= 0.1),
      JSON.stringify({ exploredTop, exploredSamples, reserveHeight, sourceGeometry })
    ).toBe(true);
    // Reconciliation may consume one whole CSS pixel while preserving the painted anchors above.
    expect(reserveHeight).toBeGreaterThanOrEqual(sourceGeometry.rowHeight - 1);
  });

  test('keeps a bottom-pinned Explored summary fixed while it expands downward', async ({
    page,
  }) => {
    await page.goto('/e2e/harness/index.html?scenario=tool-cards-large-transcript');
    const summary = page.locator('.assistant-activity-summary').last();
    await expect(page.locator('.interactive-list-track')).toHaveClass(/virtualized/);
    await expect(summary).toContainText('Explored');
    await expect(summary).toHaveAttribute('aria-expanded', 'false');
    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(2);

    const topBefore = await summary.evaluate((element) => {
      const container = element.closest<HTMLElement>('.interactive-list')!;
      return element.getBoundingClientRect().top - container.getBoundingClientRect().top;
    });
    await summary.click();
    await expect(summary).toHaveAttribute('aria-expanded', 'true');

    const samples = await summary.evaluate(async (element) => {
      const container = element.closest<HTMLElement>('.interactive-list')!;
      const tops: number[] = [];
      for (let frame = 0; frame < 12; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        tops.push(element.getBoundingClientRect().top - container.getBoundingClientRect().top);
      }
      return tops;
    });
    expect(
      samples.every((top) => Math.abs(top - topBefore) <= 1.5),
      JSON.stringify({ topBefore, samples })
    ).toBe(true);
    expect((await getScrollMetrics(page, '.interactive-list')).distanceFromBottom).toBeGreaterThan(
      10
    );
  });

  test('renders every file diff without paging them', async ({ page }) => {
    await page.goto(
      '/e2e/harness/index.html?scenario=diff-preview-large-transcript&multiFileDiff=1'
    );
    const finalRow = page.locator('[data-msg-id="message-diff-preview-assistant-59"]');
    await expect(page.locator('.interactive-list-track')).toHaveClass(/virtualized/);
    const summary = finalRow.locator('.assistant-activity-summary');
    await expect(summary).toHaveAttribute('aria-expanded', 'false');
    await summary.click();
    await expect(summary).toHaveAttribute('aria-expanded', 'true');
    await expect(finalRow.locator('.assistant-file-edit-pager')).toHaveCount(0);
    await expect(finalRow.locator('.diff-view-file')).toHaveCount(2);
    await expect(finalRow.locator('.diff-view-filename')).toHaveText([
      'report-59.ts',
      'report-59-details.ts',
    ]);
  });

  test('keeps visible rows stable after prepending heterogeneous history', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=assistant-heavy-history&windowed=1');
    const list = page.locator('.interactive-list');
    await expect(page.locator('.interactive-list-track')).toHaveClass(/virtualized/);

    await list.evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
      element.scrollTop = 20;
      element.dispatchEvent(new Event('scroll'));
    });
    // Setup only: a prepend legitimately raises scrollTop. The wheel loop below owns the jump oracle.
    await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(100);
    await waitForAnimationFrames(page, 4);

    const box = await list.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);

    for (let step = 0; step < 32; step += 1) {
      const before = await list.evaluate((element) => {
        const containerRect = element.getBoundingClientRect();
        const row = [...element.querySelectorAll<HTMLElement>('[data-msg-id]')].find(
          (candidate) => {
            const rect = candidate.getBoundingClientRect();
            return rect.bottom > containerRect.top && rect.top < containerRect.bottom;
          }
        );
        return {
          scrollTop: element.scrollTop,
          id: row?.dataset.msgId ?? '',
          top: row ? row.getBoundingClientRect().top - containerRect.top : 0,
        };
      });
      if (before.scrollTop <= 1) break;
      await page.mouse.wheel(0, -80);
      const tops = await sampleMessageTopAcrossFrames(list, before.id, 4);
      expect(
        tops.every((top) => top !== null),
        JSON.stringify({ step, before, tops })
      ).toBe(true);
      const settledTop = tops.at(-1)!;
      expect(Math.abs(settledTop! - before.top - 80), `wheel step ${step}`).toBeLessThan(6);
      for (const top of tops.slice(1)) {
        expect(Math.abs(top! - settledTop!), `settling step ${step}`).toBeLessThan(1.5);
      }
    }
  });

  test('slowly scrolls a cold large session through every history page without jumps', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 486, height: 800 });
    await page.goto(
      '/e2e/harness/index.html?scenario=cold-large-history&windowed=1&deferHistory=1'
    );
    const list = page.locator('.interactive-list');
    await expect(page.locator('.interactive-list-track')).toHaveClass(/virtualized/);
    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const harness = window as Window & {
            __varroE2E?: { pendingHistoryRequestCount?: () => number };
          };
          return harness.__varroE2E?.pendingHistoryRequestCount?.() ?? 0;
        })
      )
      .toBe(1);

    const result = await list.evaluate(async (element) => {
      const harness = window as Window & {
        __varroE2E?: {
          pendingHistoryRequestCount?: () => number;
          releaseNextHistoryRequest?: () => boolean;
          requests?: Array<{ path: string }>;
        };
      };
      // oxlint-disable-next-line consistent-function-scoping -- Playwright serializes this scope.
      const waitForFrame = () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(() => resolve(), 0)));
      const getRequestCount = () =>
        (harness.__varroE2E?.requests ?? []).filter((request) =>
          request.path.includes('/session/session-cold-large-history/message')
        ).length;
      const getVisibleRow = () => {
        const containerRect = element.getBoundingClientRect();
        return [...element.querySelectorAll<HTMLElement>('[data-msg-id]')].find((row) => {
          const rect = row.getBoundingClientRect();
          return rect.bottom > containerRect.top && rect.top < containerRect.bottom;
        });
      };
      const violations: Array<Record<string, unknown>> = [];
      // Track mutation peaks as well as painted frames. A pinned history gap must not briefly
      // materialize one placeholder MessageRow per skipped message between frame samples.
      // oxlint-disable-next-line unicorn/consistent-function-scoping -- Playwright serializes this scope.
      const countRows = (node: Node) => {
        if (!(node instanceof Element)) return 0;
        return (
          (node.matches('[data-msg-id]') ? 1 : 0) + node.querySelectorAll('[data-msg-id]').length
        );
      };
      let mountedRows = element.querySelectorAll('[data-msg-id]').length;
      let peakMountedRows = mountedRows;
      let pinnedGapMounts = 0;
      const mountObserver = new MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.removedNodes) mountedRows -= countRows(node);
          for (const node of record.addedNodes) {
            mountedRows += countRows(node);
            peakMountedRows = Math.max(peakMountedRows, mountedRows);
            if (
              node instanceof Element &&
              (node.matches('.virtual-pinned-gap') || node.querySelector('.virtual-pinned-gap'))
            ) {
              pinnedGapMounts += 1;
            }
          }
        }
      });
      mountObserver.observe(element, { childList: true, subtree: true });
      let releasedPages = 0;
      let steps = 0;

      while (steps < 1_200) {
        steps += 1;
        const row = getVisibleRow();
        const messageId = row?.dataset.msgId;
        if (!row || !messageId) {
          violations.push({ step: steps, reason: 'no-visible-row' });
          break;
        }
        const containerTop = element.getBoundingClientRect().top;
        const rowTop = row.getBoundingClientRect().top - containerTop;
        const previousScrollTop = element.scrollTop;
        const beforeGeometry = {
          rowTop,
          rowHeight: row.getBoundingClientRect().height,
          scrollTop: previousScrollTop,
          scrollHeight: element.scrollHeight,
          trackTop:
            element.querySelector<HTMLElement>('.interactive-list-track')?.getBoundingClientRect()
              .top ?? null,
          bannerHeight:
            element.querySelector<HTMLElement>('.message-history-banner')?.getBoundingClientRect()
              .height ?? null,
          topSpacerHeight:
            element.querySelector<HTMLElement>('.virtual-spacer-top')?.getBoundingClientRect()
              .height ?? 0,
        };
        const movement = Math.min(96, previousScrollTop);
        element.dispatchEvent(new WheelEvent('wheel', { deltaY: -96, bubbles: true }));
        element.scrollTop = Math.max(0, previousScrollTop - movement);
        element.dispatchEvent(new Event('scroll'));

        if (
          element.scrollTop <= 1 &&
          (harness.__varroE2E?.pendingHistoryRequestCount?.() ?? 0) > 0
        ) {
          if (harness.__varroE2E?.releaseNextHistoryRequest?.()) releasedPages += 1;
        }

        const expectedTop = rowTop + movement;
        const frameTops: Array<number | null> = [];
        for (let frame = 0; frame < 4; frame += 1) {
          await waitForFrame();
          const currentRow = element.querySelector<HTMLElement>(
            `[data-msg-id="${CSS.escape(messageId)}"]`
          );
          const sampledMountedRows = element.querySelectorAll('[data-msg-id]').length;
          peakMountedRows = Math.max(peakMountedRows, sampledMountedRows);
          if (!currentRow) {
            frameTops.push(null);
            continue;
          }
          const currentTop =
            currentRow.getBoundingClientRect().top - element.getBoundingClientRect().top;
          frameTops.push(currentTop);
        }
        if (frameTops.some((top) => top === null || Math.abs(top - expectedTop) > 2.5)) {
          violations.push({
            step: steps,
            messageId,
            expectedTop,
            frameTops,
            scrollTop: element.scrollTop,
            scrollHeight: element.scrollHeight,
            mountedRows: element.querySelectorAll('[data-msg-id]').length,
            requestCount: getRequestCount(),
            beforeGeometry,
            bannerHeight:
              element.querySelector<HTMLElement>('.message-history-banner')?.getBoundingClientRect()
                .height ?? null,
            topSpacerHeight:
              element.querySelector<HTMLElement>('.virtual-spacer-top')?.getBoundingClientRect()
                .height ?? 0,
          });
        }
        if (violations.length > 0) break;

        const visibleRow = getVisibleRow();
        if (!visibleRow) {
          violations.push({ step: steps, reason: 'viewport-uncovered' });
          break;
        }
        if (
          element.scrollTop <= 1 &&
          releasedPages === 2 &&
          (harness.__varroE2E?.pendingHistoryRequestCount?.() ?? 0) === 0 &&
          !element.querySelector('.message-history-banner')
        ) {
          break;
        }
      }

      mountObserver.disconnect();
      return {
        violations,
        peakMountedRows,
        pinnedGapMounts,
        releasedPages,
        requestCount: getRequestCount(),
        steps,
        finalScrollTop: element.scrollTop,
      };
    });

    expect(result.violations, JSON.stringify(result)).toEqual([]);
    expect(result.releasedPages).toBe(2);
    expect(result.requestCount).toBe(3);
    expect(result.finalScrollTop).toBeLessThan(2);
    expect(result.peakMountedRows).toBeLessThan(100);
    expect(result.pinnedGapMounts).toBeGreaterThanOrEqual(2);
  });

  test('preserves the same row through exact 200 plus 200 plus final pagination', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 486, height: 800 });
    await page.goto(
      '/e2e/harness/index.html?scenario=assistant-heavy-history&windowed=1&deferHistory=1'
    );
    const list = page.locator('.interactive-list');
    const historyBanner = page.locator('.message-history-banner');
    await expect(page.locator('.interactive-list-track')).toHaveClass(/virtualized/);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const harness = window as Window & {
            __varroE2E?: { pendingHistoryRequestCount?: () => number };
          };
          return harness.__varroE2E?.pendingHistoryRequestCount?.() ?? 0;
        })
      )
      .toBe(1);

    const loadPageAtTop = async () => {
      await list.evaluate((element) => {
        element.dispatchEvent(new WheelEvent('wheel', { deltaY: -200, bubbles: true }));
        element.scrollTop = 0;
        element.dispatchEvent(new Event('scroll'));
      });
      await expect(historyBanner).toHaveClass(/is-loading/);
      const anchor = await list.evaluate((element) => {
        const containerRect = element.getBoundingClientRect();
        const row = [...element.querySelectorAll<HTMLElement>('[data-msg-id]')].find(
          (candidate) => {
            const rect = candidate.getBoundingClientRect();
            return rect.bottom > containerRect.top && rect.top < containerRect.bottom;
          }
        );
        if (!row?.dataset.msgId) throw new Error('Paginated history anchor is missing');
        return {
          id: row.dataset.msgId,
          top: row.getBoundingClientRect().top - containerRect.top,
        };
      });
      const released = await page.evaluate(() => {
        const harness = window as Window & {
          __varroE2E?: { releaseNextHistoryRequest?: () => boolean };
        };
        return harness.__varroE2E?.releaseNextHistoryRequest?.() ?? false;
      });
      expect(released).toBe(true);
      const samples = await sampleMessageTopAcrossFrames(list, anchor.id);
      // The first test RAF callback can precede the history correction callback in the same
      // pre-paint turn. Every callback after that handoff must preserve the captured row.
      for (const top of samples.slice(1)) {
        expect(top).not.toBeNull();
        expect(
          Math.abs(top! - anchor.top),
          JSON.stringify({ anchor, samples })
        ).toBeLessThan(1.5);
      }
      expect(await list.locator('[data-msg-id]').count()).toBeLessThan(80);
    };

    await loadPageAtTop();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const harness = window as Window & {
            __varroE2E?: { pendingHistoryRequestCount?: () => number };
          };
          return harness.__varroE2E?.pendingHistoryRequestCount?.() ?? 0;
        })
      )
      .toBe(1);
    await loadPageAtTop();
    await expect(historyBanner).toHaveCount(0);

    const stickyCollision = await list.evaluate(async (element) => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event('scroll'));
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      );
      while (element.scrollTop < element.scrollHeight - element.clientHeight - 1) {
        element.dispatchEvent(new WheelEvent('wheel', { deltaY: 32, bubbles: true }));
        element.scrollTop = Math.min(
          element.scrollHeight - element.clientHeight,
          element.scrollTop + 32
        );
        element.dispatchEvent(new Event('scroll'));
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const overlay = document.querySelector<HTMLElement>('.latest-user-message-sticky-overlay');
        if (!overlay) continue;
        const overlayRect = overlay.getBoundingClientRect();
        const nextPrompt = [...element.querySelectorAll<HTMLElement>('.user-message-card')]
          .map((prompt) => ({ prompt, rect: prompt.getBoundingClientRect() }))
          .filter(({ rect }) => rect.top > element.getBoundingClientRect().top)
          .toSorted((left, right) => left.rect.top - right.rect.top)[0];
        if (nextPrompt && nextPrompt.rect.top < overlayRect.bottom - 1) {
          return {
            overlap: overlayRect.bottom - nextPrompt.rect.top,
            prompt: nextPrompt.prompt.textContent,
            scrollTop: element.scrollTop,
          };
        }
      }
      return null;
    });
    expect(stickyCollision).toBeNull();

    const historyRequests = await page.evaluate(() => {
      const harness = window as Window & {
        __varroE2E?: { requests?: Array<{ path: string }> };
      };
      return (harness.__varroE2E?.requests ?? [])
        .filter((request) =>
          request.path.includes('/session/session-assistant-heavy-history/message')
        )
        .map((request) => {
          const params = new URL(request.path, 'https://example.test').searchParams;
          return { before: params.get('before'), limit: params.get('limit') };
        });
    });
    expect(historyRequests).toEqual([
      { before: null, limit: '200' },
      { before: 'msg_cursor_0001', limit: '200' },
      { before: 'msg_cursor_0002', limit: '200' },
    ]);
  });

  test('keeps the sticky fixed across the history-boundary state', async ({ page }) => {
    await page.setViewportSize({ width: 486, height: 800 });
    await page.goto('/e2e/harness/index.html?scenario=sticky-preview');
    const list = page.locator('.interactive-list');
    const sticky = page.locator('.latest-user-message-sticky');
    await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event('scroll'));
    });
    await expect(sticky).toBeVisible();

    const positions = await list.evaluate((element) => {
      const overlay = document.querySelector<HTMLElement>('.latest-user-message-sticky-overlay');
      const track = element.querySelector<HTMLElement>('.interactive-list-track');
      if (!track) throw new Error('Message track is missing');
      if (!overlay) throw new Error('Boundary sticky is missing');
      const listTop = element.getBoundingClientRect().top;
      const top = () => overlay.getBoundingClientRect().top - listTop;
      const before = top();
      track.classList.add('history-boundary-visible');
      const atBoundary = top();
      track.classList.remove('history-boundary-visible');
      return {
        before,
        atBoundary,
        after: top(),
      };
    });
    expect(Math.abs(positions.atBoundary - positions.before)).toBeLessThan(1);
    expect(Math.abs(positions.after - positions.before)).toBeLessThan(1);
  });

  test('settles a compact anchor after provisional history heights collapse', async ({ page }) => {
    await page.setViewportSize({ width: 486, height: 800 });
    await page.goto(
      '/e2e/harness/index.html?scenario=compact-pagination-anchor&windowed=1&deferHistory=1'
    );
    const list = page.locator('.interactive-list');
    const historyBanner = page.locator('.message-history-banner');
    const anchor = page.locator('[data-msg-id="message-compact-pagination-anchor"]');
    await expect(page.locator('.interactive-list-track')).toHaveClass(/virtualized/);
    await expect(anchor).toBeAttached();

    await list.evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -200, bubbles: true }));
      element.scrollTop = 4;
      element.dispatchEvent(new Event('scroll'));
    });
    await expect(historyBanner).toHaveClass(/is-loading/);
    const anchorTop = await anchor.evaluate((element) => {
      const container = element.closest<HTMLElement>('.interactive-list')!;
      return element.getBoundingClientRect().top - container.getBoundingClientRect().top;
    });

    const released = await page.evaluate(() => {
      const harness = window as Window & {
        __varroE2E?: { releaseNextHistoryRequest?: () => boolean };
      };
      return harness.__varroE2E?.releaseNextHistoryRequest?.() ?? false;
    });
    expect(released).toBe(true);

    const samples = await sampleMessageTopAcrossFrames(
      list,
      'message-compact-pagination-anchor',
      8
    );
    for (const top of samples) {
      expect(top).not.toBeNull();
      // Reparenting the compact summary can transfer one row-boundary pixel on each edge while
      // its stable activity identity remains anchored.
      expect(Math.abs(top! - anchorTop), JSON.stringify({ anchorTop, samples })).toBeLessThan(2.5);
    }
  });

  test('keeps the incident-equivalent paginated image row stable across delayed loading', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 486, height: 800 });

    let markImageRequestStarted!: () => void;
    const imageRequestStarted = new Promise<void>((resolve) => {
      markImageRequestStarted = resolve;
    });
    let releaseImageRequest!: () => void;
    const imageRequestRelease = new Promise<void>((resolve) => {
      releaseImageRequest = resolve;
    });
    let imageRequestCount = 0;
    await page.route('**/e2e/harness/incident-delayed-image.svg', async (route) => {
      imageRequestCount += 1;
      markImageRequestStarted();
      await imageRequestRelease;
      await route.fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="#3b82f6"/><circle cx="320" cy="240" r="96" fill="#dbeafe"/></svg>',
      });
    });

    await page.goto(
      '/e2e/harness/index.html?scenario=incident-delayed-image-history&windowed=1&deferHistory=1'
    );
    const list = page.locator('.interactive-list');
    const historyBanner = page.locator('.message-history-banner');
    const imageRow = page.locator('[data-msg-id="message-incident-delayed-image-user"]');
    const imageFrame = imageRow.locator('.chat-image-preview-trigger');
    const pendingHistoryRequestCount = () =>
      page.evaluate(() => {
        const harness = window as Window & {
          __varroE2E?: { pendingHistoryRequestCount?: () => number };
        };
        return harness.__varroE2E?.pendingHistoryRequestCount?.() ?? 0;
      });

    const fixtureMessageCount = await page.evaluate(() => {
      const harness = window as Window & {
        __varroE2E?: { getSessionMessages?: (sessionId: string) => unknown[] };
      };
      return (
        harness.__varroE2E?.getSessionMessages?.('session-incident-delayed-image-history').length ??
        0
      );
    });
    expect(fixtureMessageCount).toBe(429);
    await expect(page.locator('.interactive-list-track')).toHaveClass(/virtualized/);
    await expect(imageRow).toBeAttached({ timeout: 5_000 });
    await imageRequestStarted;
    const frameBeforeRelease = await imageFrame.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return { width: box.width, height: box.height };
    });
    expect(frameBeforeRelease.width / frameBeforeRelease.height).toBeCloseTo(16 / 9, 2);
    expect(
      await imageFrame.locator('img').evaluate((image: HTMLImageElement) => image.naturalWidth)
    ).toBe(0);
    await expect.poll(pendingHistoryRequestCount).toBe(1);

    const loadDeferredHistoryPage = async () => {
      await list.evaluate((element) => {
        element.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, bubbles: true }));
        element.scrollTop = 0;
        element.dispatchEvent(new Event('scroll'));
      });
      await expect(historyBanner).toHaveClass(/is-loading/);
      const anchor = await list.evaluate((element) => {
        const containerRect = element.getBoundingClientRect();
        const row = [...element.querySelectorAll<HTMLElement>('[data-msg-id]')].find(
          (candidate) => {
            const rect = candidate.getBoundingClientRect();
            return rect.bottom > containerRect.top && rect.top < containerRect.bottom;
          }
        );
        if (!row?.dataset.msgId) throw new Error('Incident history anchor is missing');
        return {
          id: row.dataset.msgId,
          top: row.getBoundingClientRect().top - containerRect.top,
        };
      });
      const released = await page.evaluate(() => {
        const harness = window as Window & {
          __varroE2E?: { releaseNextHistoryRequest?: () => boolean };
        };
        return harness.__varroE2E?.releaseNextHistoryRequest?.() ?? false;
      });
      expect(released).toBe(true);

      const samples = await sampleMessageTopAcrossFrames(list, anchor.id);
      for (const top of samples) {
        expect(top).not.toBeNull();
        expect(Math.abs(top! - anchor.top)).toBeLessThan(1.5);
      }
      expect(await list.locator('[data-msg-id]').count()).toBeLessThan(80);
    };

    await loadDeferredHistoryPage();
    await expect(imageRow).toHaveCount(0);
    await expect.poll(pendingHistoryRequestCount).toBe(1);
    await loadDeferredHistoryPage();
    await expect(historyBanner).toHaveCount(0);
    await expect(imageRow).toHaveCount(0);

    const historyRequests = await page.evaluate(() => {
      const harness = window as Window & {
        __varroE2E?: { requests?: Array<{ path: string }> };
      };
      return (harness.__varroE2E?.requests ?? [])
        .filter((request) =>
          request.path.includes('/session/session-incident-delayed-image-history/message')
        )
        .map((request) => {
          const params = new URL(request.path, 'https://example.test').searchParams;
          return { before: params.get('before'), limit: params.get('limit') };
        });
    });
    expect(historyRequests).toEqual([
      { before: null, limit: '200' },
      { before: 'msg_cursor_0001', limit: '200' },
      { before: 'msg_cursor_0002', limit: '200' },
    ]);

    const imageResponse = page.waitForResponse((response) =>
      response.url().endsWith('/e2e/harness/incident-delayed-image.svg')
    );
    releaseImageRequest();
    await imageResponse;

    await list.evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: 2_000, bubbles: true }));
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event('scroll'));
    });
    await expect(imageRow).toBeAttached();
    await waitForAnimationFrames(page, 4);
    const imageRowTop = await imageRow.evaluate((element) => {
      const scrollList = element.closest<HTMLElement>('.interactive-list')!;
      return element.getBoundingClientRect().top - scrollList.getBoundingClientRect().top;
    });
    await imageFrame.locator('img').evaluate((image: HTMLImageElement) => image.decode());
    const frameAfterRelease = await imageFrame.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return { width: box.width, height: box.height };
    });
    expect(frameAfterRelease).toEqual(frameBeforeRelease);
    expect(
      await imageFrame.locator('img').evaluate((image: HTMLImageElement) => image.naturalWidth)
    ).toBe(640);
    expect(imageRequestCount).toBeGreaterThan(0);

    const remountSamples = await sampleMessageTopAcrossFrames(
      list,
      'message-incident-delayed-image-user'
    );
    for (const top of remountSamples) {
      expect(top).not.toBeNull();
      expect(Math.abs(top! - imageRowTop)).toBeLessThan(1.5);
    }
    expect(await list.locator('[data-msg-id]').count()).toBeLessThan(80);
  });

  test('transfers deferred history ownership after native PageDown movement', async ({ page }) => {
    await page.goto(
      '/e2e/harness/index.html?scenario=assistant-heavy-history&windowed=1&deferHistory=1'
    );
    const list = page.locator('.interactive-list');
    const historyBanner = page.locator('.message-history-banner');
    await expect(page.locator('.interactive-list-track')).toHaveClass(/virtualized/);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const harness = window as Window & {
            __varroE2E?: { pendingHistoryRequestCount?: () => number };
          };
          return harness.__varroE2E?.pendingHistoryRequestCount?.() ?? 0;
        })
      )
      .toBe(1);

    await list.evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -200, bubbles: true }));
      element.scrollTop = 0;
      element.dispatchEvent(new Event('scroll'));
      element.tabIndex = 0;
      element.focus();
    });
    await expect(historyBanner).toHaveClass(/is-loading/);
    await page.keyboard.press('PageDown');
    // Setup only: prove PageDown moved before capturing the user-owned visible anchor.
    await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(100);
    await list.evaluate(async (element) => {
      let previousTop = element.scrollTop;
      let stableFrames = 0;
      while (stableFrames < 3) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const nextTop = element.scrollTop;
        stableFrames = Math.abs(nextTop - previousTop) <= 0.5 ? stableFrames + 1 : 0;
        previousTop = nextTop;
      }
    });

    const anchor = await list.evaluate((element) => {
      const containerRect = element.getBoundingClientRect();
      const row = [...element.querySelectorAll<HTMLElement>('[data-msg-id]')].find((candidate) => {
        const rect = candidate.getBoundingClientRect();
        return rect.bottom > containerRect.top && rect.top < containerRect.bottom;
      });
      if (!row?.dataset.msgId) throw new Error('PageDown history anchor is missing');
      return {
        id: row.dataset.msgId,
        top: row.getBoundingClientRect().top - containerRect.top,
      };
    });
    await page.evaluate(() => {
      const harness = window as Window & {
        __varroE2E?: { releaseNextHistoryRequest?: () => boolean };
      };
      if (!harness.__varroE2E?.releaseNextHistoryRequest?.()) {
        throw new Error('Deferred history page was not pending');
      }
    });

    const samples = await sampleMessageTopAcrossFrames(list, anchor.id);
    for (const top of samples) {
      expect(top).not.toBeNull();
      expect(Math.abs(top! - anchor.top)).toBeLessThan(1.5);
    }
  });

  test('yields post-prepend settling to continued native user movement', async ({ page }) => {
    await page.goto(
      '/e2e/harness/index.html?scenario=assistant-heavy-history&windowed=1&deferHistory=1'
    );
    const list = page.locator('.interactive-list');
    const historyBanner = page.locator('.message-history-banner');
    await expect(page.locator('.interactive-list-track')).toHaveClass(/virtualized/);

    await list.evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -200, bubbles: true }));
      element.scrollTop = 0;
      element.dispatchEvent(new Event('scroll'));
    });
    await expect(historyBanner).toHaveClass(/is-loading/);

    await list.evaluate((element) => {
      element.tabIndex = 0;
      element.focus();
      element.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
      const track = element.querySelector('.interactive-list-track')!;
      const initialIds = new Set(
        [...element.querySelectorAll<HTMLElement>('[data-msg-id]')].map((row) => row.dataset.msgId)
      );
      const observer = new MutationObserver(() => {
        const hasPrependedRow = [...element.querySelectorAll<HTMLElement>('[data-msg-id]')].some(
          (row) => !initialIds.has(row.dataset.msgId)
        );
        if (!hasPrependedRow) return;
        observer.disconnect();
        let restoreFrameAttempts = 0;
        let restoreMicrotaskAttempts = 0;
        const moveAfterSynchronousRestore = () => {
          if (element.scrollTop <= 120) {
            restoreMicrotaskAttempts += 1;
            if (restoreMicrotaskAttempts < 10) {
              queueMicrotask(moveAfterSynchronousRestore);
              return;
            }
            restoreMicrotaskAttempts = 0;
            restoreFrameAttempts += 1;
            if (restoreFrameAttempts >= 60) {
              (
                window as Window & {
                  postPrependUserMovementError?: string;
                }
              ).postPrependUserMovementError = 'Post-prepend scroll restoration did not settle';
              return;
            }
            requestAnimationFrame(moveAfterSynchronousRestore);
            return;
          }
          const requestedTop = element.scrollTop - 120;
          element.scrollTop = requestedTop;
          element.dispatchEvent(new Event('scroll'));
          const bounds = element.getBoundingClientRect();
          const row = [...element.querySelectorAll<HTMLElement>('[data-msg-id]')].find(
            (candidate) => {
              const rect = candidate.getBoundingClientRect();
              return rect.bottom > bounds.top && rect.top < bounds.bottom;
            }
          );
          if (!row?.dataset.msgId) throw new Error('Post-prepend user anchor is missing');
          (
            window as Window & {
              postPrependUserMovement?: { id: string; top: number; scrollTop: number };
            }
          ).postPrependUserMovement = {
            id: row.dataset.msgId,
            top: row.getBoundingClientRect().top - bounds.top,
            scrollTop: element.scrollTop,
          };
        };
        queueMicrotask(moveAfterSynchronousRestore);
      });
      observer.observe(track, { childList: true, subtree: true });
    });

    await page.evaluate(() => {
      const harness = window as Window & {
        __varroE2E?: { releaseNextHistoryRequest?: () => boolean };
      };
      if (!harness.__varroE2E?.releaseNextHistoryRequest?.()) {
        throw new Error('Deferred history page was not pending');
      }
    });
    await expect
      .poll(async () => {
        const result = await page.evaluate(() => {
          const movementWindow = window as Window & {
            postPrependUserMovement?: { id: string; top: number; scrollTop: number };
            postPrependUserMovementError?: string;
          };
          return {
            movement: movementWindow.postPrependUserMovement ?? null,
            error: movementWindow.postPrependUserMovementError ?? null,
          };
        });
        if (result.error) return `error:${result.error}`;
        return result.movement ? 'ready' : 'pending';
      })
      .not.toBe('pending');
    const movementResult = await page.evaluate(() => {
      const movementWindow = window as Window & {
        postPrependUserMovement?: { id: string; top: number; scrollTop: number };
        postPrependUserMovementError?: string;
      };
      return {
        movement: movementWindow.postPrependUserMovement ?? null,
        error: movementWindow.postPrependUserMovementError ?? null,
      };
    });
    if (movementResult.error) throw new Error(movementResult.error);
    if (!movementResult.movement) throw new Error('Post-prepend user movement is missing');
    const userMovement = movementResult.movement;

    const samples = await sampleMessageTopAcrossFrames(list, userMovement.id, 6);
    // Provisional heights above the destination may reconcile scrollTop and the top spacer.
    // The same row's painted viewport position is the user-visible ownership invariant.
    for (const top of samples) {
      expect(top).not.toBeNull();
      expect(
        Math.abs(top! - userMovement.top),
        JSON.stringify({ userMovement, samples })
      ).toBeLessThan(1.5);
    }
  });

  test('does not restore a stale history anchor after the user scrolls during the request', async ({
    page,
  }) => {
    await page.goto(
      '/e2e/harness/index.html?scenario=assistant-heavy-history&windowed=1&deferHistory=1'
    );
    const list = page.locator('.interactive-list');
    const historyBanner = page.locator('.message-history-banner');
    await expect(page.locator('.interactive-list-track')).toHaveClass(/virtualized/);

    await list.evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -200, bubbles: true }));
      element.scrollTop = 20;
      element.dispatchEvent(new Event('scroll'));
    });
    await expect(historyBanner).toHaveClass(/is-loading/);

    const userOwnedAnchor = await list.evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: 600, bubbles: true }));
      element.scrollTop = 620;
      element.dispatchEvent(new Event('scroll'));
      const containerRect = element.getBoundingClientRect();
      const row = [...element.querySelectorAll<HTMLElement>('[data-msg-id]')].find((candidate) => {
        const rect = candidate.getBoundingClientRect();
        return rect.bottom > containerRect.top && rect.top < containerRect.bottom;
      });
      if (!row?.dataset.msgId) throw new Error('User-owned history anchor is missing');
      return {
        id: row.dataset.msgId,
        top: row.getBoundingClientRect().top - containerRect.top,
      };
    });
    await page.evaluate(() => {
      const harness = window as Window & {
        __varroE2E?: { releaseHistoryRequests?: () => void };
      };
      harness.__varroE2E?.releaseHistoryRequests?.();
    });

    await expect(historyBanner).not.toHaveClass(/is-loading/);
    await waitForAnimationFrames(page, 6);
    const samples = await sampleMessageTopAcrossFrames(list, userOwnedAnchor.id, 12);
    expect(
      samples.every((top) => top !== null && Math.abs(top - userOwnedAnchor.top) < 1.5),
      JSON.stringify({ userOwnedAnchor, samples })
    ).toBe(true);
  });

  test('keeps history anchored when an upward wheel cannot move past the top boundary', async ({
    page,
  }) => {
    await page.goto(
      '/e2e/harness/index.html?scenario=assistant-heavy-history&windowed=1&deferHistory=1'
    );
    const list = page.locator('.interactive-list');
    const historyBanner = page.locator('.message-history-banner');
    await expect(page.locator('.interactive-list-track')).toHaveClass(/virtualized/);

    await list.evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -200, bubbles: true }));
      element.scrollTop = 0;
      element.dispatchEvent(new Event('scroll'));
    });
    await expect(historyBanner).toHaveClass(/is-loading/);

    const anchor = await list.evaluate((element) => {
      const containerRect = element.getBoundingClientRect();
      const row = [...element.querySelectorAll<HTMLElement>('[data-msg-id]')].find((candidate) => {
        const rect = candidate.getBoundingClientRect();
        return rect.bottom > containerRect.top && rect.top < containerRect.bottom;
      });
      if (!row?.dataset.msgId) throw new Error('Boundary history anchor is missing');
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true }));
      return {
        id: row.dataset.msgId,
        top: row.getBoundingClientRect().top - containerRect.top,
        scrollTop: element.scrollTop,
      };
    });
    // Boundary precondition only; post-load stability is asserted from the same row below.
    expect(anchor.scrollTop).toBe(0);

    await page.evaluate(() => {
      const harness = window as Window & {
        __varroE2E?: { releaseHistoryRequests?: () => void };
      };
      harness.__varroE2E?.releaseHistoryRequests?.();
    });
    await expect(historyBanner).not.toHaveClass(/is-loading/);
    await waitForAnimationFrames(page, 6);
    await expect
      .poll(() =>
        list.evaluate((element, anchorId) => {
          const row = [...element.querySelectorAll<HTMLElement>('[data-msg-id]')].find(
            (candidate) => candidate.dataset.msgId === anchorId
          );
          return row ? row.getBoundingClientRect().top - element.getBoundingClientRect().top : null;
        }, anchor.id)
      )
      .toBeCloseTo(anchor.top, 0);
  });

  test('mixed small chat scrolls upward without random jumps', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=mixed-small-transcript');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);

    const box = await list.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);

    for (let index = 0; index < 18; index += 1) {
      const anchor = await getVisibleMessageAnchor(list);
      if (anchor.scrollTop < 160) break;
      await page.mouse.wheel(0, -160);
      const samples = await sampleMessageTopAcrossFrames(list, anchor.id, 3);
      expect(
        samples.every((top) => top !== null),
        JSON.stringify({ index, anchor, samples })
      ).toBe(true);
      const settledTop = samples.at(-1)!;
      expect(Math.abs(settledTop! - anchor.top - 160), `wheel step ${index}`).toBeLessThan(4);
      for (const top of samples.slice(1)) {
        expect(Math.abs(top! - settledTop!), `settling step ${index}`).toBeLessThan(1.5);
      }
    }
  });

  test('keeps a detached small-chat anchor stable when rows above grow and collapse', async ({
    page,
  }) => {
    await page.goto('/e2e/harness/index.html?scenario=mixed-small-transcript');
    const list = page.locator('.interactive-list');
    const track = page.locator('.interactive-list-track');
    const anchor = page.locator('[data-msg-id="message-small-user-12"]');
    const rowAbove = page.locator('[data-msg-id="message-small-assistant-2"]');
    await expect(track).not.toHaveClass(/virtualized/);

    await list.evaluate((element) => {
      const target = element.querySelector<HTMLElement>('[data-msg-id="message-small-user-12"]');
      if (!target) throw new Error('Small-chat anchor is missing');
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -200, bubbles: true }));
      element.scrollTop +=
        target.getBoundingClientRect().top - element.getBoundingClientRect().top - 120;
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrames(page, 3);

    const anchorTop = await anchor.evaluate((element) => {
      const scrollList = element.closest<HTMLElement>('.interactive-list')!;
      return element.getBoundingClientRect().top - scrollList.getBoundingClientRect().top;
    });
    await rowAbove.evaluate((element) => {
      element.style.paddingBottom = '280px';
    });
    await waitForAnimationFrames(page, 3);
    await expect
      .poll(() =>
        anchor.evaluate((element) => {
          const scrollList = element.closest<HTMLElement>('.interactive-list')!;
          return element.getBoundingClientRect().top - scrollList.getBoundingClientRect().top;
        })
      )
      .toBeCloseTo(anchorTop, 0);

    await rowAbove.evaluate((element) => {
      element.style.paddingBottom = '';
    });
    await waitForAnimationFrames(page, 3);
    await expect
      .poll(() =>
        anchor.evaluate((element) => {
          const scrollList = element.closest<HTMLElement>('.interactive-list')!;
          return element.getBoundingClientRect().top - scrollList.getBoundingClientRect().top;
        })
      )
      .toBeCloseTo(anchorTop, 0);
  });

  test('follows assistant response growth while pinned to the bottom', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=large-transcript');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);

    await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrame(page);

    for (let index = 0; index < 6; index += 1) {
      await appendDeltaToLastLargeAssistant(
        page,
        `\n\nStreaming bottom follow chunk ${index}: ${'keep following the bottom '.repeat(10)}`
      );
      await waitForAnimationFrame(page);
    }

    await expect(page.locator('.chat-turn-assistant').last()).toContainText(
      'Streaming bottom follow chunk 5'
    );
    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);
  });

  test('keeps follow disabled after manual scroll and re-enables at bottom', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=large-transcript');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);

    await list.evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -160, bubbles: true }));
      element.scrollTop = Math.max(0, element.scrollTop - 800);
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrames(page, 2);
    const detachedAnchor = await getVisibleMessageAnchor(list);

    await appendDeltaToLastLargeAssistant(
      page,
      `\n\nDetached streaming chunk: ${'do not steal scroll position '.repeat(18)}`
    );
    const detachedSamples = await sampleMessageTopAcrossFrames(list, detachedAnchor.id, 3);

    expect(
      detachedSamples.every((top) => top !== null && Math.abs(top - detachedAnchor.top) < 1.5),
      JSON.stringify({ detachedAnchor, detachedSamples })
    ).toBe(true);
    expect((await getScrollMetrics(page, '.interactive-list')).distanceFromBottom).toBeGreaterThan(
      200
    );

    await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrames(page, 2);

    await appendDeltaToLastLargeAssistant(
      page,
      `\n\nReattached streaming chunk: ${'follow again '.repeat(24)}`
    );

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);
  });
});

test.describe('auto-scroll re-engage', () => {
  test('re-engages when user scrolls within 10px of bottom', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=large-transcript');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);

    await list.evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -160, bubbles: true }));
      element.scrollTop = Math.max(0, element.scrollTop - 800);
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrames(page, 3);

    expect((await getScrollMetrics(page, '.interactive-list')).distanceFromBottom).toBeGreaterThan(
      200
    );

    await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight - element.clientHeight - 8;
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrames(page, 3);

    await appendDeltaToLastLargeAssistant(
      page,
      `\n\nRe-engage test chunk: ${'verify auto-scroll re-engages within 10px threshold '.repeat(12)}`
    );
    await waitForAnimationFrames(page, 4);

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);
  });

  test('scroll up during streaming disables follow without snap-back', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=rapid-streaming-jitter');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);

    for (let i = 0; i < 3; i += 1) {
      await appendDeltaToRapidStreaming(
        page,
        `\n\nPre-wheel chunk ${i}: ${'content before wheel '.repeat(8)}`
      );
      await waitForAnimationFrames(page, 2);
    }

    await list.evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -200, bubbles: true }));
      element.scrollTop = Math.max(0, element.scrollTop - 200);
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrames(page, 3);
    const detachedAnchor = await getVisibleMessageAnchor(list);

    for (let i = 0; i < 3; i += 1) {
      await appendDeltaToRapidStreaming(
        page,
        `\n\nPost-wheel chunk ${i}: ${'content after wheel should not snap back '.repeat(10)}`
      );
      const samples = await sampleMessageTopAcrossFrames(list, detachedAnchor.id, 2);
      expect(
        samples.every((top) => top !== null && Math.abs(top - detachedAnchor.top) < 1.5),
        JSON.stringify({ i, detachedAnchor, samples })
      ).toBe(true);
    }
  });

  test('scrolling to bottom during streaming re-engages follow', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=rapid-streaming-jitter');
    const list = page.locator('.interactive-list');
    await expect(list).toBeVisible();

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);

    await list.evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -160, bubbles: true }));
      element.scrollTop = Math.max(0, element.scrollTop - 500);
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrames(page, 3);

    expect((await getScrollMetrics(page, '.interactive-list')).distanceFromBottom).toBeGreaterThan(
      200
    );

    await appendDeltaToRapidStreaming(
      page,
      `\n\nDetached chunk: ${'should not follow '.repeat(10)}`
    );
    await waitForAnimationFrames(page, 3);

    await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event('scroll'));
    });
    await waitForAnimationFrames(page, 3);

    for (let i = 0; i < 4; i += 1) {
      await appendDeltaToRapidStreaming(
        page,
        `\n\nRe-engage chunk ${i}: ${'follow after re-engage '.repeat(12)}`
      );
      await waitForAnimationFrames(page, 2);
    }

    await expect
      .poll(() => getScrollMetrics(page, '.interactive-list').then((m) => m.distanceFromBottom))
      .toBeLessThan(15);
  });
});
