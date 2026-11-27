import { expect, test, type Page } from '@playwright/test';
import type { ServerEvent } from '../../src/shared/protocol';
import type { AssistantMessage, MessageEntry, Part, ToolPart } from '../../src/webview/types';
import { installPlaybackCapture, waitForAnimationFrames } from './helpers';

const SESSION_ID = 'file-edit-totals';
const CREATED = 1_780_000_000_000;
const INFO: AssistantMessage = {
  id: 'totals-context',
  sessionID: SESSION_ID,
  role: 'assistant',
  parentID: 'totals-user',
  time: { created: CREATED },
  providerID: 'claude-agent',
  modelID: 'opus',
  mode: 'build',
  agent: 'build',
  path: { cwd: '/workspace', root: '/workspace' },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
};

async function openTranscript(page: Page, width = 490) {
  await page.setViewportSize({ width, height: 640 });
  // Sixty steps keep the transcript virtualized, matching long Claude sessions.
  const messages: MessageEntry[] = Array.from({ length: 60 }, (_, index) => {
    const id = `totals-context-${index}`;
    return {
      info: { ...INFO, id, time: { created: CREATED, completed: CREATED + 1 } },
      parts: [
        {
          id: `${id}-text`,
          messageID: id,
          sessionID: SESSION_ID,
          type: 'text',
          text: 'The build passed. The following steps edit the same source file several times.',
        },
      ],
    };
  });
  messages.unshift({
    info: {
      id: 'totals-user',
      sessionID: SESSION_ID,
      role: 'user',
      time: { created: CREATED - 1 },
      agent: 'build',
      model: { providerID: 'claude-agent', modelID: 'opus' },
    },
    parts: [
      {
        id: 'totals-prompt',
        messageID: 'totals-user',
        sessionID: SESSION_ID,
        type: 'text',
        text: 'Update the file.',
      },
    ],
  });
  await installPlaybackCapture(page, {
    session: {
      id: SESSION_ID,
      projectID: 'project-test',
      directory: '/workspace',
      title: 'Combined edit counts',
      version: '1.0.0',
      time: { created: CREATED, updated: CREATED },
    },
    initialMessages: messages,
  });
  await page.goto('/e2e/harness/index.html?scenario=session-playback');
  await expect(page.locator('[data-msg-id="totals-context-59"]')).toBeVisible();
  await replay(page, [
    { type: 'session.status', properties: { sessionID: SESSION_ID, status: { type: 'busy' } } },
  ]);
}

function replay(page: Page, events: ServerEvent[]) {
  return page.evaluate((serverEvents) => {
    // SAFETY: The isolated E2E page installs this fixture-only transport.
    const harness = (
      window as Window & { __varroE2E?: { replayServerEvent(event: ServerEvent): void } }
    ).__varroE2E!;
    for (const event of serverEvents) harness.replayServerEvent(event);
  }, events);
}

function message(id: string, completed = false): ServerEvent {
  const info: AssistantMessage = { ...INFO, id, time: { created: CREATED + 2 } };
  if (completed) {
    info.time = { created: CREATED + 2, completed: CREATED + 3 };
    info.finish = 'tool-calls';
  }
  return { type: 'message.updated', properties: { info } };
}

/** A Claude edit as OpenCode v2 reports it: no input at first, then counts in `metadata.files`. */
function edit(
  id: string,
  messageID: string,
  path: string,
  status: 'empty' | 'running' | 'completed',
  counts: [number, number] = [2, 1]
): ServerEvent {
  const input = { path, oldString: 'a', newString: 'b' };
  const part: ToolPart = {
    id,
    messageID,
    sessionID: SESSION_ID,
    type: 'tool',
    tool: 'edit',
    callID: `${id}-call`,
    state:
      status === 'empty'
        ? { status: 'pending', input: {}, raw: '' }
        : status === 'running'
          ? { status: 'running', input, title: 'edit', time: { start: 1 } }
          : {
              status: 'completed',
              input,
              output: 'Edit applied successfully.',
              title: 'edit',
              metadata: {
                files: [
                  { file: path, status: 'modified', additions: counts[0], deletions: counts[1] },
                ],
              },
              time: { start: 1, end: 2 },
            },
  };
  return { type: 'message.part.updated', properties: { part: part satisfies Part } };
}

type Step = { frames: number; events: ServerEvent[] };

