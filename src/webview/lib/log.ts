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

export function logWarn(context: string, err: unknown): void {
  postMessage({
    type: 'log',
    payload: {
      msg: context,
      error: err instanceof Error ? err.message : String(err),
      level: 'warn',
    },
  });
}
