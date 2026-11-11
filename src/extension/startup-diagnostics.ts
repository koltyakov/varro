import { withStartupDeadline } from '../shared/startup';
import type { StartupAddonFailure } from '../shared/startup';
import { asRecord, isString } from '../shared/type-utils';
import type { OpenCodeServer } from './server';

/** Failure inventory, not activation timing: V2 does not expose which setup is currently waiting. */
export class StartupDiagnostics {
  constructor(private readonly server: Pick<OpenCodeServer, 'apiVersion' | 'request'>) {}

  async read(directory: string | undefined, signal?: AbortSignal): Promise<StartupAddonFailure[]> {
    if (this.server.apiVersion !== 2) return [];
    return withStartupDeadline(
      async (requestSignal) => {
        const results = await Promise.allSettled([
          this.server.request('GET', '/api/plugin', undefined, {
            directory,
            signal: requestSignal,
          }),
          this.server.request('GET', '/api/mcp', undefined, { directory, signal: requestSignal }),
        ]);
        const failures: StartupAddonFailure[] = [];
        for (const [index, result] of results.entries()) {
          if (result.status !== 'fulfilled') continue;
          const entries = asRecord(result.value)?.data;
          if (!Array.isArray(entries)) continue;
          for (const entry of entries.slice(0, 200)) {
            const item = asRecord(entry);
            const state = asRecord(index === 0 ? item?.state : item?.status);
            const name = index === 0 ? item?.id : item?.name;
            if (state?.status !== 'failed' || !isString(name) || !name.trim()) continue;
            failures.push({
              kind: index === 0 ? 'plugin' : 'mcp',
              name: name.replace(/[\r\n\t"]/g, ' ').slice(0, 120),
              // Never forward addon stderr, command arguments, URLs, or credentials to the webview.
              timedOut: isString(state.error) && /timed? ?out|timeout/i.test(state.error),
            });
            if (failures.length === 5) return failures;
          }
        }
        return failures;
      },
      1_000,
      'OpenCode startup diagnostics',
      signal
    ).catch(() => []);
  }
}
