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
    requests: { method: string; path: string }[];
  };
};

for (const width of [486, 1100]) {
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
