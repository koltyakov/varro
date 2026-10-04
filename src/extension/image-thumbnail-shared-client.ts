import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { request } from 'node:http';
import type { OutgoingHttpHeaders } from 'node:http';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { asRecord, isString } from '../shared/type-utils';
import { THUMBNAIL_MAX_INPUT_BYTES, THUMBNAIL_MAX_OUTPUT_BYTES } from './image-thumbnail-protocol';
import type { ThumbnailFormat, ThumbnailInput } from './image-thumbnail-protocol';
import {
  thumbnailProof,
  thumbnailSecret,
  validThumbnailProof,
} from './image-thumbnail-service-auth';
import { getVarroStateDirectory } from './varro-state-paths';

type Endpoint = { port: number; secret: string };

/** All extension hosts for this build/account share one bounded codec process. */
export class SharedThumbnailClient {
  private endpoint: Promise<Endpoint> | undefined;
  private bytes = 0;
  private jobs = 0;
  private readonly controller = new AbortController();
  processID: number | undefined;

  constructor(
    private readonly options: {
      servicePath?: string;
      stateDirectory?: string;
      idleMs?: number;
    } = {}
  ) {}

  async convert(
    input: ThumbnailInput,
    format: ThumbnailFormat,
    signal: AbortSignal
  ): Promise<string | null> {
    const combined = AbortSignal.any([signal, this.controller.signal]);
    combined.throwIfAborted();
    const size = isString(input)
      ? Math.ceil((input.length * 3) / 4)
      : 'base64' in input
        ? Math.ceil((input.base64.byteLength * 3) / 4)
        : input.byteLength;
    if (!size || size > THUMBNAIL_MAX_INPUT_BYTES) return null;
    if (this.jobs >= 9 || this.bytes + size > 64 * 1024 * 1024)
      throw new Error('Thumbnail queue is full; retry when previews finish');
    this.jobs++;
    this.bytes += size;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        combined.throwIfAborted();
        // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Promise rejection values are an untyped runtime boundary.
        const endpoint = await (this.endpoint ??= this.connect().catch((error: unknown) => {
          this.endpoint = undefined;
          throw error;
        }));
        combined.throwIfAborted();
        try {
          const base64 = isString(input)
            ? input
            : 'base64' in input
              ? input.base64
              : Buffer.from(input.buffer, input.byteOffset, input.byteLength).toString('base64');
          const body = await this.exchange(endpoint, base64, format, combined);
          const value = asRecord(JSON.parse(body));
          if (value?.url === null) return null;
          if (
            !isString(value?.url) ||
            !value.url.startsWith('data:image/webp;base64,') ||
            value.url.length > (THUMBNAIL_MAX_OUTPUT_BYTES * 4) / 3 + 64
          )
            throw new Error('Invalid shared thumbnail response');
          return value.url;
        } catch (error) {
          if (
            attempt ||
            !['ECONNREFUSED', 'ECONNRESET', 'EPIPE'].includes(String(asRecord(error)?.code))
          )
            throw error;
          this.endpoint = undefined;
        }
      }
      throw new Error('Thumbnail service unavailable');
    } finally {
      this.jobs--;
      this.bytes -= size;
    }
  }

  dispose() {
    this.controller.abort(new Error('Thumbnail client disposed'));
  }

  private async connect(): Promise<Endpoint> {
    const servicePath = this.options.servicePath ?? join(__dirname, 'thumbnail-service.js');
    const directory = this.options.stateDirectory ?? getVarroStateDirectory('thumbnails');
    const credential = await thumbnailSecret(directory);
    const identity = createHash('sha256')
      .update(directory)
      .update(servicePath)
      .update(await readFile(servicePath))
      .update(await readFile(join(dirname(servicePath), 'thumbnail-worker.js')))
      .digest();
    const secret = thumbnailProof(credential, identity.toString('hex'));
    // Binding arbitrates simultaneous starts without PID locks, stale leases or socket unlink races.
    // A few deterministic candidates tolerate unrelated loopback listeners without stopping them.
    for (let slot = 0; slot < 4; slot++) {
      const port = 40000 + (identity.readUInt32LE(slot * 4) % 20000);
      const endpoint = { port, secret };
      try {
        await this.exchange(endpoint, undefined, undefined, this.controller.signal);
        return endpoint;
      } catch (error) {
        if (asRecord(error)?.code !== 'ECONNREFUSED') continue;
      }
      const child = spawn(
        process.execPath,
        [
          servicePath,
          String(port),
          directory,
          String(this.options.idleMs ?? 60_000),
          identity.toString('hex'),
        ],
        {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        }
      );
      let launchError: Error | undefined;
      child.on('error', (error) => {
        launchError = error;
      });
      child.unref();
      for (let attempt = 0; attempt < 200; attempt++) {
        if (launchError) throw launchError;
        await sleep(25, undefined, { signal: this.controller.signal });
        try {
          await this.exchange(endpoint, undefined, undefined, this.controller.signal);
          return endpoint;
        } catch (error) {
          if (asRecord(error)?.code !== 'ECONNREFUSED') break;
        }
      }
    }
    throw new Error('Could not start or authenticate the shared thumbnail service');
  }

  private exchange(
    endpoint: Endpoint,
    base64: string | Uint8Array<ArrayBuffer> | undefined,
    format: ThumbnailFormat | undefined,
    signal: AbortSignal
  ): Promise<string> {
    const nonce = randomBytes(24).toString('hex');
    const size = base64?.length ?? 0;
    const value = `${nonce}:${size}:${format ?? ''}`;
    return new Promise((resolve, reject) => {
      const headers: OutgoingHttpHeaders = {
        'x-nonce': nonce,
        'x-format': format ?? '',
        'content-length': size,
        authorization: thumbnailProof(endpoint.secret, `client:${value}`),
      };
      if (base64 !== undefined) headers.expect = '100-continue';
      const req = request({
        host: '127.0.0.1',
        port: endpoint.port,
        method: base64 === undefined ? 'GET' : 'POST',
        path: '/',
        agent: false,
        signal,
        headers,
      });
      const timer = setTimeout(
        () => req.destroy(new Error('Thumbnail service request timed out')),
        base64 === undefined ? 1000 : 30_000
      );
      req.on('error', reject);
      req.on('close', () => clearTimeout(timer));
      req.on('information', (info) => {
        if (info.statusCode !== 100 || base64 === undefined) return;
        if (!validThumbnailProof(endpoint.secret, `server:${value}`, info.headers['x-proof'])) {
          req.destroy(new Error('Invalid thumbnail service identity'));
          return;
        }
        // Admission and peer authentication precede image transfer. Backpressure bounds copies.
        function* chunks() {
          for (let offset = 0; offset < base64!.length; offset += 65536)
            yield isString(base64)
              ? base64.slice(offset, offset + 65536)
              : base64!.subarray(offset, offset + 65536);
        }
        void pipeline(Readable.from(chunks()), req).catch(reject);
      });
      req.on('response', (response) => {
        if (!validThumbnailProof(endpoint.secret, `server:${value}`, response.headers['x-proof'])) {
          response.destroy();
          reject(new Error('Invalid thumbnail service identity'));
          return;
        }
        this.processID = Number(response.headers['x-thumbnail-process']);
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          body += chunk;
          if (body.length > (THUMBNAIL_MAX_OUTPUT_BYTES * 4) / 3 + 256)
            response.destroy(new Error('Thumbnail response too large'));
        });
        response.on('error', reject);
        response.on('end', () =>
          response.statusCode === 200
            ? resolve(body)
            : reject(
                new Error(`Thumbnail service rejected request (${response.statusCode}): ${body}`)
              )
        );
      });
      if (base64 === undefined) req.end();
      else req.flushHeaders();
    });
  }
}
