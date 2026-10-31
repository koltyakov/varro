/** Only standalone calls and class-like names are inferred, never arbitrary inline prose or paths. */
export function parseCitationSymbol(text: string): string | null {
  const value = text.trim();
  if (value.length > 128) return null;
  const call = /^([A-Za-z_][A-Za-z0-9_]*)\(\)$/.exec(value);
  if (call) return call[1]!;
  return /^[A-Z][a-z0-9]+(?:[A-Z][A-Za-z0-9]*)+$/.test(value) ? value : null;
}

export type CitationSymbolTarget = { path: string; line: number };

/** The lookup did not settle within its budget, so the caller may ask again later. */
export const CITATION_SYMBOL_PENDING = 'pending';

export type CitationSymbolResult = CitationSymbolTarget | typeof CITATION_SYMBOL_PENDING | null;
