import { describe, expect, it } from 'vitest';
import { isPlanHandedOff, recordPlanHandoff } from './plan-handoff';
import { STORAGE_KEYS, readStored } from './state-storage';

describe('plan handoff', () => {
  it('remembers plans moved to a new chat', () => {
    expect(isPlanHandedOff('plan-a')).toBe(false);
    recordPlanHandoff('plan-a', 1_000);
    expect(isPlanHandedOff('plan-a')).toBe(true);
    expect(readStored(STORAGE_KEYS.planHandoffs)).toMatchObject({ 'plan-a': 1_000 });
  });
});
