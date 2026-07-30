import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(projectRoot, 'package.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

if (!Array.isArray(manifest.files)) {
  throw new Error('package.json must define a files array');
}

const stagingRoot = await mkdtemp(join(tmpdir(), 'varro-vsix-'));
const packagePath = join(projectRoot, `${manifest.name}-${manifest.version}.vsix`);

try {
  for (const relativePath of ['package.json', ...manifest.files]) {
    const destination = join(stagingRoot, relativePath);
    await mkdir(dirname(destination), { recursive: true });
    await cp(join(projectRoot, relativePath), destination, { recursive: true });
  }

  const vscePath = join(projectRoot, 'node_modules', '@vscode', 'vsce', 'vsce');
  const exitCode = await new Promise((resolveExitCode, reject) => {
    const child = spawn(
      process.execPath,
      [vscePath, 'package', '--no-dependencies', '--out', packagePath],
      {
        cwd: stagingRoot,
        stdio: 'inherit',
      }
    );

    child.on('error', reject);
    child.on('exit', (code) => resolveExitCode(code));
  });

  if (exitCode !== 0) {
    throw new Error(`vsce package failed with exit code ${exitCode}`);
  }
} finally {
  await rm(stagingRoot, { recursive: true, force: true });
}
