/* oxlint-disable anti-slop/no-runtime-typeof -- Native capture tool input may be JSON text or an object. */
import { isDeepStrictEqual } from 'node:util';

export const V2_REPLAY_EVENTS = new Set(
  [
    'context.updated',
    'agent.switched',
    'model.switched',
    'prompt.admitted',
    'prompted',
    'synthetic',
    'step.started',
    'step.ended',
    'text.started',
    'text.delta',
    'text.ended',
    'reasoning.started',
    'reasoning.delta',
    'reasoning.ended',
    'tool.input.started',
    'tool.input.delta',
    'tool.input.ended',
    'tool.called',
    'tool.progress',
    'tool.success',
    'tool.failed',
  ].map((name) => `session.next.${name}`)
);

// Native v2 events omit some projected REST fields. Recorded terminal snapshots
// supply those fields only at the corresponding terminal boundary, never at
// admission/start. The wire events themselves retain their original order.
export class V2ReplayProjection {
  constructor(messages) {
    this.recorded = new Map(messages.map((message) => [message.info.id, message]));
  }

  apply(state, event) {
    const p = event.properties;
    const kind = event.type.slice('session.next.'.length);
    if (kind === 'context.updated' || kind === 'prompt.admitted') return;
    if (kind === 'agent.switched' || kind === 'model.switched') {
      const key = kind.split('.')[0];
      state.session[key] = structuredClone(p[key]);
      return;
    }
    if (kind === 'prompted' || kind === 'synthetic') {
      const candidates =
        kind === 'synthetic' && !p.messageID
          ? [...this.recorded.values()].filter(
              (entry) =>
                entry.info.role === 'user' &&
                entry.info.time.created === p.timestamp &&
                entry.parts.some((part) => part.text === p.text)
            )
          : [this.recorded.get(p.messageID)];
      if (candidates.length !== 1) throw new Error('Ambiguous v2 synthetic prompt');
      const recorded = candidates[0];
      if (!recorded || recorded.info.role !== 'user')
        throw new Error('V2 prompt needs recorded user');
      if (state.messages.some((message) => message.info.id === recorded.info.id))
        throw new Error('Duplicate v2 prompt');
      if (kind === 'synthetic' && !recorded.parts.some((part) => part.text === p.text))
        throw new Error('Synthetic prompt differs from recorded content');
      state.messages.push(structuredClone(recorded));
      return;
    }
    const id = p.assistantMessageID;
    const recorded = this.recorded.get(id);
    if (!recorded || recorded.info.role !== 'assistant')
      throw new Error('V2 event needs recorded assistant');
    const message = state.messages.find((entry) => entry.info.id === id);
    if (kind === 'step.started') {
      if (message) throw new Error('Duplicate v2 step');
      if (!state.messages.some((entry) => entry.info.id === recorded.info.parentID))
        throw new Error('V2 step needs admitted parent');
      const info = {
        id,
        sessionID: p.sessionID,
        role: 'assistant',
        parentID: recorded.info.parentID,
        time: { created: p.started ?? p.timestamp },
        agent: p.agent,
        mode: p.agent,
        providerID: p.model.providerID,
        modelID: p.model.modelID ?? p.model.id,
        path: structuredClone(recorded.info.path),
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      };
      if (p.model.variant !== undefined) info.variant = p.model.variant;
      state.messages.push({ info, parts: [] });
      return;
    }
    if (!message) throw new Error('V2 event before step start');
    if (kind === 'step.ended') {
      for (const key of ['cost', 'tokens']) {
        if (p[key] !== undefined && !isDeepStrictEqual(p[key], recorded.info[key]))
          throw new Error(`V2 terminal ${key} differs from capture`);
      }
      if (p.finish !== recorded.info.finish || !isDeepStrictEqual(message.parts, recorded.parts))
        throw new Error('V2 step ended before its recorded parts completed');
      message.info = structuredClone(recorded.info);
      return;
    }
    const partID = p.callID ?? p.textID ?? p.reasoningID;
    const terminal = recorded.parts.find((part) => part.id === partID);
    if (!terminal) throw new Error('V2 event needs recorded part');
    const index = message.parts.findIndex((part) => part.id === partID);
    const part = message.parts[index];
    const put = (value) => {
      if (index < 0) message.parts.push(value);
      else message.parts[index] = value;
    };
    const base = { id: partID, sessionID: p.sessionID, messageID: id };
    if (kind.startsWith('text.') || kind.startsWith('reasoning.')) {
      const [type, phase] = kind.split('.');
      if (terminal.type !== type) throw new Error('V2 part type mismatch');
      if (phase === 'started') {
        if (part) throw new Error('Duplicate v2 part start');
        const started = {
          ...base,
          type,
          text: '',
        };
        if (type === 'reasoning') started.time = { start: p.timestamp };
        put(started);
      } else {
        if (!part) throw new Error('V2 text event before part start');
        if (phase === 'delta') part.text += p.delta ?? p.text ?? '';
        else {
          if (p.text !== terminal.text) throw new Error('V2 terminal text differs from capture');
          put(structuredClone(terminal));
        }
      }
      return;
    }
    if (terminal.type !== 'tool') throw new Error('V2 tool type mismatch');
    if (kind === 'tool.input.started') {
      if (part) throw new Error('Duplicate v2 tool start');
      put({
        ...base,
        type: 'tool',
        callID: partID,
        tool: p.name,
        state: { status: 'pending', input: {}, raw: '' },
      });
      return;
    }
    if (!part) throw new Error('V2 tool event before input start');
    if (kind === 'tool.input.delta') {
      part.state.raw += p.delta ?? p.text ?? '';
    } else if (kind === 'tool.input.ended') {
      part.state.raw = p.text;
      part.state.input = JSON.parse(p.text);
    } else if (kind === 'tool.called') {
      const input =
        typeof p.input === 'string' ? JSON.parse(p.input) : (p.input ?? part.state.input);
      put({
        ...part,
        state: { status: 'running', input, time: { start: p.timestamp }, metadata: {} },
      });
    } else if (kind === 'tool.progress') {
      if (part.state.status !== 'running') throw new Error('V2 progress before tool call');
      part.state.metadata = structuredClone(p.structured ?? p.metadata ?? {});
      if (p.title !== undefined) part.state.title = p.title;
    } else if (kind === 'tool.success' || kind === 'tool.failed') {
      if (part.state.status !== 'running') throw new Error('V2 completion before tool call');
      if (!isDeepStrictEqual(part.state.input, terminal.state.input))
        throw new Error('V2 tool input differs from capture');
      const status = kind === 'tool.success' ? 'completed' : 'error';
      if (terminal.state.status !== status) throw new Error('V2 tool outcome differs from capture');
      if (status === 'error') {
        const error = typeof p.error === 'string' ? p.error : p.error?.message;
        if (error !== undefined && error !== terminal.state.error)
          throw new Error('V2 tool error differs from capture');
      }
      if (status === 'completed' && p.output !== undefined && p.output !== terminal.state.output)
        throw new Error('V2 tool output differs from capture');
      put(structuredClone(terminal));
    } else throw new Error(`Unsupported v2 projection: ${kind}`);
  }
}
