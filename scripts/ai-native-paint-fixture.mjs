/**
 * Virtualized text history followed by a still-busy turn of patch steps. Inline diffs render only
 * for the working trailing turn, so `checkpoint` pauses replay after the edits and before idle.
 */
export function nativeWheelFixture() {
  const sessionID = 'ses_native_wheel_generated';
  const now = 1_790_000_000_000;
  const initialMessages = [];
  for (let turn = 0; turn < 70; turn++) {
    const userID = `msg_wheel_${String(turn * 2).padStart(4, '0')}`;
    const id = `msg_wheel_${String(turn * 2 + 1).padStart(4, '0')}`;
    const paragraphs = Array.from(
      { length: turn % 10 === 9 ? 10 : 2 + (turn % 3) },
      (_, index) =>
        `Paragraph ${index + 1} of answer ${turn}. The generated reply keeps enough wrapped prose on screen for paint checks.`
    );
    initialMessages.push(
      {
        info: {
          id: userID,
          sessionID,
          role: 'user',
          time: { created: now + turn * 1000 },
          agent: 'build',
          model: { providerID: 'replay', modelID: 'replay' },
        },
        parts: [
          {
            id: `prt_wheel_user_${turn}`,
            messageID: userID,
            sessionID,
            type: 'text',
            text: `Review generated area ${turn} and summarize it.`,
          },
        ],
      },
      {
        info: {
          id,
          sessionID,
          parentID: userID,
          role: 'assistant',
          time: { created: now + turn * 1000 + 1, completed: now + turn * 1000 + 10 },
          finish: 'stop',
          agent: 'build',
          mode: 'build',
          providerID: 'replay',
          modelID: 'replay',
          path: { cwd: '/generated', root: '/generated' },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
        parts: [
          {
            id: `prt_wheel_text_${turn}`,
            messageID: id,
            sessionID,
            type: 'text',
            text: paragraphs.join('\n\n'),
          },
        ],
      }
    );
  }

  const finalMessages = structuredClone(initialMessages);
  const events = [];
  const add = (offsetMs, type, properties) =>
    events.push({ offsetMs, event: { type, properties } });
  const created = now + 70 * 1000;
  const user = {
    info: { ...initialMessages.at(-2).info, id: 'msg_wheel_edit_user', time: { created } },
    parts: [
      {
        id: 'prt_wheel_edit_user',
        messageID: 'msg_wheel_edit_user',
        sessionID,
        type: 'text',
        text: 'Apply the generated edits across six files.',
      },
    ],
  };
  add(0, 'message.updated', { info: user.info });
  add(1, 'message.part.updated', { part: user.parts[0] });
  add(2, 'session.status', { sessionID, status: { type: 'busy' } });
  finalMessages.push(user);
  for (let step = 0; step < 6; step++) {
    const id = `msg_wheel_edit_${step}`;
    const base = 20 + step * 300;
    const info = {
      ...initialMessages.at(-1).info,
      id,
      parentID: user.info.id,
      time: { created: created + base },
    };
    delete info.finish;
    const updates = [0, 1].map((file) => {
      const lines = Array.from({ length: 12 }, (_, line) => line);
      return [
        `*** Update File: src/generated/wheel-${step}-${file}.ts`,
        '@@',
        ...lines.map((line) => `-export const before${line} = ${step * 100 + line};`),
        ...lines.map((line) => `+export const after${line} = '${step}.${file}.${line}';`),
      ].join('\n');
    });
    const parts = [
      {
        id: `prt_wheel_edit_text_${step}`,
        messageID: id,
        sessionID,
        type: 'text',
        text: `Updating generated pair ${step}.`,
      },
      {
        id: `prt_wheel_edit_patch_${step}`,
        messageID: id,
        sessionID,
        type: 'tool',
        callID: `call_wheel_edit_${step}`,
        tool: 'apply_patch',
        state: {
          status: 'completed',
          input: { patchText: ['*** Begin Patch', ...updates, '*** End Patch'].join('\n') },
          output: 'Read-only generated replay',
          metadata: {},
          time: { start: created + base + 5, end: created + base + 6 },
        },
      },
    ];
    const complete = {
      ...info,
      time: { created: created + base, completed: created + base + 200 },
      finish: 'tool-calls',
    };
    add(base, 'message.updated', { info });
    for (const [index, part] of parts.entries())
      add(base + 10 + index * 40, 'message.part.updated', { part });
    add(base + 200, 'message.updated', { info: complete });
    finalMessages.push({ info: complete, parts });
  }
  const checkpoint = events.length;
  add(2400, 'session.status', { sessionID, status: { type: 'idle' } });
  return {
    checkpoint,
    capture: {
      scenario: 'NATIVE-WHEEL-PAINT',
      session: {
        id: sessionID,
        projectID: 'generated',
        directory: '/generated',
        title: 'Native wheel paint regression',
        version: '1',
        time: { created: now, updated: now },
      },
      initialMessages,
      finalMessages,
      events,
    },
  };
}

export function nativePaintFixture() {
  const sessionID = 'ses_native_paint_generated';
  const now = 1_790_000_000_000;
  const initialMessages = [];
  for (let turn = 0; turn < 120; turn++) {
    const userID = `msg_paint_${String(turn * 2).padStart(4, '0')}`;
    const id = `msg_paint_${String(turn * 2 + 1).padStart(4, '0')}`;
    const part = (type, suffix, fields) => ({
      id: `prt_${turn}_${suffix}`,
      messageID: id,
      sessionID,
      type,
      ...fields,
    });
    initialMessages.push({
      info: {
        id: userID,
        sessionID,
        role: 'user',
        time: { created: now + turn * 1000 },
        agent: 'build',
        model: { providerID: 'replay', modelID: 'replay' },
      },
      parts: [
        {
          id: `prt_user_${turn}`,
          messageID: userID,
          sessionID,
          type: 'text',
          text: `Check generated change ${turn}. Keep the result readable.`,
        },
      ],
    });
    const edits =
      turn >= 90
        ? Array.from({ length: 3 }, (unused, file) =>
            part('tool', `edit_${file}`, {
              callID: `call_${turn}_${file}`,
              tool: 'edit',
              state: {
                status: 'completed',
                input: { path: `generated/file-${file}.ts` },
                output: 'Generated replay edit, never executed.',
                title: `Edit generated/file-${file}.ts`,
                time: { start: now + turn * 1000 + 2, end: now + turn * 1000 + 4 },
                metadata: {
                  files: [
                    {
                      file: `generated/file-${file}.ts`,
                      status: 'modified',
                      additions: 9,
                      deletions: 1,
                      patch: `--- a/generated/file-${file}.ts\n+++ b/generated/file-${file}.ts\n@@ -1 +1,9 @@\n-old\n${Array.from({ length: 9 }, (_, line) => `+export const value${line} = ${turn + line};`).join('\n')}\n`,
                    },
                  ],
                },
              },
            })
          )
        : [];
    const assistant = {
      info: {
        id,
        sessionID,
        parentID: userID,
        role: 'assistant',
        time: { created: now + turn * 1000 + 1, completed: now + turn * 1000 + 10 },
        finish: edits.length ? 'tool-calls' : 'stop',
        agent: 'build',
        mode: 'build',
        providerID: 'replay',
        modelID: 'replay',
        path: { cwd: '/generated', root: '/generated' },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      parts: [
        part('reasoning', 'reason', {
          text: 'Reviewed the generated change.',
          time: {
            start: now + turn * 1000 + 1,
            end: now + turn * 1000 + 2,
          },
        }),
        ...edits,
        ...(edits.length
          ? []
          : [part('text', 'text', { text: `All good and ready to continue. PAINT-${turn}` })]),
      ],
    };
    initialMessages.push(assistant);
    if (edits.length) {
      const finalID = `${id}_final`;
      initialMessages.push({
        info: { ...assistant.info, id: finalID, finish: 'stop' },
        parts: [
          {
            id: `prt_final_${turn}`,
            sessionID,
            messageID: finalID,
            type: 'text',
            text: `All good and ready to continue. PAINT-${turn}`,
          },
        ],
      });
    }
  }
  return {
    scenario: 'NATIVE-PAINT',
    session: {
      id: sessionID,
      projectID: 'generated',
      directory: '/generated',
      title: 'Native paint regression',
      version: '1',
      time: { created: now, updated: now },
    },
    initialMessages,
    finalMessages: structuredClone(initialMessages),
    events: [{ offsetMs: 0, event: { type: 'session.idle', properties: { sessionID } } }],
  };
}
