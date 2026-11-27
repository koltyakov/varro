import { createSignal } from 'solid-js';
import type { Part, ToolPart } from '../types';
import {
  collapseLeadingDuplicateFileEvents,
  getFileEditVisualSignature,
} from './message-event-collapse';
import { isFileEditPart, isPendingEditAwaitingMerge } from './part-utils';
import { getToolFileChangeSignature, getToolFileChanges } from './tool-file-change';

/** Combined counts for the completed edits that one rendered edit card represents. */
export type FileEditTotals = {
  readonly edits: number;
  /** Keyed by file change `dedupeKey`. */
  readonly files: ReadonlyMap<string, { readonly additions: number; readonly deletions: number }>;
};

/** A rendered part, with the consecutive same-file edits it represents. */
export type FileEditRun = { key: string; part: Part; members: readonly Part[] };

/**
 * Groups consecutive edits to the same files into one entry. The entry keeps the latest tool
 * payload under the first edit's key, so its preview identity survives later edits.
 */
export function getFileEditRuns(parts: readonly Part[]): FileEditRun[] {
  const result: FileEditRun[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    if (isPendingEditAwaitingMerge(parts, index)) continue;
    const part = parts[index]!;
    if (!isFileEditPart(part)) {
      result.push({ key: part.id, part, members: [part] });
      continue;
    }
    const signature = getEditSignature(part);
    let last = index;
    while (
      last + 1 < parts.length &&
      isFileEditPart(parts[last + 1]!) &&
      getEditSignature(parts[last + 1]!) === signature
    ) {
      last += 1;
    }
    result.push({ key: part.id, part: parts[last]!, members: parts.slice(index, last + 1) });
    index = last;
  }
  return result;
}

function getEditSignature(part: Part) {
  // SAFETY: Callers pass file edit parts, which are tool parts.
  const tool = part as ToolPart;
  return getToolFileChangeSignature(tool.tool, tool.state);
}

/** Where the next message's collapsed leading edit merges, carried across message ranges. */
export type FileEditTotalsChain = {
  readonly signature: string | null;
  readonly ownerId: string | null;
  readonly ownerMembers: readonly Part[];
};

const EMPTY_CHAIN: FileEditTotalsChain = { signature: null, ownerId: null, ownerMembers: [] };

/**
 * Combines counts for each rendered edit card, keyed by the part the card displays. Membership
 * mirrors the transcript projection exactly: in-message runs plus leading edits that collapse into
 * the previous message's trailing card. Grouping and row content are never changed here.
 */
export function collectFileEditTotals(
  entries: readonly { info: { role: string }; parts: Part[] }[],
  chain: FileEditTotalsChain | null,
  previousTotals?: ReadonlyMap<string, FileEditTotals>
) {
  const membersById = new Map<string, readonly Part[]>();
  let previous = chain ?? EMPTY_CHAIN;
  for (const entry of entries) {
    if (entry.info.role !== 'assistant') {
      previous = EMPTY_CHAIN;
      continue;
    }
    const parts = entry.parts;
    const collapsed = collapseLeadingDuplicateFileEvents(parts, previous.signature);
    const dropped = parts.slice(0, parts.length - collapsed.length);
    const owner = previous.ownerId;
    if (owner) {
      // Held-back calls without input are not file edits yet and contribute nothing.
      const merged = dropped.filter(isFileEditPart);
      if (merged.length > 0) {
        membersById.set(owner, [...(membersById.get(owner) ?? previous.ownerMembers), ...merged]);
      }
    }
    const runs = getFileEditRuns(collapsed);
    for (const run of runs) {
      if (run.members.length > 1 && isFileEditPart(run.part))
        membersById.set(run.part.id, run.members);
    }

    const trailing = getTrailingFileEditPart(parts);
    let next = EMPTY_CHAIN;
    if (trailing) {
      const signature = getFileEditVisualSignature(trailing)!;
      const run = runs.find((candidate) => candidate.members.includes(trailing));
      if (run) {
        next = {
          signature,
          ownerId: run.part.id,
          ownerMembers: membersById.get(run.part.id) ?? run.members,
        };
      } else if (owner && dropped.includes(trailing)) {
        next = {
          signature,
          ownerId: owner,
          ownerMembers: membersById.get(owner) ?? previous.ownerMembers,
        };
      }
    }
    previous = next;
  }

  const totals = new Map<string, FileEditTotals>();
  for (const [id, members] of membersById) {
    const combined = combineCompletedEdits(members);
    if (!combined) continue;
    const reused = previousTotals?.get(id);
    totals.set(id, reused && sameFileEditTotals(reused, combined) ? reused : combined);
  }
  return { totals, chain: previous };
}

/** Matches `getTrailingFileEventSignature`, returning the part that owns that signature. */
function getTrailingFileEditPart(parts: readonly Part[]): Part | null {
  for (let index = parts.length - 1; index >= 0; index--) {
    const part = parts[index]!;
    if (getFileEditVisualSignature(part)) return part;
    if (part.type !== 'step-finish') return null;
  }
  return null;
}

function combineCompletedEdits(members: readonly Part[]): FileEditTotals | null {
  const completed = members.filter(
    (part): part is ToolPart => part.type === 'tool' && part.state.status === 'completed'
  );
  // A single completed edit already shows its own counts.
  if (completed.length < 2) return null;
  const files = new Map<string, { additions: number; deletions: number }>();
  for (const part of completed) {
    for (const change of getToolFileChanges(part.tool, part.state)) {
      if (change.isSummary) continue;
      // Partial counts would understate the change, so keep the edit's own counts instead.
      if (change.additions === undefined && change.deletions === undefined) return null;
      const current = files.get(change.dedupeKey) ?? { additions: 0, deletions: 0 };
      files.set(change.dedupeKey, {
        additions: current.additions + (change.additions ?? 0),
        deletions: current.deletions + (change.deletions ?? 0),
      });
    }
  }
  return files.size > 0 ? { edits: completed.length, files } : null;
}

export function sameFileEditTotals(
  previous: FileEditTotals | undefined,
  next: FileEditTotals | undefined
) {
  if (previous === next) return true;
  if (!previous || !next || previous.edits !== next.edits) return false;
  if (previous.files.size !== next.files.size) return false;
  for (const [key, value] of next.files) {
    const prior = previous.files.get(key);
    if (prior?.additions !== value.additions || prior.deletions !== value.deletions) return false;
  }
  return true;
}

export function sameFileEditTotalsMap(
  previous: ReadonlyMap<string, FileEditTotals>,
  next: ReadonlyMap<string, FileEditTotals>
) {
  if (previous === next) return true;
  if (previous.size !== next.size) return false;
  for (const [id, totals] of next) {
    if (!sameFileEditTotals(previous.get(id), totals)) return false;
  }
  return true;
}

const EMPTY_TOTALS: ReadonlyMap<string, FileEditTotals> = new Map();
// The transcript publishes one map; cards read their own entry behind a structurally equal memo.
const [publishedTotals, setPublishedTotals] = createSignal(EMPTY_TOTALS, {
  equals: sameFileEditTotalsMap,
});

export function publishFileEditTotals(totals: ReadonlyMap<string, FileEditTotals> | null) {
  setPublishedTotals(totals ?? EMPTY_TOTALS);
}

export function getFileEditTotals(partId: string): FileEditTotals | undefined {
  return publishedTotals().get(partId);
}
