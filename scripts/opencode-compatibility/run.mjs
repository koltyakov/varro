import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import process from 'node:process';

const RESULT_PREFIX = 'VARRO_COMPAT_RESULT=';
const DEFAULT_SCAN_COUNT = 12;
const ROOT = resolve(import.meta.dirname, '../..');
const DOCKERFILE = resolve(import.meta.dirname, 'Dockerfile');
const COMPATIBILITY_FILE = resolve(ROOT, 'src/shared/opencode-compatibility.ts');

function parseArguments(argv) {
  const options = {
    count: DEFAULT_SCAN_COUNT,
    versions: null,
    checkFloor: false,
    keepImages: false,
    report: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--check-floor') options.checkFloor = true;
    else if (argument === '--keep-images') options.keepImages = true;
    else if (argument === '--count') options.count = Number.parseInt(argv[++index] || '', 10);
    else if (argument === '--versions')
      options.versions = (argv[++index] || '').split(',').filter(Boolean);
    else if (argument === '--report') options.report = argv[++index] || null;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!Number.isSafeInteger(options.count) || options.count < 2) {
    throw new Error('--count must be an integer greater than 1');
  }
  return options;
}

function compareVersions(left, right) {
  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

async function readDeclaredCompatibilityRange() {
  const source = await readFile(COMPATIBILITY_FILE, 'utf8');
  const floor = source.match(/MINIMUM_SUPPORTED_OPENCODE_VERSION\s*=\s*'([^']+)'/)?.[1];
  const ceiling = source.match(/MAXIMUM_TESTED_OPENCODE_VERSION\s*=\s*'([^']+)'/)?.[1];
  if (!floor || !ceiling) {
    throw new Error(`Could not read compatibility range from ${COMPATIBILITY_FILE}`);
  }
  return { floor, ceiling };
}

async function readPublishedVersions() {
  const response = await fetch('https://registry.npmjs.org/opencode-ai');
  if (!response.ok) throw new Error(`npm registry returned ${response.status}`);
  const metadata = await response.json();
  return Object.keys(metadata.versions || {})
    .filter((version) => /^\d+\.\d+\.\d+$/.test(version))
    .sort((left, right) => compareVersions(right, left));
}

function selectPublishedVersions(allVersions, count, declaredFloor, declaredCeiling, anchorFloor) {
  if (allVersions.length < count) {
    throw new Error(`npm registry returned only ${allVersions.length} stable versions`);
  }
  const selected = allVersions.slice(0, count);
  if (anchorFloor) {
    const floorIndex = allVersions.indexOf(declaredFloor);
    if (floorIndex < 0) {
      throw new Error(`Declared floor ${declaredFloor} is not a published stable OpenCode version`);
    }
    if (!allVersions.includes(declaredCeiling)) {
      throw new Error(
        `Declared tested ceiling ${declaredCeiling} is not a published stable OpenCode version`
      );
    }
    selected.push(declaredFloor);
    selected.push(declaredCeiling);
    const predecessor = allVersions[floorIndex + 1];
    if (predecessor) selected.push(predecessor);
  }
  return [...new Set(selected)].sort((left, right) => compareVersions(right, left));
}

function runDocker(args, options = {}) {
  return spawnSync('docker', args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    timeout: options.timeout || 10 * 60_000,
  });
}

function assertDockerAvailable() {
  const result = runDocker(['info', '--format', '{{.ServerVersion}}'], { timeout: 30_000 });
  if (result.status !== 0) {
    throw new Error(`Docker is not available: ${(result.stderr || result.stdout).trim()}`);
  }
}

function imageTag(version) {
  return `varro-opencode-compat:${version.replace(/[^a-zA-Z0-9_.-]/g, '-')}`;
}

