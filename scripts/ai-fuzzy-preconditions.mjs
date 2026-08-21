import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_SERVER = 'http://127.0.0.1:4096';
const DEFAULT_MODEL = 'openai/gpt-5.6-luna';
const DEFAULT_TURNS = 110;

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (!argument.startsWith('--')) throw new Error(`Unexpected argument: ${argument}`);
    const key = argument.slice(2);
    const value = rest[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${key}`);
    options[key] = value;
    index += 1;
  }
  return { command, options };
}

function requiredOption(options, name) {
  const value = options[name]?.trim();
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function textParts(message) {
  return Array.isArray(message?.parts)
    ? message.parts.filter((part) => part?.type === 'text').map((part) => part.text ?? '')
    : [];
}

export function inspectGoldenMessages(messages) {
  const users = messages.filter((message) => message?.info?.role === 'user');
  const completedAssistants = messages.filter(
    (message) => message?.info?.role === 'assistant' && message.info.time?.completed
  );
  const assistantByParent = new Map(
    completedAssistants.map((message) => [message.info.parentID, textParts(message).join('\n')])
  );
  const markedTurns = [];

  for (const user of users) {
    const prompt = textParts(user).join('\n');
    const match = /\[VFZ:[^\]]+:T(\d+)\]/.exec(prompt);
    if (!match) continue;
    const turn = Number(match[1]);
    const response = assistantByParent.get(user.info.id) ?? '';
    markedTurns.push({
      turn,
      completed: response.includes(`END-${turn}`),
      tall: response.length >= 500 || response.split('\n').length >= 10,
    });
  }

  const completeMarkedTurns = markedTurns.filter((turn) => turn.completed);
  return {
    messageCount: messages.length,
    userCount: users.length,
    completedAssistantCount: completedAssistants.length,
    completeMarkedTurnCount: completeMarkedTurns.length,
    tallMarkedTurnCount: completeMarkedTurns.filter((turn) => turn.tall).length,
    firstMarkedTurn: completeMarkedTurns.at(0)?.turn ?? null,
    lastMarkedTurn: completeMarkedTurns.at(-1)?.turn ?? null,
  };
}

export function buildPreconditionReport(summary, requiredTurns = DEFAULT_TURNS) {
  const completedTurns = Math.min(
    summary.userCount,
    summary.completedAssistantCount,
    summary.completeMarkedTurnCount
  );
  const checks = {
    'AI-01': completedTurns >= 32 && summary.tallMarkedTurnCount >= 3,
    'AI-02': completedTurns >= 32 && summary.tallMarkedTurnCount >= 3,
    'AI-03': completedTurns >= 3 && summary.tallMarkedTurnCount >= 3,
    'AI-04': completedTurns >= requiredTurns,
    'AI-05': summary.messageCount > 200,
    'AI-06': completedTurns >= 32,
    'AI-07': null,
    'AI-08': null,
  };
  return {
    staticReady: Object.values(checks).every((value) => value !== false),
    checks,
    notes: {
      'AI-07': 'Run ai:live to prepare the active stream, sticky prompt, edit, disclosure, and nested scroller.',
      'AI-08': 'Run ai:live to prepare the live gate and execute the recorded 50-action plan.',
    },
  };
}

function seededChoice(seed, scenario, step, options) {
  const hash = createHash('sha256').update(`${seed}:${scenario}:${String(step)}`).digest();
  return options[hash[0] % options.length];
}

export function buildActionPlan(seed) {
  const wheel = [-32, -96, -180, 96, 180, 420];
  const pause = [0, 1, 2, 4, 12];
  const width = [360, 430, 486, 720];
  const keys = ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Space', 'Shift+Space', 'Home', 'End'];
  const required = [
    'switch session away and back',
    'wheel verified nested scroller, then outer transcript',
    'PageDown on transcript',
    'Space on transcript',
    'Shift+Space on transcript',
    'PageDown in composer',
    'Space in inline editor',
    'resize sidebar',
    'expand disclosure',
    'collapse disclosure',
    'open file card and diff',
    'focus and close diff',
    'click sticky or jump to latest',
  ];
  return Array.from({ length: 50 }, (_, index) => {
    const step = index + 1;
    if (index < required.length) return { step, action: required[index] };
    const kind = seededChoice(seed, 'AI-08', step, ['wheel', 'key', 'resize']);
    if (kind === 'wheel') {
      return {
        step,
        action: 'wheel transcript',
        delta: seededChoice(seed, 'AI-08-wheel', step, wheel),
        pauseFrames: seededChoice(seed, 'AI-08-pause', step, pause),
      };
    }
    if (kind === 'key') {
      return { step, action: 'key on transcript', key: seededChoice(seed, 'AI-08-key', step, keys) };
    }
    return { step, action: 'resize sidebar', width: seededChoice(seed, 'AI-08-width', step, width) };
  });
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

  getSession(id) {
    return this.request('GET', `/session/${encodeURIComponent(id)}`);
  }

  listSessions() {
    return this.request('GET', '/session?roots=true&limit=1000');
  }

  listMessages(id) {
    return this.request('GET', `/session/${encodeURIComponent(id)}/message?limit=1000`);
  }
}

async function fixtureStatus(workspace) {
  const [{ stdout: status }, { stdout: commit }] = await Promise.all([
    execFileAsync('git', ['-C', workspace, 'status', '--short']),
    execFileAsync('git', ['-C', workspace, 'rev-parse', 'HEAD']),
  ]);
  return { status: status.trim(), commit: commit.trim() };
}

function parseModel(model) {
  const separator = model.indexOf('/');
  if (separator <= 0 || separator === model.length - 1) {
    throw new Error('--model must use provider/model format');
  }
  return { providerID: model.slice(0, separator), modelID: model.slice(separator + 1) };
}

function goldenPrompt(seed, turn) {
  if (turn % 10 === 0) {
    const form = (turn / 10) % 3;
    const request =
      form === 0
        ? 'Write 12 short numbered lines.'
        : form === 1
          ? 'Write a 5-column Markdown table with 14 rows.'
          : 'Write two fenced code blocks in different languages with a short explanation.';
    return `[VFZ:${seed}:T${String(turn).padStart(3, '0')}] ${request} End with END-${String(turn)}. Do not use tools.`;
  }
  return `[VFZ:${seed}:T${String(turn).padStart(3, '0')}] Reply with one short sentence ending in END-${String(turn)}. Do not use tools.`;
}

async function waitForTurn(client, sessionId, turn, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const messages = await client.listMessages(sessionId);
    const summary = inspectGoldenMessages(messages);
    if (summary.completeMarkedTurnCount >= turn) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Golden session ${sessionId} did not complete turn ${String(turn)} within ${String(timeoutMs)}ms`);
}

