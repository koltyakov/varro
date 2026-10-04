import { describe, expect, it } from 'vitest';
import type { ServerEvent } from '../shared/protocol';
import { getToolFileChanges } from '../shared/tool-file-change';
import { asRecord, type UnknownRecord } from '../shared/type-utils';
import { projectV2Event } from './opencode-v2-events';
import { StreamingToolContent } from './streaming-tool-content';

function event(type: string, properties: UnknownRecord): ServerEvent {
  // SAFETY: These fixtures provide the routing required by each native tool event.
  return {
    type: `session.next.tool.${type}`,
    workspaceDirectory: '/workspace',
    properties: { sessionID: 's1', assistantMessageID: 'm1', callID: 'c1', ...properties },
  } as ServerEvent;
}

describe('streaming tool content', () => {
  it('removes native image bodies and duplicate fields before forwarding progress or completion', () => {
    const projection = new StreamingToolContent();
    projection.project(event('input.started', { name: 'read' }));
    const uri = `data:image/png;base64,${'IMAGE'.repeat(200_000)}`;
    const text = 'Read image successfully';
    for (const type of ['progress', 'success']) {
      const projected = projectV2Event({
        id: `event-${type}`,
        type: `session.tool.${type}`,
        created: 100,
        durable: { seq: 3 },
        location: { directory: '/workspace' },
        data: {
          sessionID: 's1',
          assistantMessageID: 'm1',
          id: 'c1',
          content: [
            { type: 'text', text },
            { type: 'file', uri, mime: 'image/png' },
          ],
          metadata: { title: 'Read screenshot' },
        },
      });
      // SAFETY: projectV2Event emits the native tool event exercised by this fixture.
      const source = projected[0] as ServerEvent;
      const result = projection.project(source);
      expect(JSON.stringify(result)).not.toContain('IMAGE');
      expect(JSON.stringify(result).length).toBeLessThan(1500);
      expect(result).toMatchObject({ id: `event-${type}`, seq: 3 });
      expect(result.properties).toMatchObject({ content: [{ type: 'text', text }] });
      expect(result.properties).not.toHaveProperty('metadata');
      expect(result.properties).not.toHaveProperty('output');
      expect(JSON.stringify(source)).toContain(uri);
    }
  });

  it('bounds cumulative pending input and preserves edit summaries after the complete input arrives', () => {
    const projection = new StreamingToolContent();
    projection.project(event('input.started', { name: 'apply_patch' }));
    let characters = 0;
    for (let index = 0; index < 100; index++) {
      const result = projection.project(event('input.delta', { delta: 'x'.repeat(128) }));
      const properties = asRecord(result.properties)!;
      characters += String(properties.delta).length;
      if (index > 3) expect(properties.deferred).toContain('/part/c1?directory=');
    }
    expect(characters).toBe(512);
    const input = {
      patchText: `*** Begin Patch\n*** Add File: src/new.ts\n+${'code'.repeat(5000)}\n*** End Patch`,
    };
    for (const type of ['input.ended', 'called']) {
      const result = projection.project(
        event(type, type === 'called' ? { input } : { text: JSON.stringify(input) })
      );
      expect(JSON.stringify(result).length).toBeLessThan(2500);
      expect(result.properties).toMatchObject({
        deferred: '/session/s1/message/m1/part/c1?directory=%2Fworkspace',
        deferredFiles: [{ path: 'src/new.ts', kind: 'added', additions: 1 }],
      });
      const summary = asRecord(result.properties)!;
      const changes = getToolFileChanges('apply_patch', {
        status: 'pending',
        input: {},
        raw: '',
        // SAFETY: The projection above derives these summaries from the complete patch fixture.
        deferredFiles: summary.deferredFiles as ReturnType<typeof getToolFileChanges>,
      });
      expect(changes[0]?.after).toBeUndefined();
      expect(changes[0]?.patch).toBeUndefined();
    }
  });

  it('preserves full search counts while bounding text, arrays, and metadata aliases', () => {
    const projection = new StreamingToolContent();
    projection.project(event('input.started', { name: 'glob' }));
    const output = Array.from({ length: 1000 }, (_, i) => `src/file-${i}.ts`).join('\n');
    const result = projection.project(
      event('success', {
        content: [{ type: 'text', text: output }],
        output,
        structured: { entries: Array.from({ length: 10000 }, () => 'metadata'.repeat(100)) },
        metadata: { raw: output },
        result: { raw: output },
        resultState: { raw: output },
      })
    );
    expect(JSON.stringify(result).length).toBeLessThan(20_000);
    expect(result.properties).toMatchObject({
      deferred: expect.any(String),
      structured: { matches: 1000 },
    });
    expect(JSON.stringify(result)).not.toContain('file-999.ts');
  });

  it('retains routing, error status, and child-session links in bounded failures and progress', () => {
    const projection = new StreamingToolContent();
    projection.project(event('input.started', { name: 'task' }));
    const result = projection.project(
      event('progress', {
        structured: { sessionID: 'child-session', output: 'work '.repeat(10000) },
        content: [{ type: 'text', text: 'work '.repeat(10000) }],
      })
    );
    expect(result.properties).toMatchObject({
      deferred: expect.any(String),
      structured: { sessionID: 'child-session' },
    });
    const failed = projection.project(
      event('failed', { error: { message: 'error '.repeat(10000) } })
    );
    expect(failed.type).toBe('session.next.tool.failed');
    expect(JSON.stringify(failed).length).toBeLessThan(1500);
    expect(failed.properties).toMatchObject({
      deferred: expect.any(String),
      error: expect.stringContaining('error'),
    });
  });
});
