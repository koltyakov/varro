import { expect, test } from '@playwright/test';
import type { ServerEvent } from '../../src/shared/protocol';
import type { AssistantMessage, MessageEntry, ToolPart } from '../../src/webview/types';
import { installPlaybackCapture, waitForAnimationFrames } from './helpers';

for (const measured of [false, true]) {
  test(`does not back off when Thinking hands off to a running edit (${measured ? 'measured' : 'short'})`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 490, height: 427 });
    const sessionID = 'thinking-running-edit';
    const created = 1_780_000_000_000;
    const assistantInfo: AssistantMessage = {
      id: 'edit-context',
      sessionID,
      role: 'assistant',
      parentID: 'edit-user',
      time: { created },
      providerID: 'openai',
      modelID: 'gpt-5',
      mode: 'build',
      agent: 'build',
      path: { cwd: '/workspace', root: '/workspace' },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    };
    const messages: MessageEntry[] = Array.from({ length: measured ? 60 : 1 }, (_, index) => {
      const id = `edit-context-${index}`;
      return {
        info: {
          ...assistantInfo,
          id,
          time: { created, completed: created + 1 },
          finish: 'tool-calls',
        },
        parts: [
          {
            id: `${id}-text`,
            messageID: id,
            sessionID,
            type: 'text',
            text: 'The webview checks and full plugin build passed. I also noticed the version was changed during this session. I will preserve that change and rebuild the package with the matching version.\n\nThe next edit updates the documentation.',
          },
        ],
      };
    });
    const lastContextId = messages.at(-1)!.info.id;
    messages.unshift({
      info: {
        id: 'edit-user',
        sessionID,
        role: 'user',
        time: { created: created - 1 },
        agent: 'build',
        model: { providerID: 'openai', modelID: 'gpt-5' },
      },
      parts: [
        {
          id: 'edit-prompt',
          messageID: 'edit-user',
          sessionID,
          type: 'text',
          text: 'Check the build and update the documentation.',
        },
      ],
    });
    await installPlaybackCapture(page, {
      session: {
        id: sessionID,
        projectID: 'project-test',
        directory: '/workspace',
        title: 'Thinking to edit',
        version: '1.0.0',
        time: { created, updated: created },
      },
      initialMessages: messages,
    });
    await page.goto('/e2e/harness/index.html?scenario=session-playback');
    await expect(page.locator(`[data-msg-id="${lastContextId}"]`)).toBeVisible();
    await page.evaluate(
      ({ info }) => {
        // SAFETY: The isolated E2E page installs this fixture-only transport.
        const harness = (
          window as Window & { __varroE2E?: { replayServerEvent(event: ServerEvent): void } }
        ).__varroE2E!;
        harness.replayServerEvent({
          type: 'session.status',
          properties: { sessionID: info.sessionID, status: { type: 'busy' } },
        });
        harness.replayServerEvent({
          type: 'message.updated',
          properties: { info: { ...info, id: 'thinking-message' } },
        });
        harness.replayServerEvent({
          type: 'message.part.updated',
          properties: {
            part: {
              id: 'reasoning-part',
              messageID: 'thinking-message',
              sessionID: info.sessionID,
              type: 'reasoning',
              text: 'I will update the documentation after checking the build.',
              time: { start: Date.now() },
            },
          },
        });
      },
      { info: assistantInfo }
    );
    await expect(
      page.locator('.interactive-loading-row:not(.is-reserved) .loading-indicator')
    ).toBeVisible();
    await waitForAnimationFrames(page, 30);
    const editPart: ToolPart = {
      id: 'running-edit-part',
      messageID: 'running-edit-message',
      sessionID,
      type: 'tool',
      tool: 'patch',
      callID: 'edit-call',
      state: {
        status: 'running',
        input: {},
        title: 'Edit',
        time: { start: Date.now() },
      },
    };
    const samples = await page.evaluate(
      async ({ part, info }) => {
        // SAFETY: The isolated E2E page installs this fixture-only transport.
        const harness = (
          window as Window & { __varroE2E?: { replayServerEvent(event: ServerEvent): void } }
        ).__varroE2E!;
        const list = document.querySelector<HTMLElement>('.interactive-list')!;
        const marker = [...list.querySelectorAll('.rendered-markdown p')].at(-1)!;
        const sample = () => ({
          top: marker.getBoundingClientRect().top,
          scrollTop: list.scrollTop,
          scrollHeight: list.scrollHeight,
          rowHeight:
            document.querySelector('[data-msg-id="running-edit-message"]')?.getBoundingClientRect()
              .height ?? 0,
        });
        const result = [sample()];
        harness.replayServerEvent({
          type: 'message.part.updated',
          properties: {
            part: {
              id: 'reasoning-part',
              messageID: 'thinking-message',
              sessionID: info.sessionID,
              type: 'reasoning',
              text: 'I will update the documentation after checking the build.',
              time: { start: Date.now() - 1000, end: Date.now() },
            },
          },
        });
        harness.replayServerEvent({
          type: 'message.updated',
          properties: { info: { ...info, id: part.messageID } },
        });
        harness.replayServerEvent({ type: 'message.part.updated', properties: { part } });
        for (let frame = 0; frame < 180; frame++) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
          result.push(sample());
        }
        return result;
      },
      { part: editPart, info: assistantInfo }
    );
    await expect(page.locator('[data-msg-id="running-edit-message"]')).toContainText('Editing');
    expect(samples.filter((sample) => sample.rowHeight > 0).length).toBeGreaterThan(30);
    expect(
      Math.max(...samples.slice(1).map((sample, index) => sample.top - samples[index]!.top)),
      JSON.stringify(samples)
    ).toBeLessThanOrEqual(0.1);

    const completionSamples = await page.evaluate(async (part) => {
      // SAFETY: Only the isolated harness receives these synthetic tool events.
      const harness = (
        window as Window & { __varroE2E?: { replayServerEvent(event: ServerEvent): void } }
      ).__varroE2E!;
      const list = document.querySelector<HTMLElement>('.interactive-list')!;
      const marker = [...list.querySelectorAll('.rendered-markdown p')].at(-1)!;
      const sample = () => ({
        top: marker.getBoundingClientRect().top,
        editHeight:
          document.querySelector('[data-msg-id="running-edit-message"]')?.getBoundingClientRect()
            .height ?? 0,
        cardHeight:
          document
            .querySelector('[data-msg-id="running-edit-message"] .chat-tool-invocation-part')
            ?.getBoundingClientRect().height ?? 0,
      });
      const result = [sample()];
      harness.replayServerEvent({
        type: 'message.part.updated',
        properties: {
          part: {
            ...part,
            state: {
              status: 'completed',
              input: {
                patchText:
                  '*** Begin Patch\n*** Add File: PDPCOL3.md\n+Updated rules\n*** End Patch',
              },
              output: 'Success. Updated the following files:\nA PDPCOL3.md',
              title: 'Patch',
              metadata: {
                files: [{ file: 'PDPCOL3.md', status: 'added', additions: 97, deletions: 0 }],
              },
              time: { start: Date.now() - 30_000, end: Date.now() },
            },
          } satisfies ToolPart,
        },
      });
      result.push(sample());
      for (let frame = 0; frame < 90; frame++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
        result.push(sample());
      }
      return result;
    }, editPart);
    await expect(page.locator('[data-msg-id="running-edit-message"]')).toContainText('PDPCOL3.md');
    expect(
      Math.max(
        ...completionSamples
          .slice(1)
          .map((sample, index) => sample.top - completionSamples[index]!.top)
      ),
      JSON.stringify(completionSamples)
    ).toBeLessThanOrEqual(0.1);
    expect(completionSamples.every((sample) => sample.cardHeight > 0)).toBe(true);
  });
}

