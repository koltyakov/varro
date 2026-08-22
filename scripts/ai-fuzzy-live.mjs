import { execFile } from 'node:child_process';
import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { reloadVscodeWindow, resizeVscodeSidebar } from './vscode-launch-process.mjs';

const execFileAsync = promisify(execFile);
const DEFAULT_MODEL = 'openai/gpt-5.6-luna';
const DEFAULT_MAX_PROMPTS = 3;
const DEFAULT_GATE_TIMEOUT_MS = 90_000;

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (!argument.startsWith('--')) throw new Error(`Unexpected argument: ${argument}`);
    const value = rest[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${argument}`);
    options[argument.slice(2)] = value;
    index += 1;
  }
  return { command, options };
}

function required(options, name) {
  const value = options[name]?.trim();
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function parseModel(value) {
  const separator = value.indexOf('/');
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error('--model must use provider/model format');
  }
  return { providerID: value.slice(0, separator), modelID: value.slice(separator + 1) };
}

export function modelDisplayName(value) {
  const { modelID } = parseModel(value);
  const parts = modelID.split('-');
  if (parts[0] === 'gpt' && /^\d+(?:\.\d+)*$/.test(parts[1] ?? '')) {
    return `GPT-${parts[1]} ${parts
      .slice(2)
      .map((part) => (part ? `${part[0].toUpperCase()}${part.slice(1)}` : part))
      .join(' ')}`.trim();
  }
  return parts
    .map((part) => (part ? `${part[0].toUpperCase()}${part.slice(1)}` : part))
    .join(' ');
}

export function parseRestartCount(value) {
  const restartCount = Number(value ?? 1);
  if (!Number.isInteger(restartCount) || restartCount < 1 || restartCount > 10) {
    throw new Error('--restart-count must be an integer from 1 through 10');
  }
  return restartCount;
}

export function fixtureIsSafeForScenario(fixture, manifest, scenario) {
  if (fixture.commit !== manifest.fixture.commit) return false;
  if (!fixture.status) return true;
  if (scenario !== 'AI-08') return false;
  const preparedFixture = manifest.livePreparation?.['AI-07']?.fixtureAfterPreparation;
  return (
    preparedFixture?.commit === fixture.commit && preparedFixture?.status === fixture.status
  );
}

export function missingLiveGates(snapshot, scenario) {
  const missing = [];
  if (!snapshot.virtualized) missing.push('virtualized transcript');
  if (!snapshot.busy) missing.push('active model stream');
  if (!snapshot.stickyMessageId) missing.push('sticky latest prompt');
  if (!snapshot.fileEdit) missing.push('file edit or diff');
  if (!snapshot.disclosure) missing.push('expandable activity disclosure');
  if (!snapshot.nestedActivityScroller?.hasRange) missing.push('scrollable active tray');
  if (scenario === 'AI-08' && !snapshot.diffControl) missing.push('expandable diff control');
  return missing;
}

export function buildLivePrompt({ seed, attempt, missing = [] }) {
  const marker = `[VFZ:${seed}:TOOLS-A${String(attempt)}]`;
  if (attempt === 1) {
    return `${marker} Work only in the current OpenCode repository. Investigate one real, bounded test-coverage or code-quality issue. Start with at least eight independent read or search tool calls in one parallel assistant step. Make a small verified change to exactly two existing source or test files, run two focused checks separately, and inspect the resulting diff. After the edit, issue exactly six separate read-only bash calls concurrently, one command per tool call: "sleep 8 && git status --short", "sleep 16 && git rev-parse --short HEAD", "sleep 24 && git diff --check", "sleep 32 && git status --porcelain=v1", "sleep 40 && git diff --stat", and "sleep 48 && git log -1 --oneline". Do not write final prose until all six complete. Keep a todo list and brief reasoning between groups. Finish with VFZ-TOOLS-END. Do not commit, change branches, install dependencies, generate dependency trees, touch files outside this repository, or undo existing work.`;
  }

  const requests = [];
  if (missing.includes('file edit or diff') || missing.includes('expandable diff control')) {
    requests.push(
      'make the smallest justified edit now in exactly two existing files, inspect its diff, and keep the diff available'
    );
  }
  if (missing.includes('scrollable active tray') || missing.includes('active model stream')) {
    requests.push(
      'then issue exactly six separate read-only bash calls concurrently, one command per tool call: "sleep 8 && git status --short", "sleep 16 && git rev-parse --short HEAD", "sleep 24 && git diff --check", "sleep 32 && git status --porcelain=v1", "sleep 40 && git diff --stat", and "sleep 48 && git log -1 --oneline"; do not write prose until all six complete'
    );
  }
  if (missing.includes('expandable activity disclosure')) {
    requests.push('retain completed reads or searches so an Explored disclosure is rendered');
  }
  if (missing.includes('sticky latest prompt')) {
    requests.push('continue with enough reasoning and tool work for the current prompt to move above the viewport');
  }
  if (requests.length === 0) {
    requests.push('continue the bounded task with another parallel read group, one edit, and one focused check');
  }
  return `${marker} The live UI gate is still missing: ${missing.join(', ')}. ${requests.join('; ')}. Do not repeat completed work, commit, change branches, install dependencies, or touch files outside this repository. Continue until the requested tool activity is underway, then finish with VFZ-TOOLS-END.`;
}

export function buildDuplicateDeliveryPrompt(seed, tokens) {
  return `[VFZ:${seed}:DUP] Respond with only these tokens, one per line, exactly once each, in this order:\n${tokens.join('\n')}\nDo not repeat, quote, explain, or use tools.`;
}

export function duplicateDeliveryFailures(observation, sawBusy) {
  const failures = [];
  if (!sawBusy) failures.push('active model stream was not observed');
  if (!observation?.userSeen) failures.push('sent user prompt was not observed');
  if (!observation?.assistantSeen) failures.push('assistant stream was not observed');
  if (!observation?.tokenSeen?.every(Boolean)) failures.push('not every required stream token was observed');
  if ((observation?.maxUserRows ?? 0) > 1) failures.push('sent user prompt rendered more than once');
  if ((observation?.maxAssistantRows ?? 0) > 1) failures.push('assistant response rendered in multiple rows');
  if (observation?.maxTokenCounts?.some((count) => count > 1)) {
    failures.push('a streamed token rendered more than once');
  }
  return failures;
}

export function summarizeCanonicalDelivery(messages, marker, tokens) {
  const userIndex = messages.findIndex(
    (entry) =>
      entry?.info?.role === 'user' &&
      entry.parts?.some((part) => part?.type === 'text' && part.text?.includes(marker))
  );
  const user = userIndex >= 0 ? messages[userIndex] : null;
  const assistants = user
    ? messages
        .slice(userIndex + 1)
        .filter(
          (entry) =>
            entry?.info?.role === 'assistant' &&
            (!entry.info.parentID || entry.info.parentID === user.info.id)
        )
        .map((entry) => ({
          id: entry.info.id,
          parentID: entry.info.parentID ?? null,
          finish: entry.info.finish ?? null,
          error: entry.info.error ?? null,
          text: entry.parts
            .filter((part) => part?.type === 'text' || part?.type === 'reasoning')
            .map((part) => part.text ?? '')
            .join('\n'),
        }))
    : [];
  const combinedText = assistants.map((entry) => entry.text).join('\n');
  return {
    user: user ? { id: user.info.id } : null,
    assistants,
    expectedTokensPresent: tokens.map((token) => combinedText.includes(token)),
  };
}

export function buildDuplicateDeliveryObserverExpression(marker, tokens) {
  return `(() => {
    globalThis.__varroDuplicateDeliveryObserver?.stop();
    const marker = ${JSON.stringify(marker)};
    const tokens = ${JSON.stringify(tokens)};
    const rowId = (row) => row.closest('[data-msg-id]')?.getAttribute('data-msg-id') ?? null;
    const baselineAssistantIds = new Set(
      [...document.querySelectorAll('.chat-turn-assistant')].map(rowId).filter(Boolean)
    );
    const observation = {
      frames: 0,
      userSeen: false,
      assistantSeen: false,
      rawAssistantSeen: false,
      maxUserRows: 0,
      maxAssistantRows: 0,
      maxRawAssistantRows: 0,
      rawAssistantSamples: [],
      maxTokenCounts: tokens.map(() => 0),
      tokenSeen: tokens.map(() => false),
      firstViolation: null,
    };
    let active = true;
    const sample = () => {
      if (!active) return;
      observation.frames += 1;
      const userRows = [...document.querySelectorAll('.chat-turn-user')].filter((row) =>
        row.textContent?.includes(marker)
      );
      const assistantRows = [...document.querySelectorAll('.chat-turn-assistant')].filter((row) =>
        tokens.some((token) => row.textContent?.includes(token))
      );
      const rawAssistantRows = [...document.querySelectorAll('.chat-turn-assistant')].filter((row) => {
        const id = rowId(row);
        return id && !baselineAssistantIds.has(id);
      });
      const assistantText = assistantRows.map((row) => row.textContent ?? '').join('\\n');
      const tokenCounts = tokens.map((token) => assistantText.split(token).length - 1);
      observation.userSeen ||= userRows.length > 0;
      observation.assistantSeen ||= assistantRows.length > 0;
      observation.rawAssistantSeen ||= rawAssistantRows.length > 0;
      observation.maxUserRows = Math.max(observation.maxUserRows, userRows.length);
      observation.maxAssistantRows = Math.max(observation.maxAssistantRows, assistantRows.length);
      observation.maxRawAssistantRows = Math.max(observation.maxRawAssistantRows, rawAssistantRows.length);
      for (const row of rawAssistantRows) {
        const id = rowId(row);
        if (observation.rawAssistantSamples.some((sample) => sample.id === id)) continue;
        observation.rawAssistantSamples.push({ id, text: (row.textContent ?? '').slice(0, 1000) });
      }
      tokenCounts.forEach((count, index) => {
        observation.maxTokenCounts[index] = Math.max(observation.maxTokenCounts[index], count);
        observation.tokenSeen[index] ||= count > 0;
      });
      if (!observation.firstViolation && (
        userRows.length > 1 ||
        assistantRows.length > 1 ||
        tokenCounts.some((count) => count > 1)
      )) {
        observation.firstViolation = {
          frame: observation.frames,
          userRows: userRows.length,
          assistantRows: assistantRows.length,
          tokenCounts,
        };
      }
      requestAnimationFrame(sample);
    };
    globalThis.__varroDuplicateDeliveryObserver = {
      observation,
      stop() { active = false; },
    };
    sample();
    return true;
  })()`;
}

class OpenCodeClient {
  constructor(server, workspace) {
    this.server = server.replace(/\/$/, '');
    this.workspace = workspace;
  }

  async request(method, route, body) {
    const url = new URL(`${this.server}${route}`);
    url.searchParams.set('directory', this.workspace);
    const init = {
      method,
      headers: {
        'content-type': 'application/json',
        'x-opencode-directory': this.workspace,
      },
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    const response = await fetch(url, init);
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${route} failed (${String(response.status)}): ${text}`);
    return text ? JSON.parse(text) : null;
  }

  async isBusy(sessionId) {
    const statuses = await this.request('GET', '/session/status');
    return statuses?.[sessionId]?.type === 'busy';
  }

  messages(sessionId, limit = 200) {
    return this.request(
      'GET',
      `/session/${encodeURIComponent(sessionId)}/message?limit=${String(limit)}`
    ).then((result) => (Array.isArray(result) ? result : (result?.items ?? [])));
  }

  send(sessionId, prompt, model) {
    return this.request('POST', `/session/${encodeURIComponent(sessionId)}/prompt_async`, {
      parts: [{ type: 'text', text: prompt }],
      model,
    });
  }
}

