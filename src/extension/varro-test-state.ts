import { isAbsolute, join } from 'node:path';

export type VarroStateKind = 'servers' | 'opencode-v2' | 'provider-quota-v2';

/** Test hosts must not discover or write a production editor's ownership state. */
export function getVarroTestStateDirectory(kind: VarroStateKind): string | undefined {
  const root = process.env.VARRO_TEST_STATE_ROOT;
  if (root !== undefined) {
    if (!root.trim() || !isAbsolute(root))
      throw new Error('VARRO_TEST_STATE_ROOT must be an absolute isolated directory');
    return join(root, kind);
  }
  if (process.env.VARRO_TEST_SERVER_URL)
    throw new Error(
      'AI test state isolation is missing; set VARRO_TEST_STATE_ROOT before starting Varro'
    );
  return undefined;
}
