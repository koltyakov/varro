import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HighlightWorkerClient, highlightCode, validateHighlightHtml } from './code-highlighter';
import { resetMarkdownCaches, markdownCacheStats } from './markdown-cache';
import type { HighlightRequest, HighlightResponse } from './highlight-protocol';

class TestWorker {
  onmessage: ((event: MessageEvent<HighlightResponse | { ready: true }>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  postMessage = vi.fn<(request: HighlightRequest) => void>();
  terminate = vi.fn();
  emit(data: HighlightResponse | { ready: true }) {
    this.onmessage?.(new MessageEvent('message', { data }));
  }
}

let client: HighlightWorkerClient;
let worker: TestWorker;
let factory: ReturnType<typeof vi.fn<() => Promise<TestWorker>>>;

beforeEach(() => {
  vi.useFakeTimers();
  resetMarkdownCaches();
  worker = new TestWorker();
  factory = vi.fn(async () => worker);
  client = new HighlightWorkerClient(factory);
});
afterEach(() => {
  client.dispose();
  vi.useRealTimers();
});

async function ready() {
  await Promise.resolve();
  worker.emit({ ready: true });
}
async function respond(html: string | null) {
  worker.emit({ id: worker.postMessage.mock.lastCall![0].id, html });
  await vi.advanceTimersByTimeAsync(32);
}

describe('highlight worker lifecycle', () => {
  it('deduplicates requests, cancels individual consumers, and shares the Markdown cache budget', async () => {
    const first = vi.fn();
    const second = vi.fn();
    const cancel = client.request('const x = 1;', 'typescript', first);
    client.request('const x = 1;', 'typescript', second);
    await ready();
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    cancel();
    const html = '<span class="hljs-keyword">const</span> x = 1;';
    await respond(html);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith(html);
    expect(highlightCode('const x = 1;', 'typescript')).toBe(html);
    expect(markdownCacheStats().bytes).toBeGreaterThan(html.length);
    client.request('const x = 1;', 'typescript', first);
    await vi.advanceTimersByTimeAsync(32);
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledWith(html);
  });

  it('prioritizes active content and removes obsolete queued work', async () => {
    client.request('history', 'ts', vi.fn());
    const cancel = client.request('obsolete', 'ts', vi.fn(), 2);
    client.request('active', 'ts', vi.fn(), 1);
    cancel();
    await ready();
    expect(worker.postMessage.mock.lastCall![0].text).toBe('active');
    await respond('active');
    expect(worker.postMessage.mock.lastCall![0].text).toBe('history');
  });

  it('drops a response cancelled before its frame commits', async () => {
    const apply = vi.fn();
    const cancel = client.request('hello', 'ts', apply);
    await ready();
    worker.emit({ id: worker.postMessage.mock.lastCall![0].id, html: 'hello' });
    cancel();
    await vi.advanceTimersByTimeAsync(32);
    expect(apply).not.toHaveBeenCalled();
    expect(highlightCode('hello', 'ts')).toBeNull();
  });

  it('terminates a stuck matcher and does not retry the failing input', async () => {
    const apply = vi.fn();
    client.request('pathological', 'ts', apply);
    await ready();
    await vi.advanceTimersByTimeAsync(2050);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith(null);
    client.request('pathological', 'ts', apply);
    await vi.advanceTimersByTimeAsync(32);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('bounds startup recovery and terminates a worker that arrives after disposal', async () => {
    let resolve!: (value: TestWorker) => void;
    client.dispose();
    client = new HighlightWorkerClient(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    client.request('hello', 'ts', vi.fn());
    client.dispose();
    resolve(worker);
    await Promise.resolve();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('fails closed on malformed output and recovers for another job', async () => {
    const apply = vi.fn();
    client.request('hello', 'ts', apply);
    await ready();
    await respond('<img src=x onerror=alert(1)>hello');
    expect(apply).toHaveBeenCalledWith(null);
    expect(highlightCode('hello', 'ts')).toBeNull();
    client.request('safe', 'ts', apply);
    await respond('<span class="hljs-string">safe</span>');
    expect(apply).toHaveBeenLastCalledWith('<span class="hljs-string">safe</span>');
  });

  it('bounds queued jobs and preserves plaintext for oversized input', async () => {
    const apply = vi.fn();
    client.request('a'.repeat(1001), 'ts', apply);
    await vi.advanceTimersByTimeAsync(32);
    expect(factory).not.toHaveBeenCalled();
    expect(apply).toHaveBeenCalledWith(null);
    for (let index = 0; index < 512; index++) client.request(`line${index}`, 'ts', vi.fn());
    const overflow = vi.fn();
    client.request('overflow', 'ts', overflow);
    await vi.advanceTimersByTimeAsync(32);
    expect(overflow).toHaveBeenCalledWith(null);
  });

  it('releases an idle worker', async () => {
    client.request('hello', 'ts', vi.fn());
    await ready();
    await respond('hello');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('stops retrying after three startup failures', async () => {
    factory.mockRejectedValue(new Error('CSP blocked the worker'));
    const apply = vi.fn();
    for (let index = 0; index < 5; index++) {
      client.request(`source${index}`, 'ts', apply);
      await vi.advanceTimersByTimeAsync(32);
    }
    expect(factory).toHaveBeenCalledTimes(3);
    expect(apply).toHaveBeenCalledTimes(5);
    expect(apply.mock.calls.every(([html]) => html === null)).toBe(true);
  });

  it('rejects messages from a terminated worker after recovery', async () => {
    client.request('stuck', 'ts', vi.fn());
    await ready();
    const old = worker;
    await vi.advanceTimersByTimeAsync(2050);
    worker = new TestWorker();
    factory.mockResolvedValue(worker);
    const apply = vi.fn();
    client.request('new source', 'ts', apply);
    await ready();
    old.emit({ id: worker.postMessage.mock.lastCall![0].id, html: 'new source' });
    await vi.advanceTimersByTimeAsync(32);
    expect(apply).not.toHaveBeenCalled();
    await respond('new source');
    expect(apply).toHaveBeenCalledExactlyOnceWith('new source');
  });

  it('bounds source bytes independently of the job count', async () => {
    const text = '😀'.repeat(400) + '\n';
    for (let index = 0; index < 100; index++)
      client.request(`${text.repeat(24)}${index}`, 'ts', vi.fn());
    const overflow = vi.fn();
    client.request(`${text.repeat(24)}overflow`, 'ts', overflow);
    await vi.advanceTimersByTimeAsync(32);
    expect(overflow).toHaveBeenCalledWith(null);
  });
});

describe('highlight output boundary', () => {
  it.each([
    ['<span class="hljs-title function_">x</span>&lt;😀', 'x<😀', true],
    ['<span class="hljs-string" style="color:red">x</span>', 'x', false],
    ['<span class="other">x</span>', 'x', false],
    ['<a href="javascript:alert(1)">x</a>', 'x', false],
    ['<!--comment-->x', 'x', false],
    ['<span class="hljs-string">changed</span>', 'original', false],
  ])('validates %s', (html, text, valid) => {
    expect(validateHighlightHtml(html, text)).toBe(valid);
  });
});
