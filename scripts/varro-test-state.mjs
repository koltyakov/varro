import { mkdir } from 'node:fs/promises';
import path from 'node:path';

/** Scope current records and the HOME/temp paths used by older Varro builds. */
export async function isolateVarroTestState(environment, root) {
  if (!path.isAbsolute(root)) throw new Error('Varro test profile root must be absolute');
  const home = path.join(root, 'home');
  const temporary = path.join(root, 'tmp');
  const state = path.join(root, 'state');
  const localAppData = path.join(root, 'local-appdata');
  await Promise.all(
    [home, temporary, state, localAppData].map((directory) =>
      mkdir(directory, { recursive: true, mode: 0o700 })
    )
  );
  Object.assign(environment, {
    VARRO_TEST_STATE_ROOT: path.join(state, 'varro-test'),
    HOME: home,
    USERPROFILE: home,
    LOCALAPPDATA: localAppData,
    XDG_STATE_HOME: state,
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
  });
  return environment.VARRO_TEST_STATE_ROOT;
}
