import { access, readFile, readdir, rm } from 'node:fs/promises';
import { dirname, join, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import spawn from 'cross-spawn';

const scriptPath = fileURLToPath(import.meta.url);
const defaultProjectRoot = resolve(dirname(scriptPath), '..');

export function selectStaleVsixFiles(entries, packageName) {
  const prefix = `${packageName}-`;
  return entries.filter((entry) => entry.startsWith(prefix) && entry.endsWith('.vsix'));
}

export function createVscodeInstallPlan(options) {
  if (!options.npmExecPath) {
    throw new Error('npm_execpath is unavailable; run this helper with npm run vscode:install');
  }

  const pathJoin = options.platform === 'win32' ? win32.join : join;
  const vsixPath = pathJoin(
    options.projectRoot,
    `${options.packageName}-${options.packageVersion}.vsix`
  );
  const vscodeCli =
    options.env.VARRO_VSCODE_CLI?.trim() || (options.platform === 'win32' ? 'code.cmd' : 'code');

  return {
    vsixPath,
    packageCommand: {
      command: options.nodePath,
      args: [options.npmExecPath, 'run', 'package'],
      env: options.env,
      shell: false,
    },
    installCommand: {
      command: vscodeCli,
      args: ['--install-extension', vsixPath],
      env: { ...options.env, NODE_NO_WARNINGS: '1' },
      shell: false,
    },
  };
}

function runCommand(spec, cwd) {
  return new Promise((resolveCommand, rejectCommand) => {
    // cross-spawn resolves Windows .cmd shims through cmd.exe with escaped,
    // verbatim arguments while preserving direct execution on POSIX.
    const child = spawn(spec.command, spec.args, {
      cwd,
      env: spec.env,
      shell: spec.shell,
      stdio: 'inherit',
    });
    child.once('error', rejectCommand);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolveCommand();
        return;
      }
      const outcome = signal ? `signal ${signal}` : `exit code ${String(code)}`;
      rejectCommand(new Error(`${spec.command} failed with ${outcome}`));
    });
  });
}

async function main() {
  const manifest = JSON.parse(await readFile(join(defaultProjectRoot, 'package.json'), 'utf8'));
  if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') {
    throw new Error('package.json must define string name and version fields');
  }

  const plan = createVscodeInstallPlan({
    projectRoot: defaultProjectRoot,
    packageName: manifest.name,
    packageVersion: manifest.version,
    platform: process.platform,
    nodePath: process.execPath,
    npmExecPath: process.env.npm_execpath,
    env: process.env,
  });
  const staleVsixFiles = selectStaleVsixFiles(await readdir(defaultProjectRoot), manifest.name);

  if (process.argv.includes('--dry-run')) {
    process.stdout.write(
      [
        `Would remove: ${staleVsixFiles.join(', ') || '(none)'}`,
        `Would package: ${plan.packageCommand.command} ${plan.packageCommand.args.join(' ')}`,
        `Would install: ${plan.installCommand.command} ${plan.installCommand.args.join(' ')}`,
        '',
      ].join('\n')
    );
    return;
  }

  await Promise.all(
    staleVsixFiles.map((file) => rm(join(defaultProjectRoot, file), { force: true }))
  );
  await runCommand(plan.packageCommand, defaultProjectRoot);
  await access(plan.vsixPath);
  await runCommand(plan.installCommand, defaultProjectRoot);
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  await main();
}
