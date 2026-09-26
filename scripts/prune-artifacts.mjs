// @ts-check
import { lstat, readdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULT_KEEP = 10;
const DEFAULT_MIN_AGE_HOURS = 24;

// Only regenerable run output is listed. The tmp/ fixtures, ai-fuzzy ledgers, and
// summary files such as opencode-adapters/verified.json are never candidates.
export const PRUNE_TARGETS = [
  { directory: 'artifacts/opencode-adapters', pattern: /^run-/ },
  { directory: 'artifacts/ai-streaming', pattern: /./ },
  { directory: 'artifacts/ai-test-data', pattern: /./ },
];

export function selectPruneCandidates(entries, { keep, minAgeMs, now, protectedPaths }) {
  const newestFirst = entries.toSorted((left, right) => right.mtimeMs - left.mtimeMs);
  return newestFirst
    .slice(keep)
    .filter((entry) => now - entry.mtimeMs >= minAgeMs)
    .filter(
      (entry) =>
        !protectedPaths.some(
          (protectedPath) =>
            protectedPath === entry.path || protectedPath.startsWith(`${entry.path}${path.sep}`)
        )
    );
}

export function parsePruneArguments(args) {
  const options = { apply: false, keep: DEFAULT_KEEP, minAgeHours: DEFAULT_MIN_AGE_HOURS };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--apply') options.apply = true;
    else if (argument === '--dry-run') options.apply = false;
    else if (argument === '--keep' || argument === '--min-age-hours') {
      const value = Number(args[index + 1]);
      if (!Number.isInteger(value) || value < 0) {
        throw new Error(`${argument} requires a non-negative integer`);
      }
      if (argument === '--keep') options.keep = value;
      else options.minAgeHours = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (args.includes('--apply') && args.includes('--dry-run')) {
    throw new Error('--apply and --dry-run cannot be combined');
  }
  return options;
}

async function listRunDirectories(targetDirectory, pattern) {
  let names;
  try {
    names = await readdir(targetDirectory);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
  const entries = [];
  for (const name of names) {
    if (!pattern.test(name)) continue;
    const entryPath = path.join(targetDirectory, name);
    const info = await lstat(entryPath);
    // Symlinks could point outside the artifacts tree, so they are never followed or removed.
    if (!info.isDirectory() || info.isSymbolicLink()) continue;
    entries.push({ path: entryPath, mtimeMs: info.mtimeMs });
  }
  return entries;
}

async function directorySize(directory) {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) total += await directorySize(entryPath);
    else total += (await lstat(entryPath)).size;
  }
  return total;
}

async function resolveProtectedPaths() {
  const paths = [];
  for (const value of [process.env.VARRO_AI_DATA_DIR]) {
    if (!value) continue;
    try {
      paths.push(await realpath(value));
    } catch {
      paths.push(path.resolve(value));
    }
  }
  return paths;
}

function formatSize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

async function main() {
  const options = parsePruneArguments(process.argv.slice(2));
  const protectedPaths = await resolveProtectedPaths();
  const now = Date.now();
  let totalBytes = 0;
  let totalCount = 0;
  for (const target of PRUNE_TARGETS) {
    const targetDirectory = path.join(projectRoot, target.directory);
    const entries = await listRunDirectories(targetDirectory, target.pattern);
    const candidates = selectPruneCandidates(
      await Promise.all(
        entries.map(async (entry) => ({ ...entry, path: await realpath(entry.path) }))
      ),
      {
        keep: options.keep,
        minAgeMs: options.minAgeHours * 60 * 60 * 1000,
        now,
        protectedPaths,
      }
    );
    for (const candidate of candidates) {
      const size = await directorySize(candidate.path);
      totalBytes += size;
      totalCount += 1;
      // oxlint-disable-next-line no-console
      console.log(
        `${options.apply ? 'remove' : 'would remove'} ${path.relative(projectRoot, candidate.path)} (${formatSize(size)})`
      );
      if (options.apply) await rm(candidate.path, { recursive: true });
    }
  }
  // oxlint-disable-next-line no-console
  console.log(
    `${options.apply ? 'Removed' : 'Would remove'} ${totalCount} run directories (${formatSize(totalBytes)}).${options.apply ? '' : ' Pass --apply to delete them.'}`
  );
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  await main();
}
