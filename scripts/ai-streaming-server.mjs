/* oxlint-disable anti-slop/no-runtime-typeof -- Validate external capture data and HTTP query parameters. */
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';

const EVENT_TYPES = new Set([
  'message.updated',
  'message.removed',
  'message.part.updated',
  'message.part.delta',
  'message.part.removed',
  'session.updated',
  'session.status',
  'session.idle',
  'todo.updated',
  'session.diff',
]);

/**
 * await createStreamingServer({ capture, timeline, directory }) binds 127.0.0.1:0.
 * capture: { session, initialMessages, finalMessages, events?, initialStatus?,
 *            initialTodos?, initialDiff? }; messages are SDK {info, parts} entries.
 * timeline: [{delayMs, event, offsetMs?, sourceGapMs?}], already compressed by
 * buildReplayTimeline. delayMs is a nonnegative gap, not an absolute deadline.
 * directory: absolute replay workspace path; never read, created, or written.
 *
 * Returns {url, port, start, close, getResult}. start() synchronously rejects a
 * closed/already-started server or absence of a /global/event subscriber, then
 * returns a Promise<Result>. Deadlines are cumulative delayMs from one monotonic
 * epoch, so delivery work does not accumulate timing drift. Subscriber loss at
 * delivery fails the run; reconnecting does not restart it or resend old events.
 * close(): Promise<void>, idempotent, cancels waits, resolves an active start()
 * with state 'cancelled', and destroys ALL sockets, including SSE/idle sockets.
 * getResult(): detached snapshot with state ready/running/completed/cancelled/
 * failed, error, sessionID, directory, finalMessages, expectedMessages,
 * canonicalMatch (null until completed), and scheduler timing metrics. Equality
 * compares all JSON fields, ignoring object key order but preserving array order.
 * This is transcript verification, NOT a visual pass or delivery acknowledgement.
 *
 * Single-session captures only. Routing sessionID/sessionId references are
 * remapped recursively, including task metadata; foreign sessions are rejected.
 * Session IDs/project IDs are unique per instance; the session is detached from
 * any source parent. Message/part IDs and transcript content are preserved.
 * Session directory and assistant path cwd/root use the supplied directory.
 * No source filesystem paths in tool output are dereferenced. Use a clean editor
 * fixture: this server cannot prevent the extension itself from opening files.
 *
 * Supported events are listed in EVENT_TYPES. Invalid ordering (e.g. delta before
 * part creation), foreign routing, unsupported types and invalid delays reject
 * before listening. Message info updates merge; part updates replace snapshots;
 * deltas append to text/reasoning text only. Todo/diff events replace snapshots.
 * initialStatus defaults idle; initialTodos/initialDiff default empty. No final
 * capture state is exposed through REST until events actually produce it.
 *
 * GET-only API: bootstrap routes below, session catalog/detail/status/children,
 * messages/detail, todo/diff. Messages return chronological arrays; limit selects
 * the newest N before an opaque cursor, with x-next-cursor and Link headers for
 * older pages. Cursors retain identity boundaries across removals, not indexes.
 * All non-GET requests return 405, including config/dispose/prompt/abort/auth.
 * There are NO bootstrap mutation exceptions, model calls, tools, or FS access.
 */
