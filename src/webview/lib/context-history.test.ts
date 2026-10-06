import { describe, expect, it } from 'vitest';
import { stripContextForHistory } from './context-history';

describe('stripContextForHistory', () => {
  it('removes active-file context joined to the prompt', () => {
    expect(
      stripContextForHistory(
        'Sync with latest Varro\n\n[Active file: src/main/resources/META-INF/plugin.xml]'
      ).trim()
    ).toBe('Sync with latest Varro');
  });

  it('removes file references and working-directory context without discarding prompt lines', () => {
    expect(
      stripContextForHistory(
        '[Working directory: /repo]\nReview this\n[Selection from src/app.ts lines 3-5, 9]\n[Attached file: README.md]\nKeep this instruction'
      )
    ).toBe('Review this\nKeep this instruction');
  });

  it.each(['```', '~~~~'])('preserves context examples inside %s fences', (fence) => {
    const text = `${fence}text\n[Active file: app.ts]\n[Selection from app.ts lines 3-5]\n[Attached file: README.md]\n[Working directory: /repo]\n${fence}`;
    expect(stripContextForHistory(text)).toBe(text);
  });

  it('preserves malformed references and inline mentions', () => {
    const text =
      '[Active file: ]\n[Selection from app.ts lines invalid]\nExplain [Active file: app.ts]\nReview @src/app.ts';
    expect(stripContextForHistory(text)).toBe(text);
  });

  it('preserves prompt whitespace and blank lines', () => {
    expect(
      stripContextForHistory('First paragraph\r\n\r\n  Indented line\r\n[Active file: app.ts]')
    ).toBe('First paragraph\n\n  Indented line');
  });

  it('removes context-only text', () => {
    expect(stripContextForHistory('[Active file: app.ts]')).toBe('');
  });
});
