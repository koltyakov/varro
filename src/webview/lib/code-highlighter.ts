/* oxlint-disable unicorn/prefer-add-event-listener, unicorn/require-post-message-target-origin -- Each worker has one owner; worker messages have no targetOrigin. */
// oxlint-disable-next-line import/default -- Vite's worker URL plugin supplies this default export.
import workerUrl from './highlight-worker?worker&url';
import { isRecord, isString } from '../../shared/type-utils';
import { canHighlight, MAX_HIGHLIGHT_OUTPUT_CHARACTERS } from './highlight-protocol';
import type { HighlightRequest, HighlightResponse } from './highlight-protocol';
import { getCachedValue, getUtf8ByteLength, setCachedValue } from './markdown-cache';
import type { MarkdownStringCache } from './markdown-cache';

const CODE_LANGUAGE_ALIASES = new Map([
  ['console', 'bash'],
  ['js', 'javascript'],
  ['jsx', 'javascript'],
  ['html', 'xml'],
  ['htm', 'xml'],
  ['md', 'markdown'],
  ['plain', 'plaintext'],
  ['py', 'python'],
  ['shell', 'bash'],
  ['sh', 'bash'],
  ['text', 'plaintext'],
  ['ts', 'typescript'],
  ['tsx', 'typescript'],
  ['txt', 'plaintext'],
  ['yml', 'yaml'],
  ['zsh', 'bash'],
]);
const MAX_QUEUE_BYTES = 2 * 1024 * 1024;
const MAX_JOBS = 512;
const EXECUTION_TIMEOUT_MS = 2_000;
const IDLE_TIMEOUT_MS = 30_000;
const cache: MarkdownStringCache = new Map();

export function resolveCodeLanguage(language?: string): string | undefined {
  const normalized = language?.trim().toLowerCase();
  return normalized ? (CODE_LANGUAGE_ALIASES.get(normalized) ?? normalized) : undefined;
}

function keyFor(text: string, language: string) {
  return `hljs-11.12.0:1\0${language}\0${text}`;
}

export function highlightCode(text: string, language: string): string | null {
  return getCachedValue(cache, keyFor(text, language)) ?? null;
}

