import { expect, test } from '@playwright/test';
import type { ServerEvent } from '../../src/shared/protocol';
import type {
  AssistantMessage,
  MessageEntry,
  Part,
  Session,
  TextPart,
  ToolPart,
} from '../../src/webview/types';
import { verifySessionPlayback } from '../session-playback';

type HarnessWindow = typeof window & {
  __varroE2E: {
    getSessionMessages: (id: string) => MessageEntry[];
    replayServerEvent: (event: ServerEvent) => void;
    updateMessagePart: (part: Part) => void;
  };
};

test('mocked session playback has no frame-level flicker', async ({ page }) => {
  const created = 1_780_000_000_000;
  const session: Session = {
    id: 'session-mock-playback',
    projectID: 'project-mock-playback',
    directory: '/workspace/varro',
    title: 'Parallel tool playback',
    version: '1.0.0',
    time: { created, updated: created },
  };
  const user: MessageEntry = {
    info: {
      id: 'user-playback',
      sessionID: session.id,
      role: 'user',
      time: { created },
      agent: 'build',
      model: { providerID: 'openai', modelID: 'gpt-5' },
    },
    parts: [
      {
        id: 'user-text',
        sessionID: session.id,
        messageID: 'user-playback',
        type: 'text',
        text: 'Check the sources, types, and tests in parallel.',
      },
    ],
  };
  const assistant: AssistantMessage = {
    id: 'assistant-playback',
    sessionID: session.id,
    role: 'assistant',
    parentID: user.info.id,
    time: { created: created + 100 },
    providerID: 'openai',
    modelID: 'gpt-5',
    mode: 'build',
    agent: 'build',
    path: { cwd: session.directory, root: session.directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
  const text: TextPart = {
    id: 'assistant-text',
    sessionID: session.id,
    messageID: assistant.id,
    type: 'text',
    text: 'I will run the checks in parallel.',
  };
  const tools = ['sources', 'types', 'tests'].map(
    (name, index) =>
      ({
        id: `tool-playback-${name}`,
        sessionID: session.id,
        messageID: assistant.id,
        type: 'tool',
        callID: `call-playback-${name}`,
        tool: 'bash',
        state: {
          status: 'completed',
          input: { command: `npm run check:${name}` },
          title: `Check ${name}`,
          output: `${name} passed`,
          metadata: {},
          time: { start: created + 400, end: created + [3_900, 3_400, 3_600][index]! },
        },
      }) satisfies ToolPart
  );
  const events: Array<{ offsetMs: number; event: ServerEvent }> = [
    {
      offsetMs: 0,
      event: {
        type: 'session.status',
        properties: { sessionID: session.id, status: { type: 'busy' } },
      },
    },
    { offsetMs: 100, event: { type: 'message.updated', properties: { info: assistant } } },
    { offsetMs: 200, event: { type: 'message.part.updated', properties: { part: text } } },
  ];
  for (const part of tools) {
    events.push(
      {
        offsetMs: 300,
        event: {
          type: 'message.part.updated',
          properties: {
            part: {
              ...part,
              state: { status: 'pending', input: part.state.input, raw: '' },
            } satisfies ToolPart,
          },
        },
      },
      {
        offsetMs: 400,
        event: {
          type: 'message.part.updated',
          properties: {
            part: {
              ...part,
              state: { status: 'running', input: part.state.input, time: { start: created + 400 } },
            } satisfies ToolPart,
          },
        },
      }
    );
    // Allow the display delay and minimum retention, then split the tray with out-of-order exits.
    events.push({
      offsetMs: part.state.time.end - created,
      event: {
        type: 'message.part.updated',
        properties: { part },
      },
    });
  }
  const delta = ' All three checks passed.';
  const finalInfo: AssistantMessage = {
    ...assistant,
    time: { ...assistant.time, completed: created + 5_000 },
    finish: 'stop',
  };
  events.push(
    {
      offsetMs: 3_700,
      event: {
        type: 'message.part.delta',
        properties: {
          sessionID: session.id,
          messageID: assistant.id,
          partID: text.id,
          field: 'text',
          delta,
        },
      },
    },
    { offsetMs: 5_000, event: { type: 'message.updated', properties: { info: finalInfo } } },
    {
      offsetMs: 5_100,
      event: {
        type: 'session.status',
        properties: {
          sessionID: session.id,
          status: { type: 'idle' },
        },
      },
    }
  );
  let previousOffset = 0;
  await verifySessionPlayback(page, {
    capture: {
      id: 0,
      label: 'Mocked parallel tool completions',
      scenario: 'mock',
      session,
      initialMessages: [user],
      finalMessages: [
        user,
        { info: finalInfo, parts: [{ ...text, text: text.text + delta }, ...tools] },
      ],
    },
    timeline: events
      .toSorted((left, right) => left.offsetMs - right.offsetMs)
      .map((entry) => {
        const delayMs = entry.offsetMs - previousOffset;
        previousOffset = entry.offsetMs;
        return { ...entry, delayMs, sourceGapMs: delayMs };
      }),
  });
});

test('running tool updates preserve the node and its current entrance animation', async ({
  page,
}) => {
  await page.addInitScript(() => {
    document.addEventListener('animationstart', (event) => {
      if (
        !(event.target instanceof HTMLElement) ||
        event.target.dataset.activityPartId !== 'tool-active-1'
      )
        return;
      if (event.animationName !== 'assistant-active-activity-in') return;
      const animation = event.target.getAnimations()[0];
      if (animation) {
        animation.pause();
        animation.currentTime = 70;
      }
    });
  });
  await page.goto('/e2e/harness/index.html?scenario=tool-cards&activeTray=1&activeTrayCount=2');
  const item = page.locator(
    '.assistant-active-activity-item[data-activity-part-id="tool-active-1"]'
  );
  await expect(item).toBeVisible();
  const result = await item.evaluate(async (original) => {
    const control = original.querySelector<HTMLButtonElement>('button')!;
    control.focus();
    const entrance = original
      .getAnimations()
      .find(
        (animation) =>
          animation instanceof CSSAnimation &&
          animation.animationName === 'assistant-active-activity-in'
      );
    if (!entrance) throw new Error('Expected the real CSS entrance animation');
    entrance.pause();
    entrance.currentTime = 70;
    // SAFETY: The controlled tool-cards harness exposes this typed test API.
    const harness = (window as HarnessWindow).__varroE2E;
    const part = harness
      .getSessionMessages('session-tool-cards')
      .flatMap((message) => message.parts)
      .find((candidate) => candidate.id === 'tool-active-1');
    if (part?.type !== 'tool' || part.state.status !== 'running') {
      throw new Error('Expected a running bash tool');
    }
    const updated: Part = {
      ...part,
      state: {
        ...part.state,
        title: 'Check updated sources',
        input: { command: 'npm run check-updated' },
      },
    };
    harness.updateMessagePart(updated);
    window.postMessage(
      {
        type: 'server/event',
        payload: { type: 'message.part.updated', properties: { part: updated } },
      },
      '*'
    );
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    );
    const current = document.querySelector(
      '.assistant-active-activity-item[data-activity-part-id="tool-active-1"]'
    );
    const snapshot = {
      sameNode: current === original,
      sameAnimation: current?.getAnimations().includes(entrance) ?? false,
      currentTime: entrance.currentTime,
      playState: entrance.playState,
      controlPreserved: control.isConnected && document.activeElement === control,
    };
    entrance.play();
    return snapshot;
  });
  await expect(item.locator('.tool-invocation-title')).toHaveText('Check updated sources');
  await item.getByRole('button', { name: /^Check updated sources\b/ }).click();
  await expect(item.locator('.terminal-command-row-input')).toContainText('npm run check-updated');
  await expect(item).toHaveCount(1);
  expect
    .soft(result.sameNode, 'A running object update must not remount the activity item')
    .toBe(true);
  expect
    .soft(result.sameAnimation, 'The existing CSS animation must survive the update')
    .toBe(true);
  expect.soft(result.currentTime).toBe(70);
  expect.soft(result.playState).toBe('paused');
  expect(result.controlPreserved, 'The visible tool must keep its controls and focus').toBe(true);
});

test('tool completion preserves the running outer node until direct grouping', async ({ page }) => {
  await page.goto(
    '/e2e/harness/index.html?scenario=tool-cards&activeTray=1&activeTrayCount=2&activeTrayCompletedPrefix=1'
  );
  const items = page.locator('.assistant-active-activity-item');
  await expect(items).toHaveCount(1);
  await expect(items).toHaveAttribute('data-activity-part-id', 'tool-active-0');
  const result = await page.evaluate(async () => {
    // SAFETY: The controlled tool-cards harness exposes this typed test API.
    const harness = (window as HarnessWindow).__varroE2E;
    const running = harness
      .getSessionMessages('session-tool-cards')
      .flatMap((message) => message.parts)
      .filter((part): part is ToolPart => part.type === 'tool' && part.state.status === 'running')
      .slice(0, 1);
    const originals = running.map((part) =>
      document.querySelector(`.assistant-active-activity-item[data-activity-part-id="${part.id}"]`)
    );
    if (originals.some((node) => !node)) throw new Error('Expected all running outer nodes');
    await Promise.all(
      originals.flatMap((node) => node!.getAnimations().map((animation) => animation.finished))
    );
    const samples: Array<{ sameNodes: boolean; retained: number; exiting: number; count: number }> =
      [];
    for (const part of running.toReversed()) {
      if (part.state.status !== 'running') throw new Error('Expected a running tool');
      harness.replayServerEvent({
        type: 'message.part.updated',
        properties: {
          part: {
            ...part,
            state: {
              ...part.state,
              status: 'completed',
              title: part.state.title ?? part.tool,
              output: 'Done',
              metadata: {},
              time: { ...part.state.time, end: Date.now() },
            },
          } satisfies ToolPart,
        },
      });
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    const start = performance.now();
    do {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const current = [
        ...document.querySelectorAll(
          '.assistant-active-activity-item[data-activity-part-id="tool-active-0"]'
        ),
      ];
      samples.push({
        sameNodes: current.every((node) => originals.includes(node)),
        retained: current.filter((node) => node.classList.contains('is-completed')).length,
        exiting: current.filter((node) => node.classList.contains('is-exiting')).length,
        count: current.length,
      });
    } while (performance.now() - start < 3_500);
    return { samples, originalsDisconnected: originals.every((node) => !node!.isConnected) };
  });
  expect(
    result.samples.some((sample) => sample.retained === 1),
    'Must observe minimum retention'
  ).toBe(true);
  expect(
    result.samples.some((sample) => sample.exiting > 0),
    'Tools must group without an exit animation'
  ).toBe(false);
  expect(
    result.samples.every((sample) => sample.sameNodes),
    'Completion must not replace a running outer node'
  ).toBe(true);
  expect(result.samples.at(-1)?.count).toBe(0);
  expect(result.originalsDisconnected).toBe(true);
  await expect(items).toHaveCount(1);
  await expect(items).toHaveAttribute('data-activity-part-id', 'tool-active-1');
  await expect(page.locator('.assistant-active-activity-items')).toHaveCount(1);
  await expect(page.locator('.activity-exit-bottom-reserve')).toHaveCount(0);
});

for (const completedIndex of [0, 1]) {
  test(`a ${completedIndex === 0 ? 'visible' : 'queued'} completion preserves the single-slot tool handoff`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 504, height: 800 });
    await page.goto('/e2e/harness/index.html?scenario=tool-cards&activeTray=1&activeTrayCount=3');
    const items = page.locator('.assistant-active-activity-item');
    await expect(items).toHaveCount(1);
    await expect(items).toHaveAttribute('data-activity-part-id', 'tool-active-0');
    await expect(page.locator('.assistant-active-activity-items')).toHaveCount(1);
    await items.last().evaluate(async (element) => {
      await Promise.all(element.getAnimations().map((animation) => animation.finished));
    });
    // Complete before retention expires, so the already-painted node must survive the update.
    const result = await page.evaluate(async (firstCompletedIndex) => {
      // SAFETY: The controlled tool-cards harness exposes this typed test API.
      const harness = (window as HarnessWindow).__varroE2E;
      const running = harness
        .getSessionMessages('session-tool-cards')
        .flatMap((message) => message.parts)
        .filter(
          (part): part is Extract<Part, { type: 'tool' }> =>
            part.type === 'tool' && part.state.status === 'running'
        );
      if (running.length !== 3) throw new Error('Expected three contiguous running tools');
      const complete = (part: Extract<Part, { type: 'tool' }>) => {
        if (part.state.status !== 'running') throw new Error('Expected a running tool');
        const completed: Part = {
          ...part,
          state: {
            ...part.state,
            status: 'completed',
            title: part.state.title ?? part.tool,
            output: 'Done',
            metadata: {},
            time: { start: Date.now() - 3_000, end: Date.now() },
          },
        };
        harness.updateMessagePart(completed);
        window.postMessage(
          {
            type: 'server/event',
            payload: { type: 'message.part.updated', properties: { part: completed } },
          },
          '*'
        );
      };
      const targetSelector =
        '.assistant-active-activity-item[data-activity-part-id="tool-active-0"]';
      const original = document.querySelector(targetSelector);
      if (!original) throw new Error('Expected the initially painted tool');
      const samples: Array<{
        ms: number;
        count: number;
        exiting: number;
        visibleIds: Array<string | undefined>;
        trays: number;
        summaries: number;
        remounted: boolean;
      }> = [];
      let secondCompletionAt: number | null = null;
      const start = performance.now();
      complete(running[firstCompletedIndex]!);
      while (performance.now() - start < 3_500) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const ms = performance.now() - start;
        if (secondCompletionAt === null && ms >= 200) {
          secondCompletionAt = ms;
          complete(running[1 - firstCompletedIndex]!);
        }
        const matches = document.querySelectorAll(targetSelector);
        const current = matches[0];
        samples.push({
          ms,
          count: matches.length,
          exiting: document.querySelectorAll('.assistant-active-activity-item.is-exiting').length,
          visibleIds: [
            ...document.querySelectorAll<HTMLElement>('.assistant-active-activity-item'),
          ].map((item) => item.dataset.activityPartId),
          trays: document.querySelectorAll('.assistant-active-activity-items').length,
          summaries: document.querySelectorAll('.assistant-activity-summary').length,
          remounted: !!current && current !== original,
        });
      }
      return { samples, secondCompletionAt };
    }, completedIndex);
    await test.info().attach('tool-handoff-frames', {
      body: JSON.stringify(result, null, 2),
      contentType: 'application/json',
    });
    expect(
      result.samples.some((sample) => sample.count === 1),
      'Must observe retention'
    ).toBe(true);
    expect(result.secondCompletionAt).toBeGreaterThanOrEqual(200);
    expect(result.samples.every((sample) => sample.exiting === 0)).toBe(true);
    expect(result.samples.every((sample) => !sample.remounted)).toBe(true);
    expect(result.samples.every((sample) => sample.visibleIds.length <= 1)).toBe(true);
    expect(result.samples.every((sample) => sample.trays === 1 && sample.summaries === 1)).toBe(
      true
    );
    expect(new Set(result.samples.flatMap((sample) => sample.visibleIds))).toEqual(
      new Set(['tool-active-0', 'tool-active-1', 'tool-active-2'])
    );
    expect(
      Math.max(...result.samples.map((sample) => sample.count)),
      'No duplicate target tool'
    ).toBe(1);
    expect(result.samples.at(-1)?.count, 'Grouping must finish within 3.5 seconds').toBe(0);
    await expect(items).toHaveCount(1);
    await expect(items).toHaveAttribute('data-activity-part-id', 'tool-active-2');
    await expect(page.locator('.assistant-active-activity-item.is-exiting')).toHaveCount(0);
    await expect(page.locator('.activity-exit-bottom-reserve')).toHaveCount(0);
  });
}
