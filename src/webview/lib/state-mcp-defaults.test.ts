import { flush as flushSolid } from 'solid-js';
import { storePath } from '@solidjs/signals';
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
  flushSolid();
  resetDefaultAppState();
  flushSolid();
});
afterEach(() => {
  localStorage.clear();
  flushSolid();
  resetDefaultAppState();
  flushSolid();
});

describe('MCP default selections', () => {
  it('uses configured defaults rather than shared connections for new sessions and drafts', () => {
    setState(
      storePath('mcpStatus', { rare: { status: 'connected' }, docs: { status: 'disabled' } })
    );
    flushSolid();
    setMcpDefaults({
      global: { rare: false, docs: true },
      project: {},
      effective: { rare: false, docs: true },
      editable: true,
    });
    flushSolid();
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
    flushSolid();
    setSelectedMcpsForSession('current', []);
    flushSolid();
    setDraftSelectedMcps([]);
    flushSolid();
    expect(getSelectedMcpsForSession('current')).toEqual([]);
    expect(getSelectedMcpsForSession(null)).toEqual([]);
    clearSelectedMcpsForSession('current');
    flushSolid();
    resetDraftSelectedMcps();
    flushSolid();
    expect(getSelectedMcpsForSession('current')).toEqual(['docs']);
    expect(getSelectedMcpsForSession(null)).toEqual(['docs']);
  });

  it('preserves explicit session overrides across reloads and later default changes', () => {
    setSelectedMcpsForSession('current', ['rare']);
    flushSolid();
    resetDefaultAppState();
    flushSolid();
    setMcpDefaults({
      global: { rare: false },
      project: { docs: true },
      effective: { rare: false, docs: true },
      editable: true,
    });
    flushSolid();
    expect(getSelectedMcpsForSession('current')).toEqual(['rare']);
    expect(getSelectedMcpsForSession('other')).toEqual(['docs']);
    setMcpDefaults({
      global: { rare: false },
      project: { docs: false },
      effective: { rare: false, docs: false },
      editable: true,
    });
    flushSolid();
    expect(getSelectedMcpsForSession('current')).toEqual(['rare']);
    expect(getSelectedMcpsForSession('other')).toEqual([]);
  });

  it('does not infer defaults before configuration has loaded', () => {
    setState(storePath('mcpStatus', { rare: { status: 'connected' } }));
    flushSolid();
    expect(getSelectedMcpsForSession('new')).toBeNull();
    expect(getSelectedMcpsForSession(null)).toBeNull();
  });

  it('persists consecutive changes for different sessions before the next render', () => {
    setSelectedMcpsForSession('first', ['docs']);
    setSelectedMcpsForSession('second', ['tools', 'docs', 'tools']);
    clearSelectedMcpsForSession('first');
    flushSolid();
    expect(state.sessionSelectedMcps).toEqual({ second: ['docs', 'tools'] });
    resetDefaultAppState();
    flushSolid();
    expect(state.sessionSelectedMcps).toEqual({ second: ['docs', 'tools'] });
  });
});
