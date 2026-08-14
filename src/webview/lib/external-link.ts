export type ExternalLinkTextSegment =
  | { type: 'text'; content: string }
  | { type: 'external-link'; href: string };

const HTTPS_URL_RE = /https:\/\/[^\s<>"']+/gi;
const TRAILING_URL_PUNCTUATION_RE = /[.,!?;:]$/;
const CLOSING_DELIMITERS = {
  ')': '(',
  ']': '[',
  '}': '{',
} as const;

export function isSafeExternalHref(href: string | null): boolean {
  if (!href) return false;
  try {
    const parsed = new URL(href);
    return parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function trimUrlEnd(candidate: string) {
  let end = candidate.length;
  while (end > 0 && TRAILING_URL_PUNCTUATION_RE.test(candidate[end - 1]!)) end -= 1;

  while (end > 0) {
    const closing = candidate[end - 1] as keyof typeof CLOSING_DELIMITERS;
    const opening = CLOSING_DELIMITERS[closing];
    if (!opening) break;

    const value = candidate.slice(0, end);
    const openingCount = value.split(opening).length - 1;
    const closingCount = value.split(closing).length - 1;
    if (closingCount <= openingCount) break;
    end -= 1;
  }

  return end;
}

export function splitExternalLinkText(content: string): ExternalLinkTextSegment[] {
  const segments: ExternalLinkTextSegment[] = [];
  let lastIndex = 0;

  for (const match of content.matchAll(HTTPS_URL_RE)) {
    const index = match.index ?? 0;
    const candidate = match[0];
    const urlEnd = trimUrlEnd(candidate);
    const href = candidate.slice(0, urlEnd);
    if (!isSafeExternalHref(href)) continue;

    if (index > lastIndex) {
      segments.push({ type: 'text', content: content.slice(lastIndex, index) });
    }
    segments.push({ type: 'external-link', href });
    lastIndex = index + urlEnd;
  }

  if (lastIndex < content.length) {
    segments.push({ type: 'text', content: content.slice(lastIndex) });
  }
  return segments.length > 0 ? segments : [{ type: 'text', content }];
}
