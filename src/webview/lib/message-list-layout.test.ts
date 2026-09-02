import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  prepareForPermissionRemoval,
  registerPermissionRemovalHandler,
  registerPermissionRemovalIntent,
  shouldRemovePermissionGroup,
} from './message-list-layout';

let cleanupHandler: (() => void) | undefined;
let cleanupIntent: (() => void) | undefined;

afterEach(() => {
  cleanupIntent?.();
  cleanupHandler?.();
  cleanupIntent = undefined;
  cleanupHandler = undefined;
});

describe('permission removal layout intent', () => {
  it('prepares every grouped removal while an always response is in flight', () => {
    const handler = vi.fn();
    cleanupHandler = registerPermissionRemovalHandler(handler);
    cleanupIntent = registerPermissionRemovalIntent(['permission-1', 'permission-2'], true);

    prepareForPermissionRemoval('permission-2', false);

    expect(handler).toHaveBeenCalledWith('permission-2', true);
    expect(shouldRemovePermissionGroup('permission-2', false)).toBe(true);
  });

  it('stops broadening removal after the response finishes', () => {
    const handler = vi.fn();
    cleanupHandler = registerPermissionRemovalHandler(handler);
    cleanupIntent = registerPermissionRemovalIntent(['permission-1'], true);
    cleanupIntent();
    cleanupIntent = undefined;

    prepareForPermissionRemoval('permission-1', false);

    expect(handler).toHaveBeenCalledWith('permission-1', false);
  });
});
