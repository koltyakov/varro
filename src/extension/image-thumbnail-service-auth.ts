import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { asRecord, isString } from '../shared/type-utils';

/** Credentials only. No image or thumbnail is written to disk. */
export async function thumbnailSecret(directory: string): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (
    !info.isDirectory() ||
    (process.getuid && (info.uid !== process.getuid() || (info.mode & 0o077) !== 0))
  ) {
    throw new Error('Thumbnail state directory is not private');
  }
  const path = join(directory, 'secret');
  try {
    const file = await open(path, 'wx', 0o600);
    try {
      await file.writeFile(randomBytes(32).toString('hex'));
    } finally {
      await file.close();
    }
  } catch (error) {
    if (asRecord(error)?.code !== 'EEXIST') throw error;
  }
  // Another window may have exclusively created the credential but not finished its write yet.
  for (let attempt = 0; attempt < 20; attempt++) {
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = await file.stat();
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.size > 64 ||
        (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0))
      ) {
        throw new Error('Thumbnail credential is not private');
      }
      const bytes = Buffer.alloc(65);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      const secret = bytes.toString('ascii', 0, bytesRead);
      if (/^[a-f0-9]{64}$/.test(secret)) return secret;
    } finally {
      await file.close();
    }
    await sleep(25);
  }
  throw new Error('Thumbnail credential is incomplete');
}

export function thumbnailProof(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value).digest('hex');
}

export function validThumbnailProof(
  secret: string,
  value: string,
  proof: string | string[] | undefined
): boolean {
  return (
    isString(proof) &&
    /^[a-f0-9]{64}$/.test(proof) &&
    timingSafeEqual(Buffer.from(proof, 'hex'), Buffer.from(thumbnailProof(secret, value), 'hex'))
  );
}
