import { expect, test } from '@playwright/test';
import type { ServerEvent } from '../../src/shared/protocol';
import type {
  AssistantMessage,
  MessageEntry,
  ReasoningPart,
  Session,
} from '../../src/webview/types';

for (const finishTurn of [false, true]) {
  test(`keeps Exploring in place when reasoning settles with answer events${finishTurn ? ' and idle' : ''}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 456, height: 826 });
    const created = Date.now() - 10_000;
    const session: Session = {
      id: 'session-summary-settle',
      projectID: 'project-test',
      directory: '/workspace',
      title: 'Codebase review',
      version: '1.0.0',
      time: { created, updated: created },
    };
    const info: AssistantMessage = {
      id: 'assistant-summary-settle',
      sessionID: session.id,
      role: 'assistant',
      parentID: 'user-summary-settle',
      time: { created },
      providerID: 'openai',
      modelID: 'gpt-5',
      mode: 'build',
      agent: 'build',
      path: { cwd: '/workspace', root: '/workspace' },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    };
    const reasoning: ReasoningPart = {
      id: 'reasoning-summary-settle',
      messageID: info.id,
      sessionID: session.id,
      type: 'reasoning',
      text: '**Inspecting git status and files**',
      time: { start: created },
    };
    const initialMessages: MessageEntry[] = [
      {
        info: {
          id: info.parentID,
          sessionID: session.id,
          role: 'user',
          time: { created },
          agent: 'build',
          model: { providerID: 'openai', modelID: 'gpt-5' },
        },
        parts: [
          {
            id: 'prompt-summary-settle',
            messageID: info.parentID,
            sessionID: session.id,
            type: 'text',
            text: 'Review the codebase',
          },
        ],
      },
    ];
    await page.addInitScript(
      (fixture) => {
        // SAFETY: The isolated E2E harness reads this synthetic fixture before mounting.
        (window as typeof window & { varroPlaybackCapture: typeof fixture }).varroPlaybackCapture =
          fixture;
      },
      { session, initialMessages }
    );
    await page.goto('/e2e/harness/index.html?scenario=session-playback');
    await expect(page.locator('.user-message-card')).toContainText('Review the codebase');
    await page.evaluate(
      ({ info: message, reasoning: part }) => {
        // SAFETY: The controlled playback page exposes the mock event transport.
        const harness = (
          window as typeof window & {
            __varroE2E: { replayServerEvent: (event: ServerEvent) => void };
          }
        ).__varroE2E;
        harness.replayServerEvent({
          type: 'session.status',
          properties: { sessionID: message.sessionID, status: { type: 'busy' } },
        });
        harness.replayServerEvent({ type: 'message.updated', properties: { info: message } });
        harness.replayServerEvent({ type: 'message.part.updated', properties: { part } });
      },
      { info, reasoning }
    );
    const row = page.locator(`[data-msg-id="${info.id}"]`);
    await expect(row.locator('.assistant-activity-summary-placeholder')).toHaveText('Exploring');
    await row.locator('.assistant-active-activity-item').evaluate(async (element) => {
      await Promise.all(element.getAnimations().map((animation) => animation.finished));
    });

    const samples = await row.evaluate(
      async (element, fixture) => {
        // SAFETY: The controlled playback page exposes the mock event transport.
        const harness = (
          window as typeof window & {
            __varroE2E: { replayServerEvent: (event: ServerEvent) => void };
          }
        ).__varroE2E;
        const prompt = document.querySelector('.user-message-card')!;
        const sample = () => {
          const summary = element.querySelector('.assistant-activity-summary');
          return {
            top: summary?.getBoundingClientRect().top ?? null,
            promptTop: prompt.getBoundingClientRect().top,
            label: summary?.textContent,
            active: element.querySelectorAll('.assistant-active-activity-item').length,
          };
        };
        const frames = [sample()];
        // Idle can arrive before the final part snapshot. The still-running thought
        // then groups directly, without first showing its summary in an exiting tray.
        if (fixture.finishTurn) {
          harness.replayServerEvent({
            type: 'session.status',
            properties: { sessionID: fixture.info.sessionID, status: { type: 'idle' } },
          });
        }
        harness.replayServerEvent({
          type: 'message.part.updated',
          properties: {
            part: {
              ...fixture.reasoning,
              time: { ...fixture.reasoning.time, end: Date.now() },
            },
          },
        });
        const answerInfo = { ...fixture.info, id: 'assistant-summary-answer' };
        harness.replayServerEvent({
          type: 'message.updated',
          properties: { info: answerInfo },
        });
        harness.replayServerEvent({
          type: 'message.part.updated',
          properties: {
            part: {
              id: 'answer-summary-settle',
              messageID: answerInfo.id,
              sessionID: fixture.info.sessionID,
              type: 'text',
              text: "I'll inspect the repository structure and recent diff first, then trace the highest-risk code paths and run focused checks where they help validate findings.",
            },
          },
        });
        harness.replayServerEvent({
          type: 'message.updated',
          properties: {
            info: {
              ...fixture.info,
              time: { ...fixture.info.time, completed: Date.now() },
              finish: fixture.finishTurn ? 'stop' : 'tool-calls',
            },
          },
        });
        if (fixture.finishTurn) {
          harness.replayServerEvent({
            type: 'session.status',
            properties: { sessionID: fixture.info.sessionID, status: { type: 'idle' } },
          });
        }
        for (let frame = 0; frame < 150; frame += 1) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          frames.push(sample());
        }
        return frames;
      },
      { info, reasoning, finishTurn }
    );
    await testInfo.attach('summary-positions.json', {
      body: JSON.stringify(samples, null, 2),
      contentType: 'application/json',
    });
    expect(samples[0]!.label).toBe('Exploring');
    expect(samples.at(-1)!.label).toContain('Explored: 1 thought');
    expect(samples.at(-1)!.active).toBe(0);
    expect(samples.every((sample) => sample.top !== null)).toBe(true);
    expect(samples.filter((sample) => Math.abs(sample.top! - samples[0]!.top!) > 0.5)).toEqual([]);
    expect(samples.every((sample) => sample.promptTop === samples[0]!.promptTop)).toBe(true);
  });
}
