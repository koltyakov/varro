/* oxlint-disable anti-slop/no-module-mocking -- Only unrelated session navigation is stubbed; citation checks use the real bridge and binding. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createComponent, createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { MarkdownRenderer, __resetMarkdownCachesForTests } from './MarkdownRenderer';
import { citationPathChecks } from '../lib/citation-path-checks';
import { setState } from '../lib/state';
import { asRecord, getString, isString } from '../lib/runtime-values';

vi.mock('../hooks/useOpenCode', () => ({ selectSession: vi.fn() }));

describe('MarkdownRenderer exact citation validation', () => {
  let root: HTMLDivElement;
  let dispose: (() => void) | undefined;
  const send = vi.fn();

  beforeEach(() => {
    citationPathChecks.clear();
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

  it.each(['missing.ts', 'src/missing.ts', 'app.ts', '/outside/missing.ts', 'seedX/config.yaml'])(
    'keeps missing citation %s as plain code without discovering namesakes',
    async (path) => {
      dispose = render(() => <MarkdownRenderer content={`Inspect \`${path}\`.`} />, root);
      await respond([null]);
      expect(root.querySelector('a[data-file]')).toBeNull();
      expect(root.querySelector('code')?.textContent).toBe(path);
      expect(send.mock.calls.some(([message]) => asRecord(message)?.type === 'vscode/open')).toBe(
        false
      );
    }
  );

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
});
