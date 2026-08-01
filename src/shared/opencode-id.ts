const BASE62_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
// OpenCode stores timestamp * 0x1000 in six bytes, leaving 36 timestamp bits.
const OPEN_CODE_TIMESTAMP_RANGE_MS = 1n << 36n;

let lastMessageTimestamp = 0;
let messageTimestampEra: bigint | null = null;
let fallbackRandomSequence = 0;

export function createOpenCodeMessageID(): string {
  // Keep locally generated prompts after the preceding server message and in
  // lexical order when several sends happen within the same millisecond.
  const timestamp = Math.max(Date.now() + 1, lastMessageTimestamp + 1);
  lastMessageTimestamp = timestamp;
  const fullTimestamp = BigInt(timestamp);
  const timestampEra = fullTimestamp / OPEN_CODE_TIMESTAMP_RANGE_MS;
  messageTimestampEra ??= timestampEra;
  if (timestampEra !== messageTimestampEra) {
    throw new Error('OpenCode message ID uint48 timestamp era wrapped');
  }
  const encoded = (fullTimestamp % OPEN_CODE_TIMESTAMP_RANGE_MS) * 0x1000n + 1n;
  return `msg_${encoded.toString(16).padStart(12, '0')}${randomBase62(14)}`;
}

function randomBase62(length: number): string {
  const bytes = new Uint8Array(length);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    fallbackRandomSequence += 1;
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = (fallbackRandomSequence + index * 31) % 256;
    }
  }
  return Array.from(bytes, (value) => BASE62_CHARS[value % BASE62_CHARS.length]).join('');
}
