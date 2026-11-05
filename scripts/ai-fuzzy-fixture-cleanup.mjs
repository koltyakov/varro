import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

// The caller supplies completed tool parts from the current disposable run, not output text.
// This only removes proved untracked additions; tracked-file restoration remains caller-owned.
export async function removeRunCreatedFiles({
  workspace,
  baseline,
  exitEvidence,
  parts,
  evidencePath,
}) {
  const root = await realpath(workspace);
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  if (
    baseline.status !== '' ||
    !/^[a-f\d]{40,64}$/.test(baseline.head) ||
    path.resolve(git('rev-parse', '--show-toplevel').trim()) !== root ||
    git('rev-parse', 'HEAD').trim() !== baseline.head ||
    exitEvidence.head !== baseline.head ||
    exitEvidence.baseline !== baseline.head
  )
    throw new Error('Fixture cleanup needs an unchanged clean baseline and matching exit evidence');

  const untracked = git('ls-files', '--others', '--exclude-standard', '-z')
    .split('\0')
    .filter(Boolean)
    .toSorted();
  if (JSON.stringify(untracked) !== JSON.stringify(exitEvidence.untracked.toSorted()))
    throw new Error('Untracked fixture paths changed since recorded exit evidence');
  if (!untracked.length) return [];
  if (untracked.length > 3) throw new Error('Too many run-created fixture files');
  const evidenceFile = path.join(
    await realpath(path.dirname(path.resolve(evidencePath))),
    path.basename(evidencePath)
  );
  const evidenceRelative = path.relative(root, evidenceFile);
  if (!path.isAbsolute(evidenceRelative) && !evidenceRelative.split(path.sep).includes('..'))
    throw new Error('Fixture cleanup evidence must be outside the fixture');

  const added = new Set();
  for (const part of parts) {
    if (part.type !== 'tool' || part.tool !== 'patch' || part.state?.status !== 'completed')
      continue;
    if (part.state.metadata?.truncated === true) continue;
    for (const file of part.state.metadata?.files ?? []) {
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Validate captured patch JSON before accepting a file path as ownership evidence.
      if (file.status !== 'added' || typeof file.file !== 'string') continue;
      if (path.isAbsolute(file.file)) {
        added.add(path.relative(root, file.file).split(path.sep).join('/'));
        added.add(path.relative(path.resolve(workspace), file.file).split(path.sep).join('/'));
      } else added.add(file.file.split(path.sep).join('/'));
    }
  }

  const pending = [];
  const inspect = async (relative) => {
    const file = path.join(root, relative);
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
      throw new Error(`Fixture cleanup refuses symlinks, hardlinks or non-files: ${relative}`);
    if ((await realpath(file)) !== file)
      throw new Error(`Fixture cleanup path changed identity: ${relative}`);
    const bytes = await readFile(file);
    if (digest(bytes) !== exitEvidence.contents[relative])
      throw new Error(`Run-created fixture file changed since recorded exit: ${relative}`);
    return { info, bytes };
  };
  // Validate every addition before deleting any file or restoring tracked paths.
  for (const relative of untracked) {
    if (
      path.isAbsolute(relative) ||
      relative.split(/[\\/]/).some((part) => part === '..' || part === '.git') ||
      relative.includes('\\')
    )
      throw new Error(`Unsafe fixture cleanup path: ${relative}`);
    if (!added.has(relative))
      throw new Error(`No completed patch creation evidence for ${relative}`);
    if (git('ls-tree', '--name-only', '-z', baseline.head, '--', relative))
      throw new Error(`Run-created file existed at the fixture baseline: ${relative}`);
    const { info, bytes } = await inspect(relative);
    pending.push({
      path: relative,
      sha256: digest(bytes),
      originalBase64: bytes.toString('base64'),
      device: info.dev,
      inode: info.ino,
    });
  }
  const evidence = { workspace: root, baseline: baseline.head, files: pending, removed: [] };
  // Keep recovery bytes before the first unlink; never overwrite an earlier evidence record.
  await writeFile(evidenceFile, JSON.stringify(evidence, null, 2), { flag: 'wx', mode: 0o600 });
  for (const item of pending) {
    const { info } = await inspect(item.path);
    if (info.dev !== item.device || info.ino !== item.inode)
      throw new Error(`Run-created fixture file changed identity: ${item.path}`);
    await unlink(path.join(root, item.path));
    evidence.removed.push(item.path);
    await writeFile(evidenceFile, JSON.stringify(evidence, null, 2), { mode: 0o600 });
  }
  return evidence.removed;
}
