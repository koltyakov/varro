import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';

// This owns one explicitly authorized test edit, never a repository reset.
export class ReversibleFixtureEdit {
  constructor(workspace, relativePath, marker) {
    if (path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes('..')) {
      throw new Error('Fixture edit needs a workspace-relative path without traversal');
    }
    if (!marker || /[\r\n]/.test(marker))
      throw new Error('Fixture edit needs a single-line marker');
    this.workspace = workspace;
    this.relativePath = relativePath;
    this.file = path.join(workspace, relativePath);
    this.marker = marker;
  }

  async prepare(evidencePath) {
    this.realWorkspace = await realpath(this.workspace);
    this.realFile = await this.verifyTarget();
    this.original = await readFile(this.file);
    if (this.original.includes(this.marker))
      throw new Error('Fixture already contains this edit marker');
    const newline = this.original.includes('\r\n') ? '\r\n' : '\n';
    const separator = this.original.at(-1) === 10 ? '' : newline;
    this.comment = `// ${this.marker}`;
    this.edited = Buffer.concat([
      this.original,
      Buffer.from(`${separator}${this.comment}${newline}`),
    ]);
    this.evidencePath = evidencePath;
    // A timeout can leave the child busy. Retain recovery bytes before sending,
    // rather than depending on this controller process surviving the model turn.
    await writeFile(
      evidencePath,
      `${JSON.stringify(
        {
          path: this.relativePath,
          originalBase64: this.original.toString('base64'),
          expectedBase64: this.edited.toString('base64'),
          prepared: true,
          restored: false,
        },
        null,
        2
      )}\n`
    );
  }

  async verifyTarget() {
    const info = await lstat(this.file);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
      throw new Error('Fixture edit target must be a regular file without symlinks or hardlinks');
    }
    const resolved = await realpath(this.file);
    const relative = path.relative(this.realWorkspace, resolved);
    if (path.isAbsolute(relative) || relative.split(path.sep).includes('..')) {
      throw new Error('Fixture edit target escaped its workspace');
    }
    if (this.realFile && resolved !== this.realFile)
      throw new Error('Fixture edit target changed identity');
    return resolved;
  }

  async restore(evidencePath = this.evidencePath) {
    if (!this.original) throw new Error('Fixture edit was not prepared');
    await this.verifyTarget();
    const observed = await readFile(this.file);
    const evidence = {
      path: this.relativePath,
      originalBase64: this.original.toString('base64'),
      observedBase64: observed.toString('base64'),
      expectedEdit: observed.equals(this.edited),
      unchanged: observed.equals(this.original),
      restored: false,
    };
    // Preserve the actual model result before cleanup, even for an unexpected edit.
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    if (!evidence.unchanged) await writeFile(this.file, this.original);
    evidence.restored = (await readFile(this.file)).equals(this.original);
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    if (!evidence.restored)
      throw new Error('Fixture edit did not restore its exact original bytes');
    return evidence;
  }
}
