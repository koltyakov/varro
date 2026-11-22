import { expect, test } from '@playwright/test';
import { projectDeferredPart } from '../../src/extension/message-content';
import { StreamingToolContent } from '../../src/extension/streaming-tool-content';
import type { ServerEvent, WebviewMessage } from '../../src/shared/protocol';
import type { MessageEntry, ToolPart } from '../../src/webview/types';

// Reported session ses_e0178e3bcffeLsOuKmZ2etCODB, native index 2654: a patch streams more than
// 512 input characters, is called, then fails verification. 2656 then succeeds after a long
// input stream. The host projection caps pending input and replaces patch bodies with deferred
// summaries, so these events must pass through StreamingToolContent like the real bridge.

const SESSION_ID = 'session-diff-preview-large-transcript';

type TimedEvent = {
  at: number;
  event: ServerEvent;
  status?: ToolPart['state']['status'];
  callID?: string;
  info?: Extract<MessageEntry['info'], { role: 'assistant' }>;
};
type PatchStep = {
  messageID: string;
  callID: string;
  patchText: string;
  fail: boolean;
};

function patchText(step: number, lines: number) {
  return [
    '*** Begin Patch',
    `*** Update File: src/report-gates-${step}.ts`,
    '@@',
    ...Array.from({ length: lines }, (_, line) => [
      `-    const gate${line} = native.coverage.valid && proof.webview.rows[${line}].ready;`,
      `+    const gate${line} = native.coverage.valid && proof.webview.rows[${line}].settled;`,
    ]).flat(),
    '*** End Patch',
  ].join('\n');
}

function patchEvents(step: PatchStep, start: number, inputMs: number): TimedEvent[] {
  const base = { sessionID: SESSION_ID, assistantMessageID: step.messageID, callID: step.callID };
  const raw = JSON.stringify({ patchText: step.patchText });
  const chunks = 8;
  const events: TimedEvent[] = [
    {
      at: start,
      status: 'pending',
      event: {
        type: 'session.next.tool.input.started',
        properties: { ...base, name: 'patch', timestamp: start },
      },
    },
  ];
  for (let index = 0; index < chunks; index += 1) {
    const from = Math.floor((raw.length * index) / chunks);
    const to = Math.floor((raw.length * (index + 1)) / chunks);
    const at = start + Math.round(((index + 1) * inputMs) / (chunks + 1));
    events.push({
      at,
      status: 'pending',
      event: {
        type: 'session.next.tool.input.delta',
        properties: { ...base, delta: raw.slice(from, to), timestamp: at },
      },
    });
  }
  const ran = start + inputMs;
  events.push(
    {
      at: ran,
      status: 'pending',
      event: {
        type: 'session.next.tool.input.ended',
        properties: { ...base, text: raw, timestamp: ran },
      },
    },
    {
      at: ran + 60,
      status: 'running',
      event: {
        type: 'session.next.tool.called',
        properties: {
          ...base,
          tool: 'patch',
          title: 'patch',
          input: { patchText: step.patchText },
          timestamp: ran + 60,
        },
      },
    }
  );
  const end = ran + 700;
  events.push(
    step.fail
      ? {
          at: end,
          status: 'error',
          event: {
            type: 'session.next.tool.failed',
            properties: {
              ...base,
              error: `patch verification failed: Failed to find expected lines in src/report-gates.ts:\n      valid: native.coverage.valid`,
              timestamp: end,
            },
          },
        }
      : {
          at: end,
          status: 'completed',
          event: {
            type: 'session.next.tool.success',
            properties: {
              ...base,
              content: [
                {
                  type: 'text',
                  text: 'Success. Updated the following files:\nM src/report-gates.ts',
                },
              ],
              timestamp: end,
            },
          },
        }
  );
  return events.map((entry) => ({ ...entry, callID: step.callID }));
}