type Consumer = { apply: (html: string | null) => void; priority: number };
type Job = HighlightRequest & {
  key: string;
  bytes: number;
  consumers: Set<Consumer>;
  returned?: boolean;
};
type WorkerHandle = {
  postMessage: (request: HighlightRequest) => void;
  terminate: () => void;
  onmessage: ((event: MessageEvent<HighlightResponse | { ready: true }>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
};

async function createWorker(signal: AbortSignal): Promise<WorkerHandle> {
  if (import.meta.env.DEV) return new Worker(workerUrl, { type: 'module' });
  const response = await fetch(workerUrl, { signal });
  if (!response.ok) throw new Error(`Highlight worker asset: ${response.status}`);
  const url = URL.createObjectURL(await response.blob());
  try {
    return new Worker(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Validate the shared output boundary before caching or publishing to any consumer.
export function validateHighlightHtml(html: string, text: string): boolean {
  if (html.length > MAX_HIGHLIGHT_OUTPUT_CHARACTERS) return false;
  const template = document.createElement('template');
  template.innerHTML = html;
  if (template.content.textContent !== text) return false;
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_ALL);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (node.nodeType === Node.TEXT_NODE) continue;
    if (
      !(node instanceof HTMLSpanElement) ||
      node.attributes.length !== 1 ||
      !node.hasAttribute('class') ||
      !node.classList.length ||
      [...node.classList].some((name) => !/^(?:(?:hljs|language)-[\w-]+|[a-z][\w-]*_+)$/.test(name))
    )
      return false;
  }
  return true;
}

export class HighlightWorkerClient {
  private worker: WorkerHandle | undefined;
  private starting: AbortController | undefined;
  private ready = false;
  private active: Job | undefined;
  private readonly jobs = new Map<string, Job>();
  private bytes = 0;
  private nextId = 0;
  private deadline: ReturnType<typeof setTimeout> | undefined;
  private idle: ReturnType<typeof setTimeout> | undefined;
  private failures = 0;
  private bufferedBytes = 0;
  private readonly skipped = new Set<string>();
  private disposed = false;
  private readonly commits: Array<() => void> = [];
  private frame: number | undefined;
  private flushing = false;

  constructor(private readonly factory = createWorker) {}

  request(text: string, language: string, apply: Consumer['apply'], priority = 0): () => void {
    const consumer = { apply, priority };
    let cancelled = false;
    const publish = (html: string | null) =>
      this.commit(() => {
        if (!cancelled) apply(html);
      });
    const key = keyFor(text, language);
    const cached = highlightCode(text, language);
    if (cached !== null) {
      publish(cached);
      return () => {
        cancelled = true;
      };
    }
    if (
      this.disposed ||
      this.failures >= 3 ||
      this.skipped.has(key) ||
      language === 'plaintext' ||
      !canHighlight(text)
    ) {
      publish(null);
      return () => {
        cancelled = true;
      };
    }
    let job = this.jobs.get(key);
    if (!job) {
      const bytes = getUtf8ByteLength(key);
      if (this.jobs.size >= MAX_JOBS || this.bytes + bytes > MAX_QUEUE_BYTES) {
        publish(null);
        return () => {
          cancelled = true;
        };
      }
      job = { id: ++this.nextId, text, language, key, bytes, consumers: new Set() };
      this.jobs.set(key, job);
      this.bytes += bytes;
    }
    job.consumers.add(consumer);
    this.pump();
    const owned = job;
    return () => {
      cancelled = true;
      owned.consumers.delete(consumer);
      if (!owned.consumers.size && this.active !== owned) this.remove(owned);
    };
  }

  private commit(callback: () => void) {
    if (this.disposed) return;
    this.commits.push(callback);
    if (this.frame !== undefined || this.flushing) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = undefined;
      this.flushing = true;
      const start = performance.now();
      do {
        this.commits.shift()?.();
      } while (this.commits.length && performance.now() - start < 4);
      this.flushing = false;
      if (this.commits.length) this.commit(() => {});
    });
  }

  private pump() {
    if (this.disposed || this.active || this.bufferedBytes >= 2 * 1024 * 1024) return;
    clearTimeout(this.idle);
    if (!this.jobs.size) {
      if (this.worker) this.idle = setTimeout(() => this.stop(), IDLE_TIMEOUT_MS);
      return;
    }
    if (!this.worker) {
      if (this.starting) return;
      const controller = new AbortController();
      this.starting = controller;
      this.deadline = setTimeout(() => this.fail(), 10_000);
      void this.factory(controller.signal)
        .then((worker) => {
          if (this.starting !== controller || this.disposed) {
            worker.terminate();
            return;
          }
          this.worker = worker;
          worker.onmessage = (event: MessageEvent<HighlightResponse | { ready: true }>) => {
            if (this.worker !== worker) return;
            const data = event.data;
            if (!isRecord(data)) {
              this.fail();
              return;
            }
            if ('ready' in data && data.ready === true && !this.ready) {
              clearTimeout(this.deadline);
              this.starting = undefined;
              this.ready = true;
              this.pump();
            } else if (
              'id' in data &&
              this.active &&
              data.id === this.active.id &&
              (data.html === null || isString(data.html))
            ) {
              const job = this.active;
              const rawHtml = data.html;
              clearTimeout(this.deadline);
              this.active = undefined;
              if (data.html !== null && data.html.length > MAX_HIGHLIGHT_OUTPUT_CHARACTERS) {
                this.active = job;
                this.fail();
                return;
              }
              job.returned = true;
              const resultBytes = (data.html?.length ?? 0) * 2;
              this.bufferedBytes += resultBytes;
              this.commit(() => {
                this.bufferedBytes -= resultBytes;
                this.remove(job);
                if (job.consumers.size) {
                  const html =
                    rawHtml !== null && validateHighlightHtml(rawHtml, job.text) ? rawHtml : null;
                  if (html !== null) setCachedValue(cache, job.key, html);
                  else this.skip(job.key);
                  for (const consumer of job.consumers)
                    this.commit(() => {
                      if (job.consumers.has(consumer)) consumer.apply(html);
                    });
                }
                this.pump();
              });
              this.pump();
            } else this.fail();
          };
          worker.onerror = (event) => {
            event.preventDefault();
            if (this.worker === worker) this.fail();
          };
          worker.onmessageerror = () => {
            if (this.worker === worker) this.fail();
          };
        })
        .catch(() => {
          if (this.starting === controller) this.fail();
        });
      return;
    }
    if (!this.ready) return;
    let selected: Job | undefined;
    let priority = -Infinity;
    for (const job of this.jobs.values()) {
      if (job.returned) continue;
      for (const consumer of job.consumers) {
        if (consumer.priority > priority) {
          selected = job;
          priority = consumer.priority;
        }
      }
    }
    if (!selected) return;
    this.active = selected;
    this.deadline = setTimeout(() => this.fail(), EXECUTION_TIMEOUT_MS);
    try {
      this.worker.postMessage({
        id: selected.id,
        text: selected.text,
        language: selected.language,
      });
    } catch {
      this.fail();
    }
  }

  private remove(job: Job) {
    if (this.jobs.get(job.key) === job) {
      this.jobs.delete(job.key);
      this.bytes -= job.bytes;
    }
  }

  private skip(key: string) {
    this.skipped.add(key);
    if (this.skipped.size > 16) this.skipped.delete(this.skipped.values().next().value!);
  }

  private fail() {
    this.failures++;
    this.stop();
    const failed = this.active
      ? [this.active]
      : [...this.jobs.values()].filter((job) => !job.returned);
    this.active = undefined;
    if (this.failures >= 3) failed.push(...[...this.jobs.values()].filter((job) => !job.returned));
    for (const job of new Set(failed)) {
      this.skip(job.key);
      this.remove(job);
      this.commit(() => {
        for (const consumer of job.consumers) consumer.apply(null);
      });
    }
    this.pump();
  }

  private stop() {
    clearTimeout(this.deadline);
    clearTimeout(this.idle);
    this.starting?.abort();
    this.starting = undefined;
    this.worker?.terminate();
    this.worker = undefined;
    this.ready = false;
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
    this.jobs.clear();
    this.active = undefined;
    this.bytes = 0;
    this.bufferedBytes = 0;
    this.skipped.clear();
    this.commits.length = 0;
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
  }
}

export const codeHighlighter = new HighlightWorkerClient();
window.addEventListener('pagehide', () => codeHighlighter.dispose(), { once: true });
