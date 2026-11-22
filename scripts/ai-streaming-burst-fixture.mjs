// Synthetic timings only. This fixture never reads sessions or executes recorded tools.
export const BURST_CASES = ['text-bursts', 'tool-handoffs', 'overlapping-parts'];
const BASE = Date.parse('2026-11-22T08:00:00.000Z');

export function createBurstCapture(kind, historyPairs = 60) {
  if (!BURST_CASES.includes(kind)) throw new Error(`Unknown burst case: ${kind}`);
  const sessionID = `session-burst-${kind}`;
  const directory = '/workspace/synthetic-streaming-bursts';
  const model = { providerID: 'replay', modelID: 'replay' };
  const assistant = (id, parentID, created) => ({
    id,
    sessionID,
    role: 'assistant',
    parentID,
    ...model,
    mode: 'build',
    agent: 'build',
    path: { cwd: directory, root: directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created },
  });
  const textPart = (messageID, id, text, type = 'text') => ({
    id,
    sessionID,
    messageID,
    type,
    text,
  });
  const initialMessages = [];
  for (let index = 0; index < historyPairs; index++) {
    const userID = `burst-history-user-${index}`;
    const messageID = `burst-history-assistant-${index}`;
    const created = BASE - (historyPairs - index) * 1000;
    initialMessages.push(
      {
        info: { id: userID, sessionID, role: 'user', time: { created }, model },
        parts: [textPart(userID, `${userID}-text`, `Synthetic historical prompt ${index}.`)],
      },
      {
        info: {
          ...assistant(messageID, userID, created + 1),
          finish: 'stop',
          time: { created: created + 1, completed: created + 2 },
        },
        parts: [
          textPart(
            messageID,
            `${messageID}-text`,
            `Synthetic history ${index}. This settled paragraph gives the virtualized transcript varied wrapping.\n\n` +
              'No historical sessions, commands, or files are used. '.repeat((index % 3) + 1)
          ),
        ],
      }
    );
  }
  const userID = 'burst-current-user';
  const messageID = 'burst-current-assistant';
  const leadID = 'burst-lead';
  initialMessages.push(
    {
      info: { id: userID, sessionID, role: 'user', time: { created: BASE }, model },
      parts: [
        textPart(
          userID,
          `${userID}-text`,
          `Synthetic ${kind}. Observe rapid additions without input.`
        ),
      ],
    },
    {
      info: assistant(messageID, userID, BASE + 1),
      parts: [
        textPart(
          messageID,
          leadID,
          'BURST-LEAD-MARKER. This unchanged paragraph is present before any synthetic growth. ' +
            'The reproduction records actual painted descendants, not just scroll coordinates.'
        ),
      ],
    }
  );
  const records = new Map(structuredClone(initialMessages).map((entry) => [entry.info.id, entry]));
  const events = [];
  let order = 0;
  const add = (offsetMs, event) => events.push({ offsetMs, order: order++, event });
  const update = (at, part) => add(at, { type: 'message.part.updated', properties: { part } });
  const delta = (at, id, value) =>
    add(at, {
      type: 'message.part.delta',
      properties: {
        sessionID,
        messageID,
        partID: id,
        field: 'text',
        delta: value,
      },
    });
  const paragraph = (label, index) =>
    `\n\n${label}-${index}. A synthetic paragraph arrives during overlapping events. ` +
    'Each sentence is ordinary prose so a Markdown delimiter correction cannot explain a reversal. '.repeat(
      2
    );
  const newText = (at, id) => update(at, textPart(messageID, id, ''));
  const tools = [];
  const tool = (id, status, at, progress = 0) => ({
    id,
    sessionID,
    messageID,
    type: 'tool',
    tool: 'read',
    callID: `${id}-call`,
    state:
      status === 'pending'
        ? { status, input: { filePath: `/synthetic/${id}.txt` }, raw: '' }
        : status === 'running'
          ? {
              status,
              input: { filePath: `/synthetic/${id}.txt` },
              title: `Synthetic ${id}`,
              metadata: { progress },
              time: { start: BASE + 1200 },
            }
          : {
              status,
              input: { filePath: `/synthetic/${id}.txt` },
              title: `Synthetic ${id}`,
              output: `Synthetic output ${id}, never executed.`,
              metadata: { progress: 100 },
              time: { start: BASE + 1200, end: BASE + at },
            },
  });
  add(0, { type: 'session.status', properties: { sessionID, status: { type: 'busy' } } });
  if (kind === 'text-bursts') {
    for (let wave = 0; wave < 3; wave++) {
      for (let index = 0; index < 10; index++)
        delta(
          1200 + wave * 1300 + (wave === 1 ? 0 : index * 8),
          leadID,
          paragraph(`TEXT-WAVE-${wave}`, index)
        );
    }
  } else {
    const count = kind === 'tool-handoffs' ? 24 : 12;
    for (let index = 0; index < count; index++) {
      const id = `burst-tool-${index}`;
      tools.push(id);
      update(1200, tool(id, 'pending', 1200));
      update(1240, tool(id, 'running', 1240));
      const endedAt = index < count / 2 ? 2100 + index * 16 : 4700 + index * 8;
      for (let progress = 1; progress <= 4; progress++) {
        const at = 1600 + progress * 160 + (index % 3) * 8;
        if (at < endedAt) update(at, tool(id, 'running', 0, progress * 20));
      }
      update(endedAt, tool(id, 'completed', endedAt));
    }
    const reasoningID = 'burst-reasoning';
    update(1280, {
      ...textPart(messageID, reasoningID, '', 'reasoning'),
      time: { start: BASE + 1280 },
    });
    if (kind === 'tool-handoffs') {
      newText(2700, 'burst-answer-a');
      for (let index = 0; index < 12; index++)
        delta(2700 + index * 8, 'burst-answer-a', paragraph('HANDOFF-A', index));
      newText(4400, 'burst-answer-b');
      for (let index = 0; index < 12; index++)
        delta(4400, 'burst-answer-b', paragraph('HANDOFF-B', index));
      delta(1600, reasoningID, 'Synthetic reasoning while tools run.');
    } else {
      for (let stream = 0; stream < 3; stream++)
        newText(1500 + stream * 24, `burst-stream-${stream}`);
      for (let wave = 0; wave < 8; wave++) {
        for (let stream = 0; stream < 3; stream++)
          delta(
            1650 + wave * 350 + stream * 8,
            `burst-stream-${stream}`,
            paragraph(`OVERLAP-${stream}`, wave)
          );
        delta(1650 + wave * 350, reasoningID, `Reasoning update ${wave}. `);
      }
    }
    update(5100, {
      ...textPart(
        messageID,
        reasoningID,
        kind === 'tool-handoffs'
          ? 'Synthetic reasoning while tools run.'
          : Array.from({ length: 8 }, (_, i) => `Reasoning update ${i}. `).join(''),
        'reasoning'
      ),
      time: { start: BASE + 1280, end: BASE + 5100 },
    });
  }
  add(5500, {
    type: 'message.updated',
    properties: {
      info: {
        ...assistant(messageID, userID, BASE + 1),
        finish: 'stop',
        time: { created: BASE + 1, completed: BASE + 5500 },
      },
    },
  });
  add(5520, { type: 'session.status', properties: { sessionID, status: { type: 'idle' } } });
  // Keep the read-only editor open for ten seconds of ordinary post-completion following.
  add(15520, { type: 'session.status', properties: { sessionID, status: { type: 'idle' } } });
  const sorted = events
    .toSorted((a, b) => a.offsetMs - b.offsetMs || a.order - b.order)
    .map(({ offsetMs, event }) => ({ offsetMs, event }));
  for (const { event } of sorted) {
    if (event.type === 'message.updated') {
      const info = event.properties.info;
      records.get(info.id).info = structuredClone(info);
    } else if (event.type === 'message.part.updated') {
      const part = event.properties.part;
      const parts = records.get(part.messageID).parts;
      const index = parts.findIndex((existing) => existing.id === part.id);
      if (index < 0) parts.push(structuredClone(part));
      else parts[index] = structuredClone(part);
    } else if (event.type === 'message.part.delta') {
      const { partID, delta: value } = event.properties;
      const part = records.get(messageID).parts.find((existing) => existing.id === partID);
      if (!part) throw new Error(`Delta before part ${partID}`);
      part.text += value;
    }
  }
  return {
    label: `Synthetic rapid additions: ${kind}`,
    scenario: 'SYNTHETIC_BURSTS',
    capturedAt: new Date(BASE).toISOString(),
    model: 'replay/replay',
    session: {
      id: sessionID,
      directory,
      projectID: 'synthetic-bursts',
      title: `Burst ${kind}`,
      version: '1',
      time: { created: BASE, updated: BASE + 15520 },
    },
    initialMessages,
    initialStatus: { type: 'busy' },
    finalMessages: [...records.values()],
    events: sorted,
    reproduction: {
      kind,
      historyPairs,
      toolCount: tools.length,
      settleMs: 10000,
      timing:
        'Artificial absolute offsets, including zero-gap bursts. No original-session cadence.',
    },
  };
}
