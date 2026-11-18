import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, open, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalImages } from './local-images';
import { ImageThumbnails } from './image-thumbnails';
import { THUMBNAIL_MAX_INPUT_BYTES } from './image-thumbnail-protocol';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jV1kAAAAASUVORK5CYII=',
  'base64'
);
const roots: string[] = [];
const services: LocalImages[] = [];

async function fixture(bytes = png) {
  const root = await mkdtemp(join(tmpdir(), 'varro-local-images-'));
  roots.push(root);
  const path = join(root, 'image.png');
  await writeFile(path, bytes);
  const resolvePath = vi.fn(async () => ({
    path,
    relativePath: 'image.png',
    type: 'file' as const,
  }));
  const convert = vi.fn(async () => 'data:image/webp;base64,AAAA');
  const images = new LocalImages({ resolvePath }, new ImageThumbnails({ convert }));
  services.push(images);
  return { root, path, images, resolvePath, convert };
}

afterEach(async () => {
  for (const service of services.splice(0)) service.dispose();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('LocalImages', () => {
  it('reads only the canonical authorized file and sends a bounded thumbnail', async () => {
    const { root, path, images, resolvePath, convert } = await fixture();
    const signal = new AbortController().signal;
    expect(await images.load('image.png', root, signal)).toEqual({
      url: 'data:image/webp;base64,AAAA',
      path,
      mime: 'image/webp',
    });
    expect(resolvePath).toHaveBeenCalledWith('image.png', {
      restrictToWorkspace: true,
      workspaceDirectory: root,
      allowSiblingWorkspaceFolders: true,
    });
    expect(convert).toHaveBeenCalledWith(png, 'png', expect.any(AbortSignal));
    await images.load('image.png', root, signal);
    expect(convert).toHaveBeenCalledOnce();
  });

  it('returns the original raster only when explicitly requested', async () => {
    const { root, path, images, convert } = await fixture();
    expect(await images.load(path, root, new AbortController().signal, true)).toEqual({
      url: `data:image/png;base64,${png.toString('base64')}`,
      path,
      mime: 'image/png',
    });
    expect(convert).not.toHaveBeenCalled();
  });

  it('does not read a path rejected by workspace resolution', async () => {
    const resolvePath = vi.fn(async () => null);
    const images = new LocalImages({ resolvePath });
    services.push(images);
    await expect(
      images.load('/outside/image.png', '/workspace', new AbortController().signal)
    ).rejects.toThrow('not in an open workspace');
  });

  it('rejects oversized files before allocation or conversion', async () => {
    const { root, path, images, convert } = await fixture();
    const file = await open(path, 'r+');
    try {
      await file.truncate(THUMBNAIL_MAX_INPUT_BYTES + 1);
    } finally {
      await file.close();
    }
    await expect(images.load(path, root, new AbortController().signal)).rejects.toThrow(
      'size limit'
    );
    expect(convert).not.toHaveBeenCalled();
  });

  it('rejects a final symlink instead of following an unverified replacement', async () => {
    const { root, path, images } = await fixture();
    await rm(path);
    await writeFile(join(root, 'replacement.png'), png);
    await symlink(join(root, 'replacement.png'), path);
    await expect(images.load(path, root, new AbortController().signal)).rejects.toThrow();
  });

  it('rejects SVG and other non-raster file contents, including original requests', async () => {
    const { root, path, images, convert } = await fixture(
      Buffer.from('<svg onload="alert(1)"></svg>')
    );
    await expect(images.load(path, root, new AbortController().signal, true)).rejects.toThrow(
      'Only raster'
    );
    expect(convert).not.toHaveBeenCalled();
  });

  it('aborts before touching files', async () => {
    const { root, path, images, resolvePath } = await fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(images.load(path, root, controller.signal)).rejects.toThrow();
    expect(resolvePath).not.toHaveBeenCalled();
  });
});
