export type OpenCodeApiVersion = 1 | 2;

export function openCodeApiVersion(version: string): OpenCodeApiVersion | null {
  const major = version.match(/^(?:opencode\s+v?)?(\d+)\./)?.[1];
  return major === '1' ? 1 : major === '2' ? 2 : null;
}

export function basicAuthorization(password: string, username = 'opencode'): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

/** Consume credentials before startup output reaches logs, including split stdout chunks. */
export class OpenCodeStartupOutput {
  private pending: Buffer = Buffer.alloc(0);
  private discarding = false;
  private static readonly PREFIX = Buffer.from('server password');

  constructor(private readonly onPassword: (password: string) => void) {}

  write(chunk: Buffer): Buffer {
    let source = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    this.pending = Buffer.alloc(0);
    const output: Buffer[] = [];
    while (source.length) {
      if (this.discarding) {
        const end = source.indexOf(10);
        if (end < 0) break;
        this.discarding = false;
        source = source.subarray(end + 1);
      }
      const start = source.indexOf(OpenCodeStartupOutput.PREFIX);
      if (start < 0) {
        let held = 0;
        for (
          let size = Math.min(source.length, OpenCodeStartupOutput.PREFIX.length - 1);
          size > 0;
          size--
        ) {
          if (
            (source.length === size || source[source.length - size - 1] === 10) &&
            source.subarray(-size).equals(OpenCodeStartupOutput.PREFIX.subarray(0, size))
          ) {
            held = size;
            break;
          }
        }
        output.push(held ? source.subarray(0, source.length - held) : source);
        if (held) this.pending = Buffer.from(source.subarray(-held));
        break;
      }
      output.push(source.subarray(0, start));
      const end = source.indexOf(10, start);
      if (end < 0) {
        if (source.length - start <= 8192) this.pending = Buffer.from(source.subarray(start));
        else {
          this.discarding = true;
          output.push(Buffer.from('server password [redacted]\n'));
        }
        break;
      }
      if (end - start <= 8192) {
        const password = source
          .subarray(start + OpenCodeStartupOutput.PREFIX.length, end)
          .toString('utf8')
          .trim();
        if (password && password.length <= 4096) this.onPassword(password);
      }
      output.push(Buffer.from('server password [redacted]\n'));
      source = source.subarray(end + 1);
    }
    return output.length === 1 ? output[0]! : Buffer.concat(output);
  }
}
