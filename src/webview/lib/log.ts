import { postMessage } from './bridge';

export function logError<T>(context: string, err: T): void {
  postMessage({
    type: 'log',
    payload: {
      msg: context,
      error: err instanceof Error ? err.message : String(err),
      level: 'error',
    },
  });
}

export function logWarn<T>(context: string, detail?: T): void {
  postMessage({
    type: 'log',
    payload: {
      msg: context,
      error:
        detail !== undefined
          ? detail instanceof Error
            ? detail.message
            : String(detail)
          : undefined,
      level: 'warn',
    },
  });
}