export async function createStreamingServer({ capture, timeline, directory }) {
  if (!isAbsolute(directory ?? '')) throw new Error('directory must be an absolute path');
  const sourceID = capture?.session?.id;
  if (typeof sourceID !== 'string' || !sourceID) throw new Error('capture.session.id is required');
  if (!Array.isArray(timeline)) throw new Error('timeline must be an array');
  const sessionID = `ses_replay_${randomUUID().replaceAll('-', '')}`;
  const projectID = `replay_${randomUUID()}`;

  function remap(value) {
    if (Array.isArray(value)) return value.map(remap);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => {
        if (key === 'sessionID' || key === 'sessionId') {
          if (child !== sourceID) throw new Error(`Foreign session routing: ${String(child)}`);
          return [key, sessionID];
        }
        return [key, remap(child)];
      })
    );
  }

  function sessionInfo(info) {
    if (info?.id !== sourceID) throw new Error('Foreign session info');
    const mapped = remap(info);
    delete mapped.parentID;
    return { ...mapped, id: sessionID, projectID, directory };
  }

  function messageInfo(info) {
    if (!info?.id || info.sessionID !== sourceID) throw new Error('Invalid message info');
    const mapped = remap(info);
    if (mapped.path) mapped.path = { ...mapped.path, cwd: directory, root: directory };
    return mapped;
  }

  function messagesSnapshot(messages) {
    if (!Array.isArray(messages)) throw new Error('Capture messages must be arrays');
    const ids = new Set();
    return messages.map(({ info, parts }) => {
      if (ids.has(info?.id)) throw new Error('Duplicate message ID');
      ids.add(info?.id);
      if (!Array.isArray(parts)) throw new Error('Message parts must be arrays');
      const partIDs = new Set();
      for (const part of parts) {
        if (
          !part.id ||
          part.messageID !== info.id ||
          part.sessionID !== sourceID ||
          partIDs.has(part.id)
        ) {
          throw new Error('Invalid or duplicate message part');
        }
        partIDs.add(part.id);
      }
      return { info: messageInfo(info), parts: remap(parts) };
    });
  }

  function mapEvent(event) {
    if (!EVENT_TYPES.has(event?.type)) throw new Error(`Unsupported capture event: ${event?.type}`);
    const mapped = remap(event);
    // Capture sequence numbers belong to a different stream and must not dedupe replay events.
    delete mapped.id;
    delete mapped.seq;
    delete mapped.sequenceOnly;
    if (event.type === 'session.updated')
      mapped.properties.info = sessionInfo(event.properties.info);
    if (event.type === 'message.updated')
      mapped.properties.info = messageInfo(event.properties.info);
    const routing =
      mapped.properties?.sessionID ??
      mapped.properties?.info?.sessionID ??
      mapped.properties?.part?.sessionID ??
      mapped.properties?.info?.id;
    if (routing !== sessionID) throw new Error(`Missing session routing: ${event.type}`);
    return mapped;
  }

  const initial = {
    session: sessionInfo(capture.session),
    messages: messagesSnapshot(capture.initialMessages),
    status: structuredClone(capture.initialStatus ?? { type: 'idle' }),
    todos: remap(capture.initialTodos ?? []),
    diff: remap(capture.initialDiff ?? []),
  };
  const expectedMessages = messagesSnapshot(capture.finalMessages);
  for (const entry of capture.events ?? []) mapEvent(entry.event);
  let durationMs = 0;
  const entries = timeline.map((entry) => {
    if (!Number.isFinite(entry.delayMs) || entry.delayMs < 0)
      throw new Error('Invalid timeline delayMs');
    durationMs += entry.delayMs;
    if (!Number.isSafeInteger(Math.ceil(durationMs)))
      throw new Error('Timeline duration is too large');
    return { scheduledMs: durationMs, event: mapEvent(entry.event) };
  });

  // Keep the reducer private to this server; preflight and delivery use identical rules.
  // oxlint-disable-next-line unicorn/consistent-function-scoping
  function apply(state, event) {
    const p = event.properties;
    const messageID = p.messageID ?? p.part?.messageID ?? p.info?.id;
    const message = state.messages.find((entry) => entry.info.id === messageID);
    switch (event.type) {
      case 'message.updated':
        if (message) message.info = { ...message.info, ...structuredClone(p.info) };
        else {
          if (!['user', 'assistant'].includes(p.info.role))
            throw new Error('New message needs a role');
          state.messages.push({ info: structuredClone(p.info), parts: [] });
        }
        break;
      case 'message.removed':
        if (!p.messageID) throw new Error('Removal needs messageID');
        state.messages = state.messages.filter((entry) => entry.info.id !== p.messageID);
        break;
      case 'message.part.updated': {
        if (!message || !p.part.id)
          throw new Error('Part update needs an existing message and part ID');
        const index = message.parts.findIndex((part) => part.id === p.part.id);
        if (index < 0) message.parts.push(structuredClone(p.part));
        else message.parts[index] = structuredClone(p.part);
        break;
      }
      case 'message.part.delta': {
        const part = message?.parts.find((candidate) => candidate.id === p.partID);
        if (
          !part ||
          !['text', 'reasoning'].includes(part.type) ||
          p.field !== 'text' ||
          typeof p.delta !== 'string' ||
          typeof part.text !== 'string'
        ) {
          throw new Error('Delta needs an existing text/reasoning part and string text field');
        }
        part.text += p.delta;
        break;
      }
      case 'message.part.removed':
        if (!message || !p.partID)
          throw new Error('Part removal needs an existing message and part ID');
        message.parts = message.parts.filter((part) => part.id !== p.partID);
        break;
      case 'session.updated':
        state.session = { ...state.session, ...structuredClone(p.info) };
        break;
      case 'session.status':
        if (!['idle', 'busy', 'retry'].includes(p.status?.type))
          throw new Error('Invalid session status');
        state.status = structuredClone(p.status);
        break;
      case 'session.idle':
        state.status = { type: 'idle' };
        break;
      case 'todo.updated':
        if (!Array.isArray(p.todos)) throw new Error('Todo snapshot must be an array');
        state.todos = structuredClone(p.todos);
        break;
      case 'session.diff':
        if (!Array.isArray(p.diff)) throw new Error('Diff snapshot must be an array');
        state.diff = structuredClone(p.diff);
        break;
      default:
        throw new Error(`Unsupported capture event: ${event.type}`);
    }
  }

  const validation = structuredClone(initial);
  for (const entry of entries) apply(validation, entry.event);
  const state = structuredClone(initial);
  const subscribers = new Set();
  const sockets = new Set();
  const cursors = new Map();
  let phase = 'ready';
  let error = null;
  let closed = false;
  let closePromise;
  let timer;
  let cancelWait;
  let epoch;
  let elapsedMs = 0;
  const timings = [];

  function getResult() {
    return structuredClone({
      state: phase,
      error,
      sessionID,
      directory,
      finalMessages: state.messages,
      expectedMessages,
      canonicalMatch:
        phase === 'completed' ? isDeepStrictEqual(state.messages, expectedMessages) : null,
      scheduler: {
        scheduledDurationMs: durationMs,
        elapsedMs: phase === 'running' ? performance.now() - epoch : elapsedMs,
        scheduledEvents: entries.length,
        appliedEvents: timings.length,
        maxLatenessMs: timings.reduce((max, entry) => Math.max(max, entry.latenessMs), 0),
        timings,
      },
    });
  }

  const project = {
    id: projectID,
    worktree: directory,
    time: { created: 0, updated: 0 },
    sandboxes: [],
  };
  const bootstrap = new Map([
    ['/global/health', { healthy: true, version: '1.18.29' }],
    ['/config', {}],
    ['/global/config', {}],
    ['/config/providers', { providers: [], default: {} }],
    ['/provider', { all: [], default: {}, connected: [] }],
    ['/provider/auth', {}],
    [
      '/path',
      { home: directory, state: directory, config: directory, worktree: directory, directory },
    ],
    ['/project', [project]],
    ['/project/current', project],
    [
      '/agent',
      [
        {
          name: 'build',
          description: 'Read-only replay',
          mode: 'primary',
          native: true,
          options: {},
          permission: [],
        },
      ],
    ],
    ['/command', []],
    ['/mcp', {}],
    ['/permission', []],
    ['/question', []],
    ['/lsp', []],
    ['/formatter', []],
    ['/vcs', {}],
    ['/vcs/status', []],
    ['/skill', []],
  ]);
  const server = http.createServer((request, response) => {
    const send = (value, status = 200) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(value));
    };
    if (request.method !== 'GET') {
      response.setHeader('allow', 'GET');
      request.resume();
      send({ error: 'Read-only replay server: mutations are forbidden' }, 405);
      return;
    }
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      const path = url.pathname;
      const scopes = [url.searchParams.get('directory'), request.headers['x-opencode-directory']];
      if (
        scopes.some(
          (scope) => scope && scope !== directory && scope !== encodeURIComponent(directory)
        )
      ) {
        send({ error: 'Unknown replay directory' }, 404);
        return;
      }
      if (path === '/global/event') {
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        response.write(': replay connected\n\n');
        subscribers.add(response);
        response.on('close', () => subscribers.delete(response));
        return;
      }
      if (bootstrap.has(path)) return send(bootstrap.get(path));
      if (path === '/session/status')
        return send(state.status.type === 'idle' ? {} : { [sessionID]: state.status });
      if (path === '/session' || path === '/experimental/session') {
        const search = url.searchParams.get('search')?.toLowerCase();
        const startTime = Number(url.searchParams.get('start') ?? 0);
        const matches =
          (!search || state.session.title?.toLowerCase().includes(search)) &&
          (state.session.time?.updated ?? 0) >= startTime;
        return send(matches ? [state.session] : []);
      }
      const base = `/session/${sessionID}`;
      if (path === base) return send(state.session);
      if (path === `${base}/children`) return send([]);
      if (path === `${base}/todo`) return send(state.todos);
      if (path === `${base}/diff`) return send(state.diff);
      if (path === `${base}/message`) {
        const limit = url.searchParams.has('limit')
          ? Number(url.searchParams.get('limit'))
          : undefined;
        const before = url.searchParams.get('before');
        if (
          (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) ||
          (before !== null && (limit === undefined || !cursors.has(before)))
        ) {
          return send({ error: 'Invalid message limit or cursor' }, 400);
        }
        const boundary = before === null ? null : cursors.get(before);
        const messages = boundary
          ? state.messages.filter((message) => boundary.has(message.info.id))
          : state.messages;
        const page = limit === undefined ? messages : messages.slice(-limit);
        if (page.length < messages.length) {
          const token = randomUUID();
          cursors.set(
            token,
            new Set(
              messages.slice(0, messages.length - page.length).map((message) => message.info.id)
            )
          );
          response.setHeader('x-next-cursor', token);
          response.setHeader(
            'link',
            `<${base}/message?limit=${limit}&before=${token}>; rel="next"`
          );
        }
        return send(page);
      }
      if (path.startsWith(`${base}/message/`)) {
        const id = decodeURIComponent(path.slice(`${base}/message/`.length));
        const message = state.messages.find((entry) => entry.info.id === id);
        if (message) return send(message);
      }
      send({ error: 'Unknown replay route' }, 404);
    } catch (cause) {
      send({ error: cause.message }, 400);
    }
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  function start() {
    if (closed || phase !== 'ready') throw new Error('Replay is closed or already started');
    if (!subscribers.size) throw new Error('Replay requires a connected global event subscriber');
    phase = 'running';
    epoch = performance.now();
    return (async () => {
      try {
        for (const [index, entry] of entries.entries()) {
          // Yield even when every deadline is overdue, so stop requests and deadlines can run.
          if (index % 64 === 0) await new Promise((resolve) => setImmediate(resolve));
          let remaining;
          while ((remaining = epoch + entry.scheduledMs - performance.now()) > 0) {
            if (closed) break;
            await new Promise((resolve) => {
              cancelWait = resolve;
              timer = setTimeout(resolve, Math.min(Math.ceil(remaining), 2_147_483_647));
            });
            timer = undefined;
            cancelWait = undefined;
          }
          if (closed) return getResult();
          if (!subscribers.size) throw new Error('All event subscribers disconnected');
          apply(state, entry.event);
          const actualMs = performance.now() - epoch;
          const payload = `data: ${JSON.stringify({ directory, payload: entry.event })}\n\n`;
          for (const subscriber of subscribers) {
            if (subscriber.writableLength + Buffer.byteLength(payload) > 8 * 1024 * 1024) {
              throw new Error('Replay subscriber exceeded the 8 MiB output buffer limit');
            }
            subscriber.write(payload);
          }
          timings.push({
            index,
            type: entry.event.type,
            scheduledMs: entry.scheduledMs,
            actualMs,
            latenessMs: Math.max(0, actualMs - entry.scheduledMs),
            subscribers: subscribers.size,
          });
        }
        phase = 'completed';
      } catch (cause) {
        phase = 'failed';
        error = cause.message;
      } finally {
        elapsedMs = performance.now() - epoch;
      }
      return getResult();
    })();
  }

  function close() {
    if (closePromise) return closePromise;
    closed = true;
    if (phase === 'running') elapsedMs = performance.now() - epoch;
    if (phase === 'ready' || phase === 'running') phase = 'cancelled';
    clearTimeout(timer);
    cancelWait?.();
    closePromise = new Promise((resolve, reject) => {
      server.close((cause) => (cause ? reject(cause) : resolve()));
      for (const socket of sockets) socket.destroy();
      subscribers.clear();
    });
    return closePromise;
  }

  const port = server.address().port;
  return { url: `http://127.0.0.1:${port}`, port, start, close, getResult };
}
