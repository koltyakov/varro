// Download native, pinned test tools into an isolated checkout, never the user's applications.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, realpath, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tools = path.join(root, 'artifacts/ai-test-data/startup-tools');
await mkdir(tools, { recursive: true });
const environment = {
  ...process.env,
  PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ''}`,
};
const nativePlatform = process.platform === 'win32' ? 'windows' : process.platform;
const packageName = `@opencode/cli-${nativePlatform}-${process.arch}`;
const registry = await fetch(`https://registry.npmjs.org/${encodeURIComponent(packageName)}/2.2.7`);
if (!registry.ok) throw new Error(`OpenCode registry returned ${registry.status}`);
const metadata = await registry.json();
const nativeArchive = path.join(tools, 'opencode.tgz');
await download(
  metadata.dist.tarball,
  nativeArchive,
  'sha512',
  metadata.dist.integrity.replace('sha512-', ''),
  'base64'
);
const cliRoot = path.join(tools, 'cli');
await mkdir(cliRoot);
execFileSync('tar', ['-xf', nativeArchive, '-C', cliRoot], { env: environment });
const binary = path.join(
  cliRoot,
  'package/bin',
  process.platform === 'win32' ? 'opencode.exe' : 'opencode'
);
const version = execFileSync(binary, ['--version'], { encoding: 'utf8', env: environment }).trim();
if (!version.includes('2.2.7'))
  throw new Error(`Unexpected OpenCode executable version: ${version}`);

let executable;
let vscodeVersion;
if (process.platform === 'win32') {
  executable = path.join(process.env.LOCALAPPDATA, 'Programs/Microsoft VS Code/Code.exe');
  await access(executable);
  vscodeVersion = execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      `(Get-Item -LiteralPath '${executable.replaceAll("'", "''")}').VersionInfo.ProductVersion`,
    ],
    { encoding: 'utf8' }
  ).trim();
} else {
  const platform = process.platform === 'darwin' ? 'darwin-arm64' : 'linux-x64';
  const response = await fetch(
    `https://update.code.visualstudio.com/api/update/${platform}/stable/latest`
  );
  if (!response.ok) throw new Error(`VS Code update service returned ${response.status}`);
  const update = await response.json();
  if (update.productVersion !== '1.146.0')
    throw new Error(`Expected pinned VS Code 1.146.0, got ${update.productVersion}`);
  const archive = path.join(tools, process.platform === 'darwin' ? 'vscode.zip' : 'vscode.tar.gz');
  await download(update.url, archive, 'sha256', update.sha256hash, 'hex');
  const editorRoot = path.join(tools, 'editor');
  await mkdir(editorRoot);
  if (process.platform === 'darwin') {
    execFileSync('/usr/bin/ditto', ['-x', '-k', archive, editorRoot]);
    for (const name of ['Electron', 'Code']) {
      const candidate = path.join(editorRoot, 'Visual Studio Code.app/Contents/MacOS', name);
      try {
        await access(candidate);
        executable = candidate;
        break;
      } catch {}
    }
  } else {
    execFileSync('tar', ['-xf', archive, '-C', editorRoot]);
    executable = path.join(editorRoot, 'VSCode-linux-x64/code');
  }
  if (!executable) throw new Error('VS Code archive has no native application executable');
  await access(executable);
  vscodeVersion = update.productVersion;
}

const npm =
  process.platform === 'win32'
    ? 'npm.exe'
    : await realpath(path.join(path.dirname(process.execPath), 'npm'));
const installArgs = process.platform === 'win32' ? ['install'] : [npm, 'install'];
execFileSync(process.platform === 'win32' ? npm : process.execPath, installArgs, {
  cwd: root,
  env: environment,
  stdio: 'inherit',
  timeout: 600_000,
});
await writeFile(
  path.join(tools, 'tools.json'),
  JSON.stringify(
    {
      binary,
      version,
      executable,
      vscodeVersion,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    null,
    2
  )
);
process.stdout.write(`${JSON.stringify({ root, binary, executable, version, vscodeVersion })}\n`);

async function download(url, destination, algorithm, expected, encoding) {
  const response = await fetch(url, { signal: AbortSignal.timeout(600_000) });
  if (!response.ok)
    throw new Error(`Download returned ${response.status}: ${new URL(url).hostname}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash(algorithm).update(bytes).digest(encoding) !== expected)
    throw new Error(`Checksum mismatch: ${path.basename(destination)}`);
  await writeFile(destination, bytes, { flag: 'wx', mode: 0o600 });
}