async function createGolden(client, { seed, turns, model, timeoutMs, baseline }) {
  const session = await client.request('POST', '/session', { title: `VFZ ${seed} golden-build` });
  if (!session?.id) throw new Error('OpenCode did not return a golden-build session ID');
  const parsedModel = parseModel(model);
  try {
    for (let turn = 1; turn <= turns; turn += 1) {
      await client.request('POST', `/session/${encodeURIComponent(session.id)}/prompt_async`, {
        parts: [{ type: 'text', text: goldenPrompt(seed, turn) }],
        model: parsedModel,
      });
      await waitForTurn(client, session.id, turn, timeoutMs);
      process.stdout.write(`Prepared golden turn ${String(turn)}/${String(turns)}\n`);
    }
    const title = `VFZ GOLDEN ${String(turns)}T v1 ${baseline.slice(0, 12)}`;
    await client.request('PATCH', `/session/${encodeURIComponent(session.id)}`, { title });
    return { id: session.id, title, generated: true };
  } catch (error) {
    error.message += `; incomplete run-created session retained for guarded cleanup: ${session.id}`;
    throw error;
  }
}

async function validateGolden(client, sessionId, requiredTurns) {
  const session = await client.getSession(sessionId);
  if (path.resolve(session.directory) !== path.resolve(client.workspace)) {
    throw new Error(`Session ${sessionId} belongs to ${session.directory}, not ${client.workspace}`);
  }
  const messages = await client.listMessages(sessionId);
  const summary = inspectGoldenMessages(messages);
  const preconditions = buildPreconditionReport(summary, requiredTurns);
  if (!preconditions.staticReady) {
    const failed = Object.entries(preconditions.checks)
      .filter(([, ready]) => ready === false)
      .map(([scenario]) => scenario)
      .join(', ');
    throw new Error(`Session ${sessionId} does not satisfy static preconditions for ${failed}`);
  }
  return { session, summary, preconditions };
}

async function findGolden(client, requiredTurns) {
  const sessions = await client.listSessions();
  const candidates = sessions.filter((session) => session?.title?.startsWith('VFZ GOLDEN '));
  for (const candidate of candidates) {
    try {
      return await validateGolden(client, candidate.id, requiredTurns);
    } catch {}
  }
  return null;
}

async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${String(process.pid)}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporaryPath, filePath);
}

