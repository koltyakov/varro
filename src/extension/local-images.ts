import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { isNetworkOrDevicePath } from '../shared/local-images';
import type { LocalImageResponse } from '../shared/local-images';
import type { ContextProvider } from './context-provider';
import { ImageThumbnails } from './image-thumbnails';
import { THUMBNAIL_MAX_INPUT_BYTES } from './image-thumbnail-protocol';
import type { ThumbnailFormat } from './image-thumbnail-protocol';

function imageFormat(bytes: Buffer): ThumbnailFormat | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpeg';
  if (/^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6))) return 'gif';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP')
    return 'webp';
  if (
    bytes.toString('ascii', 4, 8) === 'ftyp' &&
    ['avif', 'avis'].includes(bytes.toString('ascii', 8, 12))
  )
    return 'avif';
  return null;
}

/** Read canonical, workspace-authorized raster files, never raw paths from the webview. */
export class LocalImages {
  constructor(
    private readonly context: Pick<ContextProvider, 'resolvePath'>,
    private readonly thumbnails = new ImageThumbnails()
  ) {}

  async load(
    path: string,
    directory: string,
    signal: AbortSignal,
    original = false
  ): Promise<LocalImageResponse> {
    signal.throwIfAborted();
    // Resolution can stat the path, which already reaches a network host.
    if (isNetworkOrDevicePath(path)) throw new Error('Local image is not in an open workspace');
    const resolved = await this.context.resolvePath(path, {
      restrictToWorkspace: true,
      workspaceDirectory: directory,
      allowSiblingWorkspaceFolders: true,
    });
    signal.throwIfAborted();
    if (!resolved || resolved.type !== 'file')
      throw new Error('Local image is not in an open workspace');
    const file = await open(
      resolved.path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size === 0 || stat.size > THUMBNAIL_MAX_INPUT_BYTES)
        throw new Error('Local image exceeds the image size limit or is not a regular file');
      // Bound reads even if the file grows after stat.
      const bytes = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < bytes.length) {
        signal.throwIfAborted();
        const result = await file.read(bytes, offset, bytes.length - offset, offset);
        if (result.bytesRead === 0) break;
        offset += result.bytesRead;
      }
      const input = bytes.subarray(0, offset);
      const format = imageFormat(input);
      if (!format) throw new Error('Only raster images are supported');
      signal.throwIfAborted();
      const mime = `image/${format}`;
      if (original)
        return {
          url: `data:${mime};base64,${input.toString('base64')}`,
          path: resolved.path,
          mime,
        };
      const key = `local:${createHash('sha256').update(input).digest('hex')}`;
      const url = await this.thumbnails.getInput(key, input, format, signal);
      if (!url) throw new Error('Could not generate local image preview');
      return { url, path: resolved.path, mime: 'image/webp' };
    } finally {
      await file.close();
    }
  }

  dispose() {
    this.thumbnails.dispose();
  }
}
