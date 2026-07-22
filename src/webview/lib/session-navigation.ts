import { createSignal } from 'solid-js';

type DirectSessionReturn = {
  sessionId: string;
  returnSessionId: string;
};

const [directSessionReturn, setDirectSessionReturn] = createSignal<DirectSessionReturn | null>(
  null
);

export function rememberDirectSessionReturn(sessionId: string, returnSessionId: string): void {
  setDirectSessionReturn(sessionId === returnSessionId ? null : { sessionId, returnSessionId });
}

export function getDirectSessionReturnId(sessionId: string | null): string | null {
  const target = directSessionReturn();
  return target?.sessionId === sessionId ? target.returnSessionId : null;
}

export function clearDirectSessionReturn(): void {
  setDirectSessionReturn(null);
}

export function clearDirectSessionReturnUnless(sessionId: string | null): void {
  if (directSessionReturn()?.sessionId !== sessionId) clearDirectSessionReturn();
}
