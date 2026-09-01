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
  await expect(page.getByText('Streaming chunk 5', { exact: false })).toBeVisible();

  await page.getByRole('button', { name: 'New chat' }).first().click();

  // Draft should be blank: streamed transcript hidden.
  await expect(
    page.getByText('Still working through the requested refactor steps.', { exact: true })
  ).toBeHidden();
  await expect(page.locator('.chat-header .chat-header-title-text').first()).toHaveText('New Chat');

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
  await expect(page.getByText('Still going.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'New chat' }).first().click();
  await postDelta(page, BUSY_TARGET, '\n\nStill going after draft. ');

  const composer = page.locator('[role="textbox"][aria-multiline="true"]').first();
  await composer.fill('Hello from the draft chat.');
  await composer.press('Enter');

  await expect(page.locator('.chat-turn-user').last()).toContainText('Hello from the draft chat.');

  await expect
    .poll(() =>
      page.evaluate(() => {
        const value = (
          window as Window & {
            __varroE2E?: { requests: Array<{ method: string; path: string }> };
          }
        ).__varroE2E;
        return (
          value?.requests.filter(
            (request) =>
              request.method === 'POST' &&
              new URL(request.path, 'http://varro.test').pathname.endsWith('/prompt_async')
          ).length ?? 0
        );
      })
    )
    .toBe(1);

  const requests = await page.evaluate(() => {
    const value = (
      window as Window & {
        __varroE2E?: { requests: Array<{ method: string; path: string; body?: unknown }> };
      }
    ).__varroE2E;
    return value?.requests || [];
  });

  const promptRequests = requests.filter(
    (request) =>
      request.method === 'POST' &&
      new URL(request.path, 'http://varro.test').pathname.endsWith('/prompt_async')
  );
  expect(promptRequests).toHaveLength(1);
  const promptPath = new URL(promptRequests[0]!.path, 'http://varro.test').pathname;
  const promptSessionId = promptPath.match(/^\/session\/([^/]+)\/prompt_async$/)?.[1];
  if (!promptSessionId) throw new Error(`Unexpected prompt path: ${promptPath}`);
  const decodedPromptSessionId = decodeURIComponent(promptSessionId);
  expect(decodedPromptSessionId).not.toBe(BUSY_TARGET.sessionID);

  const deliveredToPromptSession = await page.evaluate((sessionId) => {
    const harness = window as Window & {
      __varroE2E?: {
        getSessionMessages?: (id: string) => Array<{ parts: Array<{ text?: string }> }>;
      };
    };
    return !!harness.__varroE2E
      ?.getSessionMessages?.(sessionId)
      .some((message) => message.parts.some((part) => part.text === 'Hello from the draft chat.'));
  }, decodedPromptSessionId);
  expect(deliveredToPromptSession).toBe(true);

  // The prompt route only accepts a session created by the preceding request.
  expect(
    requests.some((request) => request.method === 'POST' && /\/session(\?|$)/.test(request.path))
  ).toBe(true);

  expect(errors).toEqual([]);
});

test('new chat remains responsive with a large active transcript', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto('/e2e/harness/index.html?scenario=multi-agent-large-streaming');
  await expect(page.getByText('Starting streaming response', { exact: false })).toBeVisible();

  const startedAt = Date.now();
  await page.getByRole('button', { name: 'New chat' }).first().click();
  await expect(page.locator('.chat-header .chat-header-title-text').first()).toHaveText(
    'New Chat',
    {
      timeout: 5_000,
    }
  );

  expect(Date.now() - startedAt).toBeLessThan(5_000);
  expect(errors).toEqual([]);
});
