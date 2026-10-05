import { createSignal } from 'solid-js';
import type { ProviderLimitStatus, ProviderLimitWindow } from '../../../shared/protocol';
import { getProviderLimitTone, getProviderLimitWindowRemainingPercent } from '../../lib/format';
import { asRecord, isNumber, isString } from '../../lib/runtime-values';
import { readStored, STORAGE_KEYS, writeStored } from '../../lib/state-storage';
import { filterCompactProviderLimitForModel } from './toolbar-compact';

const LOW_REMAINING_PERCENT = 25;
const UNKNOWN_RESET_DISMISSAL_MS = 60 * 60_000;
const RESET_REMINDER_HOURS = [72, 24, 6, 1];

type ResetWarningDismissal = { providerID: string; expiresAt: number; remindAt: number };

const [resetDismissalVersion, setResetDismissalVersion] = createSignal(0);

export const resetWarningDismissals = {
  read(): ResetWarningDismissal[] {
    resetDismissalVersion();
    const stored = readStored<unknown>(STORAGE_KEYS.resetWarningDismissals);
    if (!Array.isArray(stored)) return [];
    return stored.flatMap((value) => {
      const entry = asRecord(value);
      return entry &&
        isString(entry.providerID) &&
        isNumber(entry.expiresAt) &&
        Number.isFinite(entry.expiresAt)
        ? [
            {
              providerID: entry.providerID,
              expiresAt: entry.expiresAt,
              // Older dismissals were permanent; remind again at the critical 24-hour mark.
              remindAt:
                isNumber(entry.remindAt) && Number.isFinite(entry.remindAt)
                  ? entry.remindAt
                  : entry.expiresAt - 24 * 60 * 60_000,
            },
          ]
        : [];
    });
  },

  reload() {
    setResetDismissalVersion((version) => version + 1);
  },

  dismiss(providerID: string, expirations: readonly number[], now: number) {
    const entries = this.read().filter((entry) => entry.expiresAt > now && entry.remindAt > now);
    for (const expiresAt of expirations) {
      if (
        expiresAt > now &&
        !entries.some((entry) => entry.providerID === providerID && entry.expiresAt === expiresAt)
      ) {
        const nextHours = RESET_REMINDER_HOURS.find(
          (hours) => expiresAt - hours * 60 * 60_000 > now
        );
        entries.push({
          providerID,
          expiresAt,
          remindAt: nextHours === undefined ? expiresAt : expiresAt - nextHours * 60 * 60_000,
        });
      }
    }
    writeStored(STORAGE_KEYS.resetWarningDismissals, entries);
    this.reload();
  },
};

type QuotaWarningDismissal = {
  providerID: string;
  windowID: string;
  resetAt: number | null;
  expiresAt: number;
  severity: 'warning' | 'error';
};

export function getLowQuotaWindows(
  limit: ProviderLimitStatus | null,
  modelID: string | null,
  modelName: string,
  forceShow = false
): ProviderLimitWindow[] {
  const filtered = filterCompactProviderLimitForModel(limit, modelID, modelName);
  if (filtered?.status !== 'available') return [];

  const model = `${modelID ?? ''} ${modelName}`.toLowerCase();
  return filtered.windows
    .filter((window) => {
      const scope = `${window.id} ${window.label}`.toLowerCase().replace(/[_-]/g, ' ');
      if (/\b(code review|review requests|mcp|cowork|omelette)\b/.test(scope)) return false;
      const family = /\b(sonnet|opus|haiku)\b/.exec(scope)?.[1];
      if (family && !model.includes(family)) return false;
      const remaining = getProviderLimitWindowRemainingPercent(window);
      return (
        forceShow ||
        window.remaining <= 0 ||
        (remaining !== null && remaining <= LOW_REMAINING_PERCENT)
      );
    })
    .toSorted((left, right) => {
      const exhausted = Number(right.remaining <= 0) - Number(left.remaining <= 0);
      if (exhausted) return exhausted;
      const remaining =
        (getProviderLimitWindowRemainingPercent(left) ?? 0) -
        (getProviderLimitWindowRemainingPercent(right) ?? 0);
      return remaining || left.id.localeCompare(right.id);
    });
}

export function isQuotaWarningDismissed(
  dismissals: readonly QuotaWarningDismissal[],
  providerID: string,
  window: ProviderLimitWindow,
  now: number
): boolean {
  return dismissals.some(
    (entry) =>
      entry.providerID === providerID &&
      entry.windowID === window.id &&
      entry.resetAt === window.resetAt &&
      entry.expiresAt > now &&
      (entry.severity === 'error' || getProviderLimitTone(null, window) !== 'error')
  );
}

const [dismissalVersion, setDismissalVersion] = createSignal(0);

export const quotaWarningDismissals = {
  read(): QuotaWarningDismissal[] {
    dismissalVersion();
    const stored = readStored<unknown>(STORAGE_KEYS.quotaWarningDismissals);
    if (!Array.isArray(stored)) return [];
    const entries: QuotaWarningDismissal[] = [];
    for (const value of stored) {
      const entry = asRecord(value);
      if (
        !entry ||
        !isString(entry.providerID) ||
        !isString(entry.windowID) ||
        !isNumber(entry.expiresAt) ||
        !Number.isFinite(entry.expiresAt) ||
        (entry.severity !== undefined &&
          entry.severity !== 'warning' &&
          entry.severity !== 'error') ||
        !(entry.resetAt === null || (isNumber(entry.resetAt) && Number.isFinite(entry.resetAt)))
      )
        continue;
      entries.push({
        providerID: entry.providerID,
        windowID: entry.windowID,
        resetAt: entry.resetAt,
        expiresAt: entry.expiresAt,
        // Older dismissals did not record severity, so allow critical warnings to reappear.
        severity: entry.severity === 'error' ? 'error' : 'warning',
      });
    }
    return entries;
  },

  reload() {
    setDismissalVersion((version) => version + 1);
  },

  dismiss(providerID: string, windows: readonly ProviderLimitWindow[], now: number) {
    const entries = this.read().filter((entry) => entry.expiresAt > now);
    for (const window of windows) {
      if (isQuotaWarningDismissed(entries, providerID, window, now)) continue;
      const expiresAt = window.resetAt ?? now + UNKNOWN_RESET_DISMISSAL_MS;
      if (expiresAt <= now) continue;
      const entry: QuotaWarningDismissal = {
        providerID,
        windowID: window.id,
        resetAt: window.resetAt,
        expiresAt,
        severity: getProviderLimitTone(null, window) === 'error' ? 'error' : 'warning',
      };
      const index = entries.findIndex(
        (saved) => saved.providerID === providerID && saved.windowID === window.id
      );
      if (index < 0) entries.push(entry);
      else entries[index] = entry;
    }
    writeStored(STORAGE_KEYS.quotaWarningDismissals, entries);
    this.reload();
  },
};
