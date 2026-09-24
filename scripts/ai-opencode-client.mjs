import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
let adapterModule;

export function aiServerHeaders() {
  const password = process.env.OPENCODE_SERVER_PASSWORD;
  return password
    ? {
        authorization: `Basic ${Buffer.from(`${process.env.OPENCODE_SERVER_USERNAME || 'opencode'}:${password}`).toString('base64')}`,
      }
    : {};
}

// Bundle the same protocol projection used by the extension, without loading VS Code.
function loadAdapter() {
  adapterModule ??= build({
    stdin: {
      contents: `export { OpenCodeV2Adapter } from './src/extension/opencode-v2-adapter';
        export { OpenCodeV2SessionState } from './src/extension/opencode-v2-session-state';`,
      resolveDir: root,
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
  }).then(
    ({ outputFiles }) =>
      import(
        `data:text/javascript;base64,${Buffer.from(`${outputFiles[0].text}\n//# sourceURL=varro-ai-v2-adapter.mjs`).toString('base64')}`
      )
  );
  return adapterModule;
}

export class AiOpenCodeClient {
  constructor(server, workspace) {
    this.server = server.replace(/\/$/, '');
    this.workspace = workspace;
  }

  async wire(method, route, body, options = {}) {
    const url = new URL(route, this.server);
    const headers = { 'content-type': 'application/json', ...aiServerHeaders() };
    if (!options.unscoped) {
      url.searchParams.set('directory', this.workspace);
      headers['x-opencode-directory'] = this.workspace;
    }
    const init = {
      method,
      redirect: 'error',
      headers,
      signal: options.signal ?? AbortSignal.timeout(30_000),
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    const response = await fetch(url, init);
    if (!response.ok) throw new Error(`${response.status} ${method} ${url.pathname} failed`);
    const text = await response.text();
    if (!text) return null;
    if (response.headers.get('content-type')?.includes('text/html')) {
      throw new Error(`Expected OpenCode JSON from ${url.pathname}, received HTML`);
    }
    try {
      return JSON.parse(text);
    } catch (cause) {
      throw new Error(`Invalid OpenCode JSON from ${url.pathname}`, { cause });
    }
  }

  async detect() {
    this.detection ??= this.detectBackend();
    return this.detection;
  }

  async detectBackend() {
    for (const route of ['/global/health', '/api/status', '/api/info']) {
      const response = await fetch(new URL(route, this.server), {
        redirect: 'error',
        headers: aiServerHeaders(),
        signal: AbortSignal.timeout(5_000),
      });
      if (response.status === 404 || response.headers.get('content-type')?.includes('text/html'))
        continue;
      if (!response.ok) throw new Error(`OpenCode detection ${route}: HTTP ${response.status}`);
      const info = await response.json();
      const healthy =
        route === '/global/health'
          ? info.healthy === true
          : info.ready === true || Number.isSafeInteger(info.pid);
      const major = /^(1|2)\./.exec(info.version ?? '')?.[1];
      if (!healthy || !major) throw new Error(`Invalid OpenCode backend identity at ${route}`);
      this.backend = { apiVersion: Number(major), version: info.version };
      if (this.backend.apiVersion === 2) {
        const { OpenCodeV2Adapter, OpenCodeV2SessionState } = await loadAdapter();
        const key = createHash('sha256').update(`${this.server}\n${this.workspace}`).digest('hex');
        const annotations = new OpenCodeV2SessionState(
          path.join(root, 'artifacts/ai-test-data/controller-state', key)
        );
        this.adapter = new OpenCodeV2Adapter(this.wire.bind(this), annotations);
      }
      return this.backend;
    }
    throw new Error('Cannot identify an OpenCode v1 or v2 backend');
  }

  async request(method, route, body) {
    await this.detect();
    return this.adapter
      ? this.adapter.request(method, route, body, { directory: this.workspace })
      : this.wire(method, route, body);
  }
}
