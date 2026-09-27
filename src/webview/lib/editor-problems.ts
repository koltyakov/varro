import type { EditorContext, InlineProblemAttachment } from '../../shared/protocol';
import { hostMetadata } from '../host/extensions';
import { isInlineProblemAttachment } from '../../shared/extension-message';
import { asRecord } from '../../shared/type-utils';
import { isSameWorkspacePath, normalizeWorkspaceIdentity } from '../../shared/workspace-path';
export { isInlineProblemAttachment as isInlineProblem } from '../../shared/extension-message';
import { getLeafPathName, getWorkspaceRelativePath } from './path-display';

export const PROBLEMS_REFERENCE = '[Problems]';
export type IssueAttachment = { count: number; text: string; inline?: boolean };
type NormalizedInlineProblems = { text: string; references: InlineProblemAttachment[] };

export function problemReferenceMarker(reference: InlineProblemAttachment): string {
  return `[Problem ${reference.id}]`;
}

export function problemIdentity(diagnostic: EditorContext['diagnostics'][number]): string {
  return JSON.stringify([
    normalizeWorkspaceIdentity(diagnostic.path) ?? diagnostic.path,
    diagnostic.line,
    diagnostic.column ?? 1,
    diagnostic.endLine ?? diagnostic.line,
    diagnostic.endColumn ?? diagnostic.column ?? 1,
    diagnostic.severity,
    diagnostic.source?.trim().toLowerCase() ?? '',
    diagnostic.code === undefined ? '' : String(diagnostic.code),
    diagnostic.message.replace(/\s+/g, ' ').trim(),
  ]);
}

