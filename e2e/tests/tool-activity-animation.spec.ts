import { expect, test } from '@playwright/test';
import type { ServerEvent } from '../../src/shared/protocol';
import type { MessageEntry, Session, ToolPart } from '../../src/webview/types';

for (const expandable of [false, true]) {
  test(`running command animation retains normal contrast with ${expandable ? 'expandable' : 'non-expandable'} content`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const created = Date.now();
    const session: Session = {
      id: 'session-tool-animation',
      projectID: 'project-test',
      directory: '/workspace',
      title: 'Tool animation',
      version: '1.0.0',
      time: { created, updated: created },
    };
    const user: MessageEntry = {
      info: {
        id: 'animation-user',
        sessionID: session.id,
        role: 'user',
        time: { created },
        agent: 'build',
        model: { providerID: 'openai', modelID: 'gpt-5' },
      },
      parts: [],
    };
    const assistant: MessageEntry = {
      info: {
        id: 'animation-assistant',
        sessionID: session.id,
        role: 'assistant',
        parentID: user.info.id,
        time: { created: created + 1 },
        providerID: 'openai',
        modelID: 'gpt-5',
        mode: 'build',
        agent: 'build',
        path: { cwd: '/workspace', root: '/workspace' },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      parts: [],
    };
    await page.addInitScript(
      (fixture) => {
        // SAFETY: Only the isolated E2E harness consumes this fixture.
        (window as typeof window & { varroPlaybackCapture: typeof fixture }).varroPlaybackCapture =
          fixture;
      },
      { session, initialMessages: [user, assistant] }
    );
    await page.goto('/e2e/harness/index.html?scenario=session-playback');
    await expect(page.locator('.interactive-list')).toBeVisible();
    const state: ToolPart['state'] = {
      status: 'running',
      input: { command: 'git clone https://github.com/example/repo.git tmp/repo' },
      time: { start: created },
    };
    if (expandable) state.metadata = { output: 'Cloning into tmp/repo...' };
    const tool: ToolPart = {
      id: 'animation-command',
      sessionID: session.id,
      messageID: assistant.info.id,
      callID: 'animation-call',
      type: 'tool',
      tool: 'bash',
      state,
    };
    const events: ServerEvent[] = [
      { type: 'session.status', properties: { sessionID: session.id, status: { type: 'busy' } } },
      { type: 'message.part.updated', properties: { part: tool } },
    ];
    await page.evaluate((batch) => {
      // SAFETY: This page owns the isolated E2E event transport.
      const harness = (
        window as typeof window & {
          __varroE2E: { replayServerEvent: (event: ServerEvent) => void };
        }
      ).__varroE2E;
      for (const event of batch) harness.replayServerEvent(event);
    }, events);

    const row = page.locator('[data-activity-part-id="animation-command"]');
    await expect(row).toBeVisible();
    const header = row.locator('.tool-invocation-header');
    if (expandable) await expect(header).toBeEnabled();
    else await expect(header).toBeDisabled();
    await expect(header).toHaveCSS('opacity', '1');
    const icon = row.locator('.tool-call-icon.tool-status-running');
    const foreground = await header.evaluate((element) => getComputedStyle(element).color);
    await expect(icon).toHaveCSS('color', foreground);
    for (const [time, opacity] of [
      [0, '0.4'],
      [750, '1'],
      [1500, '0.4'],
    ] as const) {
      await icon.evaluate((element, currentTime) => {
        const animation = element.getAnimations()[0]!;
        animation.pause();
        animation.currentTime = currentTime;
      }, time);
      await expect(icon).toHaveCSS('opacity', opacity);
      await expect(header).toHaveCSS('opacity', '1');
    }
    const title = row.locator('.tool-invocation-title');
    await expect(title).toHaveClass(/shimmer-progress/);
    const gradient = await title.evaluate((element) => getComputedStyle(element).backgroundImage);
    expect(gradient).toContain(`${foreground} 50%`);
  });
}