class CdpController {
  constructor(port, socket, contextId, frameId = null) {
    this.port = port;
    this.socket = socket;
    this.contextId = contextId;
    this.frameId = frameId;
    this.requestId = 0;
  }

  static async connect(port, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
      let socket = null;
      try {
        const targets = await fetch(`http://127.0.0.1:${String(port)}/json/list`).then((response) =>
          response.json()
        );
        const target = targets.find(
          (item) => item.type === 'iframe' && item.url.includes('extensionId=koltyakov.varro')
        );
        if (!target?.webSocketDebuggerUrl) {
          throw new Error('The tracked host has no Varro iframe target');
        }
        socket = new WebSocket(target.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => {
          socket.addEventListener('open', resolve, { once: true });
          socket.addEventListener('error', reject, { once: true });
        });
        const temporary = new CdpController(port, socket, null);
        const tree = await temporary.call('Page.getFrameTree');
        const frameId = tree.frameTree.childFrames?.[0]?.frame.id;
        if (!frameId) throw new Error('The Varro content frame is unavailable');
        const world = await temporary.call('Page.createIsolatedWorld', {
          frameId,
          worldName: `varro-ai-fuzzy-${String(Date.now())}`,
          grantUniveralAccess: true,
        });
        temporary.contextId = world.executionContextId;
        temporary.frameId = frameId;
        return temporary;
      } catch (error) {
        socket?.close();
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    throw new Error(
      `Could not connect to the recreated Varro content frame: ${lastError instanceof Error ? lastError.message : String(lastError)}`
    );
  }

  call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.requestId;
      const listener = (event) => {
        const message = JSON.parse(event.data);
        if (message.id !== id) return;
        this.socket.removeEventListener('message', listener);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      };
      this.socket.addEventListener('message', listener);
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    let result;
    try {
      result = await this.evaluateInCurrentContext(expression);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('Cannot find context')) throw error;
      await this.refreshContext();
      result = await this.evaluateInCurrentContext(expression);
    }
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    }
    return result.result.value;
  }

  evaluateInCurrentContext(expression) {
    return this.call('Runtime.evaluate', {
      contextId: this.contextId,
      expression,
      returnByValue: true,
    });
  }

  async refreshContext() {
    const tree = await this.call('Page.getFrameTree');
    const frameId = tree.frameTree.childFrames?.[0]?.frame.id;
    if (!frameId) throw new Error('The recreated Varro content frame is unavailable');
    const world = await this.call('Page.createIsolatedWorld', {
      frameId,
      worldName: `varro-ai-fuzzy-${String(Date.now())}`,
      grantUniveralAccess: true,
    });
    this.frameId = frameId;
    this.contextId = world.executionContextId;
  }

  snapshot() {
    return this.evaluate(`(() => {
      const transcript = document.querySelector('.interactive-list');
      const visible = (element) => {
        if (!element) return false;
        const rect = element.getBoundingClientRect();
        return rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth;
      };
      const firstVisible = (selector) => [...document.querySelectorAll(selector)].find(visible) ?? null;
      const nested = firstVisible('.assistant-active-activity-items');
      const nestedStyle = nested ? getComputedStyle(nested) : null;
      return {
        title: document.body.innerText.split('\\n')[0] ?? '',
        virtualized: !!document.querySelector('.interactive-list-track.virtualized'),
        transcript: transcript ? {
          scrollTop: transcript.scrollTop,
          scrollHeight: transcript.scrollHeight,
          clientHeight: transcript.clientHeight,
        } : null,
        stickyMessageId: document.querySelector('[data-sticky-msg-id]')?.getAttribute('data-sticky-msg-id') ?? null,
        activeActivityCount: document.querySelectorAll('.assistant-active-activity-item').length,
        nestedActivityScroller: nested ? {
          scrollTop: nested.scrollTop,
          scrollHeight: nested.scrollHeight,
          clientHeight: nested.clientHeight,
          overflowY: nestedStyle?.overflowY ?? '',
          hasRange: ['auto', 'scroll'].includes(nestedStyle?.overflowY ?? '') && nested.scrollHeight > nested.clientHeight + 1,
        } : null,
        fileEdit: !!document.querySelector('.file-change-card, .file-change-inline-diffs, .diff-summary, .diff-view-file'),
        disclosure: !!document.querySelector('.assistant-activity-summary'),
        diffControl: !!document.querySelector('[aria-label^="Expand changes in"], [aria-label^="Collapse changes in"]'),
        jumpToLatest: !!document.querySelector('[aria-label="Scroll to latest message"]'),
      };
    })()`);
  }

  async point(selector, edge = 'center') {
    for (let attempt = 0; attempt < 24; attempt += 1) {
      const result = await this.evaluate(`(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        const visible = rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth;
        return {
          visible,
          x: ${edge === 'right' ? 'rect.right - 6' : 'rect.x + rect.width / 2'},
          y: rect.y + rect.height / 2,
          direction: rect.top < 0 ? -1 : 1,
          transcript: (() => {
            const bounds = document.querySelector('.interactive-list')?.getBoundingClientRect();
            return bounds ? { x: bounds.right - 6, y: bounds.y + bounds.height / 2 } : null;
          })(),
        };
      })()`);
      if (!result) return null;
      if (result.visible) return { x: result.x, y: result.y };
      if (!result.transcript) return null;
      await this.call('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        ...result.transcript,
        deltaX: 0,
        deltaY: result.direction * 180,
      });
      await new Promise((resolve) => setTimeout(resolve, 34));
    }
    return null;
  }

  async click(selector) {
    const point = await this.point(selector);
    if (!point) return false;
    for (const [type, buttons] of [
      ['mousePressed', 1],
      ['mouseReleased', 0],
    ]) {
      await this.call('Input.dispatchMouseEvent', {
        type,
        ...point,
        button: 'left',
        buttons,
        clickCount: 1,
      });
    }
    return true;
  }

  async clickText(text, excludeText = '') {
    const exclusion = excludeText
      ? `&& !candidate.innerText.includes(${JSON.stringify(excludeText)})`
      : '';
    const point = await this.evaluate(`(() => {
      const element = [...document.querySelectorAll('button, [role="button"]')].find((candidate) => {
        const rect = candidate.getBoundingClientRect();
        return candidate.innerText.includes(${JSON.stringify(text)}) ${exclusion} &&
          rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight;
      });
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()`);
    if (!point) return false;
    for (const [type, buttons] of [
      ['mousePressed', 1],
      ['mouseReleased', 0],
    ]) {
      await this.call('Input.dispatchMouseEvent', {
        type,
        ...point,
        button: 'left',
        buttons,
        clickCount: 1,
      });
    }
    return true;
  }

  async wheel(selector, delta, edge = 'center') {
    const point = await this.point(selector, edge);
    if (!point) return false;
    await this.call('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      ...point,
      deltaX: 0,
      deltaY: delta,
    });
    return true;
  }

  async key(selector, key) {
    if (!(await this.click(selector))) return false;
    const shifted = key === 'Shift+Space';
    const normalized = shifted ? ' ' : key === 'Space' ? ' ' : key;
    const code = shifted || key === 'Space' ? 'Space' : key;
    for (const type of ['keyDown', 'keyUp']) {
      await this.call('Input.dispatchKeyEvent', {
        type,
        key: normalized,
        code,
        modifiers: shifted ? 8 : 0,
      });
    }
    return true;
  }

  async sendComposerPrompt(prompt) {
    if (!(await this.click('[aria-label="Message composer"]'))) return false;
    await this.call('Input.insertText', { text: prompt });
    for (const type of ['keyDown', 'keyUp']) {
      await this.call('Input.dispatchKeyEvent', {
        type,
        key: 'Enter',
        code: 'Enter',
      });
    }
    return true;
  }

  async selectModel(name) {
    const current = await this.evaluate(`(() => {
      const button = [...document.querySelectorAll('button')].find((candidate) =>
        candidate.innerText.trim().startsWith('GPT-5.6 ')
      );
      return button?.innerText.trim() ?? null;
    })()`);
    if (current === name) return current;
    if (!current || !(await this.clickText(current))) {
      throw new Error('The current composer model control is unavailable');
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (!(await this.clickText(name))) throw new Error(`Model ${name} is not visible in the picker`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const selected = await this.evaluate(`(() => {
      const button = [...document.querySelectorAll('button')].find((candidate) =>
        candidate.innerText.trim().startsWith('GPT-5.6 ')
      );
      return button?.innerText.trim() ?? null;
    })()`);
    if (selected !== name) throw new Error(`Model selection remained ${String(selected)}`);
    return selected;
  }

  startDuplicateDeliveryObservation(marker, tokens) {
    return this.evaluate(buildDuplicateDeliveryObserverExpression(marker, tokens));
  }

  finishDuplicateDeliveryObservation() {
    return this.evaluate(`(() => {
      const observer = globalThis.__varroDuplicateDeliveryObserver;
      if (!observer) return null;
      observer.stop();
      return observer.observation;
    })()`);
  }

  close() {
    this.socket.close();
  }
}

async function fixtureStatus(workspace) {
  const [{ stdout: status }, { stdout: commit }] = await Promise.all([
    execFileAsync('git', ['-C', workspace, 'status', '--short']),
    execFileAsync('git', ['-C', workspace, 'rev-parse', 'HEAD']),
  ]);
  return { status: status.trim(), commit: commit.trim() };
}

async function writeJsonAtomic(filePath, value) {
  const temporaryPath = `${filePath}.${String(process.pid)}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporaryPath, filePath);
}

async function openRunSession(cdp, title) {
  let snapshot = await cdp.snapshot();
  if (snapshot.title === title) return;
  const deadline = Date.now() + 5_000;
  let opened = false;
  while (Date.now() < deadline && !opened) {
    await cdp.click('[aria-label="Back to sessions"]');
    await new Promise((resolve) => setTimeout(resolve, 250));
    opened = await cdp.clickText(title);
  }
  if (!opened) {
    throw new Error(`Run session ${title} is not visible in the dedicated host session list`);
  }
  const openDeadline = Date.now() + 5_000;
  while (Date.now() < openDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    snapshot = await cdp.snapshot();
    if (snapshot?.title === title) return;
  }
  throw new Error(`Could not open run session ${title}`);
}

async function waitForLiveGate({ client, cdp, sessionId, scenario, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  let sawBusy = false;
  let best = null;
  while (Date.now() < deadline) {
    const [snapshot, busy] = await Promise.all([cdp.snapshot(), client.isBusy(sessionId)]);
    snapshot.busy = busy;
    sawBusy ||= busy;
    const missing = missingLiveGates(snapshot, scenario);
    if (!best || missing.length < best.missing.length) best = { snapshot, missing };
    if (missing.length === 0) return { snapshot, missing };
    if (sawBusy && !busy) return best;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return best;
}

async function waitForIdle(client, sessionId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (await client.isBusy(sessionId)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return true;
}

async function waitForBusy(client, sessionId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await client.isBusy(sessionId)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function nestedHandoff(cdp) {
  const captureOuterAnchor = () =>
    cdp.evaluate(`(() => {
      const scroller = document.querySelector('[aria-label="Chat messages"]');
      if (!scroller) return null;
      const viewport = scroller.getBoundingClientRect();
      const row = [...scroller.querySelectorAll('[data-msg-id]')].find((element) => {
        const rect = element.getBoundingClientRect();
        return rect.bottom > viewport.top && rect.top < viewport.bottom;
      });
      if (!row) return null;
      return {
        messageId: row.getAttribute('data-msg-id'),
        top: row.getBoundingClientRect().top - viewport.top,
      };
    })()`);
  const captureSameOuterAnchor = (anchor) =>
    anchor
      ? cdp.evaluate(`(() => {
          const scroller = document.querySelector('[aria-label="Chat messages"]');
          const row = [...(scroller?.querySelectorAll('[data-msg-id]') ?? [])].find(
            (element) => element.getAttribute('data-msg-id') === ${JSON.stringify(anchor.messageId)}
          );
          if (!scroller || !row) return null;
          return row.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
        })()`)
      : null;
  const before = await cdp.snapshot();
  const outerAnchor = await captureOuterAnchor();
  const nested = before.nestedActivityScroller;
  if (!nested?.hasRange) return { passed: false, reason: 'active tray lost its scroll range' };
  const nestedDelta = nested.scrollTop > 0 ? -96 : 96;
  await cdp.wheel('.assistant-active-activity-items', nestedDelta);
  await new Promise((resolve) => setTimeout(resolve, 80));
  const afterNested = await cdp.snapshot();
  const afterNestedOuterAnchorTop = await captureSameOuterAnchor(outerAnchor);
  const outerDelta = before.transcript.scrollTop > 1 ? -96 : 96;
  await cdp.wheel('.interactive-list', outerDelta, 'right');
  await new Promise((resolve) => setTimeout(resolve, 250));
  const afterOuter = await cdp.snapshot();
  const afterOuterAnchorTop = await captureSameOuterAnchor(outerAnchor);
  const nestedPreservedOuterContent =
    outerAnchor !== null &&
    afterNestedOuterAnchorTop !== null &&
    // Active command completion can move the tray by a few pixels during this 80 ms sample.
    // A leaked nested wheel moves the transcript by the full 96 px input delta.
    Math.abs(afterNestedOuterAnchorTop - outerAnchor.top) <= 12;
  const outerMovedContent =
    afterOuterAnchorTop === null ||
    (afterNestedOuterAnchorTop !== null &&
      Math.abs(afterOuterAnchorTop - afterNestedOuterAnchorTop) > 1.5);
  return {
    passed:
      afterNested.nestedActivityScroller?.scrollTop !== nested.scrollTop &&
      nestedPreservedOuterContent &&
      outerMovedContent,
    outerAnchor,
    afterNestedOuterAnchorTop,
    afterOuterAnchorTop,
    before,
    afterNested,
    afterOuter,
  };
}

async function switchAwayAndBack(cdp, currentTitle) {
  if (!(await cdp.click('[aria-label="Back to sessions"]'))) return false;
  await new Promise((resolve) => setTimeout(resolve, 250));
  const alternate = await cdp.evaluate(`(() => {
    const current = ${JSON.stringify(currentTitle)};
    const candidate = [...document.querySelectorAll('button, [role="button"]')].find((element) =>
      element.innerText && !element.innerText.includes(current) && !element.getAttribute('aria-label')
    );
    if (!candidate) return null;
    const rect = candidate.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  })()`);
  if (!alternate) return false;
  for (const [type, buttons] of [
    ['mousePressed', 1],
    ['mouseReleased', 0],
  ]) {
    await cdp.call('Input.dispatchMouseEvent', {
      type,
      ...alternate,
      button: 'left',
      buttons,
      clickCount: 1,
    });
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
  await cdp.click('[aria-label="Back to sessions"]');
  await new Promise((resolve) => setTimeout(resolve, 250));
  const reopened = await cdp.clickText(currentTitle);
  if (reopened) await new Promise((resolve) => setTimeout(resolve, 500));
  return reopened;
}

async function executeActionPlan(cdp, plan, currentTitle, port) {
  const results = [];
  for (const action of plan) {
    let executed = false;
    if (action.action === 'switch session away and back') {
      executed = await switchAwayAndBack(cdp, currentTitle);
    } else if (action.action === 'wheel verified nested scroller, then outer transcript') {
      executed = (await nestedHandoff(cdp)).passed;
    } else if (action.action.endsWith('on transcript') || action.action === 'key on transcript') {
      executed = await cdp.key('.interactive-list', action.key ?? action.action.split(' ')[0]);
    } else if (action.action === 'PageDown in composer') {
      executed = await cdp.key('[aria-label="Message composer"]', 'PageDown');
    } else if (action.action === 'Space in inline editor') {
      executed = await cdp.click('.user-message-card');
      if (executed) executed = await cdp.key('[contenteditable="true"]', 'Space');
      await cdp.key('[contenteditable="true"]', 'Escape');
    } else if (action.action === 'resize sidebar') {
      await resizeVscodeSidebar(port, action.width ?? 430);
      executed = true;
    } else if (action.action === 'expand disclosure' || action.action === 'collapse disclosure') {
      executed = await cdp.click('.assistant-activity-summary');
    } else if (action.action === 'open file card and diff') {
      executed = await cdp.click('[aria-label^="Expand changes in"]');
    } else if (action.action === 'focus and close diff') {
      executed = await cdp.click('.diff-view-overlay-content, .diff-view-lines');
      if (executed) executed = await cdp.click('[aria-label="Close expanded diff"], [aria-label^="Collapse changes in"]');
    } else if (action.action === 'click sticky or jump to latest') {
      executed =
        (await cdp.click('[data-sticky-msg-id]')) ||
        (await cdp.click('[aria-label="Scroll to latest message"]'));
    } else if (action.action === 'wheel transcript') {
      executed = await cdp.wheel('.interactive-list', action.delta, 'right');
    }
    results.push({ ...action, executed });
    if (!executed) break;
    await new Promise((resolve) => setTimeout(resolve, 34 + (action.pauseFrames ?? 0) * 17));
  }
  return results;
}

async function runLive(options) {
  const manifestPath = path.resolve(required(options, 'manifest'));
  const launchPath = path.resolve(required(options, 'launch'));
  const scenario = options.scenario ?? 'AI-07';
  if (!['AI-07', 'AI-08', 'AI-17'].includes(scenario)) {
    throw new Error('--scenario must be AI-07, AI-08, or AI-17');
  }
  const maxPrompts = Number(options['max-prompts'] ?? DEFAULT_MAX_PROMPTS);
  const timeoutMs = Number(options['gate-timeout-ms'] ?? DEFAULT_GATE_TIMEOUT_MS);
  const restartCount = parseRestartCount(options['restart-count']);
  if (!Number.isInteger(maxPrompts) || maxPrompts < 1 || maxPrompts > 4) {
    throw new Error('--max-prompts must be an integer from 1 through 4');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 15_000 || timeoutMs > 180_000) {
    throw new Error('--gate-timeout-ms must be an integer from 15000 through 180000');
  }
  const [manifest, launch] = await Promise.all([
    readFile(manifestPath, 'utf8').then(JSON.parse),
    readFile(launchPath, 'utf8').then(JSON.parse),
  ]);
  if (path.resolve(launch.workspace) !== path.resolve(manifest.workspace)) {
    throw new Error(`Launch workspace ${launch.workspace} does not match ${manifest.workspace}`);
  }
  if (!manifest.hostPersistenceVerifiedAt) {
    throw new Error('Run verify-run for this manifest after launching the dedicated host');
  }
  const fixture = await fixtureStatus(manifest.workspace);
  if (!fixtureIsSafeForScenario(fixture, manifest, scenario)) {
    throw new Error('The OpenCode fixture is not at the clean recorded baseline');
  }
  const tracked = manifest.runSessions.find((session) => !session.deleted);
  if (!tracked) throw new Error('The manifest has no active run session');
  const client = new OpenCodeClient(manifest.server, manifest.workspace);
  if (scenario === 'AI-17') {
    for (let restart = 0; restart < restartCount; restart += 1) {
      await reloadVscodeWindow(launch.remoteDebuggingPort);
    }
  }
  const cdp = await CdpController.connect(launch.remoteDebuggingPort);
  const attempts = [];
  let best = null;
  try {
    await openRunSession(cdp, tracked.title);
    await cdp.click('[aria-label="Scroll to latest message"]');
    await cdp.key('.interactive-list', 'End');
    if (scenario === 'AI-17') {
      const requestedModel = options.model ?? DEFAULT_MODEL;
      const selectedModel = await cdp.selectModel(modelDisplayName(requestedModel));
      const tokens = [
        ...Array.from({ length: 20 }, (_, index) =>
          `VFZ-DUP-${String(index + 1).padStart(2, '0')}`
        ),
        'VFZ-DUP-END',
      ];
      const marker = `[VFZ:${manifest.seed}:DUP]`;
      const prompt = buildDuplicateDeliveryPrompt(manifest.seed, tokens);
      await cdp.startDuplicateDeliveryObservation(marker, tokens);
      const sent = await cdp.sendComposerPrompt(prompt);
      const sawBusy = sent && (await waitForBusy(client, tracked.id, Math.min(timeoutMs, 15_000)));
      const settled = sawBusy ? await waitForIdle(client, tracked.id, timeoutMs) : false;
      await new Promise((resolve) => setTimeout(resolve, 500));
      const observation = await cdp.finishDuplicateDeliveryObservation();
      let canonicalDelivery;
      try {
        canonicalDelivery = summarizeCanonicalDelivery(
          await client.messages(tracked.id),
          marker,
          tokens
        );
      } catch (error) {
        canonicalDelivery = {
          error: error instanceof Error ? error.message : String(error),
        };
      }
      const failures = sent
        ? duplicateDeliveryFailures(observation, sawBusy)
        : ['native composer input was unavailable'];
      if (!settled) failures.push('model stream did not settle');
      if (canonicalDelivery.error) failures.push('canonical session messages could not be read');
      const fixtureAfterPreparation = await fixtureStatus(manifest.workspace);
      if (
        fixtureAfterPreparation.status !== fixture.status ||
        fixtureAfterPreparation.commit !== fixture.commit
      ) {
        failures.push('controlled stream changed the repository fixture');
      }
      const result = {
        scenario,
        restartCount,
        prepared: failures.length === 0,
        prompt,
        model: requestedModel,
        selectedModel,
        sent,
        sawBusy,
        settled,
        observation,
        canonicalDelivery,
        failures,
        fixtureAfterPreparation,
      };
      manifest.livePreparation ??= {};
      manifest.livePreparation[scenario] = { ...result, recordedAt: new Date().toISOString() };
      await writeJsonAtomic(manifestPath, manifest);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      if (failures.length > 0) {
        throw new Error(`AI-17 failed: ${failures.join('; ')}`);
      }
      return;
    }
    for (let attempt = 1; attempt <= maxPrompts; attempt += 1) {
      const idleDeadline = Date.now() + timeoutMs;
      while (await client.isBusy(tracked.id)) {
        if (Date.now() >= idleDeadline) {
          throw new Error(
            `Existing stream did not settle within ${String(timeoutMs)}ms; it was left running for controller-session safety`
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      const missing = best?.missing ?? [];
      const prompt = buildLivePrompt({ seed: manifest.seed, attempt, missing });
      await client.send(tracked.id, prompt, parseModel(options.model ?? DEFAULT_MODEL));
      const gate = await waitForLiveGate({
        client,
        cdp,
        sessionId: tracked.id,
        scenario,
        timeoutMs,
      });
      best = gate;
      attempts.push({ attempt, prompt, missingAfterAttempt: gate.missing, snapshot: gate.snapshot });
      if (gate.missing.length === 0) break;
    }

    let handoff = null;
    let actions = [];
    if (best?.missing.length === 0) {
      handoff = await nestedHandoff(cdp);
      if (scenario === 'AI-08' && handoff.passed) {
        actions = await executeActionPlan(
          cdp,
          manifest.actionPlan,
          tracked.title,
          launch.remoteDebuggingPort
        );
      }
    }
    const settled = await waitForIdle(client, tracked.id, timeoutMs);
    const fixtureAfterPreparation = await fixtureStatus(manifest.workspace);
    const actionFailure = actions.find((action) => !action.executed);
    const result = {
      scenario,
      prepared: best?.missing.length === 0 && handoff?.passed === true && !actionFailure,
      attempts,
      handoff,
      actions,
      terminalMissing: best?.missing ?? ['live gate was not sampled'],
      actionFailure: actionFailure ?? null,
      settled,
      fixtureAfterPreparation,
    };
    manifest.livePreparation ??= {};
    manifest.livePreparation[scenario] = { ...result, recordedAt: new Date().toISOString() };
    await writeJsonAtomic(manifestPath, manifest);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.prepared) {
      const reason = actionFailure
        ? `native action ${String(actionFailure.step)} (${actionFailure.action}) was unavailable`
        : `missing ${result.terminalMissing.join(', ')}`;
      throw new Error(
        `${scenario} preparation exhausted ${String(attempts.length)}/${String(maxPrompts)} prompt attempts: ${reason}`
      );
    }
    if (!settled) {
      throw new Error(
        `${scenario} actions ran, but the stream did not settle within ${String(timeoutMs)}ms; changed paths were recorded and the stream was left running`
      );
    }
  } finally {
    cdp.close();
  }
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command === 'run') return runLive(options);
  throw new Error(
    'Usage: ai-fuzzy-live.mjs run --manifest <path> --launch <path> --scenario AI-07|AI-08|AI-17'
  );
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
