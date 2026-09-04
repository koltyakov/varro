const MAX_EVENTS = 100;
const MAX_FIELD_CHARS = 256;
const MAX_EXPORT_CHARS = 64 * 1024;

type DiagnosticEvent = {
  event:
    | 'server-state'
    | 'rest-failure'
    | 'stream-connect'
    | 'stream-healthy'
    | 'stream-retry'
    | 'workspace-activated'
    | 'health';
  operationId?: string;
  state?: string;
  method?: string;
  route?: string;
  status?: number;
  attempt?: number;
  delayMs?: number;
  directory?: string;
};

type TimelineEntry = DiagnosticEvent & { at: string };

/** Only explicit lifecycle metadata enters this buffer. Ordinary logs can contain user content. */
class DiagnosticTimeline {
  private readonly entries: TimelineEntry[] = [];
  private sequence = 0;
  private lastStreamActivity: { at: string; operationId: string } | undefined;

  nextId(prefix: 'request' | 'stream'): string {
    this.sequence += 1;
    return `${prefix}-${this.sequence}`;
  }

  record(event: DiagnosticEvent): void {
    const entry: TimelineEntry = { ...event, at: new Date().toISOString() };
    for (const key of ['operationId', 'state', 'method', 'route', 'directory'] as const) {
      const value = entry[key];
      if (value !== undefined) entry[key] = redactDiagnosticText(value).slice(0, MAX_FIELD_CHARS);
    }
    this.entries.push(entry);
    if (this.entries.length > MAX_EVENTS) this.entries.shift();
  }

  streamActivity(operationId: string): void {
    this.lastStreamActivity = { at: new Date().toISOString(), operationId };
  }

  export(snapshot: string, hidePaths = true): string {
    const activity = this.lastStreamActivity;
    const lines = this.entries.map(({ at, event, ...fields }) => {
      if (hidePaths && fields.directory) fields.directory = '[local path]';
      return `${at} ${event} ${JSON.stringify(fields)}`;
    });
    const timeline = [
      '## Recent diagnostic events',
      '',
      `Last stream activity: ${activity ? `${activity.at} (${activity.operationId})` : 'not observed'}`,
      `Retained events: ${this.entries.length}/${MAX_EVENTS}. Prompt, response, and tool-output bodies are not collected.`,
      '',
      '```text',
      ...lines,
      '```',
    ].join('\n');
    const report = `${redactDiagnosticText(snapshot, hidePaths)}\n${timeline}`;
    return report.length > MAX_EXPORT_CHARS
      ? `${report.slice(0, MAX_EXPORT_CHARS - 32)}\n[Diagnostic export truncated]\n`
      : report;
  }

  clear(): void {
    this.entries.length = 0;
    this.lastStreamActivity = undefined;
  }
}

export const diagnosticTimeline = new DiagnosticTimeline();

export function redactDiagnosticText(text: string, hidePaths = false): string {
  const urls: string[] = [];
  let redacted = text
    .replace(/\b(Bearer|Basic)\s+[^\s"'`,;<>]+/gi, '$1 [redacted]')
    .replace(
      /\b(authorization|x-api-key|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|client[_-]?secret|password|secret|cookie|signature|credential|oauth[_-]?code)(["']?\s*[:=]\s*)(?:"[^"\n]*(?:"|$)|'[^'\n]*(?:'|$)|[^\s,;\n`]+)/gi,
      '$1$2[redacted]'
    )
    .replace(/https?:\/\/[^\s<>`"'()[\]]+/gi, (raw) => {
      try {
        const url = new URL(raw);
        url.username = '';
        url.password = '';
        url.search = '';
        url.hash = '';
        urls.push(raw.endsWith('/') ? url.toString() : url.toString().replace(/\/$/, ''));
      } catch {
        // Malformed URLs are omitted rather than exposing possible credentials.
        urls.push('[redacted URL]');
      }
      return `__DIAGNOSTIC_URL_${urls.length - 1}__`;
    });
  if (hidePaths) {
    redacted = redacted
      .replace(/`+(?:[a-z]:[\\/]|\\\\|\/)[^`\n]*`+/gi, '`[local path]`')
      .replace(/(?:[a-z]:[\\/]|\\\\|\/)[^\s`"'<>|,}]+/gi, '[local path]');
  }
  return redacted.replace(
    /__DIAGNOSTIC_URL_(\d+)__/g,
    (_match, index: string) => urls[Number(index)] ?? '[redacted URL]'
  );
}

/** Retain endpoint names, never query values or user-supplied path segments. */
export function diagnosticRoute(path: string): string {
  const known = new Set([
    'session',
    'message',
    'status',
    'prompt_async',
    'summarize',
    'global',
    'health',
    'event',
    'provider',
    'auth',
    'oauth',
    'callback',
    'mcp',
    'question',
    'permission',
    'config',
  ]);
  return new URL(path, 'http://localhost').pathname
    .split('/')
    .map((part) => (!part || known.has(part) ? part : ':id'))
    .join('/');
}
