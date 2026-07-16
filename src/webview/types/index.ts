import type { Message, Part } from '../../shared/opencode-types';

export * from '../../shared/opencode-types';

export type MessageEntry<TInfo extends Message = Message> = {
  info: TInfo;
  parts: Part[];
};