/** Replays steps, sampling the owner card and listed rows every frame. */
function sampleSteps(page: Page, steps: Step[], ownerId: string, emptyRowIds: string[] = []) {
  return page.evaluate(
    async ({ allSteps, owner, emptyRows }) => {
      // SAFETY: The isolated E2E page installs this fixture-only transport.
      const harness = (
        window as Window & { __varroE2E?: { replayServerEvent(event: ServerEvent): void } }
      ).__varroE2E!;
      const sample = () => {
        const row = document.querySelector<HTMLElement>(`[data-msg-id="${owner}"]`);
        const cards = row ? [...row.querySelectorAll<HTMLElement>('.file-change-card')] : [];
        const card = cards[0];
        return {
          cards: cards.length,
          top: card?.getBoundingClientRect().top ?? null,
          height: card?.getBoundingClientRect().height ?? null,
          headerHeight:
            card?.querySelector('.file-change-card-header')?.getBoundingClientRect().height ?? null,
          stats: card?.querySelector('.file-edit-diff-stats')?.textContent ?? null,
          title: card?.querySelector<HTMLElement>('.file-edit-diff-stats')?.title ?? null,
          emptyRows: emptyRows.map(
            (id) =>
              document.querySelector(`[data-msg-id="${id}"]`)?.getBoundingClientRect().height ?? 0
          ),
        };
      };
      const result = [sample()];
      for (const step of allSteps) {
        for (const event of step.events) harness.replayServerEvent(event);
        for (let frame = 0; frame < step.frames; frame++) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
          result.push(sample());
        }
      }
      return result;
    },
    { allSteps: steps, owner: ownerId, emptyRows: emptyRowIds }
  );
}

/** A Claude edit cycle: an empty call that paints, its input, then completion. */
function editCycle(id: string, messageID: string, path: string, counts: [number, number]): Step[] {
  return [
    { frames: 2, events: [edit(id, messageID, path, 'empty')] },
    { frames: 12, events: [edit(id, messageID, path, 'running')] },
    { frames: 20, events: [edit(id, messageID, path, 'completed', counts)] },
  ];
}

function expectStableCard(samples: Awaited<ReturnType<typeof sampleSteps>>) {
  const evidence = JSON.stringify(samples);
  const painted = samples.filter((sample) => sample.height !== null);
  expect(painted.length, evidence).toBeGreaterThan(0);
  expect(
    painted.every((sample) => sample.cards === 1),
    evidence
  ).toBe(true);
  const heights = painted.map((sample) => sample.height!);
  expect(Math.max(...heights) - Math.min(...heights), evidence).toBeLessThanOrEqual(0.5);
  for (let index = 1; index < painted.length; index++) {
    // Bottom follow may move the card up; it must never slide back down.
    expect(painted[index]!.top! - painted[index - 1]!.top!, evidence).toBeLessThanOrEqual(0.5);
  }
}

test('combines same-file edit counts in one message without changing the card', async ({
  page,
}) => {
  await openTranscript(page);
  const path = '/workspace/src/app.ts';
  await replay(page, [message('step-1'), edit('edit-a', 'step-1', path, 'completed', [2, 1])]);
  await expect(page.locator('[data-msg-id="step-1"] .file-edit-diff-stats')).toHaveText('+2-1');
  await waitForAnimationFrames(page, 30);

  const samples = await sampleSteps(
    page,
    [
      ...editCycle('edit-b', 'step-1', path, [2, 1]),
      ...editCycle('edit-c', 'step-1', path, [2, 1]),
    ],
    'step-1'
  );
  expectStableCard(samples);
  const texts = [...new Set(samples.map((sample) => sample.stats).filter(Boolean))];
  expect(texts, JSON.stringify(samples)).toEqual(['+2-1', '+4-2', '+6-3']);
  expect(samples.at(-1)!.title).toBe('Combined from 3 edits');
});

