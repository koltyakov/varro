import { expect, test, type Page } from '@playwright/test';
import type { ServerEvent } from '../../src/shared/protocol';
import type {
  AssistantMessage,
  MessageEntry,
  ToolPart,
  UserMessage,
} from '../../src/webview/types';

const sessionID = 'compact-status-slot';
const created = 1_780_000_000_000;
const prompt: UserMessage = {
  id: 'prompt',
  sessionID,
  role: 'user',
  time: { created },
  agent: 'build',
  model: { providerID: 'openai', modelID: 'gpt-5' },
};
const answer: AssistantMessage = {
  id: 'intro',
  parentID: prompt.id,
  sessionID,
  role: 'assistant',
  mode: 'build',
  agent: 'build',
  providerID: 'openai',
  modelID: 'gpt-5',
  path: { cwd: '/workspace', root: '/workspace' },
  time: { created: created + 1, completed: created + 2 },
  finish: 'tool-calls',
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
};

function fixture(mode: 'fitting' | 'overflow' | 'virtualized'): MessageEntry[] {
  const messages: MessageEntry[] = [];
  // Alternating roles keep the virtualized prefix physically tall and leave a visible top spacer.
  for (let i = 0; i < (mode === 'virtualized' ? 32 : 0); i++) {
    const user = { ...prompt, id: `user-${i}`, time: { created: created - 999 + i * 4 } };
    const assistant = {
      ...answer,
      id: `answer-${i}`,
      parentID: user.id,
      finish: 'stop',
      time: { created: user.time.created + 1, completed: user.time.created + 2 },
    };
    for (const info of [user, assistant]) {
      messages.push({
        info,
        parts: [
          {
            type: 'text',
            id: `${info.id}-part`,
            messageID: info.id,
            sessionID,
            text: `Historical ${info.role} ${i}`,
          },
        ],
      });
    }
  }
  return [
    ...messages,
    {
      info: prompt,
      parts: [
        {
          type: 'text',
          id: 'request',
          messageID: prompt.id,
          sessionID,
          text: 'Inspect the files.',
        },
      ],
    },
    {
      info: answer,
      parts: [
        {
          type: 'text',
          id: 'intro-text',
          messageID: answer.id,
          sessionID,
          text: Array.from(
            { length: mode === 'overflow' ? 36 : 2 },
            (_, i) => `Paragraph ${i}: inspect the next file.`
          ).join('\n\n'),
        },
        {
          type: 'tool',
          tool: 'read',
          id: 'seed-read',
          callID: 'seed',
          sessionID,
          messageID: answer.id,
          state: {
            status: 'completed',
            input: { filePath: 'seed.ts' },
            title: 'Seed',
            metadata: {},
            output: 'OK',
            time: { start: created + 1, end: created + 2 },
          },
        },
      ],
    },
  ];
}

async function openBusyFixture(page: Page, mode: Parameters<typeof fixture>[0]) {
  await page.setViewportSize({ width: 520, height: mode === 'fitting' ? 850 : 590 });
  await page.addInitScript(
    (capture) => {
      // SAFETY: The isolated playback harness consumes this fixture before mounting.
      (window as typeof window & { varroPlaybackCapture: typeof capture }).varroPlaybackCapture =
        capture;
    },
    {
      session: {
        id: sessionID,
        projectID: 'fixture',
        directory: '/workspace',
        title: 'Compact status slot',
        version: '1',
        time: { created, updated: created },
      },
      initialMessages: fixture(mode),
    }
  );
  await page.goto('/e2e/harness/index.html?scenario=session-playback');
  const marker = page.locator('[data-msg-id="intro"] .rendered-markdown p').last();
  await expect(marker).toBeInViewport();
  await page.evaluate((id) => {
    // SAFETY: This playback page exposes only a fixture event transport.
    (
      window as typeof window & { __varroE2E: { replayServerEvent(e: ServerEvent): void } }
    ).__varroE2E.replayServerEvent({
      type: 'session.status',
      properties: { sessionID: id, status: { type: 'busy' } },
    });
  }, sessionID);
  await expect(
    page.locator('.interactive-loading-row:not(.is-reserved) .loading-verb')
  ).toBeVisible();
  return marker;
}

