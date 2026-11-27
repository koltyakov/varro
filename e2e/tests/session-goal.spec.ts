import { expect, test } from '@playwright/test';
import { projectV2Message } from '../../src/extension/opencode-v2-projection';
import type { SessionGoal } from '../../src/shared/session-goal';
import type { MessageEntry, Session } from '../../src/webview/types';
import { fixture } from '../../src/webview/test-fixtures';
import { installPlaybackCapture, waitForHarnessStartup } from './helpers';

for (const width of [360, 1100]) {
  test(`shows the goal prompt and queue-style composer controls at ${width}px`, async ({
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
    await installPlaybackCapture(page, { session, initialMessages: [message], goal });
    await page.goto('/e2e/harness/index.html?scenario=session-playback');
    await waitForHarnessStartup(page);
    await expect(page.locator('.user-message-card')).toContainText(`goal ${goal.objective}`);
    const goalChip = page.locator('.user-message-card .inline-chip[data-copy-marker="/goal"]');
    await expect(goalChip.locator('.inline-chip-label')).toHaveText('goal');
    await expect(goalChip.locator('[data-chip-icon="skill"]')).toBeVisible();
    const chipLineOffset = await goalChip.evaluate((element) => {
      const text = element.nextSibling!;
      const start = text.textContent!.search(/\S/);
      const range = document.createRange();
      range.setStart(text, start);
      range.setEnd(text, start + 'Wait'.length);
      const textBox = range.getBoundingClientRect();
      const chipBox = element.getBoundingClientRect();
      return chipBox.top + chipBox.height / 2 - textBox.top - textBox.height / 2;
    });
    expect(Math.abs(chipLineOffset)).toBeLessThanOrEqual(0.5);
    const row = page.getByRole('group', { name: 'Session goal', exact: true });
    await expect(row.locator('.chat-queue-label')).toHaveText(goal.objective);
    await expect(row).not.toContainText('Goal:');
    await expect(row.getByRole('img', { name: 'Goal', exact: true })).toBeVisible();
    await expect(row).not.toContainText('Active');
    await expect(row.locator('.chat-queue-item')).toHaveCSS('padding-left', '8px');
    const labelInsets = await row.evaluate((element) => {
      const reference = document.createElement('div');
      reference.className = 'todo-block';
      const header = document.createElement('button');
      header.className = 'todo-block-header';
      const icon = document.createElement('span');
      icon.className = 'todo-block-chevron';
      const title = document.createElement('span');
      title.className = 'todo-block-title';
      title.textContent = 'Todos';
      header.append(icon, title);
      reference.append(header);
      element.parentElement!.append(reference);
      const result = {
        goal:
          element.querySelector('.chat-queue-label')!.getBoundingClientRect().left -
          element.getBoundingClientRect().left,
        todo: title.getBoundingClientRect().left - reference.getBoundingClientRect().left,
      };
      reference.remove();
      return result;
    });
    expect(labelInsets.goal).toBe(labelInsets.todo);
    const panelStyle = await row.evaluate((element) => {
      const reference = document.createElement('div');
      reference.className = 'chat-queue-container';
      element.append(reference);
      const panel = getComputedStyle(element);
      const menu = getComputedStyle(reference);
      const result = {
        actual: [panel.backgroundColor, panel.borderTopColor, panel.borderRadius, panel.boxShadow],
        expected: [menu.backgroundColor, menu.borderTopColor, menu.borderRadius, menu.boxShadow],
      };
      reference.remove();
      return result;
    });
    expect(panelStyle.actual).toEqual(panelStyle.expected);
    const pause = row.getByRole('button', { name: 'Pause goal' });
    const clear = row.getByRole('button', { name: 'Clear goal' });
    await expect(pause).toBeVisible();
    await expect(clear).toBeVisible();
    // Like queued messages, the controls appear on hover or keyboard focus.
    const actions = row.locator('.chat-queue-actions');
    await page.mouse.move(0, 0);
    await expect(actions).toHaveCSS('opacity', '0');
    await row.hover();
    await expect(actions).toHaveCSS('opacity', '1');
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
    await expect(row.locator('.chat-queue-paused-label')).toHaveCount(0);
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
      await expect(row).not.toContainText(reason);
      await expect(row).not.toContainText('Complete');
      const icon = row.getByRole('img', {
        name: status === 'complete' ? 'Goal complete' : 'Goal',
        exact: true,
      });
      await expect(icon).toBeVisible();
      await icon.hover();
      const tooltip = page.getByRole('tooltip');
      await expect(tooltip).toBeVisible();
      await expect(tooltip).toHaveClass(/themed-tooltip/);
      await expect(tooltip).toHaveClass(/panel/);
      await expect(tooltip.locator('.themed-tooltip-arrow')).toHaveCount(0);
      await expect(tooltip).toHaveCSS('padding', '9px 10px');
      await expect(tooltip).toHaveCSS('border-radius', '8px');
      await expect(tooltip).toHaveCSS('box-shadow', 'none');
      const tooltipStyle = await tooltip.evaluate((element) => {
        const reference = document.createElement('div');
        reference.className = 'chat-queue-container';
        document.querySelector('.chat-session-goal')!.append(reference);
        const panel = getComputedStyle(element);
        const menu = getComputedStyle(reference);
        const result = {
          actual: [
            panel.backgroundColor,
            panel.borderTopColor,
            panel.borderRadius,
            panel.boxShadow,
          ],
          expected: [menu.backgroundColor, menu.borderTopColor, menu.borderRadius, menu.boxShadow],
        };
        reference.remove();
        return result;
      });
      expect(tooltipStyle.actual).toEqual(tooltipStyle.expected);
      await expect
        .poll(async () => {
          const descriptionBox = (await tooltip.boundingBox())!;
          const goalBox = (await row.boundingBox())!;
          return Math.max(
            Math.abs(descriptionBox.x - goalBox.x),
            Math.abs(descriptionBox.width - goalBox.width),
            Math.abs(goalBox.y - descriptionBox.y - descriptionBox.height - 7)
          );
        })
        .toBeLessThanOrEqual(1);
      const clipped = await row
        .locator('.chat-queue-label')
        .evaluate(
          (label) =>
            label.scrollWidth > label.clientWidth || label.scrollHeight > label.clientHeight
        );
      expect(clipped).toBe(width === 360);
      if (clipped) await expect(tooltip).toContainText(goal.objective);
      else await expect(tooltip).not.toContainText(goal.objective);
      await expect(tooltip).toContainText(reason);
      await expect(row.locator('[title]')).toHaveCount(0);
      await expect(row.locator('.chat-queue-paused-label')).toHaveCount(
        status === 'paused' ? 1 : 0
      );
      expect((await row.boundingBox())!.height).toBe(rowBox.height);
      await page.screenshot({ path: testInfo.outputPath(`goal-${status}.png`) });
    }
    await expect(row.getByRole('button', { name: 'Pause goal' })).toHaveCount(0);
    await expect(row.getByRole('button', { name: 'Resume goal' })).toHaveCount(0);
    await expect(clear).toHaveCount(0);
    const close = row.getByRole('button', { name: 'Close goal' });
    await expect(close).toBeVisible();
    await expect(close).not.toHaveClass(/chat-queue-remove/);
    await expect(close).toHaveCSS('width', '20px');
    await expect(close).toHaveCSS('height', '20px');
    await expect(close).toHaveCSS('border-radius', '50%');
    const hoverStyle = await close.evaluate((element) => {
      const reference = document.createElement('span');
      reference.style.color = 'var(--color-vscode-fg)';
      reference.style.backgroundColor = 'var(--color-vscode-hover)';
      element.append(reference);
      const style = getComputedStyle(reference);
      const result = { color: style.color, background: style.backgroundColor };
      reference.remove();
      return result;
    });
    await close.hover();
    await expect(close).toHaveCSS('color', hoverStyle.color);
    await expect(close).toHaveCSS('background-color', hoverStyle.background);
    await page.screenshot({ path: testInfo.outputPath('goal-close-hover.png') });
    await close.click();
    await expect(row).toHaveCount(0);
    await expect(page.getByRole('tooltip')).toHaveCount(0);
    await expect(page.locator('.rich-composer')).toHaveText('Keep this draft');
    await expect(page.locator('.user-message-card')).toContainText(`goal ${goal.objective}`);
  });
}
