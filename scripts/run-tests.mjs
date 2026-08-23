import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TEST_FILE_PATTERN = /\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/;

function normalizeTestPath(value) {
  return value.replaceAll('\\', '/').replace(/^\.\//, '');
}

function argumentsForRunner(args, excludedTests, nodeRunner) {
  const result = [];
  for (const argument of args) {
    if (excludedTests.has(argument)) continue;
    if (nodeRunner && (argument === '-t' || argument === '--testNamePattern')) {
      result.push('--test-name-pattern');
    } else if (!nodeRunner && argument === '--test-name-pattern') {
      result.push('--testNamePattern');
    } else {
      result.push(argument);
    }
  }
  return result;
}

function orderNodeArguments(args) {
  const tests = args.filter((argument) => TEST_FILE_PATTERN.test(argument));
  const testSet = new Set(tests);
  return [...args.filter((argument) => !testSet.has(argument)), ...tests];
}

export function partitionTestArguments(args, scriptTests) {
  const scriptTestSet = new Set(scriptTests.map(normalizeTestPath));
  const explicitScriptTests = new Set(
    args.filter((argument) => scriptTestSet.has(normalizeTestPath(argument)))
  );
  const explicitVitestTests = new Set(
    args.filter(
      (argument) => TEST_FILE_PATTERN.test(argument) && !scriptTestSet.has(normalizeTestPath(argument))
    )
  );

  if (args.length === 0) {
    return { vitestArgs: [], nodeArgs: scriptTests, runVitest: true, runNode: true };
  }
  if (explicitScriptTests.size === 0) {
    const nodeOnly = args.some((argument) => argument.startsWith('--test-'));
    return {
      vitestArgs: nodeOnly ? [] : args,
      nodeArgs: nodeOnly ? orderNodeArguments([...scriptTests, ...args]) : [],
      runVitest: !nodeOnly,
      runNode: nodeOnly,
    };
  }

  return {
    vitestArgs:
      explicitVitestTests.size > 0 ? argumentsForRunner(args, explicitScriptTests, false) : [],
    nodeArgs: orderNodeArguments(argumentsForRunner(args, explicitVitestTests, true)),
    runVitest: explicitVitestTests.size > 0,
    runNode: true,
  };
}

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: projectRoot,
      stdio: 'inherit',
      shell: false,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(signal ? `test process exited with ${signal}` : `test process exited with code ${String(code)}`));
    });
  });
}

async function main() {
  const scriptTests = (await readdir(path.join(projectRoot, 'scripts')))
    .filter((name) => name.endsWith('.test.mjs'))
    .map((name) => path.join('scripts', name))
    .toSorted();
  const partition = partitionTestArguments(process.argv.slice(2), scriptTests);
  if (partition.runVitest) {
    await run([
      path.join(projectRoot, 'node_modules/vitest/vitest.mjs'),
      'run',
      ...partition.vitestArgs,
    ]);
  }
  if (partition.runNode) await run(['--test', ...partition.nodeArgs]);
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  await main();
}