for (const [mode, wrapperPadding] of [
  ['fitting', 0],
  ['overflow', 0],
  ['virtualized', 0],
  ['overflow', 1.6],
] as const) {
  test(`Thinking, read and grep rotate in one unchanged ${mode} transcript slot${wrapperPadding ? ' with tray wrapper padding' : ''}`, async ({
    page,
  }) => {
    const marker = await openBusyFixture(page, mode);
    if (wrapperPadding) {
      await page.addStyleTag({
        content: `.assistant-active-activity-tray { padding-block: ${wrapperPadding}px; }`,
      });
    }
    const result = await marker.evaluate(async (paragraph, base) => {
      // SAFETY: The playback harness supplies the event transport for this synthetic session.
      const { replayServerEvent: send } = (
        window as typeof window & { __varroE2E: { replayServerEvent(e: ServerEvent): void } }
      ).__varroE2E;
      const list = paragraph.closest<HTMLElement>('.interactive-list')!;
      const slot = list.querySelector<HTMLElement>('.interactive-loading-row')!;
      const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const height = (selector: string) =>
        list.querySelector(selector)?.getBoundingClientRect().height ?? 0;
      const sample = () => {
        const tool = slot.querySelector<HTMLElement>(':scope > .status-slot-tool');
        return {
          slotTop: slot.getBoundingClientRect().top,
          slotHeight: slot.getBoundingClientRect().height,
          scrollHeight: list.scrollHeight,
          top: list.scrollTop,
          marker: paragraph.getBoundingClientRect().top,
          sameSlot:
            list.querySelector('.interactive-loading-row') === slot &&
            slot.isConnected &&
            paragraph.isConnected,
          slotCount: list.querySelectorAll('.interactive-loading-row').length,
          append: height('.append-scroll-bottom-reserve'),
          exit: height('.activity-exit-bottom-reserve'),
          tools: list.querySelectorAll('.assistant-active-activity-item').length,
          trays: list.querySelectorAll('.assistant-active-activity-tray').length,
          verb: !!slot.querySelector('.loading-verb'),
          reserved: slot.classList.contains('is-reserved'),
          tool: tool?.dataset.activityPartId ?? null,
          source: tool?.dataset.activitySourceMessageId ?? null,
          header: !!tool?.querySelector('.file-read-card-header, .tool-invocation-header'),
          summaries: list.querySelectorAll('.assistant-activity-summary').length,
          placeholder: !!list.querySelector('.assistant-activity-summary-placeholder'),
        };
      };
      let previous = '';
      let stable = 0;
      const deadline = performance.now() + 4000;
      while (stable < 8) {
        await frame();
        const key = JSON.stringify(sample());
        stable = key === previous ? stable + 1 : 0;
        previous = key;
        if (performance.now() > deadline) throw new Error(`Initial slot unstable: ${key}`);
      }
      const baseline = sample();
      const viewport = list.clientHeight;
      const virtualPrefix = height('.virtual-spacer-top');
      const frames: ReturnType<typeof sample>[] = [];
      const wait = async (phase: string, ready: (f: ReturnType<typeof sample>) => boolean) => {
        const until = performance.now() + 8000;
        do {
          await frame();
          const f = sample();
          frames.push(f);
          if (ready(f)) return;
        } while (performance.now() < until);
        throw new Error(`${phase} not reached: ${JSON.stringify(frames.at(-1))}`);
      };
      const start = Date.now();
      const info = { ...base, id: 'active-step', finish: undefined, time: { created: start } };
      const part = (tool: string): ToolPart => ({
        id: `slot-${tool}`,
        sessionID: base.sessionID,
        messageID: info.id,
        type: 'tool',
        tool,
        callID: `call-${tool}`,
        state: {
          status: 'running',
          input:
            tool === 'read'
              ? { filePath: 'src/app.ts', offset: 1, limit: 120 }
              : { pattern: 'function', path: 'src' },
          time: { start },
        },
      });
      const read = part('read');
      const grep = part('grep');
      const update = (p: ToolPart) =>
        send({ type: 'message.part.updated', properties: { part: p } });
      send({ type: 'message.updated', properties: { info } });
      update(read);
      await wait('read', (f) => f.tool === read.id);
      const readHeader = slot.querySelector('.file-read-card-header');
      update({
        ...read,
        state: {
          status: 'running',
          title: 'Read updated',
          input: { ...read.state.input, limit: 160 },
          time: { start },
        },
      });
      await wait(
        'running read update',
        (f) =>
          f.tool === read.id &&
          slot.querySelector('.file-read-range')?.textContent?.trim() === '(L2-161)'
      );
      const readHeaderSurvived =
        readHeader !== null && slot.querySelector('.file-read-card-header') === readHeader;
      update(grep);
      await wait('queued grep rotation', (f) => f.tool === grep.id);
      const grepHeader = slot.querySelector('.tool-invocation-header');
      update({
        ...grep,
        state: {
          status: 'running',
          title: 'Find updated pattern',
          input: { ...grep.state.input, pattern: 'class' },
          time: { start },
        },
      });
      await wait('running grep update', (f) => f.tool === grep.id);
      const grepHeaderSurvived =
        grepHeader !== null && slot.querySelector('.tool-invocation-header') === grepHeader;
      await wait('rotation back to read', (f) => f.tool === read.id);
      for (const p of [grep, read]) {
        update({
          ...p,
          state: {
            status: 'completed',
            title: 'Done',
            input: p.state.input,
            time: { start, end: Date.now() },
            metadata: {},
            output: 'OK',
          },
        });
      }
      send({
        type: 'message.updated',
        properties: {
          info: { ...info, finish: 'tool-calls', time: { created: start, completed: Date.now() } },
        },
      });
      await wait('Thinking handoff', (f) => f.verb && !f.reserved && !f.tool);
      const settle = performance.now() + 350;
      await wait('final frames', () => performance.now() >= settle);
      return { baseline, frames, viewport, virtualPrefix, readHeaderSurvived, grepHeaderSurvived };
    }, answer);

    expect(result.baseline.slotHeight).toBe(44);
    expect(result.baseline.scrollHeight > result.viewport).toBe(mode !== 'fitting');
    expect(result.virtualPrefix > 0).toBe(mode === 'virtualized');
    expect(result.readHeaderSurvived, 'The running read update replaced its header').toBe(true);
    expect(
      result.grepHeaderSurvived,
      'The running grep update replaced its disclosure header'
    ).toBe(true);
    const sequence = result.frames
      .map((f) => f.tool ?? 'thinking')
      .filter((t, i, a) => !i || a[i - 1] !== t);
    expect(sequence[0] === 'thinking' ? sequence.slice(1) : sequence).toEqual([
      'slot-read',
      'slot-grep',
      'slot-read',
      'thinking',
    ]);
    for (const [index, f] of result.frames.entries()) {
      const why = `frame ${index} ${JSON.stringify(f)} vs ${JSON.stringify(result.baseline)}`;
      expect(f.sameSlot && f.slotCount === 1 && f.summaries === 1 && !f.placeholder, why).toBe(
        true
      );
      expect(f.tools, why).toBe(f.tool ? 1 : 0);
      expect(f.trays, why).toBe(0);
      expect(f.verb && !f.reserved, why).toBe(!f.tool);
      if (f.tool)
        expect(f.header && !f.verb && !f.reserved && f.source === 'active-step', why).toBe(true);
      for (const key of ['slotHeight', 'slotTop', 'top', 'scrollHeight', 'marker'] as const) {
        expect(f[key], `${key}: ${why}`).toBe(result.baseline[key]);
      }
      expect(f.append + f.exit, why).toBe(0);
    }
  });
}

