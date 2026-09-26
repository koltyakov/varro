import { createHash } from 'node:crypto';

// Native navigation owns the animation. Observe its result without issuing a
// second input or mistaking the disappearing jump button for arrival.
export async function goToLatest(
  cdp,
  {
    sessionId,
    messageId,
    timeoutMs = 30_000,
    pollMs = 50,
    settleMs = 150,
    now = Date.now,
    wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {}
) {
  if (!sessionId || !messageId) throw new Error('Latest navigation needs session and message IDs');
  if (
    !(await cdp.click('[aria-label="Scroll to latest message"]')) &&
    !(await cdp.key('.interactive-list', 'End'))
  ) {
    throw new Error('Native latest navigation control unavailable');
  }
  const deadline = now() + timeoutMs;
  const samples = [];
  let stableSince = null;
  let previous;
  while (now() <= deadline) {
    const route = await cdp.snapshot();
    const geometry = await cdp.evaluate(`(() => {
      const list = document.querySelector('.interactive-list');
      if (!list) return null;
      const viewport = list.getBoundingClientRect();
      const rows = [...list.querySelectorAll('[data-msg-id]')];
      const visible = rows.filter(row => { const r = row.getBoundingClientRect();
        return r.bottom > viewport.top && r.top < viewport.bottom; });
      return { top: list.scrollTop, height: list.scrollHeight, client: list.clientHeight,
        visibleIds: visible.map(row => row.getAttribute('data-msg-id')) };
    })()`);
    const sample = { at: now(), route: route.routeSessionId, geometry };
    samples.push(sample);
    if (samples.length > 100) samples.shift();
    const arrived =
      sample.route === sessionId &&
      geometry?.visibleIds.includes(messageId) &&
      Math.abs(geometry.height - geometry.client - geometry.top) <= 2;
    const stationary =
      arrived &&
      previous &&
      Math.abs(geometry.top - previous.top) <= 0.5 &&
      Math.abs(geometry.height - previous.height) <= 0.5 &&
      geometry.client === previous.client;
    stableSince = stationary ? (stableSince ?? sample.at) : null;
    if (stableSince !== null && sample.at - stableSince >= settleMs) return { samples };
    previous = arrived ? geometry : null;
    await wait(pollMs);
  }
  const error = new Error(
    `Latest message ${messageId} did not become visible and settled within ${timeoutMs}ms`
  );
  error.samples = samples;
  throw error;
}

// The maintained AI-01 sequence. Call against an already selected, isolated
// history; the caller owns host setup, frame recording, and evidence storage.
export async function runAi01(cdp, { sessionId, messageId, seed }) {
  if (!seed) throw new Error('AI-01 requires a recorded seed');
  const evidence = { scenario: 'AI-01', seed, actions: [] };
  const settle = () =>
    cdp.evaluate(`new Promise(resolve => {
    let frames = 0; function tick() { if (++frames === 4) resolve(); else requestAnimationFrame(tick); }
    requestAnimationFrame(tick);
  })`);
  try {
    evidence.initial = await goToLatest(cdp, { sessionId, messageId });
    for (const direction of [-1, 1]) {
      for (let step = 1; step <= 20; step++) {
        const index = createHash('sha256').update(`${seed}:${direction}:${step}`).digest()[0] % 6;
        const delta = direction * [32, 96, 180, 96, 180, 420][index];
        if (!(await cdp.wheel('.interactive-list', delta)))
          throw new Error('Native wheel target unavailable');
        await settle();
        evidence.actions.push({ direction, step, delta, snapshot: await cdp.snapshot() });
      }
    }
    for (const fraction of [0.25, 0.75, 0.5]) {
      const before = await cdp.snapshot();
      const geometry = await cdp.evaluate(`(() => {
        const list = document.querySelector('.interactive-list');
        const rect = list.getBoundingClientRect(), range = list.scrollHeight - list.clientHeight;
        const thumb = Math.max(20, rect.height * list.clientHeight / list.scrollHeight);
        const track = Math.max(1, rect.height - thumb);
        return { x: rect.right - Math.max(3, (list.offsetWidth - list.clientWidth) / 2),
          start: rect.top + list.scrollTop / range * track + thumb / 2,
          end: rect.top + ${fraction} * track + thumb / 2 };
      })()`);
      for (const [type, y, buttons] of [
        ['mousePressed', geometry.start, 1],
        ['mouseMoved', geometry.end, 1],
        ['mouseReleased', geometry.end, 0],
      ]) {
        await cdp.call('Input.dispatchMouseEvent', {
          type,
          x: geometry.x,
          y,
          buttons,
          button: 'left',
          clickCount: 1,
        });
      }
      await settle();
      const after = await cdp.snapshot();
      evidence.actions.push({ fraction, before, after });
      if (Math.abs(after.transcript.scrollTop - before.transcript.scrollTop) < 2)
        throw new Error('Native scrollbar drag did not move');
    }
    await cdp.call('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Alt',
      code: 'AltLeft',
      modifiers: 1,
    });
    try {
      const deadline = Date.now() + 5000;
      do {
        evidence.promptNumbers = await cdp.evaluate(
          `(() => [...document.querySelectorAll('.prompt-number-badge, [data-prompt-number]')].filter(e => e.getBoundingClientRect().height > 0).length)()`
        );
        if (evidence.promptNumbers) break;
        await settle();
      } while (Date.now() < deadline);
      if (!evidence.promptNumbers)
        throw new Error('Prompt numbers did not appear while Option was held');
    } finally {
      await cdp.call('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Alt',
        code: 'AltLeft',
        modifiers: 0,
      });
    }
    evidence.final = await goToLatest(cdp, { sessionId, messageId });
    evidence.result = 'PASS';
  } catch (error) {
    evidence.result = 'FAIL';
    evidence.error = error.message;
    evidence.samples = error.samples;
  }
  return evidence;
}
