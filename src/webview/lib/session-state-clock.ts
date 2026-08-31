let sessionStateLogicalTime = 0;

export function captureSessionStateTime() {
  sessionStateLogicalTime = Math.max(sessionStateLogicalTime + 1, Date.now());
  return sessionStateLogicalTime;
}

export function resetSessionStateClock() {
  sessionStateLogicalTime = 0;
}