const ABSORBED_EDIT_CASES = [
  { name: 'a matching path arrives while running', path: 'src/app.ts', runningPath: true },
  { name: 'it completes on the same path', path: 'src/app.ts', runningPath: false },
  { name: 'it completes on a different path', path: 'src/other.ts', runningPath: false },
] as const;

for (const editCase of ABSORBED_EDIT_CASES) {
  test(`does not slide back when a painted Editing row resolves as ${editCase.name}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 490, height: 427 });
    const sessionID = 'absorbed-running-edit';
    const created = 1_780_000_000_000;
    const assistantInfo: AssistantMessage = {
      id: 'absorbed-edit-context',
      sessionID,
      role: 'assistant',
      parentID: 'absorbed-edit-user',
      time: { created },
      providerID: 'anthropic',
      modelID: 'claude',
      mode: 'build',
      agent: 'build',
      path: { cwd: '/workspace', root: '/workspace' },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    };
    const messages: MessageEntry[] = Array.from({ length: 60 }, (_, index) => {
      const id = `absorbed-edit-context-${index}`;
      return {
        info: { ...assistantInfo, id, time: { created, completed: created + 1 } },
        parts: [
          {
            id: `${id}-text`,
            messageID: id,
            sessionID,
            type: 'text',
            text: 'The build passed. The next edits update the same source file in several steps.',
          },
        ],
      };
    });
    messages.unshift({
      info: {
        id: 'absorbed-edit-user',
        sessionID,
        role: 'user',
        time: { created: created - 1 },
        agent: 'build',
        model: { providerID: 'anthropic', modelID: 'claude' },
      },
      parts: [
        {
          id: 'absorbed-edit-prompt',
          messageID: 'absorbed-edit-user',
          sessionID,
          type: 'text',
          text: 'Update the source file.',
        },
      ],
    });
    await installPlaybackCapture(page, {
      session: {
        id: sessionID,
        projectID: 'project-test',
        directory: '/workspace',
        title: 'Same-file edits',
        version: '1.0.0',
        time: { created, updated: created },
      },
      initialMessages: messages,
    });
    await page.goto('/e2e/harness/index.html?scenario=session-playback');
    await expect(page.locator(`[data-msg-id="${messages.at(-1)!.info.id}"]`)).toBeVisible();

    const messageID = 'absorbed-edit-message';
    const editPart = (
      id: string,
      status: 'running' | 'completed',
      filePath: string | null,
      counts: { additions: number; deletions: number }
    ): ToolPart => ({
      id,
      messageID,
      sessionID,
      type: 'tool',
      tool: 'edit',
      callID: `${id}-call`,
      state:
        status === 'running'
          ? {
              status: 'running',
              input: filePath ? { filePath } : {},
              title: 'Editing',
              time: { start: Date.now() },
            }
          : {
              status: 'completed',
              input: { filePath: filePath! },
              output: 'Edit applied successfully.',
              title: filePath!,
              metadata: { filediff: { file: filePath!, ...counts } },
              time: { start: Date.now() - 1000, end: Date.now() },
            },
    });
    const replay = (events: ServerEvent[]) =>
      page.evaluate((serverEvents) => {
        // SAFETY: The isolated E2E page installs this fixture-only transport.
        const harness = (
          window as Window & { __varroE2E?: { replayServerEvent(event: ServerEvent): void } }
        ).__varroE2E!;
        for (const event of serverEvents) harness.replayServerEvent(event);
      }, events);

    await replay([
      { type: 'session.status', properties: { sessionID, status: { type: 'busy' } } },
      {
        type: 'message.updated',
        properties: { info: { ...assistantInfo, id: messageID, time: { created: Date.now() } } },
      },
      {
        type: 'message.part.updated',
        properties: {
          part: editPart('absorbed-edit-a', 'completed', 'src/app.ts', {
            additions: 4,
            deletions: 1,
          }),
        },
      },
    ]);
    const row = page.locator(`[data-msg-id="${messageID}"]`);
    await expect(
      row.locator('[data-assistant-render-key="file-edit-stack:absorbed-edit-a"]')
    ).toBeVisible();
    await waitForAnimationFrames(page, 30);

    await replay([
      {
        type: 'message.part.updated',
        properties: {
          part: editPart('absorbed-edit-b', 'running', null, { additions: 0, deletions: 0 }),
        },
      },
    ]);
    const standalone = row.locator('[data-assistant-render-key="part:absorbed-edit-b"]');
    await expect(standalone).toContainText('Editing');
    await waitForAnimationFrames(page, 60);
    // The regression needs a painted standalone row while bottom-follow owns the viewport.
    expect(
      await standalone.evaluate((element) => element.getBoundingClientRect().height)
    ).toBeGreaterThan(20);
    const distance = await page.evaluate(() => {
      const list = document.querySelector<HTMLElement>('.interactive-list')!;
      return list.scrollHeight - list.clientHeight - list.scrollTop;
    });
    expect(distance).toBeLessThanOrEqual(1);

    const transitions: ToolPart[] = editCase.runningPath
      ? [
          editPart('absorbed-edit-b', 'running', editCase.path, { additions: 0, deletions: 0 }),
          editPart('absorbed-edit-b', 'completed', editCase.path, { additions: 5, deletions: 2 }),
        ]
      : [editPart('absorbed-edit-b', 'completed', editCase.path, { additions: 5, deletions: 2 })];
    const samples = await page.evaluate(
      async ({ parts, rowId }) => {
        // SAFETY: The isolated E2E page installs this fixture-only transport.
        const harness = (
          window as Window & { __varroE2E?: { replayServerEvent(event: ServerEvent): void } }
        ).__varroE2E!;
        const card = document.querySelector<HTMLElement>(
          `[data-msg-id="${rowId}"] [data-assistant-render-key="file-edit-stack:absorbed-edit-a"] .file-change-card`
        )!;
        const sample = () => ({
          top: card.getBoundingClientRect().top,
          connected: card.isConnected,
        });
        const result = [sample()];
        for (const part of parts) {
          harness.replayServerEvent({ type: 'message.part.updated', properties: { part } });
          result.push(sample());
          for (let frame = 0; frame < 60; frame++) {
            await new Promise<void>((resolve) =>
              requestAnimationFrame(() => setTimeout(resolve, 0))
            );
            result.push(sample());
          }
        }
        return result;
      },
      { parts: transitions, rowId: messageID }
    );

    expect(samples.every((sample) => sample.connected)).toBe(true);
    expect(
      Math.max(...samples.slice(1).map((sample, index) => sample.top - samples[index]!.top)),
      JSON.stringify(samples)
    ).toBeLessThanOrEqual(0.5);
    await expect(standalone).toHaveCount(0);
    const cards = row.locator('.assistant-file-edit-stack .file-change-card');
    if (editCase.path === 'src/app.ts') {
      await expect(cards).toHaveCount(1);
      await expect(cards.first()).toContainText('+5');
      await expect(cards.first()).toContainText('-2');
    } else {
      await expect(cards).toHaveCount(2);
      await expect(cards.nth(1)).toContainText('other.ts');
    }
  });
}

test('keeps Thinking aligned as an inline edit appears in a measured transcript', async ({
  page,
}) => {
  await page.setViewportSize({ width: 494, height: 800 });
  await page.goto('/e2e/harness/index.html?scenario=large-transcript');
  await expect(page.locator('[data-msg-id="message-large-assistant-239"]')).toBeVisible();
  await page.evaluate(() => {
    // SAFETY: The isolated E2E page installs these fixture-only methods.
    const harness = (
      window as Window & {
        __varroE2E?: {
          getSessionMessages(sessionID: string): MessageEntry[];
          replayServerEvent(event: ServerEvent): void;
        };
      }
    ).__varroE2E!;
    const sessionID = 'session-large-transcript';
    const info = harness.getSessionMessages(sessionID).at(-1)!.info;
    if (info.role !== 'assistant') throw new Error('Missing assistant fixture');
    harness.replayServerEvent({
      type: 'session.status',
      properties: { sessionID, status: { type: 'busy' } },
    });
    harness.replayServerEvent({
      type: 'message.updated',
      properties: {
        info: { ...info, id: 'thinking-edit', time: { created: Date.now() }, finish: undefined },
      },
    });
  });
  await expect(page.locator('.interactive-loading-row .loading-indicator')).toBeVisible();
  await waitForAnimationFrames(page, 30);
  const samples = await page.evaluate(async () => {
    // SAFETY: The isolated E2E page installs this fixture-only method.
    const harness = (
      window as Window & { __varroE2E?: { replayServerEvent(event: ServerEvent): void } }
    ).__varroE2E!;
    const sessionID = 'session-large-transcript';
    harness.replayServerEvent({
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'thinking-edit-part',
          messageID: 'thinking-edit',
          sessionID,
          type: 'tool',
          tool: 'patch',
          callID: 'thinking-edit-call',
          state: {
            status: 'completed',
            input: {
              patchText:
                '*** Begin Patch\n*** Add File: sample.ts\n+export const value = 1;\n*** End Patch',
            },
            output: 'Success. Updated the following files:\nA sample.ts',
            title: 'Patch',
            metadata: {
              files: [
                {
                  file: 'sample.ts',
                  status: 'added',
                  additions: 1,
                  deletions: 0,
                  patch: '@@ -0,0 +1 @@\n+export const value = 1;',
                },
              ],
            },
            time: { start: Date.now(), end: Date.now() },
          },
        },
      },
    });
    const result: Array<{ gap: number; height: number }> = [];
    for (let frame = 0; frame < 90; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
      const card = document.querySelector('[data-msg-id="thinking-edit"] .file-change-card');
      const label = document.querySelector(
        '.interactive-loading-row:not(.is-reserved) .loading-verb'
      );
      if (card && label)
        result.push({
          gap: label.getBoundingClientRect().top - card.getBoundingClientRect().bottom,
          height: card.getBoundingClientRect().height,
        });
    }
    return result;
  });
  expect(samples.length).toBeGreaterThan(30);
  expect(samples.every((sample) => sample.height > 0)).toBe(true);
  expect(
    Math.max(...samples.map((sample) => sample.gap)) -
      Math.min(...samples.map((sample) => sample.gap)),
    JSON.stringify(samples)
  ).toBeLessThan(0.1);
  expect(samples.at(-1)!.gap).toBe(12);
});
