import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { RequestListener } from 'node:http';
import { isString } from '../shared/type-utils';
import { ImageThumbnails } from './image-thumbnails';
import { ThumbnailWorkerClient } from './image-thumbnail-worker-client';
import { THUMBNAIL_MAX_INPUT_BYTES } from './image-thumbnail-protocol';
import type { ThumbnailFormat } from './image-thumbnail-protocol';
import {
  thumbnailProof,
  thumbnailSecret,
  validThumbnailProof,
} from './image-thumbnail-service-auth';

async function start() {
  const port = Number(process.argv[2]);
  const directory = process.argv[3];
  const idleMs = Number(process.argv[4]);
  const identity = process.argv[5];
  if (
    !directory ||
    !identity ||
    !/^[a-f0-9]{64}$/.test(identity) ||
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65535 ||
    !Number.isFinite(idleMs) ||
    idleMs < 100
  )
    throw new Error('Invalid thumbnail service configuration');
  const secret = thumbnailProof(await thumbnailSecret(directory), identity);
  const worker = new ThumbnailWorkerClient();
  const thumbnails = new ImageThumbnails(worker);
  let admittedBytes = 0;
  let admittedJobs = 0;
  let idle: NodeJS.Timeout;
  const server = createServer();
  const armIdle = () => {
    clearTimeout(idle);
    if (!admittedJobs)
      idle = setTimeout(() => {
        thumbnails.dispose();
        worker.dispose();
        server.closeAllConnections();
        server.close();
      }, idleMs);
  };
  const handle: RequestListener = (request, response) => {
    const nonce = request.headers['x-nonce'];
    const format = request.headers['x-format'] ?? '';
    const size = Number(request.headers['content-length']);
    const value = `${nonce}:${size}:${format}`;
    if (
      !isString(nonce) ||
      !/^[a-f0-9]{48}$/.test(nonce) ||
      !validThumbnailProof(secret, `client:${value}`, request.headers.authorization)
    ) {
      response.writeHead(403, { connection: 'close' }).end();
      return;
    }
    const headers = {
      'x-proof': thumbnailProof(secret, `server:${value}`),
      'x-thumbnail-process': String(process.pid),
    };
    response.setHeader('x-proof', headers['x-proof']);
    response.setHeader('x-thumbnail-process', headers['x-thumbnail-process']);
    if (request.method === 'GET' && size === 0) {
      response.end('{}');
      return;
    }
    if (
      request.method !== 'POST' ||
      request.headers.expect !== '100-continue' ||
      !isString(format) ||
      !/^(png|jpeg|webp|gif|avif)$/.test(format) ||
      !Number.isSafeInteger(size) ||
      size < 1 ||
      size > (THUMBNAIL_MAX_INPUT_BYTES * 4) / 3
    ) {
      response.writeHead(400, { connection: 'close' }).end('Invalid thumbnail input');
      return;
    }
    if (admittedJobs >= 9 || admittedBytes + size > (64 * 1024 * 1024 * 4) / 3) {
      response.writeHead(429, { connection: 'close' }).end('Thumbnail queue is full');
      return;
    }
    clearTimeout(idle);
    admittedJobs++;
    admittedBytes += size;
    const controller = new AbortController();
    let input: Uint8Array<ArrayBuffer> | undefined = new Uint8Array(size);
    const hash = createHash('sha256').update(format);
    let received = 0;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      admittedJobs--;
      admittedBytes -= size;
      input = undefined;
      armIdle();
    };
    response.on('close', () => {
      controller.abort();
      release();
    });
    request.on('error', () => {
      controller.abort();
      response.destroy();
    });
    request.setTimeout(10_000, () => request.destroy(new Error('Thumbnail upload timed out')));
    request.on('data', (chunk: Buffer) => {
      if (!input || received + chunk.length > size) {
        request.destroy(new Error('Thumbnail input too large'));
        return;
      }
      input.set(chunk, received);
      hash.update(chunk);
      received += chunk.length;
    });
    request.on('end', () => {
      request.setTimeout(0);
      if (!input || received !== size) {
        response.destroy();
        return;
      }
      const key = hash.digest('hex');
      // SAFETY: The format allowlist above accepts exactly the supported ThumbnailFormat values.
      const inputFormat = format as ThumbnailFormat;
      void thumbnails
        .getInput(key, { base64: input }, inputFormat, controller.signal)
        .then((url) => {
          if (!response.destroyed) response.end(JSON.stringify({ url }));
        })
        // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Promise rejections may carry any runtime value.
        .catch((error: unknown) => {
          if (!response.destroyed)
            response.writeHead(503).end(error instanceof Error ? error.message : String(error));
        })
        .finally(release);
      input = undefined;
    });
    // Node's writeContinue() cannot carry headers. Authenticate this same connection before
    // the client sends any image bytes, using a standard interim response with our proof.
    response.socket?.write(`HTTP/1.1 100 Continue\r\nx-proof: ${headers['x-proof']}\r\n\r\n`);
  };
  server.on('request', handle);
  server.on('checkContinue', handle);
  server.maxConnections = 32;
  server.headersTimeout = 5000;
  server.requestTimeout = 30_000;
  server.on('error', (error: NodeJS.ErrnoException) => {
    // The winner of simultaneous starts owns the listener; losing candidates never load WASM.
    if (error.code !== 'EADDRINUSE') process.stderr.write(`${error.message}\n`);
    thumbnails.dispose();
    worker.dispose();
    clearTimeout(idle);
    process.exitCode = error.code === 'EADDRINUSE' ? 0 : 1;
  });
  server.listen(port, '127.0.0.1', armIdle);
}

export { SharedThumbnailClient } from './image-thumbnail-shared-client';

if (require.main === module) {
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Startup errors originate at filesystem and socket boundaries.
  void start().catch((error: unknown) => {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  });
}