test('a minute-old bash disclosure stays pinned and scrollable until collapsed', async ({
  page,
}) => {
  await openBusyFixture(page, 'overflow');
  const send = (event: ServerEvent) =>
    page.evaluate((e) => {
      // SAFETY: This isolated fixture supplies its synthetic event transport.
      (
        window as typeof window & { __varroE2E: { replayServerEvent(e: ServerEvent): void } }
      ).__varroE2E.replayServerEvent(e);
    }, event);
  const start = Date.now() - 72_000;
  const info = { ...answer, id: 'long-step', finish: undefined, time: { created: start } };
  const lines = Array.from({ length: 80 }, (_, i) => `result line ${i + 1}`).join('\n');
  const bash = (output: string): ToolPart => ({
    id: 'long-bash',
    callID: 'bash-call',
    sessionID,
    messageID: info.id,
    type: 'tool',
    tool: 'bash',
    state: {
      status: 'running',
      input: { command: 'npm test', description: 'Run tests' },
      metadata: { output },
      time: { start },
    },
  });
  const update = (part: ToolPart) => send({ type: 'message.part.updated', properties: { part } });
  await send({ type: 'message.updated', properties: { info } });
  await update(bash(lines));
  const tool = page.locator('.status-slot-tool[data-activity-part-id="long-bash"]');
  const header = tool.locator('.tool-invocation-header');
  await expect(tool).toHaveAttribute('data-activity-source-message-id', info.id);
  await expect(header.locator('.tool-invocation-duration')).toHaveText(/^1m/);
  await expect(header).toHaveAttribute('aria-expanded', 'false');
  const headerNode = await header.elementHandle();
  const expansion = header.evaluate(async (button) => {
    let before: number | undefined;
    button.addEventListener(
      'pointerdown',
      () => {
        before = button.getBoundingClientRect().top;
      },
      { once: true }
    );
    const tops = [];
    let seenAt = 0;
    const deadline = performance.now() + 5000;
    do {
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      if (before !== undefined) tops.push(button.getBoundingClientRect().top - before);
      if (button.getAttribute('aria-expanded') === 'true') seenAt ||= performance.now();
      if (performance.now() > deadline) throw new Error('Bash expansion was not painted');
    } while (!seenAt || performance.now() - seenAt < 300);
    if (!tops.length) throw new Error('Missed bash disclosure pointerdown');
    return Math.max(...tops.map(Math.abs));
  });
  await header.click();
  expect
    .soft(await expansion, 'expanded body should grow below the clicked header')
    .toBeLessThanOrEqual(1);
  const body = tool.locator('.tool-invocation-detail');
  const bodyNode = await body.elementHandle();
  const log = body.getByRole('log', { name: 'Live command output' });
  await expect(log).toHaveText(lines);
  await update({
    id: 'queued-search',
    callID: 'search-call',
    sessionID,
    messageID: info.id,
    type: 'tool',
    tool: 'grep',
    state: { status: 'running', input: { pattern: 'queued' }, time: { start: Date.now() } },
  });
  for (const tick of [1, 2]) {
    await update(bash(`${lines}\nstream update ${tick}`));
    await expect(log).toContainText(`stream update ${tick}`);
    expect(await header.evaluate((button, original) => button === original, headerNode)).toBe(true);
    expect(await body.evaluate((detail, original) => detail === original, bodyNode)).toBe(true);
  }

  const list = page.locator('.interactive-list');
  const bounds = await body.evaluate((detail) => ({
    detailBottom: detail.getBoundingClientRect().bottom,
    slotBottom: detail.closest('.interactive-loading-row')!.getBoundingClientRect().bottom,
  }));
  expect(bounds.detailBottom).toBeLessThanOrEqual(bounds.slotBottom);
  const beforeOuter = await list.evaluate((el) => el.scrollTop);
  const listBox = (await list.boundingBox())!;
  await page.mouse.move(listBox.x + 10, listBox.y + listBox.height / 2);
  await page.mouse.wheel(0, 360);
  await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBeGreaterThan(beforeOuter);
  await expect(log).toBeInViewport({ ratio: 0.99 });
  const painted = await log.evaluate((el) => {
    const { right, bottom } = el.getBoundingClientRect();
    return el.contains(document.elementFromPoint(right - 15, bottom - 3));
  });
  expect(painted, 'the bottom of the bash output viewport is not clipped').toBe(true);
  await log.hover();
  const beforeInner = await log.evaluate((el) => el.scrollTop);
  const outerAtBottom = await list.evaluate((el) => el.scrollTop);
  await page.mouse.wheel(0, -130);
  await expect.poll(() => log.evaluate((el) => el.scrollTop)).toBeLessThan(beforeInner);
  expect(await list.evaluate((el) => el.scrollTop)).toBe(outerAtBottom);
  await page.mouse.wheel(0, 130);
  await expect
    .poll(() => log.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop))
    .toBeLessThanOrEqual(1);
  const stayed = await header.evaluate(async (button) => {
    const deadline = performance.now() + 1600;
    do {
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      if (!button.isConnected || button.getAttribute('aria-expanded') !== 'true') return false;
    } while (performance.now() < deadline);
    return true;
  });
  expect(stayed, 'inspection holds the bash preview past the normal queued-tool rotation').toBe(
    true
  );
  await update({
    ...bash(lines),
    state: {
      status: 'completed',
      input: { command: 'npm test', description: 'Run tests' },
      output: `Long checks completed\n${lines}`,
      title: 'Run tests',
      metadata: {},
      time: { start, end: Date.now() },
    },
  });
  await expect(header).toHaveAttribute('aria-expanded', 'true');
  await expect(body).toContainText('Long checks completed');
  expect(await header.evaluate((button, original) => button === original, headerNode)).toBe(true);
  expect(await body.evaluate((detail, original) => detail === original, bodyNode)).toBe(true);
  expect(
    await header.evaluate(async (button) => {
      const deadline = performance.now() + 1600;
      do {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        if (!button.isConnected || button.getAttribute('aria-expanded') !== 'true') return false;
      } while (performance.now() < deadline);
      return true;
    }),
    'completion must not dismiss an inspected tool',
  ).toBe(true);
  await header.click();
  await expect(page.locator('.status-slot-tool')).toHaveAttribute(
    'data-activity-part-id',
    'queued-search'
  );
});
