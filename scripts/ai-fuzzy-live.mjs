import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  createCdpRequestClient,
  executeVscodeCommand,
  reloadVscodeWindow,
  resizeVscodeSidebar,
  verifyVscodeLaunchIdentity,
} from './vscode-launch-process.mjs';
import { requireFixtureWorkspace } from './ai-fuzzy-preconditions.mjs';

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

export function validateLiveModel(value) {
  if (!['openai/gpt-5.6-luna', 'openai/gpt-5.6-terra'].includes(value)) {
    throw new Error('--model must be openai/gpt-5.6-luna or openai/gpt-5.6-terra');
  }
  return value;
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
  if (!['AI-08', 'AI-18', 'AI-19'].includes(scenario)) return !fixture.status;
  const preparedFixture = manifest.livePreparation?.['AI-07']?.fixtureAfterPreparation;
  if (manifest.livePreparation?.['AI-07']?.prepared !== true) return false;
  return (
    preparedFixture?.commit === fixture.commit &&
    preparedFixture?.status === fixture.status &&
    JSON.stringify(preparedFixture?.changedPaths ?? []) ===
      JSON.stringify(fixture.changedPaths ?? []) &&
    (preparedFixture?.contentHash === undefined ||
      preparedFixture.contentHash === fixture.contentHash)
  );
}

export function missingLiveGates(snapshot, scenario) {
  const missing = [];
  if (!snapshot.virtualized) missing.push('virtualized transcript');
  if (!snapshot.busy) missing.push('active model stream');
  if (!snapshot.stickyMessageId) missing.push('sticky latest prompt');
  if (!snapshot.fileEdit) missing.push('file edit or diff');
  if (!snapshot.disclosure) missing.push('expandable activity disclosure');
  if (scenario === 'AI-08' && !snapshot.diffControl) missing.push('expandable diff control');
  return missing;
}

export function shouldRetryNestedHandoff(handoff) {
  if (handoff?.passed || !handoff?.before || !handoff?.afterNested) return false;
  const beforeNested = handoff.before.nestedActivityScroller;
  const afterNested = handoff.afterNested.nestedActivityScroller;
  return (
    handoff.before.activeActivityCount !== handoff.afterNested.activeActivityCount ||
    Math.abs(handoff.before.transcript.scrollHeight - handoff.afterNested.transcript.scrollHeight) >
      0.5 ||
    Math.abs((beforeNested?.scrollHeight ?? 0) - (afterNested?.scrollHeight ?? 0)) > 0.5 ||
    Math.abs((beforeNested?.clientHeight ?? 0) - (afterNested?.clientHeight ?? 0)) > 0.5
  );
}

export function shouldRetryAi08WithFreshStream(actionFailure, attempt, maxPrompts) {
  return actionFailure?.reason === 'model stream settled' && attempt < maxPrompts;
}

export function buildLivePrompt({ seed, scenario = 'AI-07', promptRun = 1, attempt, missing = [] }) {
  const marker = `[VFZ:${seed}:${scenario}:R${String(promptRun)}:TOOLS-A${String(attempt)}]`;
  const missingEmphasis =
    missing.length === 0
      ? ''
      : ` The previous turn missed these gates, so make them especially clear in this turn: ${missing.join(', ')}.`;
  return `${marker} Work only in the current OpenCode repository. This new turn must independently produce the complete live gate; do not assume activity or UI from an earlier turn carries over.${missingEmphasis} Investigate one real, bounded test-coverage or code-quality issue. Inspect the relevant implementation with three to five separate read or search operations, using parallel calls when they are genuinely independent, and retain completed work for an expandable Explored disclosure. Make the smallest justified change in one to three existing source or test files, inspect the resulting expandable diff, and run a focused test plus any broader check warranted by the change. Use bounded timeouts and no watch mode. Produce enough reasoning and tool activity for this prompt to move above the viewport. Do not use sleep, no-op commands, duplicate status commands, or deliberately slow work to keep tools visible. Keep a todo list and brief reasoning between groups. Do not write final prose until verification completes. Do not spawn, delegate to, or otherwise use subagents. Finish with VFZ-TOOLS-END. Do not commit, change branches, install dependencies, generate dependency trees, touch files outside this repository, or undo existing work.`;
}

export function buildDuplicateDeliveryPrompt(seed, tokens, promptRun = 1) {
  return `[VFZ:${seed}:AI-17:R${String(promptRun)}:DUP] Respond with only these tokens, one per line, exactly once each, in this order:\n${tokens.join('\n')}\nDo not repeat, quote, explain, use tools, spawn subagents, or delegate work.`;
}

export function classifyPromptDisposition(messages, queueItems, marker) {
  const userIds = messages
    .filter(
      (entry) =>
        entry?.info?.role === 'user' &&
        entry.parts?.some((part) => part?.type === 'text' && part.text?.includes(marker))
    )
    .map((entry) => entry.info.id);
  const queuedItemIds = queueItems
    .filter((item) => item?.text?.includes(marker))
    .map((item) => item.id)
    .filter(Boolean);
  const status =
    userIds.length > 0 && queuedItemIds.length > 0
      ? 'admitted-and-queued'
      : userIds.length > 0
        ? 'admitted'
        : queuedItemIds.length > 0
          ? 'queued'
          : 'unobserved';
  return { status, userIds, queuedItemIds };
}

export function duplicateDeliveryFailures(observation, sawBusy) {
  const failures = [];
  if (!sawBusy) failures.push('active model stream was not observed');
  if (!observation?.userSeen) failures.push('sent user prompt was not observed');
  if (!observation?.assistantSeen) failures.push('assistant stream was not observed');
  if (!observation?.tokenSeen?.every(Boolean)) failures.push('not every required stream token was observed');
  if ((observation?.maxUserRows ?? 0) > 1) failures.push('sent user prompt rendered more than once');
  if ((observation?.maxAssistantRows ?? 0) > 1) failures.push('assistant response rendered in multiple rows');
  if ((observation?.maxRawAssistantRows ?? 0) > 1) {
    failures.push('assistant response occupied multiple raw rows');
  }
  if (observation?.maxTokenCounts?.some((count) => count > 1)) {
    failures.push('a streamed token rendered more than once');
  }
  return failures;
}

export function canonicalDeliveryFailures(summary) {
  const failures = [];
  if ((summary?.markedUsers?.length ?? 0) !== 1) {
    failures.push('canonical transcript did not contain exactly one marked user');
  }
  if ((summary?.assistants?.length ?? 0) !== 1) {
    failures.push('canonical transcript did not contain exactly one linked assistant');
  }
  const assistant = summary?.assistants?.[0];
  if (assistant && (!assistant.completed || assistant.finish !== 'stop')) {
    failures.push('linked assistant did not have an accepted completed finish');
  }
  if (assistant?.error) failures.push('linked assistant contained an error');
  if (summary?.tokenCounts?.some((count) => count !== 1)) {
    failures.push('canonical response did not contain every required token exactly once');
  }
  if (summary && summary.tokensInOrder !== true) {
    failures.push('canonical response tokens were not in the required order');
  }
  return failures;
}

export function summarizeCanonicalDelivery(messages, marker, tokens) {
  const markedUsers = messages.filter(
    (entry) =>
      entry?.info?.role === 'user' &&
      entry.parts?.some((part) => part?.type === 'text' && part.text?.includes(marker))
  );
  const user = markedUsers.length === 1 ? markedUsers[0] : null;
  const assistants = user
    ? messages
        .filter(
          (entry) => entry?.info?.role === 'assistant' && entry.info.parentID === user.info.id
        )
        .map((entry) => ({
          id: entry.info.id,
          parentID: entry.info.parentID,
          providerID: entry.info.providerID ?? null,
          modelID: entry.info.modelID ?? null,
          finish: entry.info.finish ?? null,
          completed: Number.isFinite(entry.info.time?.completed),
          error: entry.info.error ?? null,
          text: entry.parts
            .filter((part) => part?.type === 'text' || part?.type === 'reasoning')
            .map((part) => part.text ?? '')
            .join('\n'),
        }))
    : [];
  const combinedText = assistants.length === 1 ? assistants[0].text : '';
  const tokenCounts = tokens.map((token) => combinedText.split(token).length - 1);
  const tokenOffsets = tokens.map((token) => combinedText.indexOf(token));
  return {
    markedUsers: markedUsers.map((entry) => ({ id: entry.info.id })),
    user: user ? { id: user.info.id } : null,
    assistants,
    tokenCounts,
    tokenOffsets,
    tokensInOrder:
      tokenOffsets.every((offset) => offset >= 0) &&
      tokenOffsets.every((offset, index) => index === 0 || offset > tokenOffsets[index - 1]),
  };
}

