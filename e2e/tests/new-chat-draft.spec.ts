/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- SAFETY: These E2E callbacks read harness-owned debug state exposed on the controlled test window. */
/*
 * Regression coverage for the "+" (new chat) button during an active
 * busy/streaming session. A removed transcript used to crash virtualized rows
 * mid update flush (VirtualizedContent dereferencing a cleared message entry),
 * which left the draft unopened, killed every chat handler, and misrouted
 * subsequent sends. See AUDIT.md (2026-08-31).
 */
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

type StreamTarget = { sessionID: string; messageID: string; partID: string };

async function postDelta(page: Page, target: StreamTarget, delta: string) {
  await page.evaluate(
    ({ part, nextDelta }) => {
      window.postMessage(
        {
          type: 'server/event',
          payload: {
            type: 'message.part.delta',
            properties: {
              sessionID: part.sessionID,
              messageID: part.messageID,
              partID: part.partID,
              field: 'text',
              delta: nextDelta,
            },
          },
        },
        '*'
      );
    },
    { part: target, nextDelta: delta }
  );
}

const BUSY_TARGET: StreamTarget = {
  sessionID: 'session-busy-stop-send',
  messageID: 'message-busy-assistant',
  partID: 'message-busy-assistant-part-1',
};

test('new chat during active streaming opens a draft and keeps handlers alive', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });

  await page.goto('/e2e/harness/index.html?scenario=busy-stop-send');
  await expect(
    page.getByText('Still working through the requested refactor steps.', { exact: true })
  ).toBeVisible();

  for (let index = 0; index < 6; index += 1) {
    await postDelta(page, BUSY_TARGET, `\n\nStreaming chunk ${index} with extra prose. `);
  }

  await page.getByRole('button', { name: 'New chat' }).first().click();

  // Draft should be blank: streamed transcript hidden.
  await expect(
    page.getByText('Still working through the requested refactor steps.', { exact: true })
  ).toBeHidden();

  // Old-session deltas keep arriving after the draft starts.
  for (let index = 0; index < 6; index += 1) {
    await postDelta(page, BUSY_TARGET, `\n\nPost-draft chunk ${index}. `);
  }

  // Draft must not resurrect the old transcript.
  await expect(page.getByText('Post-draft chunk 3', { exact: false })).toBeHidden();

  // Handlers must still work: navigate to the session list and back.
  await page.getByLabel('Back to sessions').first().click();
  await expect(page.getByText('Busy stop and send', { exact: false }).first()).toBeVisible();

  expect(errors).toEqual([]);
});

test('message typed in the draft after + goes to a new session, not the busy one', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(String(error)));

  await page.goto('/e2e/harness/index.html?scenario=busy-stop-send');
  await expect(
    page.getByText('Still working through the requested refactor steps.', { exact: true })
  ).toBeVisible();

  await postDelta(page, BUSY_TARGET, '\n\nStill going. ');
  await page.getByRole('button', { name: 'New chat' }).first().click();
  await postDelta(page, BUSY_TARGET, '\n\nStill going after draft. ');

  const composer = page.locator('[role="textbox"][aria-multiline="true"]').first();
  await composer.fill('Hello from the draft chat.');
  await composer.press('Enter');

  await expect(page.locator('.chat-turn-user').last()).toContainText('Hello from the draft chat.');

  const requests = await page.evaluate(() => {
    const value = (
      window as Window & {
        __varroE2E?: { requests: Array<{ method: string; path: string; body?: unknown }> };
      }
    ).__varroE2E;
    return value?.requests || [];
  });

  // The prompt must not have been sent (or queued) to the busy session.
  const busySessionPrompts = requests.filter((request) =>
    request.path.includes('session-busy-stop-send')
  );
  expect(
    busySessionPrompts.filter(
      (request) => request.path.includes('prompt') || request.path.includes('queue')
    )
  ).toEqual([]);

  // A new session was created for the draft send.
  expect(
    requests.some((request) => request.method === 'POST' && /\/session(\?|$)/.test(request.path))
  ).toBe(true);

  expect(errors).toEqual([]);
});
