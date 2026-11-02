import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearSelectedMcpsForSession,
  getAvailableMcpNames,
  getSelectedMcpsForSession,
  resetDefaultAppState,
  resetDraftSelectedMcps,
  setDraftSelectedMcps,
  setMcpDefaults,
  setSelectedMcpsForSession,
  setState,
  state,
} from './state';

beforeEach(() => {
  localStorage.clear();
  resetDefaultAppState();
});
afterEach(() => {
  localStorage.clear();
  resetDefaultAppState();
});

describe('MCP default selections', () => {
  it('uses configured defaults rather than shared connections for new sessions and drafts', () => {
    setState('mcpStatus', { rare: { status: 'connected' }, docs: { status: 'disabled' } });
    setMcpDefaults({
      global: { rare: false, docs: true },
      project: {},
      effective: { rare: false, docs: true },
      editable: true,
    });
    expect(getSelectedMcpsForSession(null)).toEqual(['docs']);
    expect(getSelectedMcpsForSession('new')).toEqual(['docs']);
    expect(state.sessionSelectedMcps).toEqual({});
    expect(getAvailableMcpNames()).toEqual(['docs', 'rare']);
  });

  it('keeps explicit empty session and draft overrides until reset', () => {
    setMcpDefaults({
      global: { docs: true },
      project: {},
      effective: { docs: true },
      editable: true,
    });
    setSelectedMcpsForSession('current', []);
    setDraftSelectedMcps([]);
    expect(getSelectedMcpsForSession('current')).toEqual([]);
    expect(getSelectedMcpsForSession(null)).toEqual([]);
    clearSelectedMcpsForSession('current');
    resetDraftSelectedMcps();
    expect(getSelectedMcpsForSession('current')).toEqual(['docs']);
    expect(getSelectedMcpsForSession(null)).toEqual(['docs']);
  });

  it('preserves explicit session overrides across reloads and later default changes', () => {
    setSelectedMcpsForSession('current', ['rare']);
    resetDefaultAppState();
    setMcpDefaults({
      global: { rare: false },
      project: { docs: true },
      effective: { rare: false, docs: true },
      editable: true,
    });
    expect(getSelectedMcpsForSession('current')).toEqual(['rare']);
    expect(getSelectedMcpsForSession('other')).toEqual(['docs']);
    setMcpDefaults({
      global: { rare: false },
      project: { docs: false },
      effective: { rare: false, docs: false },
      editable: true,
    });
    expect(getSelectedMcpsForSession('current')).toEqual(['rare']);
    expect(getSelectedMcpsForSession('other')).toEqual([]);
  });

  it('does not infer defaults before configuration has loaded', () => {
    setState('mcpStatus', { rare: { status: 'connected' } });
    expect(getSelectedMcpsForSession('new')).toBeNull();
    expect(getSelectedMcpsForSession(null)).toBeNull();
  });
});
