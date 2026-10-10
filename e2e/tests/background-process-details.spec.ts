import { expect, test } from '@playwright/test';
import type { BackgroundProcess } from '../../src/shared/background-process';
import type { ServerEvent } from '../../src/shared/protocol';
import type { MessageEntry, Session } from '../../src/webview/types';

type ProcessFixture = {
  sessionID: string;
  processes: BackgroundProcess[];
  output: Record<string, string>;
};
type ProcessHarnessWindow = Window & {
  varroPlaybackCapture?: { session: Session; initialMessages: MessageEntry[] };
  varroBackgroundProcessFixture?: ProcessFixture;
  __varroE2E?: {
    replayServerEvent(event: ServerEvent): void;
    requests: { method: string; path: string; body?: unknown }[];
  };
};

for (const width of [486, 1100]) {
  test(`clicked service details stay compact with equal adjacent stop buttons at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 794 });
    const created = Date.now() - 10_000;
    await page.clock.setFixedTime(created + 8767 + 24 * 60_000 + 59_000);
    const session: Session = {
      id: 'ses_service_layout',
      projectID: 'project-test',
      directory: '/workspace',
      title: 'Service layout',
      version: '1.0.0',
      time: { created, updated: created },
    };
    const processes: BackgroundProcess[] = [8766, 8767, 8768].map((port) => ({
      id: `shell-${port}`,
      status: 'running',
      service: true,
      command: `python3 tools/serve.py ${port}`,
      cwd: '/workspace',
      pid: port,
      time: { started: created + port },
    }));
    await page.addInitScript(
      ({ capture, fixture }) => {
        // SAFETY: These synthetic sessions and processes are consumed only by the isolated harness.
        const host = window as ProcessHarnessWindow;
        host.varroPlaybackCapture = capture;
        host.varroBackgroundProcessFixture = fixture;
      },
      {
        capture: { session, initialMessages: [] },
        fixture: {
          sessionID: session.id,
          processes,
          output: { 'shell-8767': 'Serving on port 8767\n' },
        },
      }
    );
    await page.goto('/e2e/harness/index.html?scenario=session-playback');
    await page
      .getByRole('button', {
        name: 'Inspect background service: python3 tools/serve.py 8767',
        exact: true,
      })
      .click();
    const dialog = page.getByRole('dialog', { name: 'Background processes' });
    await expect(dialog.locator('.background-process-detail-command')).toHaveText(
      'python3 tools/serve.py 8767'
    );
    await expect(dialog.getByLabel('Process output')).toHaveText('Serving on port 8767\n');
    const duration = dialog.locator('.background-process-detail .background-process-duration');
    await expect(duration).toHaveText('24m 59s');
    const list = dialog.getByRole('navigation', {
      name: 'Background processes',
      includeHidden: true,
    });
    if (width <= 600) {
      await expect(list).toBeHidden();
      await expect(duration).toBeVisible();
    } else {
      await expect(list).toBeVisible();
      await expect(duration).toBeHidden();
      await expect(list.getByRole('button')).toHaveCount(3);
    }
    const stop = (await dialog
      .getByRole('button', { name: 'Stop process', exact: true })
      .boundingBox())!;
    const steer = (await dialog
      .getByRole('button', { name: 'Steer stop', exact: true })
      .boundingBox())!;
    expect(stop.width).toBeCloseTo(steer.width, 1);
    expect(stop.y).toBeCloseTo(steer.y, 1);
    expect(steer.x - (stop.x + stop.width)).toBeCloseTo(6, 1);
    for (const name of ['Stop process', 'Steer stop']) {
      const button = dialog.getByRole('button', { name, exact: true });
      await expect(button).toHaveCSS('display', 'flex');
      await expect(button).toHaveCSS('align-items', 'center');
      await expect(button).toHaveCSS('justify-content', 'center');
      await expect(button).toHaveCSS('line-height', '11px');
      const centerOffset = await button.evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        const text = range.getBoundingClientRect();
        const bounds = element.getBoundingClientRect();
        return Math.abs(text.y + text.height / 2 - (bounds.y + bounds.height / 2));
      });
      expect(centerOffset).toBeLessThanOrEqual(1);
    }
    // Crossing the breakpoint must preserve the selected process without reopening the dialog.
    await page.setViewportSize({ width: width <= 600 ? 1100 : 486, height: 794 });
    if (width <= 600) {
      await expect(list).toBeVisible();
      await expect(duration).toBeHidden();
    } else {
      await expect(list).toBeHidden();
      await expect(duration).toBeVisible();
    }
    await expect(dialog.locator('.background-process-detail-command')).toHaveText(
      'python3 tools/serve.py 8767'
    );
    // Verify both layouts return to a narrow focused view before the minute rollover.
    await page.setViewportSize({ width: 486, height: 794 });
    await expect(duration).toBeVisible();
    const metadata = dialog.locator('.background-process-detail-meta');
    const beforeMetadata = (await metadata.boundingBox())!;
    const beforeDuration = (await duration.boundingBox())!;
    await page.clock.setFixedTime(created + 8767 + 25 * 60_000);
    await expect(duration).toHaveText('25m 0s');
    const afterMetadata = (await metadata.boundingBox())!;
    const afterDuration = (await duration.boundingBox())!;
    expect(afterMetadata).toEqual(beforeMetadata);
    expect(afterDuration).toEqual(beforeDuration);
  });

  test(`a persistent server can stop waiting and stay inspectable at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 794 });
    const created = Date.now() - 10_000;
    const session: Session = {
      id: 'ses_background_service',
      projectID: 'project-test',
      directory: '/workspace',
      title: 'Preview server',
      version: '1.0.0',
      time: { created, updated: created },
    };
    const initialMessages: MessageEntry[] = [
      {
        info: {
          id: 'prompt',
          sessionID: session.id,
          role: 'user',
          time: { created },
          agent: 'build',
          model: { providerID: 'openai', modelID: 'gpt-5' },
        },
        parts: [
          {
            id: 'prompt-text',
            messageID: 'prompt',
            sessionID: session.id,
            type: 'text',
            text: 'Start the preview server.',
          },
        ],
      },
      {
        info: {
          id: 'answer',
          sessionID: session.id,
          role: 'assistant',
          parentID: 'prompt',
          time: { created: created + 100, completed: created + 1000 },
          finish: 'stop',
          providerID: 'openai',
          modelID: 'gpt-5',
          agent: 'build',
          mode: 'build',
          path: { cwd: '/workspace', root: '/workspace' },
          cost: 0,
          tokens: { input: 10, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
        },
        parts: [
          {
            id: 'answer-text',
            messageID: 'answer',
            sessionID: session.id,
            type: 'text',
            text: 'Preview server is running.',
          },
        ],
      },
    ];
    await page.addInitScript(
      ({ capture, fixture }) => {
        // SAFETY: Only the isolated playback harness consumes these synthetic process fixtures.
        const host = window as ProcessHarnessWindow;
        host.varroPlaybackCapture = capture;
        host.varroBackgroundProcessFixture = fixture;
      },
      {
        capture: { session, initialMessages },
        fixture: {
          sessionID: session.id,
          processes: [
            {
              id: 'shell-server',
              status: 'running',
              command: 'python3 tools/serve.py 18765',
              cwd: '/workspace',
              pid: 42,
              time: { started: created },
            },
          ],
          output: { 'shell-server': 'Serving on port 18765\n' },
        } satisfies ProcessFixture,
      }
    );
    await page.goto('/e2e/harness/index.html?scenario=session-playback');
    await page.evaluate((sessionID) => {
      // SAFETY: This fixture only updates the isolated page's session status.
      (window as ProcessHarnessWindow).__varroE2E!.replayServerEvent({
        type: 'session.status',
        properties: {
          sessionID,
          status: {
            type: 'busy',
            background: true,
            backgroundCommand: 'python3 tools/serve.py 18765',
          },
        },
      });
    }, session.id);
    await page.getByRole('button', { name: 'View background process details' }).click();
    const dialog = page.getByRole('dialog', { name: 'Background processes' });
    const wait = dialog.getByRole('checkbox', { name: 'Wait for completion' });
    await expect(dialog.getByLabel('Process output')).toContainText('Serving on port 18765');
    await wait.click();
    await expect(wait).not.toBeChecked();
    await expect(page.locator('.background-process')).toHaveCount(0);
    await expect(page.locator('.assistant-dialog-summary')).toBeVisible();
    await expect(dialog).toBeVisible();
    const serviceRow = page.getByRole('button', {
      name: 'Inspect background service: python3 tools/serve.py 18765',
      exact: true,
    });
    await expect(serviceRow).toBeVisible();
    await expect(page.locator('.chat-header .chat-background-service')).toHaveCount(0);
    const tray = page.locator('.interactive-input-part > .chat-background-services');
    await expect(tray).toBeVisible();
    await expect(serviceRow).toHaveCSS('height', '28px');
    await page.evaluate((sessionID) => {
      // SAFETY: Reproduce the ordinary send/steer status replacement only in this synthetic chat.
      const host = window as ProcessHarnessWindow;
      for (const type of ['busy', 'idle', 'busy', 'idle'] as const)
        host.__varroE2E!.replayServerEvent({
          type: 'session.status',
          properties: { sessionID, status: { type } },
        });
    }, session.id);
    await expect(serviceRow).toBeVisible();
    const trayBounds = (await tray.boundingBox())!;
    const inputBounds = (await page.locator('.chat-input-container').boundingBox())!;
    expect(trayBounds.y + trayBounds.height).toBeLessThanOrEqual(inputBounds.y);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await page.evaluate((sessionID) => {
      // SAFETY: Seed paused queue and pending steering rows only in the isolated playback fixture.
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'queued-messages/sync',
            payload: {
              messages: [
                {
                  id: 'alignment-queue',
                  sessionId: sessionID,
                  text: 'Queued alignment',
                  paused: true,
                  droppedFiles: [],
                  clipboardImages: [],
                  terminalSelection: null,
                },
              ],
            },
          },
        })
      );
      // SAFETY: The playback harness installs this typed event replay API on its own window.
      const host = window as ProcessHarnessWindow;
      host.__varroE2E!.replayServerEvent({
        type: 'message.updated',
        properties: {
          info: {
            id: 'alignment-steer',
            sessionID,
            role: 'user',
            pendingDelivery: 'steer',
            time: { created: Date.now() },
            agent: 'build',
            model: { providerID: 'openai', modelID: 'gpt-5' },
          },
        },
      });
      host.__varroE2E!.replayServerEvent({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'alignment-steer-text',
            messageID: 'alignment-steer',
            sessionID,
            type: 'text',
            text: 'Steering alignment',
          },
        },
      });
    }, session.id);
    const queuedRow = page.locator('[data-queued-message-id="alignment-queue"]');
    const steeringRow = page.locator('[data-steered-message-id="alignment-steer"]');
    await expect(queuedRow).toBeVisible();
    await expect(steeringRow).toBeVisible();
    const serviceLabel = (await serviceRow.locator('.chat-queue-label').boundingBox())!;
    const serviceIcon = (await serviceRow.locator('.chat-background-service-icon').boundingBox())!;
    const terminalIcon = (await serviceRow
      .locator('.chat-background-service-icon > .ui-icon')
      .boundingBox())!;
    expect(terminalIcon.x + terminalIcon.width / 2).toBeCloseTo(
      serviceIcon.x + serviceIcon.width / 2 + 2,
      1
    );
    for (const [row, iconSelector] of [
      [queuedRow, '.chat-queue-drag-handle'],
      [steeringRow, '.chat-steer-icon'],
    ] as const) {
      const label = (await row.locator('.chat-queue-label').boundingBox())!;
      const icon = (await row.locator(iconSelector).boundingBox())!;
      expect(serviceLabel.x).toBeCloseTo(label.x, 1);
      expect(serviceIcon.x + serviceIcon.width / 2).toBeCloseTo(icon.x + icon.width / 2, 1);
      expect(serviceIcon.width).toBe(icon.width);
      expect(serviceIcon.height).toBe(icon.height);
    }
    await page.evaluate((sessionID) => {
      // SAFETY: Remove only the synthetic alignment fixtures added above.
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'queued-messages/sync', payload: { messages: [] } },
        })
      );
      // SAFETY: The playback harness owns this replay API and the synthetic message ID.
      (window as ProcessHarnessWindow).__varroE2E!.replayServerEvent({
        type: 'message.removed',
        properties: { sessionID, messageID: 'alignment-steer' },
      });
    }, session.id);
    await page.getByRole('button', { name: 'Back to sessions', exact: true }).click();
    const sessionRow = page.locator(`[data-session-id="${session.id}"]`).first();
    const badge = sessionRow.locator('.session-item-background-services');
    await expect(badge).toBeVisible();
    await sessionRow.hover();
    await expect(badge).toBeVisible();
    await sessionRow.locator('.session-item-main').click();
    await serviceRow.click();
    await expect(dialog).toBeVisible();
    await expect(wait).not.toBeChecked();
    await expect(dialog.getByLabel('Process output')).toContainText('Serving on port 18765');
    await wait.click();
    await expect(wait).toBeChecked();
    await expect(page.locator('.background-process')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Back to sessions', exact: true }).click();
    const leading = sessionRow.locator('.session-item-leading.has-status');
    await expect(leading).toBeVisible();
    await leading.hover();
    await expect(leading.locator('.session-item-indicator')).toHaveCSS('opacity', '1');
    await expect(leading.locator('.session-item-drag-handle')).toHaveCount(0);
    await sessionRow.locator('.session-item-main').click();
    await page.getByRole('textbox', { name: 'Message composer' }).fill('Keep this draft');
    await page.evaluate(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'context/update',
            payload: {
              workspacePath: '/workspace',
              activeFile: {
                path: '/workspace/index.html',
                relativePath: 'index.html',
                language: 'html',
              },
              selection: null,
              diagnostics: [],
            },
          },
        })
      );
    });
    await page.getByRole('button', { name: 'View background process details' }).click();
    await dialog.getByRole('button', { name: 'Steer stop', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'Message composer' })).toHaveText(
      'Keep this draft'
    );
    const stopAction = page.locator('.stop-process-action');
    await expect(stopAction).toBeVisible();
    await expect(stopAction).toHaveText('Stop process 42');
    await expect(stopAction).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(stopAction).toHaveCSS('border-width', '0px');
    await expect(stopAction.locator('.ui-icon')).toHaveCount(1);
    await expect(
      stopAction.locator(
        '.user-message-text-scroll, .prompt-number-badge, .user-message-attachment'
      )
    ).toHaveCount(0);
    const stopSend = await page.evaluate(() => {
      // SAFETY: The isolated harness owns this synthetic request ledger.
      return (window as ProcessHarnessWindow).__varroE2E!.requests.find(
        (request) => request.path.includes('/prompt_async') && request.method === 'POST'
      );
    });
    expect(stopSend?.body).toMatchObject({
      parts: [
        {
          type: 'text',
          text: 'Stop the background process with PID 42 running this command:\npython3 tools/serve.py 18765\nProcess ID: shell-server\nWorking directory: /workspace',
        },
      ],
    });
    expect(stopSend?.body).toHaveProperty('parts.length', 1);
    const stopRequests = await page.evaluate(() => {
      // SAFETY: The isolated harness records only synthetic API requests.
      return (window as ProcessHarnessWindow).__varroE2E!.requests.filter(
        (request) => request.path.includes('/background-process/') && request.method === 'DELETE'
      );
    });
    expect(stopRequests).toHaveLength(0);
    await page.evaluate((sessionID) => {
      // SAFETY: The generic mock prompt handler drops background fields. Restore this
      // synthetic running-process status to continue the independent direct-stop check.
      (window as ProcessHarnessWindow).__varroE2E!.replayServerEvent({
        type: 'session.status',
        properties: {
          sessionID,
          status: {
            type: 'busy',
            background: true,
            backgroundCommand: 'python3 tools/serve.py 18765',
          },
        },
      });
    }, session.id);
    await page.getByRole('button', { name: 'View background process details' }).click();
    await wait.click();
    await expect(wait).not.toBeChecked();
    await expect(page.locator('.background-process')).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Stop process' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(serviceRow).toHaveCount(0);
    const mutations = await page.evaluate(() => {
      // SAFETY: The harness owns this ledger and never connects to a real session.
      return (window as ProcessHarnessWindow).__varroE2E!.requests.filter(
        (request) => request.path.includes('/background-process/') && request.method !== 'GET'
      );
    });
    expect(mutations.map((request) => request.method)).toEqual([
      'PATCH',
      'PATCH',
      'PATCH',
      'DELETE',
    ]);
  });

  test(`background process details keep read-only live logs through completion at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 794 });
    const created = Date.now() - 10_000;
    const session: Session = {
      id: 'ses_background_details',
      projectID: 'project-test',
      directory: '/workspace',
      title: 'Background details',
      version: '1.0.0',
      time: { created, updated: created },
    };
    const initialMessages: MessageEntry[] = [
      {
        info: {
          id: 'prompt',
          sessionID: session.id,
          role: 'user',
          time: { created },
          agent: 'build',
          model: { providerID: 'openai', modelID: 'gpt-5' },
        },
        parts: [
          {
            id: 'prompt-text',
            messageID: 'prompt',
            sessionID: session.id,
            type: 'text',
            text: 'Run the tests in the background.',
          },
        ],
      },
      {
        info: {
          id: 'answer',
          sessionID: session.id,
          role: 'assistant',
          parentID: 'prompt',
          time: { created: created + 100, completed: created + 1000 },
          finish: 'stop',
          providerID: 'openai',
          modelID: 'gpt-5',
          agent: 'build',
          mode: 'build',
          path: { cwd: '/workspace', root: '/workspace' },
          cost: 0,
          tokens: { input: 10, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
        },
        parts: [
          {
            id: 'answer-text',
            messageID: 'answer',
            sessionID: session.id,
            type: 'text',
            text: 'Tests are running. Waiting for their results.',
          },
        ],
      },
    ];
    const processes: BackgroundProcess[] = [
      {
        id: 'shell-test',
        status: 'running',
        command: 'npm test',
        cwd: '/workspace',
        pid: 42,
        time: { started: created },
      },
      {
        id: 'shell-build',
        status: 'running',
        command: 'npm run build',
        cwd: '/workspace',
        pid: 43,
        time: { started: created - 1000 },
      },
    ];
    await page.addInitScript(
      ({ capture, fixture }) => {
        // SAFETY: This isolated harness consumes the controlled fixtures before mounting.
        const host = window as ProcessHarnessWindow;
        host.varroPlaybackCapture = capture;
        host.varroBackgroundProcessFixture = fixture;
      },
      {
        capture: { session, initialMessages },
        fixture: {
          sessionID: session.id,
          processes,
          output: { 'shell-test': 'Tests started\n', 'shell-build': 'Build started\n' },
        },
      }
    );
    await page.goto('/e2e/harness/index.html?scenario=session-playback');
    await page.evaluate((sessionID) => {
      // SAFETY: This isolated page installs the production-event replay transport.
      (window as ProcessHarnessWindow).__varroE2E!.replayServerEvent({
        type: 'session.status',
        properties: {
          sessionID,
          status: { type: 'busy', background: true, backgroundCommand: 'npm test' },
        },
      });
    }, session.id);
    const opener = page.getByRole('button', { name: 'View background process details' });
    await expect(opener).toBeVisible();
    await expect(opener.locator('.tool-invocation-title')).toHaveText(
      'Background process: npm test'
    );
    const cardHeight = (await opener.boundingBox())!.height;
    await page.evaluate((sessionID) => {
      // SAFETY: Only this page's synthetic process status is changed.
      (window as ProcessHarnessWindow).__varroE2E!.replayServerEvent({
        type: 'session.status',
        properties: {
          sessionID,
          status: {
            type: 'busy',
            background: true,
            backgroundCommand: `python3 tools/serve.py 18765 ${'x'.repeat(1024)}`,
          },
        },
      });
    }, session.id);
    await expect(opener.locator('.tool-invocation-title')).toContainText(
      'Background process: python3 tools/serve.py 18765'
    );
    expect(
      await opener
        .locator('.tool-invocation-title')
        .evaluate((element) => element.scrollWidth > element.clientWidth)
    ).toBe(true);
    expect((await opener.boundingBox())!.height).toBe(cardHeight);
    await expect(opener.locator('.tool-invocation-duration')).toBeInViewport();
    expect(
      await page.evaluate(() => {
        // SAFETY: This isolated harness owns the API request ledger.
        return (window as ProcessHarnessWindow).__varroE2E!.requests.filter((request) =>
          request.path.includes('/background-process')
        ).length;
      })
    ).toBe(0);
    const marker = page.locator('[data-msg-id="answer"] .rendered-markdown');
    const top = await marker.evaluate((element) => element.getBoundingClientRect().top);
    await opener.click();
    const dialog = page.getByRole('dialog', { name: 'Background processes' });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.background-process-detail-command')).toHaveCSS(
      'background-color',
      'rgba(0, 0, 0, 0)'
    );
    await expect(dialog.locator('.background-process-detail-command')).toHaveCSS(
      'font-size',
      '12px'
    );
    expect(
      await dialog
        .locator('.background-process-detail-command')
        .evaluate(
          (element) =>
            getComputedStyle(element).color ===
            getComputedStyle(element.closest('.background-process-dialog')!).color
        )
    ).toBe(true);
    await expect(dialog.locator('.background-process-detail')).toHaveCSS('gap', '6px');
    await expect(dialog.getByLabel('Process output')).toHaveText('Tests started\n');
    await expect(dialog.getByLabel('Process output')).toHaveCSS('font-size', '11px');
    const stdout = dialog.getByLabel('Process output');
    const wrap = dialog.getByRole('button', { name: 'Wrap output lines' });
    const follow = dialog.getByRole('button', { name: 'Follow output', exact: true });
    await expect(stdout).toHaveCSS('white-space', 'pre');
    await expect(stdout).toHaveCSS('font-weight', '400');
    await page.evaluate(() => {
      // SAFETY: Only this page's synthetic process output is changed.
      (window as ProcessHarnessWindow).varroBackgroundProcessFixture!.output['shell-test'] +=
        Array.from(
          { length: 60 },
          (_, index) => `Log ${index}: GET /assets/${'long-path-'.repeat(20)} 200\n`
        ).join('');
    });
    await expect(stdout).toContainText('Log 59:');
    expect(await stdout.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(
      true
    );
    await wrap.click();
    await expect(stdout).toHaveCSS('white-space', 'pre-wrap');
    expect(await stdout.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
      true
    );
    await wrap.click();
    await stdout.evaluate((element) => {
      element.scrollTop = 0;
    });
    await expect(follow).toHaveAttribute('aria-pressed', 'false');
    await page.evaluate(() => {
      // SAFETY: Only this page's synthetic process output is changed.
      (window as ProcessHarnessWindow).varroBackgroundProcessFixture!.output['shell-test'] +=
        'Appended while reading older output\n';
    });
    await expect(stdout).toContainText('Appended while reading older output');
    expect(await stdout.evaluate((element) => element.scrollTop)).toBe(0);
    await follow.click();
    await expect(follow).toHaveAttribute('aria-pressed', 'true');
    await expect
      .poll(() =>
        stdout.evaluate(
          (element) => element.scrollHeight - element.clientHeight - element.scrollTop
        )
      )
      .toBeLessThanOrEqual(1);
    await expect(dialog).toContainText('PID 42');
    expect(
      Math.abs((await marker.evaluate((element) => element.getBoundingClientRect().top)) - top)
    ).toBeLessThanOrEqual(1);
    const bounds = await dialog.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(794);
    await page.evaluate(() => {
      // SAFETY: Only this page's synthetic process fixture is changed.
      (window as ProcessHarnessWindow).varroBackgroundProcessFixture!.output['shell-test'] +=
        'All tests passed\n';
    });
    await expect(dialog.getByLabel('Process output')).toContainText('All tests passed');
    await dialog.getByRole('button', { name: /npm run build/ }).click();
    await expect(dialog.getByLabel('Process output')).toHaveText('Build started\n');
    await dialog.getByRole('button', { name: /npm test/ }).click();
    await expect(dialog.getByLabel('Process output')).toContainText('All tests passed');
    await page.evaluate(() => {
      // SAFETY: Only this page's synthetic process fixture and status are changed.
      const host = window as ProcessHarnessWindow;
      const fixture = host.varroBackgroundProcessFixture!;
      fixture.processes = fixture.processes.map((process) => ({
        ...process,
        status: 'exited',
        exit: 0,
        time: { ...process.time, completed: Date.now() },
      }));
      host.__varroE2E!.replayServerEvent({
        type: 'session.status',
        properties: { sessionID: fixture.sessionID, status: { type: 'idle' } },
      });
    });
    await expect(dialog).toContainText('Exited (0)');
    await expect(dialog.getByRole('button', { name: /npm test/ })).toBeFocused();
    await expect(dialog.getByLabel('Process output')).toContainText('All tests passed');
    await page.evaluate(() => {
      // SAFETY: Only this page's synthetic process fixture is changed.
      (window as ProcessHarnessWindow).varroBackgroundProcessFixture!.processes = [];
    });
    await expect(dialog).toContainText('No longer available');
    await expect(dialog.getByLabel('Process output')).toContainText('All tests passed');
    const requests = await page.evaluate(() => {
      // SAFETY: This isolated harness owns the API request ledger.
      return (window as ProcessHarnessWindow).__varroE2E!.requests.filter((request) =>
        request.path.includes('/background-process')
      );
    });
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((request) => request.method === 'GET')).toBe(true);
    expect(requests.some((request) => request.path.includes('cursor='))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await page.waitForTimeout(1200);
    const readsAfterClose = await page.evaluate(() => {
      // SAFETY: This isolated harness owns the API request ledger.
      return (window as ProcessHarnessWindow).__varroE2E!.requests.filter((request) =>
        request.path.includes('/background-process')
      ).length;
    });
    expect(readsAfterClose).toBe(requests.length);
  });
}
