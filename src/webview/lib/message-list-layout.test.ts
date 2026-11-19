import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  notifyInlineDiffMount,
  prepareForPermissionRemoval,
  registerInlineDiffLoadHandler,
  registerPermissionRemovalHandler,
  registerPermissionRemovalIntent,
  shouldRemovePermissionGroup,
  trackInlineDiffLoad,
} from './message-list-layout';

let cleanupHandler: (() => void) | undefined;
let cleanupIntent: (() => void) | undefined;

afterEach(() => {
  cleanupIntent?.();
  cleanupHandler?.();
  cleanupIntent = undefined;
  cleanupHandler = undefined;
});

describe('inline diff layout handlers', () => {
  it('forwards the mounted element and message ID to the current owner', () => {
    const onMount = vi.fn<(element: HTMLElement, messageId: string) => void>();
    cleanupHandler = registerInlineDiffLoadHandler(vi.fn(), onMount);
    const element = document.createElement('div');

    notifyInlineDiffMount(element, 'message-1');

    expect(onMount).toHaveBeenCalledExactlyOnceWith(element, 'message-1');
    expect(onMount.mock.calls[0]?.[0]).toBe(element);
  });

  it('keeps the replacement callbacks on stale cleanup and clears both on current cleanup', () => {
    const oldLoad = vi.fn();
    const oldMount = vi.fn();
    const disposeOld = registerInlineDiffLoadHandler(oldLoad, oldMount);
    const finishLoad = vi.fn();
    const load = vi.fn(() => finishLoad);
    const mount = vi.fn();
    cleanupHandler = registerInlineDiffLoadHandler(load, mount);
    const element = document.createElement('div');

    disposeOld();
    notifyInlineDiffMount(element, 'message-2');
    expect(trackInlineDiffLoad('session-1', 'message-2')).toBe(finishLoad);
    expect(mount).toHaveBeenCalledExactlyOnceWith(element, 'message-2');
    expect(load).toHaveBeenCalledExactlyOnceWith('session-1', 'message-2');

    cleanupHandler();
    notifyInlineDiffMount(element, 'message-3');
    expect(trackInlineDiffLoad('session-1', 'message-3')).toBeUndefined();
    expect(mount).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledTimes(1);
    expect(oldMount).not.toHaveBeenCalled();
    expect(oldLoad).not.toHaveBeenCalled();
  });
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
