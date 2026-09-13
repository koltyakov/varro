import type { DatabaseContext } from '../../shared/protocol';

export function formatDatabaseContext(context: DatabaseContext): string {
  const text = JSON.stringify(context, null, 2);
  const fence = '`'.repeat(
    Math.max(3, ...[...text.matchAll(/`+/g)].map((match) => match[0].length + 1))
  );
  return `[Database context]\n${fence}json\n${text}\n${fence}`;
}
