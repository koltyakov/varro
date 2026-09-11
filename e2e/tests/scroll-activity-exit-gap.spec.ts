import { expect, test } from '@playwright/test';
import type { ServerEvent } from '../../src/shared/protocol';
import type { AssistantMessage, MessageEntry, Part, Session } from '../../src/webview/types';

for (const virtualized of [false, true]) {
  test(`reserves the final tray's flow gap before removal${virtualized ? ' with virtualization' : ''}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 486, height: 800 });
    const created = Date.now() - 60_000;
    const session: Session = {
      id: 'session-exit-gap',
      projectID: 'project-test',
      directory: '/workspace',
      title: 'Reasoning exit gap',
      version: '1.0.0',
      time: { created, updated: created },
    };
    const user = (index: number): MessageEntry => ({
      info: {
        id: `user-${index}`,
        sessionID: session.id,
        role: 'user',
        time: { created: created + index * 1000 },
        agent: 'build',
        model: { providerID: 'openai', modelID: 'gpt-5' },
      },
      parts: [
        {
          id: `prompt-${index}`,
          sessionID: session.id,
          messageID: `user-${index}`,
          type: 'text',
          text: `Inspect the source ${index}.`,
        },
      ],
    });
    const assistant = (index: number): AssistantMessage => ({
      id: `assistant-${index}`,
      sessionID: session.id,
      role: 'assistant',
      parentID: `user-${index}`,
      time: { created: created + index * 1000 + 100, completed: created + index * 1000 + 200 },
      providerID: 'openai',
      modelID: 'gpt-5',
      mode: 'build',
      agent: 'build',
      path: { cwd: '/workspace', root: '/workspace' },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      finish: 'stop',
    });
    const info = assistant(60);
    const initial: MessageEntry[] = virtualized
      ? Array.from({ length: 26 }, (_, index) => [
          user(index),
          {
            info: assistant(index),
            parts: [
              {
                id: `text-${index}`,
                sessionID: session.id,
                messageID: `assistant-${index}`,
                type: 'text' as const,
                text: 'Earlier response with stable layout.',
              },
            ],
          },
        ]).flat()
      : [];
    initial.push(user(60), {
      info,
      parts: [
        {
          id: 'context',
          sessionID: session.id,
          messageID: info.id,
          type: 'text',
          text: Array.from(
            { length: 12 },
            (_, index) =>
              `Paragraph ${index}. Preserve this painted transcript while the last reasoning tray collapses into its preceding Explored group.`
          ).join('\n\n'),
        },
        {
          id: 'earlier-thought',
          sessionID: session.id,
          messageID: info.id,
          type: 'reasoning',
          text: '**Earlier thought**',
          time: { start: created, end: created + 1 },
        },
      ],
    });
    await page.addInitScript(
      (fixture) => {
        // SAFETY: The isolated harness reads its fixture before mounting the application.
        (window as typeof window & { varroPlaybackCapture: typeof fixture }).varroPlaybackCapture =
          fixture;
      },
      { session, initialMessages: initial }
    );
    await page.goto('/e2e/harness/index.html?scenario=session-playback');
    const row = page.locator(`[data-msg-id="${info.id}"]`);
    await expect(row.locator('.rendered-markdown')).toContainText('Paragraph 11.');
    if (virtualized)
      await expect(page.locator('.interactive-list-track')).toHaveClass(/virtualized/);
    const running: Part = {
      id: 'last-thought',
      sessionID: session.id,
      messageID: info.id,
      type: 'reasoning',
      text: '**Finalizing implementation**',
      time: { start: Date.now() },
    };
    await page.evaluate(
      ({ info: messageInfo, running: activity, sessionID }) => {
        // SAFETY: This controlled page exposes only the mock replay transport.
        const harness = (
          window as typeof window & {
            __varroE2E: { replayServerEvent: (event: ServerEvent) => void };
          }
        ).__varroE2E;
        harness.replayServerEvent({
          type: 'message.updated',
          properties: {
            info: {
              ...messageInfo,
              time: { created: messageInfo.time.created },
              finish: undefined,
            },
          },
        });
        harness.replayServerEvent({
          type: 'session.status',
          properties: { sessionID, status: { type: 'busy' } },
        });
        harness.replayServerEvent({ type: 'message.part.updated', properties: { part: activity } });
      },
      { info, running, sessionID: session.id }
    );
    const tray = row.locator('.assistant-active-activity-tray');
    await expect(tray).toBeVisible();
    await expect(tray.locator('.assistant-active-activity-summary')).toHaveCount(0);
    await page.waitForTimeout(1500);

    const samples = await row.evaluate(async (element, activity) => {
      // SAFETY: The isolated fixture owns these message accessors and transcript nodes.
      const harness = (
        window as typeof window & {
          __varroE2E: { replayServerEvent: (event: ServerEvent) => void };
        }
      ).__varroE2E;
      const list = element.closest<HTMLElement>('.interactive-list')!;
      const marker = [...element.querySelectorAll<HTMLElement>('.rendered-markdown p')].at(-1)!;
      const result: Array<{
        source: string;
        top: number;
        scrollTop: number;
        height: number;
        connected: boolean;
        active: number;
      }> = [];
      const sample = (source: string) =>
        result.push({
          source,
          top: marker.getBoundingClientRect().top,
          scrollTop: list.scrollTop,
          height: list.scrollHeight,
          connected: marker.isConnected,
          active: element.querySelectorAll('[data-activity-part-id="last-thought"]').length,
        });
      sample('before');
      // Observe the removal before a later anchor correction can mask a shortfall in scroll range.
      const observer = new MutationObserver(() => sample('mutation'));
      observer.observe(element, { childList: true, subtree: true });
      if (activity.type !== 'reasoning') throw new Error('Expected reasoning fixture');
      harness.replayServerEvent({
        type: 'message.part.updated',
        properties: { part: { ...activity, time: { ...activity.time, end: Date.now() } } },
      });
      for (let index = 0; index < 90; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        sample('frame');
      }
      observer.disconnect();
      return result;
    }, running);
    await testInfo.attach('exit-gap.json', {
      body: JSON.stringify(samples, null, 2),
      contentType: 'application/json',
    });
    expect(samples.every((sample) => sample.connected)).toBe(true);
    expect(samples.at(-1)!.active).toBe(0);
    const jumps = samples.filter((sample) => sample.top > samples[0]!.top + 1.5);
    expect(jumps).toEqual([]);
  });
}
