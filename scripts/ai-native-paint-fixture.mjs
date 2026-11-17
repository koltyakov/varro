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
