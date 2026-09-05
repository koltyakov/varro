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
    const siblingControl = document.querySelector<HTMLButtonElement>(
      '[data-activity-part-id="tool-active-0"] button'
    )!;
    siblingControl.focus();
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
      siblingPreserved: siblingControl.isConnected && document.activeElement === siblingControl,
    };
    entrance.play();
    return snapshot;
  });
  await expect(item.locator('.tool-invocation-title')).toHaveText('Check updated sources');
  await item.getByRole('button', { name: 'Check updated sources', exact: true }).click();
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
  expect(result.siblingPreserved, 'An unchanged sibling must keep its controls and focus').toBe(
    true
  );
});

for (const removedIndex of [0, 1]) {
  test(`a ${removedIndex === 0 ? 'leading' : 'middle'} completion does not restart a later tool exit when the tray splits`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 504, height: 800 });
    await page.goto('/e2e/harness/index.html?scenario=tool-cards&activeTray=1&activeTrayCount=3');
    const items = page.locator('.assistant-active-activity-item');
    await expect(items).toHaveCount(3);
    await expect(page.locator('.assistant-active-activity-items')).toHaveCount(1);
    await items.last().evaluate(async (element) => {
      await Promise.all(element.getAnimations().map((animation) => animation.finished));
    });
    // Use the already-visible branch without bypassing production minimum retention.
    await page.waitForTimeout(2_100);
    const result = await page.evaluate(async (completedIndex) => {
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
      const targetSelector = `.assistant-active-activity-item[data-activity-part-id="${CSS.escape(running[2]!.id)}"]`;
      const middleSelector = `.assistant-active-activity-item[data-activity-part-id="${CSS.escape(running[completedIndex]!.id)}"]`;
      const samples: Array<{
        ms: number;
        opacity: number | null;
        count: number;
        exiting: boolean;
        middleCount: number;
        trays: number;
        remounted: boolean;
      }> = [];
      let secondCompletionAt: number | null = null;
      let firstExitingNode: Element | null = null;
      const start = performance.now();
      complete(running[completedIndex]!);
      while (performance.now() - start < 3_500) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const ms = performance.now() - start;
        if (secondCompletionAt === null && ms >= 200) {
          secondCompletionAt = ms;
          complete(running[2]!);
        }
        const matches = document.querySelectorAll(targetSelector);
        const current = matches[0];
        const exiting = current?.classList.contains('is-exiting') ?? false;
        if (exiting && !firstExitingNode) firstExitingNode = current ?? null;
        samples.push({
          ms,
          count: matches.length,
          exiting,
          opacity: current ? Number.parseFloat(getComputedStyle(current).opacity) : null,
          middleCount: document.querySelectorAll(middleSelector).length,
          trays: document.querySelectorAll('.assistant-active-activity-items').length,
          remounted: exiting && current !== firstExitingNode,
        });
      }
      return { samples, secondCompletionAt };
    }, removedIndex);
    await test.info().attach('tool-exit-frames', {
      body: JSON.stringify(result, null, 2),
      contentType: 'application/json',
    });
    const exiting = result.samples.filter((sample) => sample.exiting);
    expect(exiting.length, 'Must sample the actual exit, not just settled cleanup').toBeGreaterThan(
      5
    );
    expect(result.secondCompletionAt).toBeGreaterThanOrEqual(200);
    expect(result.secondCompletionAt).toBeLessThan(300);
    expect(
      exiting.some(
        (sample) => sample.middleCount === 0 && sample.trays === (removedIndex === 0 ? 1 : 2)
      ),
      'The middle tool must leave while the later tool is still exiting in the split tray'
    ).toBe(true);
    expect(
      exiting.some((sample) => sample.remounted),
      'The exiting node must survive the split'
    ).toBe(false);
    expect(
      Math.max(...result.samples.map((sample) => sample.count)),
      'No duplicate target tool'
    ).toBe(1);
    expect(result.samples.at(-1)?.count, 'Exit cleanup must finish within 3.5 seconds').toBe(0);
    await expect(items).toHaveCount(1);
    await expect(items).toHaveAttribute(
      'data-activity-part-id',
      `tool-active-${removedIndex === 0 ? 1 : 0}`
    );
    await expect(page.locator('.assistant-active-activity-item.is-exiting')).toHaveCount(0);
    await expect(page.locator('.activity-exit-bottom-reserve')).toHaveCount(0);
    const jumps = exiting.slice(1).map((sample, index) => ({
      ms: sample.ms,
      rise: sample.opacity! - exiting[index]!.opacity!,
      remounted: sample.remounted,
    }));
    const worst = jumps.reduce((largest, jump) => (jump.rise > largest.rise ? jump : largest));
    expect(
      worst.rise,
      `Exit opacity flashed at ${worst.ms.toFixed(1)}ms; remounted=${worst.remounted}`
    ).toBeLessThanOrEqual(0.05);
  });
}
