import { expect, test } from '@playwright/test';
import { projectV2Message } from '../../src/extension/opencode-v2-projection';
import type { SessionGoal } from '../../src/shared/session-goal';
import type { MessageEntry, Session } from '../../src/webview/types';
import { fixture } from '../../src/webview/test-fixtures';
import { waitForHarnessStartup } from './helpers';

for (const width of [360, 1100]) {
  test(`shows the goal prompt and persistent composer controls at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 800 });
    const created = Date.now();
    const session: Session = {
      id: 'ses_goal',
      projectID: 'project-test',
      directory: '/workspace',
      title: 'Wait for 1 minute',
      version: '2',
      time: { created, updated: created },
    };
    const goal: SessionGoal = {
      id: 'goal-1',
      objective: 'Wait for 1 minute and verify the result before completing the goal',
      status: 'active',
      rounds: 0,
      maxRounds: 50,
      updatedAt: created,
    };
    const message = fixture<MessageEntry>(
      projectV2Message(
        {
          id: 'msg_goal',
          type: 'synthetic',
          description: `Goal: ${goal.objective}`,
          text: `<untrusted_objective>\n${goal.objective}\n</untrusted_objective>`,
          metadata: { source: 'goal', goalID: goal.id },
          time: { created },
        },
        session.id
      )
    );
    await page.addInitScript(
      (capture) => {
        // SAFETY: This fixture is consumed only by the isolated browser harness.
        (window as typeof window & { varroPlaybackCapture: typeof capture }).varroPlaybackCapture =
          capture;
      },
      { session, initialMessages: [message], goal }
    );
    await page.goto('/e2e/harness/index.html?scenario=session-playback');
    await waitForHarnessStartup(page);
    await expect(page.locator('.user-message-card')).toContainText(`/goal ${goal.objective}`);
    const row = page.getByRole('group', { name: 'Session goal', exact: true });
    await expect(row).toContainText(`Goal: ${goal.objective}`);
    const pause = row.getByRole('button', { name: 'Pause goal' });
    const clear = row.getByRole('button', { name: 'Clear goal' });
    await expect(pause).toBeVisible();
    await expect(clear).toBeVisible();
    // Controls must remain visible without hover, even when the objective is truncated.
    await expect(pause).toHaveCSS('opacity', '1');
    const rowBox = (await row.boundingBox())!;
    const inputBox = (await page.locator('.chat-input-shell').boundingBox())!;
    const clearBox = (await clear.boundingBox())!;
    expect(rowBox.y + rowBox.height).toBeLessThanOrEqual(inputBox.y);
    expect(clearBox.x + clearBox.width).toBeLessThanOrEqual(width);
    await page.locator('.rich-composer').fill('Keep this draft');
    await pause.click();
    await expect(row).toContainText('Paused');
    const resume = row.getByRole('button', { name: 'Resume goal' });
    await expect(resume).toBeVisible();
    await resume.click();
    await expect(row).toContainText('Active');
    await expect(pause).toBeVisible();
    await expect(page.locator('.rich-composer')).toHaveText('Keep this draft');
    await page.screenshot({ path: testInfo.outputPath('goal-controls.png') });
    for (const status of ['paused', 'complete'] as const) {
      const reason =
        status === 'paused'
          ? 'Paused because the goal needs your input before it can continue.'
          : 'Verified the result and completed the objective.';
      await page.evaluate(
        (input) => {
          window.dispatchEvent(
            new MessageEvent('message', {
              data: {
                type: 'server/event',
                payload: {
                  type: 'session.goal.updated',
                  properties: {
                    sessionID: input.sessionID,
                    goal: { ...input.goal, status: input.status, reason: input.reason },
                  },
                },
              },
            })
          );
        },
        { sessionID: session.id, goal, status, reason }
      );
      await expect(row).toContainText(status === 'paused' ? 'Paused' : 'Complete');
      const reasonBlock = row.getByLabel('Goal reason');
      await expect(reasonBlock).toBeVisible();
      await expect(reasonBlock).toHaveText(reason);
      const reasonBox = (await reasonBlock.boundingBox())!;
      expect(reasonBox.x + reasonBox.width).toBeLessThanOrEqual(width);
    }
    await expect(row.getByRole('button', { name: 'Pause goal' })).toHaveCount(0);
    await expect(row.getByRole('button', { name: 'Resume goal' })).toHaveCount(0);
    await clear.click();
    await expect(row).toHaveCount(0);
    await expect(page.locator('.rich-composer')).toHaveText('Keep this draft');
    await expect(page.locator('.user-message-card')).toContainText(`/goal ${goal.objective}`);
  });
}
