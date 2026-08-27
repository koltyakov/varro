export type ExternalLinkTextSegment =
  | { type: 'text'; content: string }
  | { type: 'external-link'; href: string; target: string; kind: 'web' | 'git' };

const EXTERNAL_LINK_RE = /https:\/\/[^\s<>"']+|git@[a-z0-9.-]+:[^\s<>"']+/gi;
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

export function getGitRemoteHttpsUrl(remote: string): string | null {
  const match = remote.match(/^git@([a-z0-9.-]+):([^\s]+)\.git$/i);
  if (!match?.[1] || !match[2] || !match[2].includes('/')) return null;
  const target = `https://${match[1]}/${match[2]}`;
  return isSafeExternalHref(target) ? target : null;
}

function trimUrlEnd(candidate: string) {
  let end = candidate.length;
  while (end > 0) {
    if (TRAILING_URL_PUNCTUATION_RE.test(candidate[end - 1]!)) {
      end -= 1;
      continue;
    }

    // SAFETY: The surrounding shape or discriminator check establishes the keyof contract used below.
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

  for (const match of content.matchAll(EXTERNAL_LINK_RE)) {
    const index = match.index ?? 0;
    const candidate = match[0];
    const urlEnd = trimUrlEnd(candidate);
    const href = candidate.slice(0, urlEnd);
    const gitTarget = getGitRemoteHttpsUrl(href);
    const target = gitTarget ?? href;
    if (!isSafeExternalHref(target)) continue;

    if (index > lastIndex) {
      segments.push({ type: 'text', content: content.slice(lastIndex, index) });
    }
    segments.push({ type: 'external-link', href, target, kind: gitTarget ? 'git' : 'web' });
    lastIndex = index + urlEnd;
  }

  if (lastIndex < content.length) {
    segments.push({ type: 'text', content: content.slice(lastIndex) });
  }
  return segments.length > 0 ? segments : [{ type: 'text', content }];
}