function testVersion(version) {
  const tag = imageTag(version);
  process.stdout.write(`\n[${version}] Building compatibility image...\n`);
  const build = runDocker([
    'build',
    '--file',
    DOCKERFILE,
    '--build-arg',
    `OPENCODE_VERSION=${version}`,
    '--tag',
    tag,
    ROOT,
  ]);
  if (build.status !== 0) {
    throw new Error(
      `Docker build failed for OpenCode ${version}:\n${build.stderr || build.stdout}`
    );
  }

  process.stdout.write(`[${version}] Probing Varro capabilities...\n`);
  const run = runDocker(['run', '--rm', tag], { timeout: 2 * 60_000 });
  const output = `${run.stdout || ''}\n${run.stderr || ''}`;
  const resultLine = output.split(/\r?\n/).find((line) => line.startsWith(RESULT_PREFIX));
  if (!resultLine) {
    throw new Error(`Compatibility container failed for OpenCode ${version}:\n${output.trim()}`);
  }
  const result = JSON.parse(resultLine.slice(RESULT_PREFIX.length));
  const failedChecks = result.checks.filter((check) => !check.ok);
  process.stdout.write(
    `[${version}] ${result.compatible ? 'COMPATIBLE' : 'INCOMPATIBLE'} (${result.checks.length - failedChecks.length}/${result.checks.length} checks passed)\n`
  );
  for (const check of failedChecks) {
    process.stdout.write(`  - ${check.name}: ${check.error}\n`);
  }
  if (result.harnessError) {
    throw new Error(`Probe harness failed for OpenCode ${version}: ${result.harnessError}`);
  }
  return result;
}

function analyze(results) {
  const contiguous = [];
  let firstIncompatible = null;
  for (const result of results) {
    if (!result.compatible) {
      firstIncompatible = result;
      break;
    }
    contiguous.push(result);
  }
  return {
    detectedFloor: firstIncompatible ? contiguous.at(-1)?.requestedVersion || null : null,
    oldestTestedCompatible: contiguous.at(-1)?.requestedVersion || null,
    firstIncompatible: firstIncompatible?.requestedVersion || null,
    boundaryFound: firstIncompatible !== null,
  };
}

async function writeReport(path, report) {
  const absolutePath = resolve(ROOT, path);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, `${JSON.stringify(report, null, 2)}\n`);
}

const options = parseArguments(process.argv.slice(2));
assertDockerAvailable();
const { floor: declaredFloor, ceiling: declaredCeiling } = await readDeclaredCompatibilityRange();
const versions = options.versions
  ? options.versions.sort((left, right) => compareVersions(right, left))
  : selectPublishedVersions(
      await readPublishedVersions(),
      options.count,
      declaredFloor,
      declaredCeiling,
      options.checkFloor
    );

process.stdout.write(
  `Testing ${versions.length} OpenCode releases from ${versions[0]} through ${versions.at(-1)}.\n`
);
process.stdout.write(`Declared Varro compatibility floor: ${declaredFloor}.\n`);
process.stdout.write(`Declared Varro tested ceiling: ${declaredCeiling}.\n`);

const results = [];
try {
  for (const version of versions) results.push(testVersion(version));
} finally {
  if (!options.keepImages) {
    for (const version of versions) runDocker(['image', 'rm', '--force', imageTag(version)]);
  }
}

const analysis = analyze(results);
const report = {
  generatedAt: new Date().toISOString(),
  declaredFloor,
  declaredCeiling,
  testedVersions: versions,
  ...analysis,
  results,
};
if (options.report) await writeReport(options.report, report);

process.stdout.write('\nCompatibility summary\n');
for (const result of results) {
  process.stdout.write(
    `  ${result.requestedVersion}: ${result.compatible ? 'compatible' : 'incompatible'}\n`
  );
}

if (!analysis.boundaryFound) {
  const message = `No incompatibility boundary found in ${versions.length} releases; the practical floor is ${analysis.oldestTestedCompatible} or older. Increase --count before changing the declared floor.`;
  if (options.checkFloor) throw new Error(message);
  process.stdout.write(`${message}\n`);
} else {
  process.stdout.write(
    `Detected floor: ${analysis.detectedFloor} (next older tested release ${analysis.firstIncompatible} is incompatible).\n`
  );
  if (options.checkFloor && analysis.detectedFloor !== declaredFloor) {
    throw new Error(
      `Declared floor ${declaredFloor} does not match Docker-tested floor ${analysis.detectedFloor}.`
    );
  }
}