async function prepareRun(options) {
  const seed = requiredOption(options, 'seed');
  const workspace = path.resolve(options.workspace ?? path.join(projectRoot, 'tmp/opencode'));
  const turns = Number(options.turns ?? DEFAULT_TURNS);
  if (!Number.isInteger(turns) || turns < 110) throw new Error('--turns must be an integer of at least 110');
  const client = new OpenCodeClient(options.server ?? DEFAULT_SERVER, workspace);
  const fixture = await fixtureStatus(workspace);
  if (fixture.status) throw new Error(`Fixture must be clean before preparation:\n${fixture.status}`);

  let validated;
  if (options.golden) validated = await validateGolden(client, options.golden, turns);
  else validated = await findGolden(client, turns);
  let source = validated
    ? { id: validated.session.id, title: validated.session.title, generated: false }
    : null;
  if (!source) {
    source = await createGolden(client, {
      seed,
      turns,
      model: options.model ?? DEFAULT_MODEL,
      timeoutMs: Number(options['turn-timeout-ms'] ?? 120_000),
      baseline: fixture.commit,
    });
    validated = await validateGolden(client, source.id, turns);
  }

  const fork = await client.request('POST', `/session/${encodeURIComponent(source.id)}/fork`);
  const title = `VFZ ${seed} golden-fork`;
  const renamed = await client.request('PATCH', `/session/${encodeURIComponent(fork.id)}`, { title });
  const validatedFork = await validateGolden(client, renamed.id, turns);
  const timestamp = new Date().toISOString().replaceAll(':', '').replaceAll('-', '').replace(/\.\d{3}Z$/, 'Z');
  const manifestPath = path.resolve(
    options.output ?? path.join(projectRoot, 'artifacts/ai-fuzzy', `${timestamp}-${seed}-preconditions.json`)
  );
  const manifest = {
    version: 1,
    seed,
    createdAt: new Date().toISOString(),
    server: options.server ?? DEFAULT_SERVER,
    workspace,
    fixture,
    modelForGoldenGeneration: source.generated ? options.model ?? DEFAULT_MODEL : null,
    golden: source,
    runSessions: [{ id: renamed.id, title, deleted: false }],
    hostPersistenceVerifiedAt: null,
    summary: validated.summary,
    preconditions: validatedFork.preconditions,
    actionPlan: buildActionPlan(seed),
  };
  await writeJsonAtomic(manifestPath, manifest);
  process.stdout.write(`${JSON.stringify({ manifestPath, ...manifest }, null, 2)}\n`);
}

async function inspect(options) {
  const sessionId = requiredOption(options, 'session');
  const workspace = path.resolve(options.workspace ?? path.join(projectRoot, 'tmp/opencode'));
  const client = new OpenCodeClient(options.server ?? DEFAULT_SERVER, workspace);
  const result = await validateGolden(client, sessionId, Number(options.turns ?? DEFAULT_TURNS));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function verifyRun(options) {
  const manifestPath = path.resolve(requiredOption(options, 'manifest'));
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const client = new OpenCodeClient(manifest.server, manifest.workspace);
  const fixture = await fixtureStatus(manifest.workspace);
  if (fixture.status) throw new Error(`Fixture must be clean before the timed run:\n${fixture.status}`);
  if (fixture.commit !== manifest.fixture.commit) {
    throw new Error(
      `Fixture commit changed from ${manifest.fixture.commit} to ${fixture.commit}; prepare a new run fork`
    );
  }
  for (const tracked of manifest.runSessions) {
    if (tracked.deleted) throw new Error(`Run session ${tracked.id} is already marked deleted`);
    const validated = await validateGolden(
      client,
      tracked.id,
      manifest.summary.completeMarkedTurnCount
    );
    if (!validated.session.title?.startsWith(`VFZ ${manifest.seed}`)) {
      throw new Error(`Run session ${tracked.id} no longer has the expected seed title prefix`);
    }
    tracked.verifiedAt = new Date().toISOString();
    tracked.summary = validated.summary;
  }
  manifest.hostPersistenceVerifiedAt = new Date().toISOString();
  await writeJsonAtomic(manifestPath, manifest);
  process.stdout.write(
    `Verified ${String(manifest.runSessions.length)} cold run fork(s) without opening the webview\n`
  );
}

async function cleanup(options) {
  const manifestPath = path.resolve(requiredOption(options, 'manifest'));
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const prefix = `VFZ ${manifest.seed}`;
  const client = new OpenCodeClient(manifest.server, manifest.workspace);
  const activeIds = new Set((await client.listSessions()).map((session) => session.id));
  for (const tracked of manifest.runSessions) {
    if (tracked.deleted) continue;
    if (!activeIds.has(tracked.id)) {
      tracked.deleted = true;
      tracked.deletedAt = new Date().toISOString();
      tracked.deletionNote = 'Already absent before cleanup';
      continue;
    }
    const session = await client.getSession(tracked.id);
    if (!session.title?.startsWith(prefix)) {
      throw new Error(`Refusing to delete ${tracked.id}: title does not start with ${prefix}`);
    }
    await client.request('DELETE', `/session/${encodeURIComponent(tracked.id)}`);
    tracked.deleted = true;
    tracked.deletedAt = new Date().toISOString();
  }
  const finalActiveIds = new Set((await client.listSessions()).map((session) => session.id));
  const remaining = manifest.runSessions.filter((session) => finalActiveIds.has(session.id));
  if (remaining.length > 0) throw new Error(`Cleanup verification failed for ${remaining.map((item) => item.id).join(', ')}`);
  await writeJsonAtomic(manifestPath, manifest);
  process.stdout.write(`Deleted and verified ${String(manifest.runSessions.length)} run session(s)\n`);
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command === 'prepare-run') return prepareRun(options);
  if (command === 'inspect') return inspect(options);
  if (command === 'verify-run') return verifyRun(options);
  if (command === 'cleanup') return cleanup(options);
  throw new Error(
    'Usage: ai-fuzzy-preconditions.mjs <prepare-run|inspect|verify-run|cleanup> [--seed value] [--golden session-id]'
  );
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
