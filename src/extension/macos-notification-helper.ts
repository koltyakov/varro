import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { asRecord } from '../shared/type-utils';
import { readEditorVisibility } from './editor-window-visibility';

type RunCommand = (file: string, args: string[]) => Promise<string | void>;

/** Installs the repository-built app in durable extension storage for Launch Services. */
export class MacOSNotificationHelper {
  private ready: Promise<string> | undefined;

  constructor(
    private readonly archiveDirectory: string,
    private readonly storageDirectory: string,
    private readonly run: RunCommand
  ) {}

  async executable(): Promise<string> {
    this.ready ??= this.install();
    try {
      return await this.ready;
    } catch (error: unknown) {
      this.ready = undefined;
      throw error;
    }
  }

  async isEditorVisible(processID: number): Promise<boolean> {
    const result = await this.run(await this.executable(), ['--windows', String(processID)]);
    if (!result) throw new Error('The macOS helper returned no editor visibility state');
    return readEditorVisibility(result);
  }

  private async install(): Promise<string> {
    const archive = join(this.archiveDirectory, 'macos-notifier.zip');
    const manifest: unknown = JSON.parse(
      await readFile(join(this.archiveDirectory, 'macos-notifier.json'), 'utf8')
    );
    const checksum = createHash('sha256')
      .update(await readFile(archive))
      .digest('hex');
    if (asRecord(manifest)?.sha256 !== checksum) {
      throw new Error('Varro notification helper checksum mismatch. Reinstall the extension.');
    }
    const cache = join(this.storageDirectory, 'notifications');
    const destination = join(cache, checksum);
    const app = join(destination, 'Varro.app');
    const executable = join(app, 'Contents', 'MacOS', 'varro-notifier');
    await mkdir(cache, { recursive: true });
    try {
      await access(executable);
    } catch (error: unknown) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
      const staging = await mkdtemp(join(cache, '.install-'));
      try {
        await this.run('/usr/bin/ditto', ['-x', '-k', archive, staging]);
        await this.run('/usr/bin/codesign', [
          '--verify',
          '--deep',
          '--strict',
          join(staging, 'Varro.app'),
        ]);
        try {
          await rename(staging, destination);
        } catch (renameError: unknown) {
          // Another editor window may have installed the identical archive first.
          // Windows reports this directory collision as EPERM.
          if (
            !(renameError instanceof Error) ||
            !('code' in renameError) ||
            !['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(String(renameError.code))
          )
            throw renameError;
          try {
            await access(executable);
          } catch {
            throw renameError;
          }
        }
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    }
    await this.run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
    await this.run(
      '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister',
      ['-f', app]
    );
    return executable;
  }
}
