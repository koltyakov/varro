/* oxlint-disable anti-slop/no-module-mocking -- Only unrelated session navigation is stubbed; citation checks use the real bridge and binding. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createComponent, createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { MarkdownRenderer, __resetMarkdownCachesForTests } from './MarkdownRenderer';
import { citationPathChecks } from '../lib/citation-path-checks';
import { citationSymbolLookups } from '../lib/citation-symbol-checks';
import { setState } from '../lib/state';
import { asRecord, getString, isString } from '../lib/runtime-values';
import { getFileTypeIcon } from './FileTypeIcon';

vi.mock('../hooks/useOpenCode', () => ({ selectSession: vi.fn() }));

describe('MarkdownRenderer exact citation validation', () => {
  let root: HTMLDivElement;
  let dispose: (() => void) | undefined;
  const send = vi.fn();

  beforeEach(() => {
    citationPathChecks.clear();
    citationSymbolLookups.clear();
    __resetMarkdownCachesForTests();
    send.mockReset();
    window.__sendToExtension = send;
    setState('activeSessionId', null);
    setState('sessions', []);
    setState('editorContext', {
      workspacePath: '/repo',
      activeFile: null,
      selection: null,
      diagnostics: [],
    });
    root = document.createElement('div');
    document.body.append(root);
  });

  afterEach(() => {
    dispose?.();
    dispose = undefined;
    root.remove();
    citationPathChecks.clear();
    citationSymbolLookups.clear();
    delete window.__sendToExtension;
  });

  function requests() {
    return send.mock.calls
      .map(([message]) => asRecord(message))
      .filter((message) => message?.type === 'api/request')
      .map((message) => asRecord(message?.payload));
  }

  async function respond(values: Array<string | null>, index = 0) {
    await vi.waitFor(() => expect(requests().length).toBeGreaterThan(index));
    const request = requests()[index];
    const body = asRecord(request?.body);
    const paths = body?.paths;
    const firstPath = Array.isArray(paths) ? paths[0] : undefined;
    if (!isString(firstPath)) throw new Error('Expected a citation path batch');
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          type: 'api/response',
          payload: { id: request?.id, data: values },
        },
      })
    );
    await Promise.resolve();
    await Promise.resolve();
    await vi.waitFor(() =>
      expect(
        citationPathChecks.peek(firstPath, {
          directory: getString(body?.directory) || undefined,
          sessionID: getString(body?.sessionID) || undefined,
        })
      ).not.toBeUndefined()
    );
  }

  it.each([
    ['src/app.ts', '/repo/src/app.ts'],
    ['/outside/app.ts', '/outside/app.ts'],
    ['app.ts', '/repo/app.ts'],
  ])('links an existing exact path %s only after validation', async (path, absolutePath) => {
    dispose = render(() => <MarkdownRenderer content={`Updated \`${path}\`.`} />, root);
    expect(root.querySelector('a[data-file]')).toBeNull();
    expect(root.querySelector('code')?.textContent).toBe(path);
    await respond([absolutePath]);
    await vi.waitFor(() =>
      expect(root.querySelector('a[data-file]')?.getAttribute('href')).toBe(absolutePath)
    );
    expect(asRecord(requests()[0]?.body)).toEqual({ directory: '/repo', paths: [path] });
  });

  it.each([
    'missing.ts',
    'src/missing.ts',
    'app.ts',
    '/outside/missing.ts',
    'seedX/config.yaml',
    'pdf-source/65129.pdf',
    'pdf-source/__65129.pdf',
  ])('keeps missing citation %s as plain code without discovering namesakes', async (path) => {
    dispose = render(() => <MarkdownRenderer content={`Inspect \`${path}\`.`} />, root);
    const icon = root.querySelector<HTMLImageElement>('code.citation-path .file-path-icon');
    expect(icon?.getAttribute('src')).toBe(getFileTypeIcon(path));
    await respond([null]);
    expect(root.querySelector('code.citation-path .file-path-icon')).toBe(icon);
    expect(root.querySelector('a[data-file]')).toBeNull();
    expect(root.querySelector('code')?.textContent).toBe(path);
    expect(send.mock.calls.some(([message]) => asRecord(message)?.type === 'vscode/open')).toBe(
      false
    );
  });

  it('opens the validated absolute target and preserves the cited line range', async () => {
    dispose = render(() => <MarkdownRenderer content="[app.ts](src/app.ts#L10-L12)" />, root);
    await respond(['/repo/src/app.ts']);
    const anchor = root.querySelector<HTMLAnchorElement>('a[data-file]');
    await vi.waitFor(() => expect(anchor?.href).toContain('/repo/src/app.ts:10-12'));
    anchor?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(send).toHaveBeenCalledWith({
      type: 'vscode/open',
      payload: expect.objectContaining({
        path: '/repo/src/app.ts',
        line: 10,
        endLine: 12,
        exact: true,
      }),
    });
    const opened = send.mock.calls
      .map(([message]) => asRecord(message))
      .find((message) => message?.type === 'vscode/open');
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          type: 'vscode/open-result',
          payload: {
            requestId: asRecord(opened?.payload)?.requestId,
            status: 'opened',
          },
        },
      })
    );
  });

  it('renders streaming text while checks are pending and reuses checks across appends', async () => {
    const [content, setContent] = createSignal('Updated `src/app.ts`.\n\nWorking');
    dispose = render(
      () =>
        createComponent(MarkdownRenderer, {
          get content() {
            return content();
          },
          forceStreaming: true,
        }),
      root
    );
    await vi.waitFor(() => expect(requests()).toHaveLength(1));
    setContent('Updated `src/app.ts`.\n\nWorking without waiting for the filesystem.');
    await vi.waitFor(() =>
      expect(root.textContent).toContain('without waiting for the filesystem')
    );
    expect(root.querySelector('a[data-file]')).toBeNull();
    await respond(['/repo/src/app.ts']);
    await vi.waitFor(() => expect(root.querySelector('a[data-file]')).not.toBeNull());
    const anchor = root.querySelector('a[data-file]');
    setContent('Updated `src/app.ts`.\n\nWorking without waiting for the filesystem. More text.');
    await vi.waitFor(() => expect(root.textContent).toContain('More text.'));
    expect(root.querySelector('a[data-file]')).toBe(anchor);
    expect(requests()).toHaveLength(1);
  });

  it('reuses cached checks across virtual remounts without restoring unvalidated links', async () => {
    dispose = render(
      () => <MarkdownRenderer content="`src/app.ts` and `missing.ts`" cacheByContent />,
      root
    );
    await respond(['/repo/src/app.ts', null]);
    await vi.waitFor(() => expect(root.querySelectorAll('a[data-file]')).toHaveLength(1));
    dispose();
    root.replaceChildren();
    dispose = render(
      () => <MarkdownRenderer content="`src/app.ts` and `missing.ts`" cacheByContent />,
      root
    );
    expect(root.querySelectorAll('a[data-file]')).toHaveLength(1);
    expect(root.querySelector('code')?.textContent).toBe('missing.ts');
    expect(root.querySelector('code.citation-path .file-path-icon')?.getAttribute('src')).toBe(
      getFileTypeIcon('missing.ts')
    );
    expect(requests()).toHaveLength(1);
  });

  it('ignores a late result after the component is disposed', async () => {
    dispose = render(() => <MarkdownRenderer content="`src/app.ts`" />, root);
    await vi.waitFor(() => expect(requests()).toHaveLength(1));
    dispose();
    dispose = undefined;
    await respond(['/repo/src/app.ts']);
    expect(root.querySelector('a[data-file]')).toBeNull();
  });

  it('does not apply a pending validation from the previous session project directory', async () => {
    const [directory, setDirectory] = createSignal('/repo-a');
    dispose = render(
      () =>
        createComponent(MarkdownRenderer, {
          content: '`src/app.ts`',
          get directory() {
            return directory();
          },
        }),
      root
    );
    await vi.waitFor(() => expect(requests()).toHaveLength(1));
    const oldCode = root.querySelector('code');
    setDirectory('/repo-b');
    await vi.waitFor(() => expect(root.querySelector('code')).not.toBe(oldCode));
    await respond(['/repo-a/src/app.ts']);
    expect(root.querySelector('a[data-file]')).toBeNull();
    await respond(['/repo-b/src/app.ts'], 1);
    await vi.waitFor(() =>
      expect(root.querySelector('a[data-file]')?.getAttribute('href')).toBe('/repo-b/src/app.ts')
    );
    expect(asRecord(requests()[1]?.body)?.directory).toBe('/repo-b');
  });

  it('does not validate fenced examples or external links', async () => {
    dispose = render(
      () => (
        <MarkdownRenderer content={'```text\nsrc/example.ts\n```\n\n[Docs](https://example.com)'} />
      ),
      root
    );
    expect(root.querySelector('pre code')?.textContent?.trim()).toBe('src/example.ts');
    expect(root.querySelector('a')?.getAttribute('href')).toBe('https://example.com');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(requests()).toHaveLength(0);
  });

  async function respondSymbols(values: unknown[], index = 0) {
    await vi.waitFor(() => expect(requests().length).toBeGreaterThan(index));
    const request = requests()[index];
    expect(request?.path).toBe('/varro/citation-symbols');
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          type: 'api/response',
          payload: { id: request?.id, data: values },
        },
      })
    );
    await Promise.resolve();
    await Promise.resolve();
  }

  it('resolves the issue 51 functions and class but leaves grouped prose alone', async () => {
    dispose = render(
      () => (
        <MarkdownRenderer
          content={
            '`transporter / franka / clip`, `loss_weights()`, `soft_updates()`, `stack_on_channel()`, `CustomMultiTaskRLBenchEnv`'
          }
          cacheByContent
        />
      ),
      root
    );
    const codes = [...root.querySelectorAll('code')];
    expect(root.querySelector('a')).toBeNull();
    await respondSymbols([
      { path: '/repo/loss.py', line: 12 },
      { path: '/repo/agent.py', line: 34 },
      { path: '/repo/stack.py', line: 56 },
      { path: '/repo/env.py', line: 78 },
    ]);
    await vi.waitFor(() => expect(root.querySelectorAll('a[data-file]')).toHaveLength(4));
    expect([...root.querySelectorAll('code')]).toEqual(codes);
    expect(codes[0]?.parentElement?.tagName).not.toBe('A');
    expect(asRecord(requests()[0]?.body)).toEqual({
      directory: '/repo',
      symbols: [
        'loss_weights()',
        'soft_updates()',
        'stack_on_channel()',
        'CustomMultiTaskRLBenchEnv',
      ],
    });
    const anchor = root.querySelector<HTMLAnchorElement>('a[data-file]')!;
    anchor.click();
    expect(send).toHaveBeenCalledWith({
      type: 'vscode/open',
      payload: expect.objectContaining({
        path: '/repo/loss.py',
        line: 12,
        exact: true,
      }),
    });
  });

  it.each([null, { path: 'relative.py', line: 1 }, { path: '/repo/loss.py', line: 0 }])(
    'leaves unresolved or malformed symbol results inert: %j',
    async (value) => {
      dispose = render(() => <MarkdownRenderer content="`loss_weights()`" />, root);
      const code = root.querySelector('code');
      await respondSymbols([value]);
      expect(root.querySelector('a')).toBeNull();
      expect(root.querySelector('code')).toBe(code);
    }
  );

  // Mirrors CitationSymbolLookups.RETRY_DELAYS_MS: about one minute in total.
  const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];

  async function withFakeTimers(run: () => Promise<void>) {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await run();
    } finally {
      vi.useRealTimers();
    }
  }

  it('resolves a lookup that stays pending past several retries for the rendered node', () =>
    withFakeTimers(async () => {
      dispose = render(() => <MarkdownRenderer content="`loss_weights()`" />, root);
      const code = root.querySelector('code');
      // The extension reports a timed-out or concurrency-skipped lookup as pending.
      for (const [index, delay] of RETRY_DELAYS_MS.slice(0, 5).entries()) {
        await respondSymbols(['pending'], index);
        expect(root.querySelector('a')).toBeNull();
        await vi.advanceTimersByTimeAsync(delay);
      }
      // About 30s after the first request, beyond the old 5s retry window.
      await respondSymbols([{ path: '/repo/loss.py', line: 12 }], 5);
      await vi.waitFor(() => expect(root.querySelector('a[data-file]')).not.toBeNull());
      expect(root.querySelector('a code')).toBe(code);
      expect(root.querySelector('a')?.getAttribute('href')).toBe('/repo/loss.py:12');
    }));

  it('shares one bounded retry chain across remounts and pauses after exhaustion', () =>
    withFakeTimers(async () => {
      const mount = () => render(() => <MarkdownRenderer content="`loss_weights()`" />, root);
      dispose = mount();
      for (const [index, delay] of RETRY_DELAYS_MS.entries()) {
        await respondSymbols(['pending'], index);
        if (index === 2) {
          // A remounted row joins the running chain instead of starting another one.
          dispose();
          root.replaceChildren();
          dispose = mount();
        }
        await vi.advanceTimersByTimeAsync(delay);
      }
      await respondSymbols(['pending'], RETRY_DELAYS_MS.length);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(requests()).toHaveLength(RETRY_DELAYS_MS.length + 1);
      expect(root.querySelector('a')).toBeNull();

      // Within the exhausted pause, remounts stay inert; afterwards a fresh chain starts.
      dispose();
      root.replaceChildren();
      dispose = mount();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(requests()).toHaveLength(RETRY_DELAYS_MS.length + 1);
      await vi.advanceTimersByTimeAsync(10_000);
      dispose();
      root.replaceChildren();
      dispose = mount();
      await respondSymbols([{ path: '/repo/loss.py', line: 12 }], RETRY_DELAYS_MS.length + 1);
      await vi.waitFor(() => expect(root.querySelector('a[data-file]')).not.toBeNull());
    }));

  it('stops polling when no rendered node remains and never retries a miss', () =>
    withFakeTimers(async () => {
      dispose = render(() => <MarkdownRenderer content="`stack_on_channel()`" />, root);
      await respondSymbols(['pending']);
      dispose();
      dispose = undefined;
      root.replaceChildren();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(requests()).toHaveLength(1);

      // A later remount starts a fresh chain for the unresolved symbol.
      dispose = render(() => <MarkdownRenderer content="`stack_on_channel()`" />, root);
      await respondSymbols([{ path: '/repo/stack.py', line: 56 }], 1);
      await vi.waitFor(() => expect(root.querySelector('a[data-file]')).not.toBeNull());
      dispose();
      root.replaceChildren();

      dispose = render(() => <MarkdownRenderer content="`soft_updates()`" />, root);
      await respondSymbols([null], 2);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(requests()).toHaveLength(3);
      expect(root.querySelector('a')).toBeNull();
    }));

  it('reuses symbol results across appends and remounts without replacing code nodes', async () => {
    const [content, setContent] = createSignal('`loss_weights()`\n\nWorking');
    const mount = () => render(() => <MarkdownRenderer content={content()} />, root);
    dispose = mount();
    await respondSymbols([{ path: '/repo/loss.py', line: 12 }]);
    await vi.waitFor(() => expect(root.querySelector('a')).not.toBeNull());
    const anchor = root.querySelector('a');
    setContent('`loss_weights()`\n\nWorking on more text');
    await vi.waitFor(() => expect(root.textContent).toContain('more text'));
    expect(root.querySelector('a')).toBe(anchor);
    dispose();
    root.replaceChildren();
    dispose = mount();
    expect(root.querySelector('a')?.getAttribute('href')).toBe('/repo/loss.py:12');
    expect(requests()).toHaveLength(1);
  });

  it('ignores symbol results from a replaced project or disposed component', async () => {
    const [directory, setDirectory] = createSignal('/repo-a');
    dispose = render(
      () => <MarkdownRenderer content="`loss_weights()`" directory={directory()} />,
      root
    );
    await vi.waitFor(() => expect(requests()).toHaveLength(1));
    const oldCode = root.querySelector('code');
    setDirectory('/repo-b');
    await vi.waitFor(() => expect(root.querySelector('code')).not.toBe(oldCode));
    await respondSymbols([{ path: '/repo-a/loss.py', line: 12 }]);
    expect(root.querySelector('a')).toBeNull();
    await vi.waitFor(() => expect(requests()).toHaveLength(2));
    dispose();
    dispose = undefined;
    await respondSymbols([{ path: '/repo-b/loss.py', line: 12 }], 1);
    expect(root.querySelector('a')).toBeNull();
  });

  it('activates cached symbols in a detached stable append before attaching its nodes', async () => {
    const [content, setContent] = createSignal('`loss_weights()`\n\nWorking');
    dispose = render(() => <MarkdownRenderer content={content()} />, root);
    await respondSymbols([{ path: '/repo/loss.py', line: 12 }]);
    await vi.waitFor(() => expect(root.querySelectorAll('a[data-file]')).toHaveLength(1));
    setContent('`loss_weights()`\n\nAlso `loss_weights()`\n\nWorking');
    await vi.waitFor(() => expect(root.querySelectorAll('a[data-file]')).toHaveLength(2));
    expect(requests()).toHaveLength(1);
  });

  it('does not trust symbol markers authored in raw HTML', async () => {
    dispose = render(
      () => (
        <MarkdownRenderer content={'<code data-citation-symbol="forged">loss_weights()</code>'} />
      ),
      root
    );
    expect(root.querySelector('code[data-citation-symbol]')).toBeNull();
    await new Promise((done) => setTimeout(done, 10));
    expect(requests()).toHaveLength(0);
  });

  it('does not look up fenced symbols, illustrative groups, ordinary code, or disabled linkification', async () => {
    dispose = render(
      () => (
        <MarkdownRenderer
          content={
            '```python\nloss_weights()\n```\n\n`transporter / franka / clip` and `value`\n\nFor example, `loss_weights()`.'
          }
        />
      ),
      root
    );
    await new Promise((done) => setTimeout(done, 10));
    expect(requests()).toHaveLength(0);
    dispose();
    root.replaceChildren();
    dispose = render(
      () => <MarkdownRenderer content="`loss_weights()`" disablePathLinkify />,
      root
    );
    await new Promise((done) => setTimeout(done, 10));
    expect(requests()).toHaveLength(0);
  });
});