type AssistantInfo = Extract<MessageEntry['info'], { role: 'assistant' }>;
type ToolStatus = ToolPart['state']['status'];
const STATUSES: ToolStatus[] = ['pending', 'running', 'error', 'completed'];

function fullPart(step: PatchStep, status: ToolStatus): ToolPart {
  const input = { patchText: step.patchText };
  const common = {
    id: step.callID,
    sessionID: SESSION_ID,
    messageID: step.messageID,
    type: 'tool' as const,
    tool: 'patch',
    callID: step.callID,
  };
  if (status === 'pending')
    return { ...common, state: { status, input, raw: JSON.stringify(input) } };
  if (status === 'running')
    return {
      ...common,
      state: { status, input, title: 'patch', metadata: {}, time: { start: 1 } },
    };
  if (status === 'error')
    return {
      ...common,
      state: {
        status,
        input,
        error: 'patch verification failed',
        metadata: {},
        time: { start: 1, end: 2 },
      },
    };
  return {
    ...common,
    state: {
      status,
      input,
      output: 'Success',
      title: 'patch',
      metadata: {},
      time: { start: 1, end: 2 },
    },
  };
}

/** Full details for deferred reads and the REST projection persisted by the fake server. */
function partVariants(steps: PatchStep[]) {
  const details: Record<string, Record<string, ToolPart>> = {};
  const persisted: Record<string, Record<string, ToolPart>> = {};
  for (const step of steps) {
    details[step.callID] = {};
    persisted[step.callID] = {};
    for (const status of STATUSES) {
      const part = fullPart(step, status);
      details[step.callID]![status] = part;
      persisted[step.callID]![status] = projectDeferredPart(part);
    }
  }
  return { details, persisted };
}

function buildTimeline(template: AssistantInfo) {
  const bridge = new StreamingToolContent();
  const steps: PatchStep[] = [
    {
      messageID: 'patch-failure-step',
      callID: 'call-patch-failure',
      patchText: patchText(0, 18),
      fail: true,
    },
    {
      messageID: 'patch-retry-step',
      callID: 'call-patch-retry',
      patchText: patchText(1, 18),
      fail: false,
    },
  ];
  const timeline: TimedEvent[] = [];
  const now = Date.now();
  const model = { providerID: template.providerID, modelID: template.modelID };
  const stepInfo = (messageID: string, created: number, completed?: number): AssistantInfo => ({
    ...template,
    id: messageID,
    finish: completed ? 'tool-calls' : undefined,
    time: completed ? { created, completed } : { created },
  });
  const startStep = (messageID: string, at: number) =>
    timeline.push({
      at,
      info: stepInfo(messageID, now + at),
      event: {
        type: 'session.next.step.started',
        properties: {
          sessionID: SESSION_ID,
          assistantMessageID: messageID,
          model,
          agent: 'build',
          timestamp: now + at,
        },
      },
    });
  let at = 0;
  for (const step of steps) {
    const created = now + at;
    startStep(step.messageID, at);
    timeline.push(...patchEvents(step, at + 150, 2600));
    at += 4200;
    timeline.push({
      at: at - 200,
      info: stepInfo(step.messageID, created, now + at - 200),
      event: {
        type: 'session.next.step.ended',
        properties: {
          sessionID: SESSION_ID,
          assistantMessageID: step.messageID,
          finish: 'tool-calls',
          timestamp: now + at - 200,
        },
      },
    });
  }
  startStep('patch-text-step', at);
  const text = {
    sessionID: SESSION_ID,
    assistantMessageID: 'patch-text-step',
    textID: 'patch-text-step-text',
  };
  timeline.push({ at: at + 40, event: { type: 'session.next.text.started', properties: text } });
  const answer = 'The retry applied the gate update after the failed verification. ';
  for (let index = 1; index <= 6; index += 1)
    timeline.push({
      at: at + index * 80,
      event: { type: 'session.next.text.delta', properties: { ...text, delta: answer } },
    });
  return {
    steps,
    ...partVariants(steps),
    timeline: timeline
      .toSorted((left, right) => left.at - right.at)
      .map((entry) => ({ ...entry, event: bridge.project(entry.event) })),
    endAt: at + 2200,
  };
}