export function promptModelFailures(messages, markers, requestedModel) {
  const requested = parseModel(requestedModel);
  const failures = [];
  const observations = [];
  for (const marker of markers) {
    const users = messages.filter(
      (entry) =>
        entry?.info?.role === 'user' &&
        entry.parts?.some((part) => part?.type === 'text' && part.text?.includes(marker))
    );
    const assistants =
      users.length === 1
        ? messages.filter(
            (entry) =>
              entry?.info?.role === 'assistant' && entry.info.parentID === users[0].info.id
          )
        : [];
    const observed = assistants.map((entry) => ({
      id: entry.info.id,
      providerID: entry.info.providerID ?? null,
      modelID: entry.info.modelID ?? null,
    }));
    observations.push({ marker, observed });
    if (
      observed.length === 0 ||
      observed.some(
        (entry) =>
          entry.providerID !== requested.providerID || entry.modelID !== requested.modelID
      )
    ) {
      failures.push(`assistant model for ${marker} was not ${requestedModel}`);
    }
  }
  return { observations, failures };
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
        rawAssistantRows.length > 1 ||
        tokenCounts.some((count) => count > 1)
      )) {
        observation.firstViolation = {
          frame: observation.frames,
          userRows: userRows.length,
          assistantRows: assistantRows.length,
          rawAssistantRows: rawAssistantRows.length,
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

  listSessions() {
    return this.request('GET', '/session?limit=1000').then((result) =>
      Array.isArray(result) ? result : (result?.items ?? [])
    );
  }

  async pendingInput(sessionId) {
    const [permissions, questions] = await Promise.all([
      this.request('GET', '/permission'),
      this.request('GET', '/question'),
    ]);
    return {
      permissions: (Array.isArray(permissions) ? permissions : []).filter(
        (request) => request?.sessionID === sessionId
      ),
      questions: (Array.isArray(questions) ? questions : []).filter(
        (request) => request?.sessionID === sessionId
      ),
    };
  }
}

function describeTarget(descriptor) {
  const context = descriptor.context;
  const route = descriptor.route;
  return `${descriptor.id} (${context?.surface ?? 'unknown'}/${context?.viewId ?? 'unknown'}, ${route?.type === 'session' ? `session ${route.sessionId}` : (route?.type ?? 'unknown')})`;
}

export function selectVarroTargetDescriptor(descriptors, requested) {
  const viable = descriptors.filter((descriptor) => !descriptor.error && descriptor.context);
  const matching = viable.filter((descriptor) => {
    if (requested.surface && descriptor.context.surface !== requested.surface) return false;
    if (requested.viewId && descriptor.context.viewId !== requested.viewId) return false;
    if (
      requested.sessionId &&
      !requested.allowSessionNavigation &&
      (descriptor.route?.type !== 'session' || descriptor.route.sessionId !== requested.sessionId)
    ) {
      return false;
    }
    return true;
  });
  if (matching.length === 1) return matching[0];
  const inspected = descriptors.map(describeTarget).join(', ') || 'none';
  const wanted = [
    requested.surface ? `surface=${requested.surface}` : null,
    requested.viewId ? `viewId=${requested.viewId}` : null,
    requested.sessionId ? `session=${requested.sessionId}` : null,
  ]
    .filter(Boolean)
    .join(', ');
  if (matching.length === 0) {
    throw new Error(`No Varro iframe matched ${wanted || 'the requested target'}; inspected: ${inspected}`);
  }
  throw new Error(
    `Varro iframe target is ambiguous for ${wanted || 'the requested target'}; matches: ${matching.map(describeTarget).join(', ')}`
  );
}

function getContentFrameId(frameTree) {
  const children = frameTree?.frameTree?.childFrames ?? [];
  return children[0]?.frame?.id ?? null;
}

async function inspectVarroTarget(port, target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  const controller = new CdpController(port, socket, null, null, target.id);
  try {
    const tree = await controller.call('Page.getFrameTree');
    const frameId = getContentFrameId(tree);
    if (!frameId) throw new Error('content frame is unavailable');
    const contexts = [];
    const contextListener = (event) => {
      const message = JSON.parse(event.data);
      if (message.method === 'Runtime.executionContextCreated') {
        contexts.push(message.params.context);
      }
    };
    socket.addEventListener('message', contextListener);
    await controller.call('Runtime.enable');
    socket.removeEventListener('message', contextListener);
    const mainContext = contexts.find(
      (context) =>
        context.auxData?.frameId === frameId && context.auxData?.isDefault === true
    );
    if (!mainContext) throw new Error('default content execution context is unavailable');
    controller.mainContextId = mainContext.id;
    const inspected = await controller.call('Runtime.evaluate', {
      contextId: mainContext.id,
      expression: `(() => {
        const context = globalThis.__initialWebviewState?.webviewContext ?? null;
        let persisted = null;
        try {
          persisted = globalThis.__vscodeWebviewState?.getState?.()?.['varro.lastOpenedView'] ?? null;
        } catch {}
        if (!persisted) {
          try {
            const raw = localStorage.getItem('varro.lastOpenedView');
            persisted = raw ? JSON.parse(raw) : null;
          } catch {}
        }
        const route = persisted?.type === 'session' && typeof persisted.sessionId === 'string'
          ? { type: 'session', sessionId: persisted.sessionId }
          : context?.initialRoute ?? null;
        return { context, route, title: document.body.innerText.split('\\n')[0] ?? '' };
      })()`,
      returnByValue: true,
    });
    if (inspected.exceptionDetails) {
      throw new Error(
        inspected.exceptionDetails.exception?.description ?? inspected.exceptionDetails.text
      );
    }
    const world = await controller.call('Page.createIsolatedWorld', {
      frameId,
      worldName: `varro-ai-fuzzy-${String(Date.now())}`,
      grantUniveralAccess: true,
    });
    controller.contextId = world.executionContextId;
    controller.frameId = frameId;
    controller.targetContext = inspected.result.value?.context ?? null;
    return {
      id: target.id,
      url: target.url,
      context: inspected.result.value?.context ?? null,
      route: inspected.result.value?.route ?? null,
      title: inspected.result.value?.title ?? '',
      controller,
    };
  } catch (error) {
    controller.close();
    throw error;
  }
}

export function findSessionDescendants(sessions, rootSessionId) {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  return sessions.filter((session) => {
    const visited = new Set();
    let parentId = session.parentID;
    while (parentId && !visited.has(parentId)) {
      if (parentId === rootSessionId) return true;
      visited.add(parentId);
      parentId = byId.get(parentId)?.parentID;
    }
    return false;
  });
}

export function inventoryVerifiedDescendants(
  manifest,
  sessions,
  rootSessionId,
  descendantsBefore,
  createdBy
) {
  const observed = findSessionDescendants(sessions, rootSessionId).filter(
    (session) => !descendantsBefore.has(session.id)
  );
  const trackedIds = new Set(manifest.runSessions.map((session) => session.id));
  const recorded = [];
  for (const session of observed) {
    if (trackedIds.has(session.id)) continue;
    const entry = {
      id: session.id,
      title: session.title ?? session.id,
      parentID: session.parentID,
      rootSessionId,
      deleted: false,
      createdBy,
    };
    manifest.runSessions.push(entry);
    trackedIds.add(session.id);
    recorded.push(entry);
  }
  return { observed, recorded };
}

class CdpController {
  constructor(port, socket, contextId, frameId = null, targetId = null) {
    this.port = port;
    this.socket = socket;
    this.contextId = contextId;
    this.frameId = frameId;
    this.targetId = targetId;
    this.targetContext = null;
    this.mainContextId = null;
    this.requests = createCdpRequestClient(socket, 20_000);
  }

  static async connect(port, requested = {}, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        const targets = await fetch(`http://127.0.0.1:${String(port)}/json/list`).then((response) =>
          response.json()
        );
        const matchingTargets = targets.filter(
          (item) => item.type === 'iframe' && item.url.includes('extensionId=koltyakov.varro')
        );
        if (matchingTargets.length === 0) {
          throw new Error('The tracked host has no Varro iframe target');
        }
        const descriptors = await Promise.all(
          matchingTargets.map(async (target) => {
            try {
              return await inspectVarroTarget(port, target);
            } catch (error) {
              return {
                id: target.id,
                url: target.url,
                context: null,
                route: null,
                error: error instanceof Error ? error.message : String(error),
              };
            }
          })
        );
        let selected;
        try {
          selected = selectVarroTargetDescriptor(descriptors, requested);
        } catch (error) {
          for (const descriptor of descriptors) descriptor.controller?.close();
          throw error;
        }
        for (const descriptor of descriptors) {
          if (descriptor !== selected) descriptor.controller?.close();
        }
        return selected.controller;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    throw new Error(
      `Could not connect to the recreated Varro content frame: ${lastError instanceof Error ? lastError.message : String(lastError)}`
    );
  }

  call(method, params = {}) {
    return this.requests.call(method, params);
  }

  async evaluate(expression) {
    let result;
    try {
      result = await this.evaluateInCurrentContext(expression);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !/Cannot find context|Execution context was destroyed|Session closed|Target closed|CDP (?:request client is closed|socket (?:closed|failed))/i.test(
          error.message
        )
      ) {
        throw error;
      }
      await this.rebind();
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

  async rebind() {
    const viewId = this.targetContext?.viewId;
    if (!viewId) throw new Error('Cannot rebind a Varro iframe without a stable viewId');
    const rebound = await CdpController.connect(this.port, { viewId }, 20_000);
    this.requests.dispose();
    this.socket.close();
    this.socket = rebound.socket;
    this.requests = rebound.requests;
    this.contextId = rebound.contextId;
    this.mainContextId = rebound.mainContextId;
    this.frameId = rebound.frameId;
    this.targetId = rebound.targetId;
    this.targetContext = rebound.targetContext;
  }

  async snapshot(marker = '') {
    const snapshot = await this.evaluate(`(() => {
      const transcript = document.querySelector('.interactive-list');
      const marker = ${JSON.stringify(marker)};
      const visible = (element) => {
        if (!element) return false;
        const rect = element.getBoundingClientRect();
        return rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth;
      };
      const rows = [...document.querySelectorAll('[data-msg-id]')];
      const markerRow = marker
        ? rows.find((row) => row.querySelector('.user-message-card')?.innerText.includes(marker)) ?? null
        : null;
      const markerIndex = markerRow ? rows.indexOf(markerRow) : -1;
      const turnRows = [];
      for (let index = markerIndex < 0 ? 0 : markerIndex; index < rows.length; index += 1) {
        const row = rows[index];
        if (markerIndex >= 0 && index > markerIndex && row.querySelector('.user-message-card')) break;
        turnRows.push(row);
      }
      const queryAll = (selector) => marker
        ? turnRows.flatMap((row) => [...row.querySelectorAll(selector)])
        : [...document.querySelectorAll(selector)];
      const firstVisible = (selector) => queryAll(selector).find(visible) ?? null;
      const nested = firstVisible('.assistant-active-activity-items');
      const nestedStyle = nested ? getComputedStyle(nested) : null;
      const stickyMessageId = document.querySelector('[data-sticky-msg-id]')?.getAttribute('data-sticky-msg-id') ?? null;
      const markerMessageId = markerRow?.getAttribute('data-msg-id') ?? null;
      return {
        title:
          document.querySelector('.chat-header-title-text')?.textContent?.trim() ||
          document.body.innerText.split('\\n')[0] ||
          '',
        virtualized: !!document.querySelector('.interactive-list-track.virtualized'),
        transcript: transcript ? {
          scrollTop: transcript.scrollTop,
          scrollHeight: transcript.scrollHeight,
          clientHeight: transcript.clientHeight,
        } : null,
        markerMessageId,
        turnMessageIds: turnRows.map((row) => row.getAttribute('data-msg-id')).filter(Boolean),
        turnPartIds: [...new Set(queryAll('[data-activity-part-id]').map((element) =>
          element.getAttribute('data-activity-part-id')
        ).filter(Boolean))],
        turnRenderKeys: [...new Set(queryAll('[data-assistant-render-key]').map((element) =>
          element.getAttribute('data-assistant-render-key')
        ).filter(Boolean))],
        stickyMessageId: marker && stickyMessageId !== markerMessageId ? null : stickyMessageId,
        activeActivityCount: queryAll('.assistant-active-activity-item').length,
        nestedActivityScroller: nested ? {
          scrollTop: nested.scrollTop,
          scrollHeight: nested.scrollHeight,
          clientHeight: nested.clientHeight,
          overflowY: nestedStyle?.overflowY ?? '',
          hasRange: ['auto', 'scroll'].includes(nestedStyle?.overflowY ?? '') && nested.scrollHeight > nested.clientHeight + 1,
        } : null,
        fileEdit: queryAll('.file-change-card, .file-change-inline-diffs, .diff-summary, .diff-view-file').length > 0,
        disclosure: queryAll('.assistant-activity-summary').length > 0,
        diffControl: queryAll('[aria-label^="Expand changes in"], [aria-label^="Collapse changes in"]').length > 0,
        jumpToLatest: !!document.querySelector('[aria-label="Scroll to latest message"]'),
      };
    })()`);
    if (!this.mainContextId) throw new Error('default content execution context is unavailable');
    const route = await this.call('Runtime.evaluate', {
      contextId: this.mainContextId,
      expression: `(() => {
        const persisted = globalThis.__vscodeWebviewState?.getState?.()?.['varro.lastOpenedView'] ?? null;
        return persisted?.type === 'session' ? persisted.sessionId ?? null : null;
      })()`,
      returnByValue: true,
    });
    if (route.exceptionDetails) {
      throw new Error(route.exceptionDetails.exception?.description ?? route.exceptionDetails.text);
    }
    return { ...snapshot, routeSessionId: route.result.value ?? null };
  }

  async point(selector, edge = 'center', scope = null) {
    for (let attempt = 0; attempt < 24; attempt += 1) {
      const result = await this.evaluate(`(() => {
        const scope = ${JSON.stringify(scope)};
        const elements = [...document.querySelectorAll(${JSON.stringify(selector)})].filter((element) => {
          if (!scope?.messageIds?.length) return true;
          const messageId = element.closest('[data-msg-id]')?.getAttribute('data-msg-id');
          return messageId && scope.messageIds.includes(messageId);
        });
        const visibleElement = elements.find((candidate) => {
          const rect = candidate.getBoundingClientRect();
          const transcript = candidate.closest('.interactive-list')?.getBoundingClientRect();
          const top = Math.max(0, transcript?.top ?? 0);
          const bottom = Math.min(innerHeight, transcript?.bottom ?? innerHeight);
          return rect.bottom > top && rect.top < bottom && rect.right > 0 && rect.left < innerWidth;
        });
        const element = visibleElement ?? elements.toSorted((left, right) => {
          const distance = (candidate) => {
            const rect = candidate.getBoundingClientRect();
            if (rect.bottom < 0) return -rect.bottom;
            if (rect.top > innerHeight) return rect.top - innerHeight;
            return 0;
          };
          return distance(left) - distance(right);
        })[0];
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        const transcript = element.closest('.interactive-list')?.getBoundingClientRect();
        const visibleTop = Math.max(0, transcript?.top ?? 0, rect.top);
        const visibleBottom = Math.min(innerHeight, transcript?.bottom ?? innerHeight, rect.bottom);
        const visible = visibleBottom > visibleTop && rect.right > 0 && rect.left < innerWidth;
        const point = ${
          edge === 'safe'
            ? `(() => {
                const left = Math.max(0, rect.left) + 8;
                const right = Math.min(innerWidth, rect.right) - 20;
                const top = visibleTop + 8;
                const bottom = visibleBottom - 8;
                if (right <= left || bottom <= top) return null;
                const controls = 'button, a, input, textarea, select, summary, [role="button"], [contenteditable="true"], [tabindex]';
                const xs = [left, right, (left + right) / 2];
                const ys = [(top + bottom) / 2, top, bottom, top + (bottom - top) / 4, bottom - (bottom - top) / 4];
                for (const x of xs) {
                  for (const y of ys) {
                    const target = document.elementFromPoint(x, y);
                    if (!target || !element.contains(target)) continue;
                    const control = target.closest(controls);
                    if (control && control !== element) continue;
                    return { x, y };
                  }
                }
                return null;
              })()`
            : `{ x: ${edge === 'right' ? 'rect.right - 6' : 'rect.x + rect.width / 2'}, y: (visibleTop + visibleBottom) / 2 }`
        };
        if (!point) return null;
        const hit = document.elementFromPoint(point.x, point.y);
        const pointVisible = visible && !!hit && (hit === element || element.contains(hit));
        return {
          visible: pointVisible,
          ...point,
          direction:
            rect.top < (transcript?.top ?? 0) ||
            (!pointVisible && point.y < ((transcript?.top ?? 0) + (transcript?.bottom ?? innerHeight)) / 2)
              ? -1
              : 1,
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

  async click(selector, scope = null, edge = 'center') {
    const point = await this.point(selector, edge, scope);
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

  async contextClick(selector, scope = null) {
    const point = await this.point(selector, 'center', scope);
    if (!point) return false;
    for (const [type, buttons] of [
      ['mousePressed', 2],
      ['mouseReleased', 0],
    ]) {
      await this.call('Input.dispatchMouseEvent', {
        type,
        ...point,
        button: 'right',
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

  async clickSession(sessionId) {
    const point = await this.evaluate(`(() => {
      const sessionId = ${JSON.stringify(sessionId)};
      const row = [...document.querySelectorAll('.session-item')].find(
        (candidate) => candidate.getAttribute('data-session-id') === sessionId
      );
      const control = row?.querySelector('.session-item-main');
      if (!control) return null;
      const rect = control.getBoundingClientRect();
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
    await new Promise((resolve) => setTimeout(resolve, 100));
    if ((await this.snapshot()).routeSessionId === sessionId) return true;

    await executeVscodeCommand(this.port, 'View: Focus Secondary Side Bar');
    await this.refreshContext();
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const focused = await this.evaluate(`(() => {
        const active = document.activeElement;
        return active?.classList.contains('session-item-main') === true &&
          active.closest('.session-item')?.getAttribute('data-session-id') === ${JSON.stringify(sessionId)};
      })()`);
      if (focused) {
        await this.key('', 'Enter');
        return true;
      }
      await this.key('', 'Tab');
    }
    return false;
  }

  async altClickSession(title) {
    const point = await this.evaluate(`(() => {
      const title = ${JSON.stringify(title)};
      const text = [...document.querySelectorAll('.session-item-title-text')].find(
        (element) => element.textContent?.trim() === title
      );
      const row = text?.closest('.session-item');
      if (!row) return null;
      const rect = row.getBoundingClientRect();
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
        modifiers: 1,
        clickCount: 1,
      });
    }
    return true;
  }

  async clickSessionControl(sessionId, selector) {
    const point = await this.evaluate(`(() => {
      const sessionId = ${JSON.stringify(sessionId)};
      const row = [...document.querySelectorAll('.session-item')].find(
        (candidate) => candidate.getAttribute('data-session-id') === sessionId
      );
      const control = row?.querySelector(${JSON.stringify(selector)});
      if (!control) return null;
      const rect = control.getBoundingClientRect();
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

  async clickQueueControl(itemId, label) {
    const point = await this.evaluate(`(() => {
      const itemId = ${JSON.stringify(itemId)};
      const label = ${JSON.stringify(label)};
      const row = [...document.querySelectorAll('[data-queued-message-id]')].find(
        (candidate) => candidate.getAttribute('data-queued-message-id') === itemId
      );
      const control = [...(row?.querySelectorAll('button') ?? [])].find(
        (button) => button.getAttribute('aria-label') === label
      );
      if (!control || control.disabled || control.hidden) return null;
      const rect = control.getBoundingClientRect();
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
    await new Promise((resolve) => setTimeout(resolve, 100));
    const remainsActionable = () =>
      this.evaluate(`(() => {
        const row = [...document.querySelectorAll('[data-queued-message-id]')].find(
          (candidate) => candidate.getAttribute('data-queued-message-id') === ${JSON.stringify(itemId)}
        );
        const control = [...(row?.querySelectorAll('button') ?? [])].find(
          (button) => button.getAttribute('aria-label') === ${JSON.stringify(label)}
        );
        return !!control && !control.disabled && !control.hidden;
      })()`);
    if (!(await remainsActionable())) return true;

    if (
      !(await this.evaluate('document.hasFocus()')) &&
      this.targetContext?.surface === 'sidebar'
    ) {
      await executeVscodeCommand(this.port, 'View: Focus Secondary Side Bar');
      await this.refreshContext();
    }
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const focused = await this.evaluate(`(() => {
        const active = document.activeElement;
        return active?.getAttribute('aria-label') === ${JSON.stringify(label)} &&
          active.closest('[data-queued-message-id]')?.getAttribute('data-queued-message-id') === ${JSON.stringify(itemId)};
      })()`);
      if (focused) {
        await this.key('', 'Space');
        await new Promise((resolve) => setTimeout(resolve, 100));
        return !(await remainsActionable());
      }
      await this.key('', 'Tab');
    }
    return false;
  }

  readQueueRow(itemId) {
    return this.evaluate(`(() => {
      const itemId = ${JSON.stringify(itemId)};
      const row = [...document.querySelectorAll('[data-queued-message-id]')].find(
        (candidate) => candidate.getAttribute('data-queued-message-id') === itemId
      );
      if (!row) return null;
      return {
        id: itemId,
        ownerViewId: row.getAttribute('data-queued-message-owner'),
        sessionId: row.getAttribute('data-queued-message-session-id'),
        paused: !!row.querySelector('[aria-label="Play queued message"]'),
        editing: row.classList.contains('is-editing'),
        text: row.textContent ?? '',
      };
    })()`);
  }

  readComposerText() {
    return this.evaluate(
      `document.querySelector('[aria-label="Message composer"]')?.textContent ?? ''`
    );
  }

  isDocumentVisible() {
    return this.evaluate(`document.visibilityState === 'visible'`);
  }

  async wheel(selector, delta, edge = 'center', scope = null) {
    const point = await this.point(selector, edge, scope);
    if (!point) return false;
    await this.call('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      ...point,
      deltaX: 0,
      deltaY: delta,
    });
    return true;
  }

  async key(selector, key, scope = null) {
    if (
      selector &&
      !(await this.click(
        selector,
        scope,
        selector === '.interactive-list' || selector === '.session-list-view' ? 'safe' : 'center'
      ))
    ) {
      return false;
    }
    const shifted = key === 'Shift+Space';
    const normalized = shifted ? ' ' : key === 'Space' ? ' ' : key;
    const code = shifted || key === 'Space' ? 'Space' : key;
    const virtualKeyCode =
      normalized === 'Enter' ? 13 : normalized === 'Tab' ? 9 : normalized === ' ' ? 32 : undefined;
    for (const type of ['keyDown', 'keyUp']) {
      const event = {
        type,
        key: normalized,
        code,
        modifiers: shifted ? 8 : 0,
      };
      if (virtualKeyCode !== undefined) {
        event.windowsVirtualKeyCode = virtualKeyCode;
        event.nativeVirtualKeyCode = virtualKeyCode;
      }
      await this.call('Input.dispatchKeyEvent', event);
    }
    return true;
  }

  async sendComposerPrompt(prompt) {
    if (!(await this.click('[aria-label="Message composer"]'))) return false;
    const selectAllModifier = process.platform === 'darwin' ? 4 : 2;
    for (const type of ['keyDown', 'keyUp']) {
      await this.call('Input.dispatchKeyEvent', {
        type,
        key: 'a',
        code: 'KeyA',
        modifiers: selectAllModifier,
      });
    }
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

  async selectExactModel(value) {
    const { providerID, modelID } = parseModel(value);
    const buttonSelector = `.model-picker-item[data-provider-id=${JSON.stringify(providerID)}][data-model-id=${JSON.stringify(modelID)}]`;
    const current = await this.evaluate(`(() => {
      const button = document.querySelector('.model-picker-btn');
      return button ? {
        providerID: button.getAttribute('data-provider-id'),
        modelID: button.getAttribute('data-model-id'),
      } : null;
    })()`);
    if (current?.providerID === providerID && current?.modelID === modelID) return current;
    const modelButton = await this.evaluate(`document.querySelector('.model-picker-btn')?.getAttribute('aria-label') ?? null`);
    if (!modelButton || !(await this.click('.model-picker-btn'))) {
      throw new Error('The current composer model control is unavailable');
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (!(await this.click(buttonSelector))) {
      throw new Error(`Model ${value} is not visible in the picker`);
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    const selected = await this.evaluate(`(() => {
      const button = document.querySelector('.model-picker-btn');
      return button ? {
        providerID: button.getAttribute('data-provider-id'),
        modelID: button.getAttribute('data-model-id'),
      } : null;
    })()`);
    if (selected?.providerID !== providerID || selected?.modelID !== modelID) {
      throw new Error(`Model selection did not resolve to ${value}`);
    }
    return selected;
  }

  async selectPermissionMode(mode) {
    const current = await this.evaluate(
      `document.querySelector('.permission-mode-button')?.getAttribute('data-permission-mode') ?? null`
    );
    if (current === mode) return current;
    if (!(await this.click('.permission-mode-button'))) {
      throw new Error('The permission mode control is unavailable');
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
    if (!(await this.click(`[data-permission-mode-option=${JSON.stringify(mode)}]`))) {
      throw new Error(`Permission mode ${mode} is unavailable`);
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
    const selected = await this.evaluate(
      `document.querySelector('.permission-mode-button')?.getAttribute('data-permission-mode') ?? null`
    );
    if (selected !== mode) throw new Error(`Permission mode selection remained ${String(selected)}`);
    return selected;
  }

  readComposerConfiguration() {
    return this.evaluate(`(() => {
      const model = document.querySelector('.model-picker-btn');
      return {
        model: model ? {
          providerID: model.getAttribute('data-provider-id'),
          modelID: model.getAttribute('data-model-id'),
        } : null,
        permissionMode: document.querySelector('.permission-mode-button')?.getAttribute('data-permission-mode') ?? null,
      };
    })()`);
  }

  captureActionState(scope = null) {
    return this.evaluate(`(() => {
      const scope = ${JSON.stringify(scope)};
      const transcript = document.querySelector('.interactive-list');
      const scoped = (selector) => [...document.querySelectorAll(selector)].filter((element) => {
        if (!scope?.messageIds?.length) return true;
        const messageId = element.closest('[data-msg-id]')?.getAttribute('data-msg-id');
        return messageId && scope.messageIds.includes(messageId);
      });
      const identity = (element) => ({
        messageId: element.closest('[data-msg-id]')?.getAttribute('data-msg-id') ?? null,
        renderKey: element.closest('[data-assistant-render-key]')?.getAttribute('data-assistant-render-key') ?? null,
        partId: element.closest('[data-activity-part-id]')?.getAttribute('data-activity-part-id') ?? null,
      });
      const active = document.activeElement;
      const focusOwner = active?.closest?.('[aria-label="Message composer"]')
        ? 'composer'
        : active?.matches?.('[aria-label^="Collapse changes in"]') ||
            active?.closest?.('.diff-view-overlay-content, .diff-view-lines, .file-change-inline-diffs, .diff-view-file')
          ? 'diff'
          : active?.closest?.('.interactive-list')
            ? 'transcript'
            : active?.tagName?.toLowerCase() ?? 'none';
      const visibleRows = transcript
        ? [...transcript.querySelectorAll('[data-msg-id]')].filter((element) => {
            const row = element.getBoundingClientRect();
            const viewport = transcript.getBoundingClientRect();
            return row.bottom > viewport.top && row.top < viewport.bottom;
          })
        : [];
      const firstVisible = visibleRows[0] ?? null;
      return {
        width: innerWidth,
        focusOwner,
        transcript: transcript ? {
          scrollTop: transcript.scrollTop,
          scrollHeight: transcript.scrollHeight,
          clientHeight: transcript.clientHeight,
          firstVisibleMessageId: firstVisible?.getAttribute('data-msg-id') ?? null,
          firstVisibleTop: firstVisible
            ? firstVisible.getBoundingClientRect().top - transcript.getBoundingClientRect().top
            : null,
          visibleRows: visibleRows.map((element) => ({
            messageId: element.getAttribute('data-msg-id'),
            top: element.getBoundingClientRect().top - transcript.getBoundingClientRect().top,
          })),
        } : null,
        disclosures: scoped('.assistant-activity-summary').map((element) => ({
          ...identity(element),
          key: element.getAttribute('data-activity-summary-group-key'),
          expanded: element.getAttribute('aria-expanded') === 'true',
        })),
        diffs: scoped('[aria-label^="Expand changes in"], [aria-label^="Collapse changes in"]').map((element) => ({
          ...identity(element),
          label: element.getAttribute('aria-label'),
        })),
        expandedDiffCount: scoped('[aria-label^="Collapse changes in"], [aria-label="Close expanded diff"], .diff-view-overlay-content').length,
        queueItems: [...document.querySelectorAll('[data-queued-message-id]')].map((element) => ({
          id: element.getAttribute('data-queued-message-id'),
          ownerViewId: element.getAttribute('data-queued-message-owner'),
          sessionId: element.getAttribute('data-queued-message-session-id'),
          text: element.textContent ?? '',
        })),
        sessionQueueCounts: [...document.querySelectorAll('.session-item[data-session-id]')].map((row) => {
          const counter = row.querySelector('.session-item-queued-counter');
          return {
            sessionId: row.getAttribute('data-session-id'),
            count: Number(counter?.getAttribute('data-queued-message-count') ?? 0),
          };
        }),
      };
    })()`);
  }

  countScoped(selector, scope) {
    return this.evaluate(`(() => {
      const scope = ${JSON.stringify(scope)};
      return [...document.querySelectorAll(${JSON.stringify(selector)})].filter((element) => {
        if (!scope?.messageIds?.length) return true;
        const messageId = element.closest('[data-msg-id]')?.getAttribute('data-msg-id');
        return messageId && scope.messageIds.includes(messageId);
      }).length;
    })()`);
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
    this.requests.dispose();
    this.socket.close();
  }
}

export function parseGitStatusPaths(status) {
  const records = status.split('\0');
  const paths = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    const state = record.slice(0, 2);
    paths.push(record.slice(3));
    if (state.includes('R') || state.includes('C')) {
      const originalPath = records[++index];
      if (originalPath) paths.push(originalPath);
    }
  }
  return [...new Set(paths)].toSorted();
}

async function fixtureStatus(workspace) {
  const [{ stdout: status }, { stdout: porcelain }, { stdout: commit }] = await Promise.all([
    execFileAsync('git', ['-C', workspace, 'status', '--short', '--untracked-files=all']),
    execFileAsync('git', [
      '-C',
      workspace,
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
    ]),
    execFileAsync('git', ['-C', workspace, 'rev-parse', 'HEAD']),
  ]);
  const changedPaths = parseGitStatusPaths(porcelain);
  const contents = await Promise.all(
    changedPaths.map(async (changedPath) => {
      try {
        return [changedPath, await readFile(path.join(workspace, changedPath))];
      } catch {
        return [changedPath, null];
      }
    })
  );
  const contentHash = createHash('sha256');
  for (const [changedPath, content] of contents) {
    contentHash.update(changedPath);
    contentHash.update('\0');
    if (content) contentHash.update(content);
    contentHash.update('\0');
  }
  return {
    status: status.trimEnd(),
    commit: commit.trim(),
    changedPaths,
    contentHash: contentHash.digest('hex'),
  };
}

async function writeJsonAtomic(filePath, value) {
  const temporaryPath = `${filePath}.${String(process.pid)}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporaryPath, filePath);
}

export async function persistFixtureExitEvidence({
  manifest,
  manifestPath,
  scenario,
  workspace,
  error = null,
  readFixture = fixtureStatus,
  writeManifest = writeJsonAtomic,
}) {
  const fixture = await readFixture(workspace);
  manifest.livePreparation ??= {};
  const previous = manifest.livePreparation[scenario] ?? { scenario, prepared: false };
  const failure = error
    ? `controller failure: ${error instanceof Error ? error.message : String(error)}`
    : null;
  const record = {
    ...previous,
    prepared: error ? false : previous.prepared,
    fixtureAfterPreparation: fixture,
    fixtureExitEvidence: {
      ...fixture,
      capturedAt: new Date().toISOString(),
    },
  };
  if (failure) {
    record.controllerFailure = failure;
    record.failures = [...new Set([...(previous.failures ?? []), failure])];
  }
  manifest.livePreparation[scenario] = record;
  await writeManifest(manifestPath, manifest);
  return fixture;
}

export function sessionSnapshotMatches(snapshot, sessionId, title) {
  return snapshot?.routeSessionId === sessionId && snapshot.title === title;
}

async function openRunSession(cdp, sessionId, title) {
  let snapshot = await cdp.snapshot();
  if (sessionSnapshotMatches(snapshot, sessionId, title)) return;
  const deadline = Date.now() + 5_000;
  let opened = false;
  while (Date.now() < deadline && !opened) {
    await cdp.click('[aria-label="Back to sessions"]');
    await new Promise((resolve) => setTimeout(resolve, 250));
    opened = await cdp.clickSession(sessionId);
  }
  if (!opened) {
    throw new Error(`Run session ${title} is not visible in the dedicated host session list`);
  }
  const openDeadline = Date.now() + 5_000;
  while (Date.now() < openDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    snapshot = await cdp.snapshot();
    if (sessionSnapshotMatches(snapshot, sessionId, title)) return;
  }
  throw new Error(`Could not open run session ${title}`);
}

async function restoreSidebarSessionFromPicker(cdp, sessionId, title) {
  if (sessionSnapshotMatches(await cdp.snapshot(), sessionId, title)) return true;
  await new Promise((resolve) => setTimeout(resolve, 250));
  if (!(await cdp.key('.session-list-view', 'Escape'))) return false;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (sessionSnapshotMatches(await cdp.snapshot(), sessionId, title)) return true;
  }
  return false;
}

export async function waitForLiveGate({
  client,
  cdp,
  sessionId,
  scenario,
  timeoutMs,
  marker = '',
  pollIntervalMs = 50,
}) {
  const deadline = Date.now() + timeoutMs;
  let sawBusy = false;
  let stickyNudgeAttempts = 0;
  let best = null;
  let latest = null;
  const observations = [];
  let lastSignature = '';
  while (Date.now() < deadline) {
    const [snapshot, busy] = await Promise.all([cdp.snapshot(marker), client.isBusy(sessionId)]);
    snapshot.busy = busy;
    sawBusy ||= busy;
    const missing = missingLiveGates(snapshot, scenario);
    latest = { snapshot, missing };
    const signature = JSON.stringify([busy, missing, snapshot.activeActivityCount]);
    if (signature !== lastSignature) {
      observations.push({
        atMs: timeoutMs - Math.max(0, deadline - Date.now()),
        busy,
        missing,
        activeActivityCount: snapshot.activeActivityCount,
        nestedActivityScroller: snapshot.nestedActivityScroller,
      });
      lastSignature = signature;
    }
    if (!best || missing.length < best.missing.length) best = { snapshot, missing };
    if (missing.length === 0) {
      return {
        snapshot,
        bestSnapshot: snapshot,
        missing,
        latestMissing: missing,
        sawBusy,
        observations,
      };
    }
    if (
      stickyNudgeAttempts < 12 &&
      busy &&
      snapshot.nestedActivityScroller?.hasRange &&
      missing.length === 1 &&
      missing[0] === 'sticky latest prompt'
    ) {
      stickyNudgeAttempts += 1;
      if (await cdp.wheel('.interactive-list', -96, 'right')) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      continue;
    }
    if (sawBusy && !busy) break;
    if (pollIntervalMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }
  const selected = best ?? latest;
  return {
    snapshot: latest?.snapshot ?? selected?.snapshot ?? null,
    bestSnapshot: selected?.snapshot ?? null,
    missing: selected?.missing ?? ['live gate was not sampled'],
    latestMissing: latest?.missing ?? ['live gate was not sampled'],
    sawBusy,
    observations,
  };
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

async function waitForPromptDisposition(client, cdp, sessionId, marker, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let disposition = { status: 'unobserved', userIds: [], queuedItemIds: [] };
  while (Date.now() < deadline) {
    const [messages, state] = await Promise.all([
      client.messages(sessionId, 20),
      cdp.captureActionState(),
    ]);
    disposition = classifyPromptDisposition(messages, state.queueItems ?? [], marker);
    if (disposition.status !== 'unobserved') return disposition;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return disposition;
}

async function waitForNoPendingInput(client, sessionId, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let pending = await client.pendingInput(sessionId);
  while (pending.permissions.length > 0 || pending.questions.length > 0) {
    if (Date.now() >= deadline) return pending;
    await new Promise((resolve) => setTimeout(resolve, 100));
    pending = await client.pendingInput(sessionId);
  }
  return pending;
}

async function nestedHandoff(cdp, marker = '', scope = null) {
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
  const before = await cdp.snapshot(marker);
  const outerAnchor = await captureOuterAnchor();
  const nested = before.nestedActivityScroller;
  if (!nested?.hasRange) return { passed: false, reason: 'active tray lost its scroll range' };
  const nestedDelta = nested.scrollTop > 0 ? -96 : 96;
  await cdp.wheel('.assistant-active-activity-items', nestedDelta, 'center', scope);
  await new Promise((resolve) => setTimeout(resolve, 80));
  const afterNested = await cdp.snapshot(marker);
  const afterNestedOuterAnchorTop = await captureSameOuterAnchor(outerAnchor);
  const outerDelta = before.transcript.scrollTop > 1 ? -96 : 96;
  await cdp.wheel('.interactive-list', outerDelta, 'right');
  await new Promise((resolve) => setTimeout(resolve, 250));
  const afterOuter = await cdp.snapshot(marker);
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

async function switchAwayAndBack(cdp, currentSessionId, currentTitle) {
  if (!(await cdp.click('[aria-label="Back to sessions"]'))) {
    return { dispatched: false, switchedAway: false, returned: false };
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
  const alternate = await cdp.evaluate(`(() => {
    const currentSessionId = ${JSON.stringify(currentSessionId)};
    const row = [...document.querySelectorAll('.session-item')].find((candidate) =>
      candidate.getAttribute('data-session-id') !== currentSessionId
    );
    if (!row) return null;
    const rect = row.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  })()`);
  if (!alternate) return { dispatched: false, switchedAway: false, returned: false };
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
  const switchedAway = (await cdp.snapshot()).title !== currentTitle;
  await cdp.click('[aria-label="Back to sessions"]');
  await new Promise((resolve) => setTimeout(resolve, 250));
  const reopened = await cdp.clickSession(currentSessionId);
  if (reopened) await new Promise((resolve) => setTimeout(resolve, 500));
  return {
    dispatched: true,
    switchedAway,
    returned: reopened && (await cdp.snapshot()).title === currentTitle,
  };
}

async function clickWithRetry(cdp, selector, scope = null) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (await cdp.click(selector, scope)) return true;
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

export async function sendComposerPromptWithRetry(
  cdp,
  prompt,
  maxAttempts = 20,
  pollIntervalMs = 100
) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (await cdp.sendComposerPrompt(prompt)) return true;
    if (attempt < maxAttempts - 1 && pollIntervalMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }
  return false;
}

function transcriptMoved(before, after) {
  if (!before?.transcript || !after?.transcript) return false;
  return (
    Math.abs(after.transcript.scrollTop - before.transcript.scrollTop) > 1.5 ||
    after.transcript.firstVisibleMessageId !== before.transcript.firstVisibleMessageId ||
    (Number.isFinite(after.transcript.firstVisibleTop) &&
      Number.isFinite(before.transcript.firstVisibleTop) &&
      Math.abs(after.transcript.firstVisibleTop - before.transcript.firstVisibleTop) > 1.5)
  );
}

function transcriptMovementDirection(before, after) {
  if (!before?.transcript || !after?.transcript) return 0;
  const afterRows = new Map(
    (after.transcript.visibleRows ?? []).map((row) => [row.messageId, row.top])
  );
  for (const row of before.transcript.visibleRows ?? []) {
    const afterTop = afterRows.get(row.messageId);
    if (!Number.isFinite(row.top) || !Number.isFinite(afterTop)) continue;
    const delta = row.top - afterTop;
    if (Math.abs(delta) > 1.5) return Math.sign(delta);
  }
  const scrollDelta = after.transcript.scrollTop - before.transcript.scrollTop;
  return Math.abs(scrollDelta) > 1.5 ? Math.sign(scrollDelta) : 0;
}

function expectedTranscriptDirection(action) {
  if (action.action === 'wheel transcript') return Math.sign(action.delta ?? 0) || null;
  if (!(action.action.endsWith('on transcript') || action.action === 'key on transcript')) return null;
  const key = action.key ?? action.action.split(' ')[0];
  if (['ArrowDown', 'PageDown', 'Space', 'End'].includes(key)) return 1;
  if (['ArrowUp', 'PageUp', 'Shift+Space', 'Home'].includes(key)) return -1;
  return null;
}

function transcriptAtBoundary(action, state) {
  const direction = expectedTranscriptDirection(action);
  const transcript = state?.transcript;
  if (direction === null || !transcript) return false;
  const maximum = Math.max(0, transcript.scrollHeight - transcript.clientHeight);
  return direction > 0 ? transcript.scrollTop >= maximum - 1.5 : transcript.scrollTop <= 1.5;
}

export function verifyActionEffect(action, before, after, details = {}) {
  if (!details.dispatched) return { verified: false, reason: 'input was not dispatched' };
  if (action.action === 'switch session away and back') {
    return details.switchedAway && details.returned
      ? { verified: true }
      : { verified: false, reason: 'session route did not switch away and return' };
  }
  if (action.action === 'wheel verified nested scroller, then outer transcript') {
    return details.handoff?.passed
      ? { verified: true }
      : { verified: false, reason: details.handoff?.reason ?? 'nested handoff was not verified' };
  }
  if (action.action.endsWith('on transcript') || action.action === 'key on transcript') {
    if (after?.focusOwner !== 'transcript') {
      return { verified: false, reason: 'transcript focus and movement were not both verified' };
    }
    if (!transcriptMoved(before, after)) {
      return transcriptAtBoundary(action, before)
        ? { verified: true }
        : { verified: false, reason: 'transcript focus and movement were not both verified' };
    }
  }
  if (action.action.endsWith('in composer')) {
    return after?.focusOwner === 'composer' && !transcriptMoved(before, after)
      ? { verified: true }
      : { verified: false, reason: 'composer focus ownership was not verified' };
  }
  if (action.action === 'resize sidebar') {
    return Math.abs((after?.width ?? 0) - (action.width ?? 430)) <= 1
      ? { verified: true }
      : { verified: false, reason: 'requested webview width was not measured' };
  }
  if (action.action === 'expand disclosure' || action.action === 'collapse disclosure') {
    const expected = action.action === 'expand disclosure';
    const changed = before?.disclosures?.some((entry) =>
      after?.disclosures?.some(
        (candidate) =>
          candidate.messageId === entry.messageId &&
          candidate.key === entry.key &&
          entry.expanded !== expected &&
          candidate.expanded === expected
      )
    );
    return changed
      ? { verified: true }
      : { verified: false, reason: 'the scoped disclosure state did not change as requested' };
  }
  if (action.action === 'open file card and diff') {
    return (after?.expandedDiffCount ?? 0) > (before?.expandedDiffCount ?? 0)
      ? { verified: true }
      : { verified: false, reason: 'the scoped diff did not expand' };
  }
  if (action.action === 'focus and close diff') {
    return details.focusOwner === 'diff' &&
      (after?.expandedDiffCount ?? 0) < (before?.expandedDiffCount ?? 0)
      ? { verified: true }
      : { verified: false, reason: 'diff focus and collapse were not both verified' };
  }
  if (
    action.action === 'click sticky or jump to latest' ||
    action.action === 'wheel transcript' ||
    action.action.endsWith('on transcript') ||
    action.action === 'key on transcript'
  ) {
    if (transcriptAtBoundary(action, before)) return { verified: true };
    if (!transcriptMoved(before, after)) {
      return { verified: false, reason: 'transcript destination did not move' };
    }
    const expectedDirection = expectedTranscriptDirection(action);
    if (
      expectedDirection !== null &&
      transcriptMovementDirection(before, after) !== expectedDirection
    ) {
      return { verified: false, reason: 'transcript moved opposite the requested direction' };
    }
    if (
      expectedDirection !== null &&
      details.settledAfter &&
      transcriptMovementDirection(after, details.settledAfter) === -expectedDirection
    ) {
      return { verified: false, reason: 'transcript movement reversed after the input' };
    }
    return { verified: true };
  }
  return { verified: false, reason: `no effect oracle for ${action.action}` };
}

export async function executeActionPlan(cdp, plan, currentTitle, port, options = {}) {
  const results = [];
  for (const action of plan) {
    if (options.isActive && !(await options.isActive())) {
      results.push({ ...action, executed: false, reason: 'model stream settled' });
      break;
    }
    const before = await cdp.captureActionState(options.scope);
    let dispatched = false;
    const details = {};
    if (action.action === 'switch session away and back') {
      const switched = await switchAwayAndBack(cdp, options.sessionId, currentTitle);
      dispatched = switched.dispatched;
      details.switchedAway = switched.switchedAway;
      details.returned = switched.returned;
    } else if (action.action === 'wheel verified nested scroller, then outer transcript') {
      details.handoff = await nestedHandoff(cdp, options.marker, options.scope);
      dispatched = !!details.handoff.before;
    } else if (action.action.endsWith('on transcript') || action.action === 'key on transcript') {
      dispatched = await cdp.key(
        '.interactive-list',
        action.key ?? action.action.split(' ')[0]
      );
    } else if (action.action.endsWith('in composer')) {
      dispatched = await cdp.key(
        '[aria-label="Message composer"]',
        action.key ?? action.action.split(' ')[0]
      );
    } else if (action.action === 'resize sidebar') {
      await resizeVscodeSidebar(port, action.width ?? 430);
      dispatched = true;
    } else if (action.action === 'expand disclosure' || action.action === 'collapse disclosure') {
      const expected = action.action === 'expand disclosure';
      const target = before.disclosures?.find(
        (entry) => entry.key && entry.expanded !== expected
      );
      const selector = target
        ? `.assistant-activity-summary[data-activity-summary-group-key=${JSON.stringify(target.key)}]`
        : null;
      if (selector) {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          dispatched = (await cdp.click(selector, options.scope)) || dispatched;
          if (!dispatched) break;
          await new Promise((resolve) => setTimeout(resolve, 100));
          const state = await cdp.captureActionState(options.scope);
          if (
            state.disclosures?.some(
              (entry) => entry.key === target.key && entry.expanded === expected
            )
          ) {
            details.after = state;
            break;
          }
        }
      }
    } else if (action.action === 'open file card and diff') {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        dispatched = (await cdp.click('[aria-label^="Expand changes in"]', options.scope)) || dispatched;
        if (!dispatched) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
        const state = await cdp.captureActionState(options.scope);
        if ((state.expandedDiffCount ?? 0) > (before.expandedDiffCount ?? 0)) {
          details.after = state;
          break;
        }
      }
    } else if (action.action === 'focus and close diff') {
      let focused = false;
      for (const target of [
        { selector: '.diff-view-overlay-content', scope: null },
        { selector: '.diff-view-lines', scope: options.scope },
        { selector: '.file-change-inline-diffs', scope: options.scope },
        { selector: '.diff-view-file', scope: options.scope },
        { selector: '.file-change-card', scope: options.scope },
      ]) {
        focused = await clickWithRetry(cdp, target.selector, target.scope);
        if (focused) break;
      }
      dispatched = focused;
      if (focused) {
        details.focusOwner = (await cdp.captureActionState(options.scope)).focusOwner;
        for (const target of [
          { selector: '[aria-label="Close expanded diff"]', scope: null },
          { selector: '[aria-label^="Collapse changes in"]', scope: options.scope },
        ]) {
          for (let attempt = 0; attempt < 3; attempt += 1) {
            dispatched = (await cdp.click(target.selector, target.scope)) || dispatched;
            await new Promise((resolve) => setTimeout(resolve, 100));
            const state = await cdp.captureActionState(options.scope);
            if ((state.expandedDiffCount ?? 0) < (before.expandedDiffCount ?? 0)) {
              details.after = state;
              break;
            }
          }
          if (details.after) break;
        }
      }
    } else if (action.action === 'click sticky or jump to latest') {
      dispatched =
        (await cdp.click('[data-sticky-msg-id]')) ||
        (await cdp.click('[aria-label="Scroll to latest message"]'));
      if (!dispatched && (await cdp.wheel('.interactive-list', -420, 'right'))) {
        dispatched = await clickWithRetry(cdp, '[aria-label="Scroll to latest message"]');
      }
    } else if (action.action === 'wheel transcript') {
      dispatched = await cdp.wheel('.interactive-list', action.delta, 'right');
    }
    await new Promise((resolve) => setTimeout(resolve, 34));
    const after = details.after ?? (await cdp.captureActionState(options.scope));
    const settleDelayMs = 100 + (action.pauseFrames ?? 0) * 17;
    let settledAfter = null;
    if (expectedTranscriptDirection(action) !== null) {
      await new Promise((resolve) => setTimeout(resolve, settleDelayMs));
      settledAfter = await cdp.captureActionState(options.scope);
    }
    const effect = verifyActionEffect(action, before, after, {
      ...details,
      dispatched,
      settledAfter,
    });
    const result = {
      ...action,
      dispatched,
      executed: effect.verified,
      before,
      after,
    };
    if (settledAfter) result.settledAfter = settledAfter;
    if (effect.reason) result.reason = effect.reason;
    results.push(result);
    if (!effect.verified) break;
    if (!settledAfter) await new Promise((resolve) => setTimeout(resolve, settleDelayMs));
  }
  return results;
}

export function buildMultiWebviewScenarioPlan(seed, promptRun = 1) {
  const marker = `[VFZ:${seed}:AI18:R${String(promptRun)}`;
  return [
    { step: 1, action: 'target sidebar', viewId: 'sidebar' },
    { step: 2, action: 'create and inventory child session', marker: `${marker}:CHILD]` },
    { step: 3, action: 'select model and permission in sidebar' },
    { step: 4, action: 'route root into editor' },
    { step: 5, action: 'route child then root through same editor viewId' },
    { step: 6, action: 'start real root stream', marker: `${marker}:STREAM]` },
    { step: 7, action: 'queue from sidebar', marker: `${marker}:Q1]` },
    { step: 8, action: 'queue from editor', marker: `${marker}:Q2]` },
    { step: 9, action: 'hide editor and verify queue handoff' },
    { step: 10, action: 'reveal editor by stable viewId' },
    { step: 11, action: 'toggle inline file changes off and on' },
    { step: 12, action: 'reload and restore editor by stable viewId' },
    { step: 13, action: 'queue a fresh editor close-handoff item' },
    { step: 14, action: 'close editor and verify target disappearance and queue handoff' },
    { step: 15, action: 'sample delivery, counts, leakage, and focus' },
  ];
}

function configurationMatches(configuration, requestedModel, permissionMode) {
  const requested = parseModel(requestedModel);
  return {
    model:
      configuration?.model?.providerID === requested.providerID &&
      configuration?.model?.modelID === requested.modelID,
    permissionMode: configuration?.permissionMode === permissionMode,
  };
}

export function queueHandoffMatches(
  sample,
  expectedIds,
  expectedOwnerViewId,
  expectedCount,
  sessionId
) {
  if (!sample || sample.displayedCount !== expectedCount) return false;
  const items = (sample.queueItems ?? []).filter((item) => item.sessionId === sessionId);
  return (
    JSON.stringify(items.map((item) => item.id).toSorted()) ===
      JSON.stringify([...expectedIds].toSorted()) &&
    items.every((item) => item.ownerViewId === expectedOwnerViewId)
  );
}

export function multiWebviewScenarioFailures(evidence) {
  const failures = [];
  if (evidence?.targets?.sidebarViewId !== 'sidebar' || !evidence?.targets?.editorViewId) {
    failures.push('sidebar and editor targets were not identified by explicit viewId');
  }
  if (!evidence?.editor?.opened || !evidence.editor.revealed || !evidence.editor.restored) {
    failures.push('editor open, reveal, and reload restoration were not all verified');
  }
  if (!evidence?.editor?.rootTitleRouted || !evidence.editor.childTitleRouted) {
    failures.push('root and child title routing was not verified');
  }
  const synchronizedPhases = new Set(
    evidence?.synchronization?.samples
      ?.filter((sample) => sample.model && sample.permissionMode)
      .map((sample) => sample.phase) ?? []
  );
  if (
    ![
      'sidebar-source',
      'editor-root',
      'editor-root-return',
      'editor-reload',
    ].every((phase) => synchronizedPhases.has(phase))
  ) {
    failures.push('model and permission mode were not synchronized across views');
  }
  const enqueueOrder = evidence?.queues?.enqueueOrder ?? [];
  const enqueueIds = enqueueOrder.map((entry) => entry.id);
  if (
    enqueueOrder.length !== 3 ||
    new Set(enqueueIds).size !== 3 ||
    new Set(enqueueOrder.map((entry) => entry.sourceViewId)).size < 2 ||
    !queueHandoffMatches(
      evidence?.queues?.hiddenHandoff,
      enqueueIds.slice(0, 2),
      'sidebar',
      2,
      evidence?.queues?.sessionId
    ) ||
    !queueHandoffMatches(
      evidence?.queues?.closedHandoff,
      enqueueIds.slice(2),
      'sidebar',
      1,
      evidence?.queues?.sessionId
    ) ||
    evidence?.queues?.closedHandoff?.targetDisappeared !== true
  ) {
    failures.push('multi-view queue ownership and hidden/closed handoff were not verified');
  }
  if (!evidence?.fileDiffs?.hidden || !evidence.fileDiffs.shown) {
    failures.push('inline file changes did not respond to both command-palette toggles');
  }
  if (
    evidence?.delivery?.userCounts?.length !== enqueueOrder.length ||
    evidence.delivery.userCounts.some((count) => count !== 1)
  ) {
    failures.push('queued prompts were not delivered exactly once');
  }
  if (evidence?.delivery?.ordered !== true) {
    failures.push('queued prompts were not dispatched in recorded order');
  }
  if (
    evidence?.delivery?.assistantCounts?.length !== enqueueOrder.length ||
    evidence.delivery.assistantCounts.some((count) => count !== 1)
  ) {
    failures.push('queued responses did not have exactly one linked assistant each');
  }
  if (
    evidence?.delivery?.assistantValid?.length !== enqueueOrder.length ||
    evidence.delivery.assistantValid.some((valid) => !valid)
  ) {
    failures.push('a queued response did not complete cleanly with its exact response marker');
  }
  if (evidence?.delivery?.reloadDuplicateFree !== true) {
    failures.push('reload duplicate-delivery sampling failed');
  }
  if (
    !evidence?.leakage?.rootAbsentFromChild ||
    !evidence.leakage.childPresentInChild ||
    !evidence.leakage.childAbsentFromRoot ||
    !evidence.leakage.rootPresentInRoot
  ) {
    failures.push('cross-session content leakage was observed');
  }
  if (evidence?.counts?.accurate !== true) failures.push('queue counts were not accurate');
  if (evidence?.focus?.usable !== true) failures.push('composer focus was not usable after handoff');
  if ((evidence?.unexpectedDescendants?.length ?? 0) > 0) {
    failures.push('the bounded stream created uninventoryed descendants');
  }
  return failures;
}

export function summarizeQueuedDelivery(messages, turns) {
  const userEntries = turns.map(({ promptMarker }) =>
    messages.filter(
      (entry) =>
        entry?.info?.role === 'user' &&
        entry.parts?.some((part) => part?.type === 'text' && part.text?.includes(promptMarker))
    )
  );
  const userCounts = userEntries.map((entries) => entries.length);
  const assistantEntries = userEntries.map((entries) =>
    entries.length === 1
      ? messages.filter(
          (entry) =>
            entry?.info?.role === 'assistant' && entry.info.parentID === entries[0].info.id
        )
      : []
  );
  const assistantCounts = assistantEntries.map((entries) => entries.length);
  const assistantValid = assistantEntries.map((entries, index) => {
    const assistant = entries.length === 1 ? entries[0] : null;
    const responseMarker = turns[index]?.responseMarker ?? '';
    const text =
      assistant?.parts
        ?.filter((part) => part?.type === 'text' || part?.type === 'reasoning')
        .map((part) => part.text ?? '')
        .join('\n') ?? '';
    return (
      !!assistant &&
      Number.isFinite(assistant.info.time?.completed) &&
      assistant.info.finish === 'stop' &&
      !assistant.info.error &&
      responseMarker.length > 0 &&
      text.split(responseMarker).length - 1 === 1
    );
  });
  const indexes = userEntries.map((entries) =>
    entries.length === 1 ? messages.indexOf(entries[0]) : -1
  );
  const userIds = userEntries.map((entries) => (entries.length === 1 ? entries[0].info.id : null));
  const assistantIds = assistantEntries.map((entries) =>
    entries.length === 1 ? entries[0].info.id : null
  );
  return {
    userCounts,
    assistantCounts,
    assistantValid,
    userIds,
    assistantIds,
    indexes,
    ordered:
      indexes.every((index) => index >= 0) &&
      indexes.every((index, position) => position === 0 || index > indexes[position - 1]),
  };
}

async function waitForQueuedDelivery(client, sessionId, turns, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let messages = [];
  let delivery = summarizeQueuedDelivery(messages, turns);
  while (Date.now() < deadline) {
    messages = await client.messages(sessionId, 1000);
    delivery = summarizeQueuedDelivery(messages, turns);
    if (
      delivery.userCounts.every((count) => count === 1) &&
      delivery.assistantCounts.every((count) => count === 1) &&
      delivery.assistantValid.every(Boolean) &&
      !(await client.isBusy(sessionId))
    ) {
      return { settled: true, messages, delivery };
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return { settled: false, messages, delivery };
}

async function waitForTarget(port, requested, timeoutMs) {
  return CdpController.connect(port, requested, timeoutMs);
}

async function readActiveVscodeTabTitle(port) {
  const targets = await fetch(`http://127.0.0.1:${String(port)}/json/list`).then((response) =>
    response.json()
  );
  const workbench = targets.find(
    (target) => target.type === 'page' && target.title.includes('[Extension Development Host]')
  );
  if (!workbench?.webSocketDebuggerUrl) return null;
  const socket = new WebSocket(workbench.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  const requests = createCdpRequestClient(socket);
  try {
    const result = await requests.call('Runtime.evaluate', {
      expression: `document.querySelector('.tab.active')?.getAttribute('aria-label') ?? null`,
      returnByValue: true,
    });
    return result.result.value ?? null;
  } finally {
    requests.dispose();
    socket.close();
  }
}

async function waitForSessionSnapshot(cdp, title, sessionId, port, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let snapshot = null;
  while (Date.now() < deadline) {
    snapshot = await cdp.snapshot();
    if (snapshot.routeSessionId === sessionId) {
      const nativeTitle = await readActiveVscodeTabTitle(port);
      const observed = { ...snapshot, webviewTitle: snapshot.title, title: nativeTitle };
      if (nativeTitle === title) return observed;
      snapshot = observed;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return snapshot;
}

async function varroEditorTargetIds(port) {
  const targets = await fetch(`http://127.0.0.1:${String(port)}/json/list`).then((response) =>
    response.json()
  );
  return targets
    .filter(
      (target) =>
        target.type === 'iframe' &&
        target.url.includes('extensionId=koltyakov.varro') &&
        !target.url.includes('purpose=webviewView')
    )
    .map((target) => target.id);
}

async function closeVscodeSessionEditorTabs(port, titles) {
  const targets = await fetch(`http://127.0.0.1:${String(port)}/json/list`).then((response) =>
    response.json()
  );
  const workbenches = targets.filter(
    (target) => target.type === 'page' && target.title.includes('[Extension Development Host]')
  );
  if (workbenches.length !== 1 || !workbenches[0]?.webSocketDebuggerUrl) {
    throw new Error(`Expected one VS Code workbench target, found ${String(workbenches.length)}`);
  }
  const socket = new WebSocket(workbenches[0].webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  const requests = createCdpRequestClient(socket);
  let closed = 0;
  try {
    for (let attempt = 0; attempt < titles.length; attempt += 1) {
      const point = await requests.call('Runtime.evaluate', {
        expression: `(() => {
          const titles = ${JSON.stringify(titles)};
          const tab = [...document.querySelectorAll('.tab')].find((candidate) =>
            titles.includes(candidate.getAttribute('aria-label') ?? candidate.innerText.trim())
          );
          const close = tab?.querySelector('[aria-label^="Close"]');
          if (!close) return null;
          const rect = close.getBoundingClientRect();
          return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        })()`,
        returnByValue: true,
      });
      const value = point.result.value;
      if (!value) break;
      for (const [type, buttons] of [
        ['mousePressed', 1],
        ['mouseReleased', 0],
      ]) {
        await requests.call('Input.dispatchMouseEvent', {
          type,
          ...value,
          button: 'left',
          buttons,
          clickCount: 1,
        });
      }
      closed += 1;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  } finally {
    requests.dispose();
    socket.close();
  }
  return closed;
}

async function waitForNoVarroEditorTargets(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await varroEditorTargetIds(port)).length === 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function openAi18SidebarSession(cdp, sessionId, title, port, sessionTitles) {
  if (sessionSnapshotMatches(await cdp.snapshot(), sessionId, title)) return;
  let lastTitle = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const returnedToParent =
      (await cdp.clickText('Return to parent')) ||
      (await cdp.click('[aria-label^="Back to parent session"]'));
    if (returnedToParent) {
      const parentDeadline = Date.now() + 5_000;
      while (Date.now() < parentDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        const snapshot = await cdp.snapshot();
        lastTitle = snapshot.title;
        if (sessionSnapshotMatches(snapshot, sessionId, title)) return;
      }
    }
    await closeVscodeSessionEditorTabs(port, sessionTitles);
    if (!(await waitForNoVarroEditorTargets(port, 10_000))) {
      throw new Error('AI-18 stale editor target did not close before opening the sidebar');
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    await cdp.rebind();
    await cdp.click('[aria-label="Back to sessions"]');
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (!(await cdp.clickSession(sessionId))) continue;
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const snapshot = await cdp.snapshot();
      lastTitle = snapshot.title;
      if (sessionSnapshotMatches(snapshot, sessionId, title)) return;
      if ((await varroEditorTargetIds(port)).length > 0) break;
    }
  }
  throw new Error(
    `Could not open AI-18 root in the sidebar; last sidebar title was ${String(lastTitle)}`
  );
}

async function openSessionEditorWithRetry(
  sidebar,
  port,
  sessionId,
  title,
  sessionTitles,
  timeoutMs = 20_000
) {
  try {
    const existing = await waitForTarget(port, { surface: 'editor', sessionId }, 1_000);
    if (await existing.isDocumentVisible()) return existing;
    existing.close();
  } catch {}

  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) {
      await openAi18SidebarSession(sidebar, sessionId, title, port, sessionTitles);
    }
    try {
      if (!(await sidebar.contextClick('.chat-header-session-title'))) {
        throw new Error(`Could not open the ${title} session actions`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (!(await sidebar.clickText('Open as Editor'))) {
        throw new Error(`Could not open ${title} in an editor`);
      }
      return await waitForTarget(port, { surface: 'editor', sessionId }, timeoutMs);
    } catch (error) {
      lastError = error;
      await closeVscodeSessionEditorTabs(port, [title, ...sessionTitles]);
      if (!(await waitForNoVarroEditorTargets(port, 10_000))) {
        throw new Error(`The stale ${title} editor target did not close before retrying`, {
          cause: error,
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
      await sidebar.rebind();
    }
  }
  throw new Error(
    `Could not open ${title} in a usable editor after retrying: ${lastError instanceof Error ? lastError.message : String(lastError)}`
  );
}

async function waitForScopedCount(cdp, selector, scope, accept, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let count = 0;
  while (Date.now() < deadline) {
    count = await cdp.countScoped(selector, scope);
    if (accept(count)) return count;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return count;
}

export async function waitForTargetDisappearance(
  port,
  targetId,
  timeoutMs,
  listTargets = () =>
    fetch(`http://127.0.0.1:${String(port)}/json/list`).then((response) => response.json()),
  pollIntervalMs = 100
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (!(await listTargets()).some((target) => target.id === targetId)) return true;
    } catch {}
    if (pollIntervalMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }
  return false;
}

async function waitForSessionQueueCount(cdp, sessionId, expectedCount, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let state = null;
  while (Date.now() < deadline) {
    state = await cdp.captureActionState();
    const count = state.sessionQueueCounts.find((entry) => entry.sessionId === sessionId)?.count;
    if (count === expectedCount) return { count, state };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { count: null, state };
}

async function waitForQueueMarker(controller, marker, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let state = null;
  while (Date.now() < deadline) {
    state = await controller.captureActionState();
    const matches = state.queueItems.filter((item) => item.text.includes(marker));
    if (matches.length === 1) return { item: matches[0], state };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { item: null, state };
}

async function waitForSessionQuiescence(client, controller, sessionId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let stableSamples = 0;
  while (Date.now() < deadline) {
    const [busy, state] = await Promise.all([
      client.isBusy(sessionId),
      controller.captureActionState(),
    ]);
    const count =
      state.sessionQueueCounts.find((entry) => entry.sessionId === sessionId)?.count ??
      state.queueItems.filter((item) => item.sessionId === sessionId).length;
    stableSamples = !busy && count === 0 ? stableSamples + 1 : 0;
    if (stableSamples >= 3) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function runMultiWebviewScenario({
  cdp: sidebar,
  client,
  launch,
  manifest,
  manifestPath,
  options,
  requestedModel,
  selectedModel,
  tracked,
  fixture,
  descendantsBefore,
  promptRun,
  markModelMayEdit,
}) {
  const timeoutMs = Number(options['gate-timeout-ms'] ?? DEFAULT_GATE_TIMEOUT_MS);
  const permissionMode = options['permission-mode'] ?? 'auto';
  if (!['default', 'edits', 'auto', 'full'].includes(permissionMode)) {
    throw new Error('--permission-mode must be default, edits, auto, or full');
  }
  const plan = buildMultiWebviewScenarioPlan(manifest.seed, promptRun);
  const runSessionTitles = manifest.runSessions
    .filter((session) => !session.deleted)
    .map((session) => session.title);
  await openAi18SidebarSession(
    sidebar,
    tracked.id,
    tracked.title,
    launch.remoteDebuggingPort,
    runSessionTitles
  );
  if (!(await waitForSessionQuiescence(client, sidebar, tracked.id, timeoutMs * 3))) {
    throw new Error('AI-18 root session and queue did not become quiescent before replay');
  }
  const childTitle = `VFZ ${manifest.seed} AI-18 child`;
  const sessions = await client.listSessions();
  const recordedChild = manifest.runSessions
    .toReversed()
    .find(
      (session) =>
        !session.deleted && session.createdBy === 'AI-18' && session.parentID === tracked.id
    );
  const existingChild = recordedChild
    ? sessions.find((session) => session.id === recordedChild.id && session.parentID === tracked.id)
    : null;
  const child =
    existingChild ??
    (await client.request('POST', '/session', {
      title: childTitle,
      parentID: tracked.id,
    }));
  if (!child?.id || child.parentID !== tracked.id) {
    throw new Error('OpenCode did not create the requested AI-18 child session');
  }
  if (!existingChild) {
    manifest.runSessions.push({
      id: child.id,
      title: childTitle,
      parentID: tracked.id,
      rootSessionId: tracked.id,
      deleted: false,
      createdBy: 'AI-18',
    });
    await writeJsonAtomic(manifestPath, manifest);
  }

  const evidence = {
    plan,
    targets: {
      sidebarViewId: sidebar.targetContext?.viewId ?? null,
      editorViewId: null,
    },
    editor: {
      opened: false,
      revealed: false,
      restored: false,
      rootTitleRouted: false,
      childTitleRouted: false,
      samples: [],
    },
    synchronization: { model: true, permissionMode: true, samples: [] },
    queues: {
      sessionId: tracked.id,
      enqueueOrder: [],
      hiddenHandoff: null,
      closedHandoff: null,
      samples: [],
    },
    fileDiffs: { hidden: false, shown: false, samples: [] },
    delivery: null,
    leakage: {
      rootAbsentFromChild: false,
      childPresentInChild: false,
      childAbsentFromRoot: false,
      rootPresentInRoot: false,
    },
    counts: { accurate: false, samples: [] },
    focus: { usable: false },
    unexpectedDescendants: [],
  };
  const marker = `[VFZ:${manifest.seed}:AI18:R${String(promptRun)}`;
  const responseMarker = `VFZ-AI18-R${String(promptRun)}`;
  const streamMarker = `${marker}:STREAM]`;
  const closeStreamMarker = `${marker}:CLOSE-STREAM]`;
  const childTurn = {
    promptMarker: `${marker}:CHILD]`,
    responseMarker: `${responseMarker}-CHILD-END`,
  };
  const childEditTurn = {
    promptMarker: `${marker}:EDIT]`,
    responseMarker: `${responseMarker}-EDIT-END`,
  };
  const queueTurns = [
    { promptMarker: `${marker}:Q1]`, responseMarker: `${responseMarker}-Q1-END` },
    { promptMarker: `${marker}:Q2]`, responseMarker: `${responseMarker}-Q2-END` },
    { promptMarker: `${marker}:Q3]`, responseMarker: `${responseMarker}-Q3-END` },
  ];
  const rootMarkers = [streamMarker, ...queueTurns.slice(0, 2).map((turn) => turn.promptMarker)];
  const sampleConfiguration = async (controller, phase) => {
    const deadline = Date.now() + 10_000;
    let configuration = null;
    let matches = { model: false, permissionMode: false };
    while (Date.now() < deadline) {
      configuration = await controller.readComposerConfiguration();
      matches = configurationMatches(configuration, requestedModel, permissionMode);
      if (matches.model && matches.permissionMode) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    evidence.synchronization.samples.push({ phase, configuration, ...matches });
    evidence.synchronization.model &&= matches.model;
    evidence.synchronization.permissionMode &&= matches.permissionMode;
  };
  const enqueueTurn = async (controller, sourceViewId, turn, phase) => {
    if (
      !(await sendComposerPromptWithRetry(
        controller,
        `${turn.promptMarker} Reply with only ${turn.responseMarker}. Do not use tools or subagents.`
      ))
    ) {
      throw new Error(`AI-18 could not enqueue ${turn.promptMarker} from ${sourceViewId}`);
    }
    const queued = await waitForQueueMarker(controller, turn.promptMarker);
    if (!queued.item?.id || queued.item.ownerViewId !== sourceViewId) {
      throw new Error(`AI-18 did not observe exact ownership for ${turn.promptMarker}`);
    }
    const entry = {
      id: queued.item.id,
      sourceViewId,
      promptMarker: turn.promptMarker,
      responseMarker: turn.responseMarker,
    };
    evidence.queues.enqueueOrder.push(entry);
    evidence.queues.samples.push({ phase, state: queued.state, entry });
    return entry;
  };

  let editor = null;
  try {
    await openAi18SidebarSession(
      sidebar,
      tracked.id,
      tracked.title,
      launch.remoteDebuggingPort,
      runSessionTitles
    );
    await sidebar.selectPermissionMode(permissionMode);
    await sampleConfiguration(sidebar, 'sidebar-source');
    const streamPrompt = `${streamMarker} Produce 120 numbered paragraphs of 35-45 words each. Emit every paragraph in order and end with ${responseMarker}-STREAM-END. Do not use tools, spawn subagents, delegate work, or change files.`;
    markModelMayEdit();
    if (!(await sendComposerPromptWithRetry(sidebar, streamPrompt))) {
      throw new Error('AI-18 could not send the real stream from the sidebar');
    }
    if (!(await waitForBusy(client, tracked.id, Math.min(timeoutMs, 15_000)))) {
      throw new Error('AI-18 did not observe the root stream become busy');
    }
    await enqueueTurn(sidebar, 'sidebar', queueTurns[0], 'sidebar-enqueue');

    editor = await openSessionEditorWithRetry(
      sidebar,
      launch.remoteDebuggingPort,
      tracked.id,
      tracked.title,
      runSessionTitles,
      20_000
    );
    const editorViewId = editor.targetContext?.viewId;
    if (!editorViewId) throw new Error('AI-18 editor target has no stable viewId');
    evidence.targets.editorViewId = editorViewId;
    evidence.editor.opened = true;
    const openedRoot = await waitForSessionSnapshot(
      editor,
      tracked.title,
      tracked.id,
      launch.remoteDebuggingPort
    );
    evidence.editor.samples.push({ phase: 'opened-root', snapshot: openedRoot });
    evidence.editor.rootTitleRouted =
      openedRoot.title === tracked.title && openedRoot.routeSessionId === tracked.id;
    if (!(await restoreSidebarSessionFromPicker(sidebar, tracked.id, tracked.title))) {
      throw new Error('AI-18 could not restore the root session in the sidebar after opening the editor');
    }
    await sampleConfiguration(editor, 'editor-root');
    await enqueueTurn(editor, editorViewId, queueTurns[1], 'editor-enqueue');

    await executeVscodeCommand(launch.remoteDebuggingPort, 'File: New Untitled Text File');
    await new Promise((resolve) => setTimeout(resolve, 500));
    await sidebar.rebind();
    const hiddenCount = await waitForSessionQueueCount(sidebar, tracked.id, 2, 5_000);
    evidence.counts.samples.push({ phase: 'hidden', count: hiddenCount.count });
    await openAi18SidebarSession(
      sidebar,
      tracked.id,
      tracked.title,
      launch.remoteDebuggingPort,
      runSessionTitles
    );
    const hiddenQueue = await sidebar.captureActionState();
    evidence.queues.hiddenHandoff = {
      displayedCount: hiddenCount.count,
      queueItems: hiddenQueue.queueItems,
    };
    evidence.queues.samples.push({ phase: 'hidden-handoff', state: hiddenQueue });

    await sidebar.click('[aria-label="Back to sessions"]');
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (!(await sidebar.clickSessionControl(tracked.id, '.session-item-subagents'))) {
      throw new Error('AI-18 could not open the root sub-agent list');
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (!(await sidebar.clickSession(child.id))) {
      throw new Error('AI-18 could not reveal the child session in the editor');
    }
    editor.close();
    editor = await waitForTarget(
      launch.remoteDebuggingPort,
      { surface: 'editor', viewId: editorViewId, sessionId: child.id },
      20_000
    );
    evidence.editor.revealed = true;
    const childSnapshot = await waitForSessionSnapshot(
      editor,
      childTitle,
      child.id,
      launch.remoteDebuggingPort
    );
    evidence.editor.samples.push({ phase: 'child', snapshot: childSnapshot });
    evidence.editor.childTitleRouted =
      childSnapshot.title === childTitle && childSnapshot.routeSessionId === child.id;
    evidence.leakage.rootAbsentFromChild = !(await editor.evaluate(
      `${JSON.stringify(rootMarkers)}.some((marker) => document.body.innerText.includes(marker))`
    ));
    await client.send(
      child.id,
      `${childEditTurn.promptMarker} Work only in the current OpenCode repository. Read packages/opencode/src/util/timeout.ts. Use the edit tool to append the exact temporary comment " // VFZ AI18 transient" to the line "let timeout: NodeJS.Timeout", then use the edit tool again to remove exactly that comment so the file returns byte-for-byte to its starting content. Verify the final repository status still has exactly the pre-existing changed paths and run git diff --check. Do not touch any other content, spawn subagents, or delegate work. Finish with ${childEditTurn.responseMarker}.`,
      parseModel(requestedModel)
    );
    if (!(await waitForBusy(client, child.id, Math.min(timeoutMs, 15_000)))) {
      throw new Error('AI-18 child edit stream did not become busy');
    }
    if (!(await waitForIdle(client, child.id, timeoutMs * 3))) {
      throw new Error('AI-18 child edit stream did not settle');
    }
    const childEditMessages = await client.messages(child.id, 1000);
    const childEditUsers = childEditMessages.filter(
      (entry) =>
        entry?.info?.role === 'user' &&
        entry.parts?.some(
          (part) => part?.type === 'text' && part.text?.includes(childEditTurn.promptMarker)
        )
    );
    const childEditAssistants =
      childEditUsers.length === 1
        ? childEditMessages.filter(
            (entry) =>
              entry?.info?.role === 'assistant' && entry.info.parentID === childEditUsers[0].info.id
          )
        : [];
    const childEditScope = {
      messageIds: [
        childEditUsers.length === 1 ? childEditUsers[0].info.id : null,
        ...childEditAssistants.map((entry) => entry.info.id),
      ].filter(Boolean),
    };
    const fixtureAfterChildEdit = await fixtureStatus(manifest.workspace);
    if (
      childEditScope.messageIds.length < 2 ||
      fixtureAfterChildEdit.commit !== fixture.commit ||
      fixtureAfterChildEdit.status !== fixture.status ||
      fixtureAfterChildEdit.contentHash !== fixture.contentHash ||
      JSON.stringify(fixtureAfterChildEdit.changedPaths) !== JSON.stringify(fixture.changedPaths)
    ) {
      throw new Error('AI-18 child edit turn did not preserve the exact recorded fixture state');
    }
    await executeVscodeCommand(launch.remoteDebuggingPort, 'Varro: Show File Diffs');
    const inlineBefore = await waitForScopedCount(
      editor,
      '.file-change-inline-diffs',
      childEditScope,
      (count) => count > 0,
      10_000
    );
    if (!(await editor.point('.file-change-inline-diffs', 'center', childEditScope))) {
      throw new Error('AI-18 could not reveal the current child inline file changes');
    }
    await executeVscodeCommand(launch.remoteDebuggingPort, 'Varro: Hide File Diffs');
    const inlineHidden = await waitForScopedCount(
      editor,
      '.file-change-inline-diffs',
      childEditScope,
      (count) => count === 0
    );
    await executeVscodeCommand(launch.remoteDebuggingPort, 'Varro: Show File Diffs');
    const inlineShown = await waitForScopedCount(
      editor,
      '.file-change-inline-diffs',
      childEditScope,
      (count) => count > 0
    );
    evidence.fileDiffs.samples = [inlineBefore, inlineHidden, inlineShown];
    evidence.fileDiffs.hidden = inlineHidden === 0;
    evidence.fileDiffs.shown = inlineBefore > 0 && inlineShown > 0;

    await client.send(
      child.id,
      `${childTurn.promptMarker} Reply with only ${childTurn.responseMarker}. Do not use tools or subagents.`,
      parseModel(requestedModel)
    );
    const childDelivery = await waitForQueuedDelivery(client, child.id, [childTurn], timeoutMs);
    evidence.leakage.childPresentInChild =
      childDelivery.settled &&
      (await editor.evaluate(
        `document.body.innerText.includes(${JSON.stringify(childTurn.promptMarker)})`
      ));

    const returnedEditorToRoot =
      (await editor.clickText('Return to parent')) ||
      (await editor.click(
        '[aria-label^="Back to parent session"], [aria-label="Back to parent session"]'
      ));
    if (!returnedEditorToRoot) {
      throw new Error('AI-18 could not return the managed child editor to its root session');
    }
    editor.close();
    editor = await waitForTarget(
      launch.remoteDebuggingPort,
      { surface: 'editor', viewId: editorViewId, sessionId: tracked.id },
      20_000
    );
    const returnedRoot = await waitForSessionSnapshot(
      editor,
      tracked.title,
      tracked.id,
      launch.remoteDebuggingPort
    );
    evidence.editor.samples.push({ phase: 'returned-root', snapshot: returnedRoot });
    evidence.editor.rootTitleRouted &&=
      returnedRoot.title === tracked.title && returnedRoot.routeSessionId === tracked.id;
    await sampleConfiguration(editor, 'editor-root-return');
    evidence.leakage.childAbsentFromRoot = !(await editor.evaluate(
      `document.body.innerText.includes(${JSON.stringify(childTurn.promptMarker)})`
    ));
    const returnedRootMessages = await client.messages(tracked.id, 1000);
    evidence.leakage.rootPresentInRoot =
      returnedRoot?.routeSessionId === tracked.id &&
      returnedRootMessages.some(
        (entry) =>
          entry?.info?.role === 'user' &&
          entry.parts?.some((part) => part?.type === 'text' && part.text?.includes(streamMarker))
      );
    if (!(await restoreSidebarSessionFromPicker(sidebar, tracked.id, tracked.title))) {
      throw new Error('AI-18 could not restore the root sidebar after child routing');
    }

    await editor.key('.interactive-list', 'End');
    await reloadVscodeWindow(launch.remoteDebuggingPort, 20_000, editor.targetId);
    await sidebar.rebind();
    await editor.rebind();
    const restoredRoot = await waitForSessionSnapshot(
      editor,
      tracked.title,
      tracked.id,
      launch.remoteDebuggingPort
    );
    evidence.editor.samples.push({ phase: 'reloaded-root', snapshot: restoredRoot });
    evidence.editor.restored =
      editor.targetContext?.viewId === editorViewId &&
      restoredRoot.title === tracked.title &&
      restoredRoot.routeSessionId === tracked.id;
    await sampleConfiguration(editor, 'editor-reload');

    const initialDelivery = await waitForQueuedDelivery(
      client,
      tracked.id,
      queueTurns.slice(0, 2),
      timeoutMs * 3
    );
    if (!initialDelivery.settled) {
      throw new Error('AI-18 initial root queue did not settle before the close-handoff phase');
    }
    const reloadRowCounts = await editor.evaluate(`(() => {
      const ids = ${JSON.stringify([
        ...initialDelivery.delivery.userIds,
        ...initialDelivery.delivery.assistantIds,
      ])};
      return ids.map((id) => id
        ? document.querySelectorAll('[data-msg-id="' + CSS.escape(id) + '"]').length
        : 0);
    })()`);

    const closeStreamPrompt = `${closeStreamMarker} Produce 120 numbered paragraphs of 35-45 words each and end with ${responseMarker}-CLOSE-STREAM-END. Do not use tools, spawn subagents, delegate work, or change files.`;
    if (!(await sendComposerPromptWithRetry(editor, closeStreamPrompt))) {
      throw new Error('AI-18 could not start the close-handoff stream from the editor');
    }
    if (!(await waitForBusy(client, tracked.id, Math.min(timeoutMs, 15_000)))) {
      throw new Error('AI-18 close-handoff stream did not become busy');
    }
    await enqueueTurn(editor, editorViewId, queueTurns[2], 'editor-close-enqueue');
    const closingTargetId = editor.targetId;
    if (!closingTargetId) throw new Error('AI-18 editor target lost its target ID before close');
    await executeVscodeCommand(launch.remoteDebuggingPort, 'View: Close Editor');
    const targetDisappeared = await waitForTargetDisappearance(
      launch.remoteDebuggingPort,
      closingTargetId,
      10_000
    );
    editor.close();
    editor = null;
    await sidebar.rebind();
    const closedCount = await waitForSessionQueueCount(sidebar, tracked.id, 1, 5_000);
    evidence.counts.samples.push({ phase: 'closed', count: closedCount.count });
    await openAi18SidebarSession(
      sidebar,
      tracked.id,
      tracked.title,
      launch.remoteDebuggingPort,
      runSessionTitles
    );
    const closedQueue = await sidebar.captureActionState();
    evidence.queues.closedHandoff = {
      displayedCount: closedCount.count,
      queueItems: closedQueue.queueItems,
      targetDisappeared,
    };
    evidence.queues.samples.push({ phase: 'closed-handoff', state: closedQueue });

    const queuedDelivery = await waitForQueuedDelivery(
      client,
      tracked.id,
      queueTurns,
      timeoutMs * 3
    );
    const settled = queuedDelivery.settled;
    const messages = queuedDelivery.messages;
    const rootModelEvidence = promptModelFailures(
      messages,
      [streamMarker, ...queueTurns.map((turn) => turn.promptMarker), closeStreamMarker],
      requestedModel
    );
    const childModelEvidence = promptModelFailures(
      childDelivery.messages,
      [childEditTurn.promptMarker, childTurn.promptMarker],
      requestedModel
    );
    const modelEvidence = {
      root: rootModelEvidence.observations,
      child: childModelEvidence.observations,
      failures: [...rootModelEvidence.failures, ...childModelEvidence.failures],
    };
    evidence.delivery = {
      ...queuedDelivery.delivery,
      reloadRowCounts,
    };
    const finalQueue = await sidebar.captureActionState();
    await sidebar.click('[aria-label="Back to sessions"]');
    await new Promise((resolve) => setTimeout(resolve, 250));
    const finalCount = await waitForSessionQueueCount(sidebar, tracked.id, 0, 5_000);
    evidence.counts.samples.push({ phase: 'final', count: finalCount.count });
    evidence.counts.accurate =
      finalQueue.queueItems.length === 0 &&
      JSON.stringify(evidence.counts.samples.map((sample) => sample.count)) ===
        JSON.stringify([2, 1, 0]);
    await openAi18SidebarSession(
      sidebar,
      tracked.id,
      tracked.title,
      launch.remoteDebuggingPort,
      runSessionTitles
    );
    await sidebar.key('.interactive-list', 'End');
    const finalRowCounts = await sidebar.evaluate(`(() => {
      const ids = ${JSON.stringify([
        ...evidence.delivery.userIds,
        ...evidence.delivery.assistantIds,
      ])};
      return ids.map((id) => id
        ? document.querySelectorAll('[data-msg-id="' + CSS.escape(id) + '"]').length
        : 0);
    })()`);
    evidence.delivery.finalRowCounts = finalRowCounts;
    evidence.delivery.reloadDuplicateFree =
      reloadRowCounts.every((count) => count === 1) &&
      finalRowCounts.every((count) => count <= 1) &&
      finalRowCounts[queueTurns.length - 1] === 1 &&
      finalRowCounts[queueTurns.length * 2 - 1] === 1;
    evidence.leakage.childAbsentFromRoot &&= !(await sidebar.evaluate(
      `document.body.innerText.includes(${JSON.stringify(childTurn.promptMarker)})`
    ));
    evidence.leakage.rootPresentInRoot &&= evidence.delivery.userCounts[2] === 1;
    await sidebar.click('[aria-label="Message composer"]');
    evidence.focus.usable = (await sidebar.captureActionState()).focusOwner === 'composer';
    const descendantInventory = inventoryVerifiedDescendants(
      manifest,
      await client.listSessions(),
      tracked.id,
      descendantsBefore,
      'AI-18'
    );
    evidence.unexpectedDescendants = descendantInventory.observed.filter(
      (session) => session.id !== child.id
    );
    const fixtureAfterPreparation = await fixtureStatus(manifest.workspace);
    const failures = multiWebviewScenarioFailures(evidence);
    failures.push(...modelEvidence.failures);
    if (!settled) failures.push('AI-18 root and queued streams did not settle');
    if (
      fixtureAfterPreparation.commit !== fixture.commit ||
      fixtureAfterPreparation.status !== fixture.status ||
      fixtureAfterPreparation.contentHash !== fixture.contentHash ||
      JSON.stringify(fixtureAfterPreparation.changedPaths) !== JSON.stringify(fixture.changedPaths)
    ) {
      failures.push('AI-18 changed the recorded repository fixture state');
    }
    const result = {
      scenario: 'AI-18',
      promptRun,
      prepared: failures.length === 0,
      model: requestedModel,
      selectedModel,
      permissionMode,
      childSession: { id: child.id, title: childTitle, parentID: tracked.id },
      settled,
      evidence,
      modelEvidence,
      failures,
      fixtureAfterPreparation,
    };
    manifest.livePreparation ??= {};
    manifest.livePreparation['AI-18'] = { ...result, recordedAt: new Date().toISOString() };
    await writeJsonAtomic(manifestPath, manifest);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (failures.length > 0) throw new Error(`AI-18 failed: ${failures.join('; ')}`);
  } finally {
    editor?.close();
  }
}

async function waitForObservation(read, accept, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let value = null;
  while (Date.now() < deadline) {
    value = await read();
    if (accept(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return value;
}

export function lifecycleScenarioFailures(evidence) {
  const failures = [];
  if (!evidence.editor.opened || !evidence.editor.revealed || !evidence.editor.sameViewId) {
    failures.push('editor did not hide and reveal through the same stable viewId');
  }
  if (!evidence.permissions.sidebarFullReachedEditor) {
    failures.push('sidebar full permission mode did not reach the editor');
  }
  if (!evidence.permissions.editorAutoReachedSidebar) {
    failures.push('editor auto permission mode did not reach the sidebar');
  }
  if (!evidence.queue.initialOwner || !evidence.queue.paused) {
    failures.push('editor queue row did not preserve its exact owner and paused state');
  }
  if (!evidence.queue.edited || !evidence.queue.transferredToSidebar) {
    failures.push('edited queue row did not transfer from the hidden editor to the sidebar');
  }
  if (!evidence.queue.steerDispatched || !evidence.queue.removedAfterSteer) {
    failures.push('paused queue row was not dispatched manually as a steer');
  }
  if (!evidence.editor.orphanedDraftCleared) {
    failures.push('revealed editor retained the transferred queued edit as an ordinary draft');
  }
  const delivery = evidence.delivery;
  if (
    !delivery ||
    delivery.userCounts?.[0] !== 1 ||
    delivery.assistantCounts?.[0] !== 1 ||
    delivery.assistantValid?.[0] !== true
  ) {
    failures.push('manual steer did not produce one valid canonical user/assistant delivery');
  }
  if (evidence.unexpectedDescendants.length > 0) {
    failures.push('lifecycle scenario created an unexpected descendant session');
  }
  return failures;
}

async function runLifecycleScenario({
  cdp: sidebar,
  client,
  launch,
  manifest,
  manifestPath,
  requestedModel,
  selectedModel,
  tracked,
  fixture,
  descendantsBefore,
  promptRun,
  markModelMayEdit,
  timeoutMs,
}) {
  const runSessionTitles = manifest.runSessions
    .filter((session) => !session.deleted)
    .map((session) => session.title);
  await openAi18SidebarSession(
    sidebar,
    tracked.id,
    tracked.title,
    launch.remoteDebuggingPort,
    runSessionTitles
  );
  if (!(await waitForSessionQuiescence(client, sidebar, tracked.id, timeoutMs * 3))) {
    throw new Error('AI-19 root session and queue did not become quiescent before replay');
  }

  const streamMarker = `[VFZ:${manifest.seed}:AI19:R${String(promptRun)}:STREAM]`;
  const queueTurn = {
    promptMarker: `[VFZ:${manifest.seed}:AI19:R${String(promptRun)}:STEER]`,
    responseMarker: `VFZ-AI19-R${String(promptRun)}-STEER-END`,
  };
  const evidence = {
    editor: {
      opened: false,
      revealed: false,
      sameViewId: false,
      orphanedDraftCleared: false,
      viewId: null,
    },
    permissions: {
      sidebarFullReachedEditor: false,
      editorAutoReachedSidebar: false,
      samples: [],
    },
    queue: {
      id: null,
      initialOwner: false,
      paused: false,
      edited: false,
      transferredToSidebar: false,
      steerDispatched: false,
      removedAfterSteer: false,
      samples: [],
    },
    delivery: null,
    unexpectedDescendants: [],
  };

  let editor = null;
  try {
    editor = await openSessionEditorWithRetry(
      sidebar,
      launch.remoteDebuggingPort,
      tracked.id,
      tracked.title,
      runSessionTitles,
      20_000
    );
    const editorViewId = editor.targetContext?.viewId;
    if (!editorViewId) throw new Error('AI-19 editor target has no stable viewId');
    evidence.editor.opened = true;
    evidence.editor.viewId = editorViewId;
    if (!(await restoreSidebarSessionFromPicker(sidebar, tracked.id, tracked.title))) {
      throw new Error('AI-19 could not restore the root in the sidebar');
    }

    await sidebar.selectPermissionMode('full');
    const editorFull = await waitForObservation(
      () => editor.readComposerConfiguration(),
      (configuration) => configuration?.permissionMode === 'full'
    );
    evidence.permissions.samples.push({ phase: 'sidebar-full', editor: editorFull });
    evidence.permissions.sidebarFullReachedEditor = editorFull?.permissionMode === 'full';

    await editor.selectPermissionMode('auto');
    const sidebarAuto = await waitForObservation(
      () => sidebar.readComposerConfiguration(),
      (configuration) => configuration?.permissionMode === 'auto'
    );
    evidence.permissions.samples.push({ phase: 'editor-auto', sidebar: sidebarAuto });
    evidence.permissions.editorAutoReachedSidebar = sidebarAuto?.permissionMode === 'auto';

    markModelMayEdit();
    const streamPrompt = `${streamMarker} Produce 120 numbered paragraphs of 35-45 words each and end with VFZ-AI19-R${String(promptRun)}-STREAM-END. Do not use tools, spawn subagents, delegate work, or change files.`;
    if (!(await sendComposerPromptWithRetry(sidebar, streamPrompt))) {
      throw new Error('AI-19 could not start the root stream');
    }
    if (!(await waitForBusy(client, tracked.id, Math.min(timeoutMs, 15_000)))) {
      throw new Error('AI-19 did not observe the root stream become busy');
    }
    if (
      !(await sendComposerPromptWithRetry(
        editor,
        `${queueTurn.promptMarker} Reply with only ${queueTurn.responseMarker}. Do not use tools or subagents.`
      ))
    ) {
      throw new Error('AI-19 could not enqueue the editor follow-up');
    }
    const queued = await waitForQueueMarker(editor, queueTurn.promptMarker);
    if (!queued.item?.id) throw new Error('AI-19 could not identify the editor queue row');
    evidence.queue.id = queued.item.id;
    evidence.queue.initialOwner = queued.item.ownerViewId === editorViewId;
    evidence.queue.samples.push({ phase: 'enqueued', row: queued.item });

    if (!(await editor.clickQueueControl(queued.item.id, 'Pause queued message'))) {
      throw new Error('AI-19 could not pause the editor queue row');
    }
    const paused = await waitForObservation(
      () => editor.readQueueRow(queued.item.id),
      (row) => row?.paused === true
    );
    evidence.queue.paused = paused?.paused === true;
    evidence.queue.samples.push({ phase: 'paused', row: paused });

    if (!(await editor.clickQueueControl(queued.item.id, 'Edit queued message'))) {
      throw new Error('AI-19 could not edit the queued row');
    }
    const edited = await waitForObservation(
      async () => ({
        row: await editor.readQueueRow(queued.item.id),
        composerText: await editor.readComposerText(),
      }),
      (sample) =>
        sample?.row?.editing === true && sample.composerText.includes(queueTurn.promptMarker)
    );
    evidence.queue.edited =
      edited?.row?.editing === true && edited.composerText.includes(queueTurn.promptMarker);
    evidence.queue.samples.push({ phase: 'editing', ...edited });

    await executeVscodeCommand(launch.remoteDebuggingPort, 'File: New Untitled Text File');
    await new Promise((resolve) => setTimeout(resolve, 500));
    await sidebar.rebind();
    const transferred = await waitForObservation(
      () => sidebar.readQueueRow(queued.item.id),
      (row) => row?.ownerViewId === 'sidebar' && row.paused === true
    );
    evidence.queue.transferredToSidebar =
      transferred?.ownerViewId === 'sidebar' && transferred.paused === true;
    evidence.queue.samples.push({ phase: 'hidden-transfer', row: transferred });

    evidence.queue.steerDispatched = await sidebar.clickQueueControl(
      queued.item.id,
      'Send as Steer'
    );
    const removed = await waitForObservation(
      () => sidebar.readQueueRow(queued.item.id),
      (row) => row === null
    );
    evidence.queue.removedAfterSteer = removed === null;

    if (!(await sidebar.contextClick('.chat-header-session-title'))) {
      throw new Error('AI-19 could not reopen the root session actions');
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (!(await sidebar.clickText('Open as Editor'))) {
      throw new Error('AI-19 could not reveal the root editor');
    }
    const visible = await waitForObservation(
      () => editor.isDocumentVisible(),
      (isVisible) => isVisible === true,
      20_000
    );
    await editor.rebind();
    const restored = await waitForSessionSnapshot(
      editor,
      tracked.title,
      tracked.id,
      launch.remoteDebuggingPort
    );
    const cleared = await waitForObservation(
      async () => ({
        composerText: await editor.readComposerText(),
        row: await editor.readQueueRow(queued.item.id),
      }),
      (sample) =>
        sample?.row === null && !sample.composerText.includes(queueTurn.promptMarker)
    );
    evidence.editor.revealed = visible === true && restored.routeSessionId === tracked.id;
    evidence.editor.sameViewId = editor.targetContext?.viewId === editorViewId;
    evidence.editor.orphanedDraftCleared =
      cleared?.row === null && !cleared.composerText.includes(queueTurn.promptMarker);

    const queuedDelivery = await waitForQueuedDelivery(
      client,
      tracked.id,
      [queueTurn],
      timeoutMs * 3
    );
    evidence.delivery = queuedDelivery.delivery;
    if (!(await waitForIdle(client, tracked.id, timeoutMs * 3))) {
      throw new Error('AI-19 streams did not settle');
    }
    evidence.unexpectedDescendants = inventoryVerifiedDescendants(
      manifest,
      await client.listSessions(),
      tracked.id,
      descendantsBefore,
      'AI-19'
    ).observed;

    const messages = await client.messages(tracked.id, 1000);
    const modelEvidence = promptModelFailures(
      messages,
      [streamMarker, queueTurn.promptMarker],
      requestedModel
    );
    const fixtureAfterPreparation = await fixtureStatus(manifest.workspace);
    const failures = lifecycleScenarioFailures(evidence);
    failures.push(...modelEvidence.failures);
    if (
      fixtureAfterPreparation.commit !== fixture.commit ||
      fixtureAfterPreparation.status !== fixture.status ||
      fixtureAfterPreparation.contentHash !== fixture.contentHash ||
      JSON.stringify(fixtureAfterPreparation.changedPaths) !== JSON.stringify(fixture.changedPaths)
    ) {
      failures.push('AI-19 changed the recorded repository fixture state');
    }
    const result = {
      scenario: 'AI-19',
      promptRun,
      prepared: failures.length === 0,
      model: requestedModel,
      selectedModel,
      evidence,
      modelEvidence,
      failures,
      fixtureAfterPreparation,
    };
    manifest.livePreparation ??= {};
    manifest.livePreparation['AI-19'] = { ...result, recordedAt: new Date().toISOString() };
    await writeJsonAtomic(manifestPath, manifest);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (failures.length > 0) throw new Error(`AI-19 failed: ${failures.join('; ')}`);
  } finally {
    editor?.close();
  }
}

async function runLive(options) {
  const manifestPath = path.resolve(required(options, 'manifest'));
  const launchPath = path.resolve(required(options, 'launch'));
  const scenario = options.scenario ?? 'AI-07';
  if (!['AI-07', 'AI-08', 'AI-17', 'AI-18', 'AI-19'].includes(scenario)) {
    throw new Error('--scenario must be AI-07, AI-08, AI-17, AI-18, or AI-19');
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
  manifest.workspace = await requireFixtureWorkspace(manifest.workspace);
  const launchWorkspace = await requireFixtureWorkspace(launch.workspace);
  if (launchWorkspace !== manifest.workspace) {
    throw new Error(`Launch workspace ${launch.workspace} does not match ${manifest.workspace}`);
  }
  await verifyVscodeLaunchIdentity(launch);
  if (!manifest.hostPersistenceVerifiedAt) {
    throw new Error('Run verify-run for this manifest after launching the dedicated host');
  }
  const fixture = await fixtureStatus(manifest.workspace);
  if (!fixtureIsSafeForScenario(fixture, manifest, scenario)) {
    throw new Error('The OpenCode fixture is not at the clean recorded baseline');
  }
  const tracked = manifest.runSessions.find((session) => !session.deleted && !session.parentID);
  if (!tracked) throw new Error('The manifest has no active run session');
  const client = new OpenCodeClient(manifest.server, manifest.workspace);
  if (
    scenario === 'AI-08' &&
    !manifest.runSessions.some(
      (session) => !session.deleted && session.createdBy === 'AI-08 session switch'
    )
  ) {
    const fork = await client.request('POST', `/session/${encodeURIComponent(tracked.id)}/fork`);
    const title = `VFZ ${manifest.seed} AI-08 alternate`;
    const alternate = await client.request('PATCH', `/session/${encodeURIComponent(fork.id)}`, {
      title,
    });
    manifest.runSessions.push({
      id: alternate.id,
      title,
      deleted: false,
      createdBy: 'AI-08 session switch',
    });
    await writeJsonAtomic(manifestPath, manifest);
  }
  const requestedModel = validateLiveModel(options.model ?? DEFAULT_MODEL);
  const targetSurface = options.surface ?? 'sidebar';
  if (!['sidebar', 'editor'].includes(targetSurface)) {
    throw new Error('--surface must be sidebar or editor');
  }
  const targetViewId = options['view-id'] ?? (targetSurface === 'sidebar' ? 'sidebar' : null);
  if (targetSurface === 'editor' && !targetViewId) {
    throw new Error('--view-id is required when --surface is editor');
  }
  if (
    ['AI-18', 'AI-19'].includes(scenario) &&
    (targetSurface !== 'sidebar' || targetViewId !== 'sidebar')
  ) {
    throw new Error(`${scenario} must start from --surface sidebar --view-id sidebar`);
  }
  const requestedTarget = {
    surface: targetSurface,
    viewId: targetViewId,
    sessionId: options['session-id'] ?? tracked.id,
    allowSessionNavigation: targetSurface === 'sidebar',
  };
  const cdp = await CdpController.connect(launch.remoteDebuggingPort, requestedTarget);
  const promptRun = Number(manifest.livePreparation?.[scenario]?.promptRun ?? 0) + 1;
  manifest.livePreparation ??= {};
  manifest.livePreparation[scenario] = {
    ...manifest.livePreparation[scenario],
    promptRun,
  };
  const attempts = [];
  let best = null;
  let modelMayEdit = false;
  let controllerError = null;
  let descendantsBefore = null;
  try {
    await (async () => {
    if (scenario === 'AI-17') {
      for (let restart = 0; restart < restartCount; restart += 1) {
        await reloadVscodeWindow(launch.remoteDebuggingPort, 20_000, cdp.targetId);
        await cdp.rebind();
      }
    }
    if (scenario === 'AI-18') {
      await openAi18SidebarSession(
        cdp,
        tracked.id,
        tracked.title,
        launch.remoteDebuggingPort,
        manifest.runSessions.filter((session) => !session.deleted).map((session) => session.title)
      );
    } else {
      await openRunSession(cdp, tracked.id, tracked.title);
    }
    if (scenario === 'AI-08' && manifest.hostState?.fileDiffsEnabled !== true) {
      await executeVscodeCommand(launch.remoteDebuggingPort, 'Varro: Show File Diffs');
      await new Promise((resolve) => setTimeout(resolve, 300));
      manifest.hostState = {
        ...manifest.hostState,
        fileDiffsEnabled: true,
      };
      await writeJsonAtomic(manifestPath, manifest);
    }
    await cdp.click('[aria-label="Scroll to latest message"]');
    await cdp.key('.interactive-list', 'End');
    const selectedModel = await cdp.selectExactModel(requestedModel);
    const selectedPermissionMode = ['AI-07', 'AI-08'].includes(scenario)
      ? await cdp.selectPermissionMode('full')
      : null;
    const pendingInput = await waitForNoPendingInput(client, tracked.id);
    if (pendingInput.permissions.length > 0 || pendingInput.questions.length > 0) {
      throw new Error(
        `Run session has ${String(pendingInput.permissions.length)} pending permissions and ${String(pendingInput.questions.length)} pending questions`
      );
    }
    const sessionsBefore = await client.listSessions();
    descendantsBefore = new Set(
      findSessionDescendants(sessionsBefore, tracked.id).map((session) => session.id)
    );
    if (scenario === 'AI-17') {
      const tokens = [
        ...Array.from({ length: 20 }, (_, index) =>
          `VFZ-DUP-${String(index + 1).padStart(2, '0')}`
        ),
        'VFZ-DUP-END',
      ];
      const marker = `[VFZ:${manifest.seed}:AI-17:R${String(promptRun)}:DUP]`;
      const prompt = buildDuplicateDeliveryPrompt(manifest.seed, tokens, promptRun);
      await cdp.startDuplicateDeliveryObservation(marker, tokens);
      modelMayEdit = true;
      const sent = await cdp.sendComposerPrompt(prompt);
      const disposition = sent
        ? await waitForPromptDisposition(client, cdp, tracked.id, marker)
        : { status: 'unobserved', userIds: [], queuedItemIds: [] };
      const sawBusy =
        disposition.status === 'admitted' &&
        (await waitForBusy(client, tracked.id, Math.min(timeoutMs, 15_000)));
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
      const failures = !sent
        ? ['native composer input was unavailable']
        : disposition.status !== 'admitted'
          ? [`prompt submission was ${disposition.status}`]
          : duplicateDeliveryFailures(observation, sawBusy);
      if (!settled) failures.push('model stream did not settle');
      if (canonicalDelivery.error) failures.push('canonical session messages could not be read');
      else failures.push(...canonicalDeliveryFailures(canonicalDelivery));
      const requestedModelParts = parseModel(requestedModel);
      if (
        canonicalDelivery.assistants?.some(
          (assistant) =>
            assistant.providerID !== requestedModelParts.providerID ||
            assistant.modelID !== requestedModelParts.modelID
        )
      ) {
        failures.push(`canonical assistant did not use ${requestedModel}`);
      }
      const descendantInventory = inventoryVerifiedDescendants(
        manifest,
        await client.listSessions(),
        tracked.id,
        descendantsBefore,
        scenario
      );
      const descendantsObserved = descendantInventory.observed;
      if (descendantsObserved.length > 0) {
        failures.push('controlled stream created an unexpected descendant session');
      }
      const fixtureAfterPreparation = await fixtureStatus(manifest.workspace);
      if (
        fixtureAfterPreparation.status !== fixture.status ||
        fixtureAfterPreparation.commit !== fixture.commit ||
        fixtureAfterPreparation.contentHash !== fixture.contentHash ||
        JSON.stringify(fixtureAfterPreparation.changedPaths) !== JSON.stringify(fixture.changedPaths)
      ) {
        failures.push('controlled stream changed the repository fixture');
      }
      const result = {
        scenario,
        promptRun,
        restartCount,
        prepared: failures.length === 0,
        prompt,
        model: requestedModel,
        selectedModel,
        selectedPermissionMode,
        target: { ...requestedTarget, boundViewId: cdp.targetContext?.viewId ?? null },
        sent,
        disposition,
        sawBusy,
        settled,
        observation,
        canonicalDelivery,
        descendantsObserved,
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
    if (scenario === 'AI-18') {
      return await runMultiWebviewScenario({
        cdp,
        client,
        launch,
        manifest,
        manifestPath,
        options,
        requestedModel,
        selectedModel,
        tracked,
        fixture,
        descendantsBefore,
        promptRun,
        markModelMayEdit: () => {
          modelMayEdit = true;
        },
      });
    }
    if (scenario === 'AI-19') {
      return await runLifecycleScenario({
        cdp,
        client,
        launch,
        manifest,
        manifestPath,
        requestedModel,
        selectedModel,
        tracked,
        fixture,
        descendantsBefore,
        promptRun,
        timeoutMs,
        markModelMayEdit: () => {
          modelMayEdit = true;
        },
      });
    }
    let handoff = null;
    let actions = [];
    let scope = null;
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
      const prompt = buildLivePrompt({
        seed: manifest.seed,
        scenario,
        promptRun,
        attempt,
        missing,
      });
      const marker = prompt.match(/^\[VFZ:[^\]]+\]/)?.[0] ?? '';
      await cdp.wheel('.interactive-list', -96, 'right');
      await new Promise((resolve) => setTimeout(resolve, 100));
      const reattached = await cdp.click('[aria-label="Scroll to latest message"]');
      if (!reattached) await cdp.key('.interactive-list', 'End');
      await new Promise((resolve) => setTimeout(resolve, 100));
      modelMayEdit = true;
      const sent = await cdp.sendComposerPrompt(prompt);
      if (!sent) throw new Error('Native composer input was unavailable');
      const disposition = await waitForPromptDisposition(client, cdp, tracked.id, marker);
      const promptSeen = disposition.status === 'admitted';
      const gate = promptSeen
        ? await waitForLiveGate({
            client,
            cdp,
            sessionId: tracked.id,
            scenario,
            timeoutMs,
            marker,
          })
        : {
            snapshot: await cdp.snapshot(marker),
            bestSnapshot: null,
            missing: [`prompt submission was ${disposition.status}`],
            latestMissing: [`prompt submission was ${disposition.status}`],
            sawBusy: false,
            observations: [],
          };
      if (promptSeen && !gate.sawBusy && gate.missing.length === 0) {
        gate.missing = ['active model stream'];
      }
      best = gate;
      gate.marker = marker;
      const attemptRecord = {
        attempt,
        prompt,
        promptSeen,
        disposition,
        sawBusy: gate.sawBusy,
        missingAfterAttempt: gate.missing,
        latestMissing: gate.latestMissing,
        snapshot: gate.snapshot,
        bestSnapshot: gate.bestSnapshot,
        observations: gate.observations,
      };
      attempts.push(attemptRecord);
      if (!promptSeen) break;
      if (gate.missing.length > 0) continue;

      scope = gate.bestSnapshot?.turnMessageIds?.length
        ? {
            messageIds: gate.bestSnapshot.turnMessageIds,
            partIds: gate.bestSnapshot.turnPartIds,
            renderKeys: gate.bestSnapshot.turnRenderKeys,
          }
        : null;
      if (gate.bestSnapshot?.nestedActivityScroller?.hasRange) {
        handoff = await nestedHandoff(cdp, gate.marker, scope);
        if (shouldRetryNestedHandoff(handoff)) {
          const firstAttempt = handoff;
          await new Promise((resolve) => setTimeout(resolve, 250));
          const retry = await nestedHandoff(cdp, gate.marker, scope);
          handoff = { ...retry, recoveryAttempts: [firstAttempt, retry] };
        }
      }
      attemptRecord.handoff = handoff;
      attemptRecord.actionScope = scope;
      if (scenario === 'AI-07') break;

      actions = await executeActionPlan(
        cdp,
        manifest.actionPlan,
        tracked.title,
        launch.remoteDebuggingPort,
        {
          isActive: () => client.isBusy(tracked.id),
          marker: gate.marker,
          sessionId: tracked.id,
          scope,
        }
      );
      attemptRecord.actions = actions;
      const attemptActionFailure = actions.find((action) => !action.executed);
      if (!shouldRetryAi08WithFreshStream(attemptActionFailure, attempt, maxPrompts)) break;
    }
    const settled = await waitForIdle(client, tracked.id, timeoutMs);
    const fixtureAfterPreparation = await fixtureStatus(manifest.workspace);
    const actionFailure = actions.find((action) => !action.executed);
    const promptMarkers = attempts.map((attempt) => attempt.prompt.match(/^\[VFZ:[^\]]+\]/)?.[0]).filter(Boolean);
    const modelEvidence = promptModelFailures(
      await client.messages(tracked.id),
      promptMarkers,
      requestedModel
    );
    const descendantInventory = inventoryVerifiedDescendants(
      manifest,
      await client.listSessions(),
      tracked.id,
      descendantsBefore,
      scenario
    );
    const descendantsObserved = descendantInventory.observed;
    const failures = [...modelEvidence.failures];
    if (descendantsObserved.length > 0) {
      failures.push('bounded live scenario created an unexpected descendant session');
    }
    const result = {
      scenario,
      promptRun,
      prepared:
        best?.missing.length === 0 &&
        (handoff === null || handoff.passed === true) &&
        !actionFailure &&
        failures.length === 0,
      model: requestedModel,
      selectedModel,
      selectedPermissionMode,
      modelEvidence,
      target: { ...requestedTarget, boundViewId: cdp.targetContext?.viewId ?? null },
      attempts,
      handoff,
      actions,
      actionScope: scope,
      descendantsObserved,
      failures,
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
    })();
  } catch (error) {
    controllerError = error;
  }
  try {
    cdp.close();
  } catch (error) {
    controllerError ??= error;
  }
  if (descendantsBefore) {
    try {
      const descendantInventory = inventoryVerifiedDescendants(
        manifest,
        await client.listSessions(),
        tracked.id,
        descendantsBefore,
        scenario
      );
      if (descendantInventory.recorded.length > 0) {
        await writeJsonAtomic(manifestPath, manifest);
      }
    } catch (error) {
      controllerError = controllerError
        ? new AggregateError(
            [controllerError, error],
            `Failed to inventory verified descendants after ${scenario}`,
            { cause: controllerError }
          )
        : error;
    }
  }
  let persistError = null;
  if (modelMayEdit) {
    try {
      await persistFixtureExitEvidence({
        manifest,
        manifestPath,
        scenario,
        workspace: manifest.workspace,
        error: controllerError,
      });
    } catch (error) {
      persistError = error;
    }
  }
  if (controllerError && persistError) {
    throw new AggregateError(
      [controllerError, persistError],
      `Failed to persist fixture exit evidence after ${scenario}`,
      { cause: controllerError }
    );
  }
  if (controllerError) throw controllerError;
  if (persistError) throw persistError;
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command === 'run') return runLive(options);
  throw new Error(
    'Usage: ai-fuzzy-live.mjs run --manifest <path> --launch <path> --scenario AI-07|AI-08|AI-17|AI-18|AI-19'
  );
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
