import { describe, expect, it } from 'vitest';
import { DeferredMessageRemovals } from './deferred-message-removals';

describe('DeferredMessageRemovals', () => {
  it('reports nothing deferred before any hold', () => {
    const deferrals = new DeferredMessageRemovals();
    expect(deferrals.isDeferred('session-1', 'message-1')).toBe(false);
    expect(deferrals.trackedSessionCount).toBe(0);
  });

  it('defers the exact messages it was given', () => {
    const deferrals = new DeferredMessageRemovals();
    deferrals.defer('session-1', ['message-1', 'message-2']);

    expect(deferrals.isDeferred('session-1', 'message-1')).toBe(true);
    expect(deferrals.isDeferred('session-1', 'message-2')).toBe(true);
    expect(deferrals.isDeferred('session-1', 'message-3')).toBe(false);
  });

  it('scopes holds to their session', () => {
    const deferrals = new DeferredMessageRemovals();
    deferrals.defer('session-1', ['message-1']);

    expect(deferrals.isDeferred('session-2', 'message-1')).toBe(false);
  });

  it('releases a hold and forgets the session', () => {
    const deferrals = new DeferredMessageRemovals();
    const release = deferrals.defer('session-1', ['message-1']);

    release();

    expect(deferrals.isDeferred('session-1', 'message-1')).toBe(false);
    expect(deferrals.trackedSessionCount).toBe(0);
  });

  it('keeps a message deferred until every overlapping hold releases', () => {
    const deferrals = new DeferredMessageRemovals();
    const releaseFirst = deferrals.defer('session-1', ['message-1']);
    const releaseSecond = deferrals.defer('session-1', ['message-1']);

    releaseFirst();
    expect(deferrals.isDeferred('session-1', 'message-1')).toBe(true);

    releaseSecond();
    expect(deferrals.isDeferred('session-1', 'message-1')).toBe(false);
    expect(deferrals.trackedSessionCount).toBe(0);
  });

  it('releases overlapping holds correctly when they unwind out of order', () => {
    const deferrals = new DeferredMessageRemovals();
    const releaseOuter = deferrals.defer('session-1', ['message-1', 'message-2']);
    const releaseInner = deferrals.defer('session-1', ['message-2']);

    releaseInner();
    expect(deferrals.isDeferred('session-1', 'message-1')).toBe(true);
    expect(deferrals.isDeferred('session-1', 'message-2')).toBe(true);

    releaseOuter();
    expect(deferrals.isDeferred('session-1', 'message-1')).toBe(false);
    expect(deferrals.isDeferred('session-1', 'message-2')).toBe(false);
    expect(deferrals.trackedSessionCount).toBe(0);
  });

  it('ignores a repeated release so a double-invoked cleanup cannot drop a live hold', () => {
    const deferrals = new DeferredMessageRemovals();
    const releaseFirst = deferrals.defer('session-1', ['message-1']);
    const releaseSecond = deferrals.defer('session-1', ['message-1']);

    releaseFirst();
    releaseFirst();
    releaseFirst();

    expect(deferrals.isDeferred('session-1', 'message-1')).toBe(true);

    releaseSecond();
    expect(deferrals.isDeferred('session-1', 'message-1')).toBe(false);
  });

  it('counts a message listed twice in one hold as a single nesting level', () => {
    const deferrals = new DeferredMessageRemovals();
    const release = deferrals.defer('session-1', ['message-1', 'message-1']);

    release();

    expect(deferrals.isDeferred('session-1', 'message-1')).toBe(false);
    expect(deferrals.trackedSessionCount).toBe(0);
  });

  it('keeps a session tracked while any of its messages remain deferred', () => {
    const deferrals = new DeferredMessageRemovals();
    const releaseFirst = deferrals.defer('session-1', ['message-1']);
    deferrals.defer('session-1', ['message-2']);

    releaseFirst();

    expect(deferrals.isDeferred('session-1', 'message-1')).toBe(false);
    expect(deferrals.isDeferred('session-1', 'message-2')).toBe(true);
    expect(deferrals.trackedSessionCount).toBe(1);
  });

  it('starts a fresh hold after a session has been fully released', () => {
    const deferrals = new DeferredMessageRemovals();
    deferrals.defer('session-1', ['message-1'])();

    const release = deferrals.defer('session-1', ['message-1']);
    expect(deferrals.isDeferred('session-1', 'message-1')).toBe(true);

    release();
    expect(deferrals.isDeferred('session-1', 'message-1')).toBe(false);
    expect(deferrals.trackedSessionCount).toBe(0);
  });

  it('tracks sessions independently', () => {
    const deferrals = new DeferredMessageRemovals();
    const releaseFirst = deferrals.defer('session-1', ['message-1']);
    deferrals.defer('session-2', ['message-1']);

    releaseFirst();

    expect(deferrals.isDeferred('session-1', 'message-1')).toBe(false);
    expect(deferrals.isDeferred('session-2', 'message-1')).toBe(true);
    expect(deferrals.trackedSessionCount).toBe(1);
  });

  it('releases an empty hold without stranding the session', () => {
    const deferrals = new DeferredMessageRemovals();
    const release = deferrals.defer('session-1', []);

    expect(deferrals.trackedSessionCount).toBe(1);
    release();
    expect(deferrals.trackedSessionCount).toBe(0);
  });
});
