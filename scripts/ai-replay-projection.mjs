/* oxlint-disable anti-slop/no-runtime-typeof -- Captured legacy deltas are validated at the replay JSON boundary before mutating text. */
import { V2_REPLAY_EVENTS, V2ReplayProjection } from './ai-streaming-v2.mjs';

// The browser's fake REST state and the isolated streaming server must expose
// only records produced by events already delivered, including native v2 events.
export class ReplayProjection {
  constructor(recordedMessages) {
    this.v2 = new V2ReplayProjection(recordedMessages);
  }

  apply(state, event) {
    if (V2_REPLAY_EVENTS.has(event.type)) {
      this.v2.apply(state, event);
      return;
    }
    const p = event.properties;
    if (!p) throw new Error(`Capture event needs properties: ${event.type}`);
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
}
