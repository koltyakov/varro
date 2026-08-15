import { postMessage } from './bridge';

export function logError(context: string, err: unknown): void {
  postMessage({
    type: 'log',
    payload: {
      msg: context,
      error: err instanceof Error ? err.message : String(err),
      level: 'error',
    },
  });
}

export function logWarn(context: string, detail?: unknown): void {
  postMessage({
    type: 'log',
    payload: {
      msg: context,
      ...(detail !== undefined
        ? { error: detail instanceof Error ? detail.message : String(detail) }
        : {}),
      level: 'warn',
    },
  });
}
