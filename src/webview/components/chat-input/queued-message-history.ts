import { client } from '../../lib/client';

export async function queuedMessageWasAdmitted(sessionId: string, messageId: string) {
  let before: string | undefined;
  const consumedCursors = new Set<string>();
  do {
    const messages = await client.session.messages(sessionId, { limit: 200, before });
    if (messages.some((message) => message.info.id === messageId)) return true;
    const nextCursor = messages.nextCursor;
    if (!nextCursor) return false;
    if (consumedCursors.has(nextCursor)) {
      throw new Error('Queued message history cursor did not advance');
    }
    consumedCursors.add(nextCursor);
    before = nextCursor;
  } while (before);
  return false;
}