for (const measured of [false, true]) {
  for (const diffs of [true, false]) {
    test(`failed and retried streaming patches keep painted content fixed: ${measured ? 'measured' : 'short'} diffs=${diffs ? 'on' : 'off'}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width: 486, height: 800 });
      await page.goto(
        `/e2e/harness/index.html?scenario=diff-preview-large-transcript&diffPreviewTurns=${measured ? 60 : 3}&diffPreviewCompleted=1&diffPreviewInline=${diffs ? 1 : 0}`
      );
      const list = page.locator('.interactive-list');
      await expect(
        list.locator('.file-change-card, .file-change-inline-diffs').first()
      ).toBeVisible();
      await expect
        .poll(() =>
          list.evaluate(
            (element) => element.scrollHeight - element.clientHeight - element.scrollTop
          )
        )
        .toBeLessThanOrEqual(1);
      await page.waitForTimeout(400);
      const template = await page.evaluate((sessionID) => {
        // SAFETY: The isolated fixture installs typed persistence and production-event replay helpers.
        const harness = (
          window as typeof window & {
            __varroE2E: { getSessionMessages(id: string): MessageEntry[] };
          }
        ).__varroE2E;
        return harness.getSessionMessages(sessionID).at(-1)!.info;
      }, SESSION_ID);
      if (template.role !== 'assistant') throw new Error('Expected an assistant fixture');
      const fixture = buildTimeline(template);

      const result = await page.evaluate(async ({ steps, timeline, endAt, details, persisted }) => {
        type Harness = {
          replayServerEvent(event: ServerEvent): void;
          updateMessageInfo(info: MessageEntry['info']): void;
          updateMessagePart(part: ToolPart): void;
        };
        type FrameSample = {
          frame: number;
          t: number;
          scrollTop: number;
          scrollHeight: number;
          distance: number;
          reserve: number;
          failedRow: string;
          retryRow: string;
          retryMinHeight: string;
        };
        type Reversal = FrameSample & { delta: number; anchor: string; lastEvents?: string };
        // SAFETY: The isolated fixture installs typed persistence and production-event replay helpers.
        const host = window as typeof window & {
          __varroE2E: Harness;
          __sendToExtension?: Window['__sendToExtension'];
        };
        const harness = host.__varroE2E;
        const viewport = document.querySelector<HTMLElement>('.interactive-list')!;
        const liveStatus = new Map<string, ToolPart['state']['status']>();
        const requests: string[] = [];
        const send = host.__sendToExtension;
        host.__sendToExtension = (message) => {
          // SAFETY: The application bridge sends the WebviewMessage union to this harness callback.
          const request = message as WebviewMessage;
          const step =
            request.type === 'api/request'
              ? steps.find((candidate) =>
                  request.payload.path.includes(`/part/${candidate.callID}`)
                )
              : undefined;
          if (request.type !== 'api/request' || !step) return send?.(message);
          const status = liveStatus.get(step.callID) ?? 'pending';
          requests.push(`${step.callID}:${status}`);
          // Deferred details arrive after the live status change, as a host round trip does.
          setTimeout(
            () =>
              window.postMessage(
                {
                  type: 'api/response',
                  payload: { id: request.payload.id, data: details[step.callID]![status] },
                },
                '*'
              ),
            140
          );
        };

        const tracked =
          '.rendered-markdown p, .user-message-card, .file-change-card-header, .assistant-activity-summary, .diff-view-file';
        const describeRow = (id: string) => {
          const row = viewport.querySelector<HTMLElement>(`[data-msg-id="${id}"]`);
          if (!row) return 'none';
          const items = [...row.querySelectorAll<HTMLElement>('.assistant-message-flow-item')].map(
            (element) =>
              `${element.dataset.assistantRenderKey ?? ''}:${Math.round(element.getBoundingClientRect().height)}`
          );
          return `${Math.round(row.getBoundingClientRect().height)}[${items.join(' ')}]`;
        };
        let previousTops = new Map<Element, number>();
        const reversals: Reversal[] = [];
        const frames: FrameSample[] = [];
        const fired: string[] = [];
        const errors: string[] = [];
        const onError = (event: ErrorEvent) => errors.push(event.message);
        window.addEventListener('error', onError);
        const start = performance.now();
        let next = 0;
        let frame = 0;
        try {
          while (performance.now() - start < endAt) {
            const elapsed = performance.now() - start;
            const labels: string[] = [];
            while (next < timeline.length && timeline[next]!.at <= elapsed) {
              const entry = timeline[next]!;
              if (entry.status && entry.callID) {
                liveStatus.set(entry.callID, entry.status);
                // The fake server persists the same deferred projection that REST would return.
                harness.updateMessagePart(persisted[entry.callID]![entry.status]!);
              }
              if (entry.info) harness.updateMessageInfo(entry.info);
              harness.replayServerEvent(entry.event);
              labels.push(entry.event.type.replace('session.next.', ''));
              next += 1;
            }
            if (labels.length) fired.push(`${frame}@${Math.round(elapsed)}:${labels.join(',')}`);
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
            frame += 1;
            const bounds = viewport.getBoundingClientRect();
            const tops = new Map<Element, number>();
            for (const element of viewport.querySelectorAll(tracked)) {
              const rect = element.getBoundingClientRect();
              if (rect.height > 0 && rect.bottom > bounds.top && rect.top < bounds.bottom)
                tops.set(element, rect.top);
            }
            // The topmost element painted in both frames is the reader's anchor.
            let anchor: Element | null = null;
            for (const [element, top] of previousTops)
              if (tops.has(element) && (!anchor || top < previousTops.get(anchor)!))
                anchor = element;
            const sample: FrameSample = {
              frame,
              t: Math.round(performance.now() - start),
              scrollTop: viewport.scrollTop,
              scrollHeight: viewport.scrollHeight,
              distance: Math.round(
                viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop
              ),
              reserve:
                viewport.querySelector('.append-scroll-bottom-reserve')?.getBoundingClientRect()
                  .height ?? 0,
              failedRow: describeRow('patch-failure-step'),
              retryRow: describeRow('patch-retry-step'),
              retryMinHeight:
                viewport.querySelector<HTMLElement>('[data-msg-id="patch-retry-step"]')?.style
                  .minHeight ?? '',
            };
            frames.push(sample);
            if (anchor) {
              const delta = tops.get(anchor)! - previousTops.get(anchor)!;
              if (delta > 0.5)
                reversals.push({
                  ...sample,
                  delta: Math.round(delta * 10) / 10,
                  anchor: `${anchor.className.slice(0, 32)}:${(anchor.textContent ?? '').slice(0, 30)}`,
                  lastEvents: fired.at(-1),
                });
            }
            previousTops = tops;
          }
        } finally {
          host.__sendToExtension = send;
          window.removeEventListener('error', onError);
        }
        const windows = reversals
          .slice(0, 3)
          .map((reversal) =>
            frames.filter(
              (sample) => sample.frame <= reversal.frame + 2 && sample.frame >= reversal.frame - 12
            )
          );
        return { reversals, fired, requests, errors, windows };
      }, fixture);
      await testInfo.attach('patch-failure-frames', {
        body: JSON.stringify(result),
        contentType: 'application/json',
      });
      expect(result.errors).toEqual([]);
      expect(
        result.reversals,
        JSON.stringify({ reversals: result.reversals.slice(0, 4), frames: result.windows[0] })
      ).toEqual([]);
    });
  }
}
