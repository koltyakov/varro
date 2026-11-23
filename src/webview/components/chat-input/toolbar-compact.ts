import type { ProviderLimitStatus } from '../../../shared/protocol';

export type ToolbarControl =
  | 'permission'
  | 'attachments'
  | 'send'
  | 'reasoning'
  | 'agent'
  | 'stop'
  | 'context';
export type ToolbarCompactMode =
  | 'full'
  | 'compact-provider-limit'
  | 'compact-stop'
  | 'compact-agent'
  | 'compact-reasoning'
  | 'truncate-model'
  | 'hide-permission'
  | 'hide-attachments'
  | 'hide-send'
  | 'hide-reasoning'
  | 'hide-agent'
  | 'hide-stop'
  | 'hide-context'
  | 'tight';

const TOOLBAR_HIDE_ORDER: ToolbarControl[] = [
  'permission',
  'attachments',
  'send',
  'reasoning',
  'agent',
  'stop',
  'context',
];

export const TOOLBAR_COMPACT_MODES: ToolbarCompactMode[] = [
  'full',
  'compact-provider-limit',
  'compact-stop',
  'compact-agent',
  'compact-reasoning',
  'truncate-model',
  'hide-permission',
  'hide-attachments',
  'hide-send',
  'hide-reasoning',
  'hide-agent',
  'hide-stop',
  'hide-context',
  'tight',
];

// How many controls from the front of TOOLBAR_HIDE_ORDER each mode hides.
const HIDDEN_CONTROL_COUNT: Partial<Record<ToolbarCompactMode, number>> = {
  'hide-permission': 1,
  'hide-attachments': 2,
  'hide-send': 3,
  'hide-reasoning': 4,
  'hide-agent': 5,
  'hide-stop': 6,
  'hide-context': 7,
  tight: 7,
};

export function isToolbarControlHidden(mode: ToolbarCompactMode, control: ToolbarControl) {
  const hiddenControlCount = HIDDEN_CONTROL_COUNT[mode] ?? 0;
  const hiddenControlIndex = TOOLBAR_HIDE_ORDER.indexOf(control);
  return hiddenControlIndex !== -1 && hiddenControlIndex < hiddenControlCount;
}

export function isToolbarControlCompacted(
  mode: ToolbarCompactMode,
  control: 'agent' | 'reasoning' | 'stop'
) {
  if (control === 'agent')
    return !['full', 'compact-provider-limit', 'compact-stop'].includes(mode);
  if (control === 'reasoning')
    return !['full', 'compact-provider-limit', 'compact-stop', 'compact-agent'].includes(mode);
  return mode !== 'full';
}

export function filterCompactProviderLimitForModel(
  limit: ProviderLimitStatus | null | undefined,
  modelID: string | null | undefined,
  modelName: string | null | undefined
): ProviderLimitStatus | null {
  if (!limit || limit.status !== 'available') return limit ?? null;

  const isSparkModel = isCodexSparkModelLabel(modelID) || isCodexSparkModelLabel(modelName);
  const windows = limit.windows.filter((window) => {
    const isSparkWindow = window.id.toLowerCase().includes('spark');
    return isSparkModel ? isSparkWindow : !isSparkWindow;
  });

  return {
    ...limit,
    windows,
  };
}

function isCodexSparkModelLabel(value: string | null | undefined) {
  const normalized = value?.toLowerCase() ?? '';
  return normalized.includes('codex') && normalized.includes('spark');
}