test('combines same-file edit counts across Claude steps into the earlier card', async ({
  page,
}) => {
  await openTranscript(page);
  const path = '/workspace/src/app.ts';
  await replay(page, [
    message('step-1'),
    edit('edit-a', 'step-1', path, 'completed', [1, 0]),
    message('step-1', true),
  ]);
  await expect(page.locator('[data-msg-id="step-1"] .file-edit-diff-stats')).toHaveText('+1-0');
  await waitForAnimationFrames(page, 30);

  const samples = await sampleSteps(
    page,
    [
      { frames: 4, events: [message('step-2')] },
      ...editCycle('edit-b', 'step-2', path, [2, 1]),
      { frames: 4, events: [message('step-2', true), message('step-3')] },
      ...editCycle('edit-c', 'step-3', path, [3, 2]),
    ],
    'step-1',
    ['step-2', 'step-3']
  );
  expectStableCard(samples);
  const texts = [...new Set(samples.map((sample) => sample.stats).filter(Boolean))];
  expect(texts, JSON.stringify(samples)).toEqual(['+1-0', '+3-1', '+6-3']);
  // The later steps collapse into the first card and never paint rows of their own.
  expect(
    samples.every((sample) => sample.emptyRows.every((height) => height === 0)),
    JSON.stringify(samples)
  ).toBe(true);
});

test('keeps the header height when combined counts widen at a narrow width', async ({ page }) => {
  await openTranscript(page, 320);
  const path =
    '/workspace/packages/a-very-long-package-name/src/components/deeply/nested/directory/component-with-a-long-name.ts';
  await replay(page, [message('step-1'), edit('edit-a', 'step-1', path, 'completed', [1, 0])]);
  await expect(page.locator('[data-msg-id="step-1"] .file-edit-diff-stats')).toHaveText('+1-0');
  await waitForAnimationFrames(page, 30);

  const samples = await sampleSteps(
    page,
    [
      ...editCycle('edit-b', 'step-1', path, [10, 9]),
      ...editCycle('edit-c', 'step-1', path, [100, 90]),
      ...editCycle('edit-d', 'step-1', path, [1000, 900]),
    ],
    'step-1'
  );
  expectStableCard(samples);
  const headers = samples
    .map((sample) => sample.headerHeight)
    .filter((height): height is number => height !== null);
  expect(Math.max(...headers) - Math.min(...headers), JSON.stringify(samples)).toBeLessThanOrEqual(
    0.5
  );
  expect(samples.at(-1)!.stats).toBe('+1111-999');
});

test('keeps the measured row height when totals change while the card is unmounted', async ({
  page,
}) => {
  await openTranscript(page);
  const path = '/workspace/src/app.ts';
  await replay(page, [
    message('step-1'),
    edit('edit-a', 'step-1', path, 'completed', [1, 0]),
    edit('edit-b', 'step-1', path, 'completed', [2, 1]),
    message('step-1', true),
  ]);
  const ownerRow = page.locator('[data-msg-id="step-1"]');
  await expect(ownerRow.locator('.file-edit-diff-stats')).toHaveText('+3-1');
  await waitForAnimationFrames(page, 30);
  const heightBefore = await ownerRow.evaluate((row) => row.getBoundingClientRect().height);

  // The list owns programmatic scroll positions; native wheel input detaches it like a user.
  const list = page.locator('.interactive-list');
  await list.hover();
  await expect
    .poll(async () => {
      await page.mouse.wheel(0, -2000);
      await waitForAnimationFrames(page, 4);
      return list.evaluate((element) => element.scrollTop);
    })
    .toBe(0);
  await expect(ownerRow.locator('.file-change-card')).toHaveCount(0);
  const marker = page.locator('[data-msg-id="totals-context-2"]');
  await expect(marker).toBeVisible();
  const markerTop = await marker.evaluate((row) => row.getBoundingClientRect().top);

  // The next step's edit completes and collapses into the unmounted card.
  await replay(page, [message('step-2'), edit('edit-c', 'step-2', path, 'completed', [4, 2])]);
  await waitForAnimationFrames(page, 30);
  expect(await marker.evaluate((row) => row.getBoundingClientRect().top)).toBeCloseTo(markerTop, 0);

  await expect
    .poll(async () => {
      await page.mouse.wheel(0, 4000);
      await waitForAnimationFrames(page, 4);
      return list.evaluate(
        (element) => element.scrollHeight - element.clientHeight - element.scrollTop
      );
    })
    .toBeLessThanOrEqual(1);
  await expect(ownerRow.locator('.file-edit-diff-stats')).toHaveText('+7-3');
  await waitForAnimationFrames(page, 30);
  expect(await ownerRow.evaluate((row) => row.getBoundingClientRect().height)).toBeCloseTo(
    heightBefore,
    0
  );
});