/** Add each identity to seen once, retaining the first snapshot. */
export function uniqueProblems(
  diagnostics: readonly EditorContext['diagnostics'][number][],
  seen = new Set<string>()
): EditorContext['diagnostics'] {
  return diagnostics.filter((diagnostic) => {
    const key = problemIdentity(diagnostic);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function attachedProblemKeys(
  text: string,
  references: readonly InlineProblemAttachment[],
  diagnostics: readonly EditorContext['diagnostics'][number][]
): Set<string> {
  const seen = new Set(diagnostics.map(problemIdentity));
  for (const reference of references) {
    if (!text.includes(problemReferenceMarker(reference))) continue;
    for (const diagnostic of reference.group ?? [reference.diagnostic])
      seen.add(problemIdentity(diagnostic));
  }
  return seen;
}

export function hasInlineProblemsForFile(
  text: string,
  references: readonly InlineProblemAttachment[],
  path: string | undefined
): boolean {
  return (
    !!path &&
    references.some(
      (reference) =>
        text.includes(problemReferenceMarker(reference)) &&
        (reference.group ?? [reference.diagnostic]).some((diagnostic) =>
          isSameWorkspacePath(diagnostic.path, path)
        )
    )
  );
}

export function deduplicateInlineProblems(
  text: string,
  references: readonly InlineProblemAttachment[],
  attached: readonly EditorContext['diagnostics'][number][]
): NormalizedInlineProblems {
  const seen = new Set(attached.map(problemIdentity));
  const ids = new Set<string>();
  const retained: InlineProblemAttachment[] = [];
  for (const reference of references) {
    if (ids.has(reference.id) || !text.includes(problemReferenceMarker(reference))) continue;
    ids.add(reference.id);
    const members = reference.group ?? [reference.diagnostic];
    const unique = uniqueProblems(members, seen);
    if (!unique.length) continue;
    retained.push(
      unique.length === members.length
        ? reference
        : {
            ...reference,
            diagnostic: unique[0]!,
            group: reference.group ? unique : undefined,
          }
    );
  }
  const retainedIds = new Set(retained.map((reference) => reference.id));
  for (const reference of references) {
    if (!retainedIds.has(reference.id))
      text = text.replaceAll(problemReferenceMarker(reference), '');
  }
  return { text, references: retained };
}

export function formatInlineProblem(reference: InlineProblemAttachment): string {
  const payload = reference.group ? { group: reference.group } : reference.diagnostic;
  return `${problemReferenceMarker(reference)}\n${JSON.stringify(payload)}`;
}

export function parseInlineProblem(text: string): InlineProblemAttachment | null {
  const match = text.match(/^\[Problem ([\w-]+)\]\n([\s\S]+)$/);
  if (!match) return null;
  try {
    const diagnostic: unknown = JSON.parse(match[2]!);
    const grouped = asRecord(diagnostic);
    const reference =
      grouped && Array.isArray(grouped.group)
        ? { id: match[1], diagnostic: grouped.diagnostic ?? grouped.group[0], group: grouped.group }
        : { id: match[1], diagnostic };
    return isInlineProblemAttachment(reference) ? reference : null;
  } catch {
    return null;
  }
}

export function cloneInlineProblems(
  references: readonly InlineProblemAttachment[] | undefined
): InlineProblemAttachment[] {
  return (references ?? []).map((reference) => ({
    id: reference.id,
    group: reference.group?.map((diagnostic) => ({
      ...diagnostic,
      relatedInformation: diagnostic.relatedInformation?.map((related) => ({ ...related })),
    })),
    diagnostic: {
      ...reference.diagnostic,
      relatedInformation: reference.diagnostic.relatedInformation?.map((related) => ({
        ...related,
      })),
    },
  }));
}

export function problemReferenceLocation(reference: InlineProblemAttachment): string {
  if (reference.group) return String(reference.group.length);
  return `L${reference.diagnostic.line}${reference.diagnostic.column ? `:${reference.diagnostic.column}` : ''}`;
}

export function problemReferenceLabel(reference: InlineProblemAttachment): string {
  return reference.group ? 'Problems' : getLeafPathName(reference.diagnostic.path);
}

export function problemReferenceSeverity(
  reference: InlineProblemAttachment
): 'error' | 'warning' | 'info' {
  const diagnostics = reference.group ?? [reference.diagnostic];
  return diagnostics.some((diagnostic) => diagnostic.severity === 'error')
    ? 'error'
    : diagnostics.some((diagnostic) => diagnostic.severity === 'warning')
      ? 'warning'
      : 'info';
}

export function problemReferenceDetails(
  reference: InlineProblemAttachment,
  workspacePath: string | null
): string {
  const diagnostics = reference.group ?? [reference.diagnostic];
  return formatAttachedDiagnostics(diagnostics, diagnostics.length, workspacePath);
}

export function getProblemsSeverity(text: string): 'error' | 'warning' | 'info' {
  const counts = text.match(/^\[[^\]\n]+ problems for [^\n]+: (\d+) errors, (\d+) warnings\]\n/);
  if (counts) {
    if (Number(counts[1]) > 0) return 'error';
    if (Number(counts[2]) > 0) return 'warning';
  }
  return /^ERROR /m.test(text) ? 'error' : /^WARNING /m.test(text) ? 'warning' : 'info';
}

/** Recognize standalone diagnostic parts, including messages sent before issue chips existed. */
export function parseIssueAttachment(text: string): IssueAttachment | null {
  const automatic = text.match(/^\[[^\]\n]+ problems for [^\n]+: (\d+) errors, (\d+) warnings\]\n/);
  const explicit = text.match(/^\[Attached diagnostics: \d+ of (\d+)\]\n/);
  const count = automatic
    ? Number(automatic[1]) + Number(automatic[2])
    : explicit
      ? Number(explicit[1])
      : 0;
  return Number.isSafeInteger(count) && count > 0 ? { count, text } : null;
}

export function getEditorIssueCount(context: EditorContext): number {
  if (!context.activeFile || context.databaseContext) return 0;
  return context.diagnosticCounts &&
    context.diagnostics.every((d) => d.path === context.activeFile?.path)
    ? context.diagnosticCounts.errors + context.diagnosticCounts.warnings
    : context.diagnostics.filter(
        (d) =>
          d.path === context.activeFile?.path &&
          (d.severity === 'error' || d.severity === 'warning')
      ).length;
}

export function formatAttachedDiagnostics(
  diagnostics: EditorContext['diagnostics'],
  total: number,
  workspacePath: string | null
): string {
  const rows = diagnostics.map((diagnostic) => {
    const path = getWorkspaceRelativePath(diagnostic.path, workspacePath) ?? diagnostic.path;
    const message = diagnostic.message.replace(/\s+/g, ' ').slice(0, 500);
    return `${diagnostic.severity.toUpperCase()} ${path}:${diagnostic.line} - ${message}`;
  });
  return `[Attached diagnostics: ${diagnostics.length} of ${total}]\n${rows.join('\n')}`;
}

/** Bounded automatic context. Explicit diagnostic attachments use their own snapshot. */
export function formatEditorProblems(context: EditorContext): string | null {
  const file = context.activeFile;
  if (!file || context.databaseContext) return null;
  const diagnostics = context.diagnostics.filter(
    (d) => d.path === file.path && (d.severity === 'error' || d.severity === 'warning')
  );
  const counts = (context.diagnostics.every((d) => d.path === file.path)
    ? context.diagnosticCounts
    : undefined) ?? {
    errors: diagnostics.filter((d) => d.severity === 'error').length,
    warnings: diagnostics.filter((d) => d.severity === 'warning').length,
  };
  const total = counts.errors + counts.warnings;
  if (!total) return null;
  const path = (value: string) => getWorkspaceRelativePath(value, context.workspacePath) ?? value;
  const ranked = diagnostics.toSorted(
    (a, b) =>
      Number(!!b.intersectsSelection) - Number(!!a.intersectsSelection) ||
      Number(a.severity !== 'error') - Number(b.severity !== 'error')
  );
  const rows = ranked.slice(0, 5).map((d) => {
    const location = `${path(d.path)}:${d.line}:${d.column ?? 1}`;
    const source = [d.source, d.code].filter((value) => value !== undefined).join(' ');
    const selected = d.intersectsSelection ? ' [intersects selection]' : '';
    const message = d.intersectsSelection ? d.message : d.message.replace(/\s+/g, ' ');
    const details = d.intersectsSelection
      ? (d.relatedInformation ?? [])
          .map(
            (related) =>
              `  Related: ${path(related.path)}:${related.line}:${related.column}: ${related.message}`
          )
          .join('\n')
      : '';
    const text = `${d.severity.toUpperCase()} ${location}-${d.endLine ?? d.line}:${d.endColumn ?? d.column ?? 1}${source ? ` (${source})` : ''}${selected}\n${message}${details ? `\n${details}` : ''}`;
    const limit = d.intersectsSelection ? 6000 : 700;
    return text.length > limit ? `${text.slice(0, limit)}\n[Diagnostic details truncated]` : text;
  });
  const body = rows.join('\n\n');
  return (
    `[${hostMetadata().ideName} problems for ${path(file.path)}: ${counts.errors} errors, ${counts.warnings} warnings]\n` +
    'Editor diagnostics are context, not a request to fix unrelated issues.\n' +
    (body.length > 12000 ? `${body.slice(0, 12000)}\n[Problem details truncated]` : body) +
    (total > rows.length ? `\n${total - rows.length} additional problems omitted.` : '')
  );
}
