import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { formatAttachedDiagnostics, formatEditorProblems } from '../lib/editor-problems';
import { ProblemsTooltip } from './ProblemsTooltip';

let container: HTMLDivElement;
let cleanup: (() => void) | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  container.remove();
  vi.useRealTimers();
});

it('shows selected diagnostics first, bounds highlights, and hides on Escape', async () => {
  const text = formatEditorProblems({
    workspacePath: '/repo',
    activeFile: { path: '/repo/app.ts', relativePath: 'app.ts', language: 'typescript' },
    selection: { startLine: 8, endLine: 8 },
    diagnosticCounts: { errors: 5, warnings: 1 },
    diagnostics: [
      ...Array.from({ length: 5 }, (_, index) => ({
        path: '/repo/app.ts',
        line: index + 1,
        severity: 'error' as const,
        message: `Error ${index}`,
      })),
      {
        path: '/repo/app.ts',
        line: 8,
        column: 3,
        severity: 'warning',
        message: 'Selected warning\nWith extra detail',
        source: 'eslint',
        code: 'rule-name',
        intersectsSelection: true,
      },
    ],
  });
  cleanup = render(
    () => (
      <ProblemsTooltip text={text} action="Included in context. Click to disable.">
        <button>Problems 6</button>
      </ProblemsTooltip>
    ),
    container
  );
  const trigger = container.querySelector('button')!;
  trigger.dispatchEvent(new MouseEvent('mouseenter'));
  await vi.advanceTimersByTimeAsync(400);
  const tooltip = document.querySelector('[role="tooltip"]')!;
  expect(tooltip.textContent).toContain('5 errors, 1 warning');
  const highlights = tooltip.querySelectorAll('.problems-tooltip-item');
  expect(highlights).toHaveLength(3);
  expect(highlights[0]?.textContent).toContain('Selected warning');
  expect(highlights[0]?.textContent).toContain('In selection');
  expect(highlights[0]?.textContent).toContain('app.ts:8:3');
  expect(highlights[0]?.textContent).toContain('eslint rule-name');
  expect(tooltip.textContent).toContain('3 more problems');
  expect(tooltip.textContent).not.toContain('Editor diagnostics are context');
  trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  expect(document.querySelector('[role="tooltip"]')).toBeNull();
});

it('previews explicit snapshots on focus and updates disabled-state guidance', async () => {
  const text = formatAttachedDiagnostics(
    [
      {
        path: '/repo/app.ts',
        line: 12,
        severity: 'error',
        message: '<script>unsafe markup</script>',
      },
    ],
    1,
    '/repo'
  );
  const [enabled, setEnabled] = createSignal(true);
  cleanup = render(
    () => (
      <ProblemsTooltip
        text={text}
        action={enabled() ? 'Included in context.' : 'Not included in context. Click to enable.'}
      >
        <button>Problems 1</button>
      </ProblemsTooltip>
    ),
    container
  );
  container.querySelector('button')!.dispatchEvent(new FocusEvent('focusin'));
  await vi.advanceTimersByTimeAsync(400);
  const tooltip = document.querySelector('[role="tooltip"]')!;
  expect(tooltip.textContent).toContain('app.ts:12');
  expect(tooltip.textContent).toContain('<script>unsafe markup</script>');
  expect(tooltip.querySelector('script')).toBeNull();
  setEnabled(false);
  expect(tooltip.textContent).toContain('Not included in context. Click to enable.');
});
