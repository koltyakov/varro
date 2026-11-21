import { open, unlink } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { createCdpRequestClient } from './vscode-launch-process.mjs';

export const PAINT_TRACE_CATEGORIES = [
  'toplevel',
  'benchmark',
  'cc',
  'gpu',
  'input',
  'latencyInfo',
  'viz',
  'devtools.timeline',
];

export async function startPaintTrace(
  port,
  {
    categories = PAINT_TRACE_CATEGORIES,
    completionTimeoutMs = 60_000,
    exportTimeoutMs = 120_000,
    maxBytes = 512 * 1024 * 1024,
    outputPath,
  } = {}
) {
  for (const value of [completionTimeoutMs, exportTimeoutMs, maxBytes]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Invalid trace budget');
  }
  if (!categories.length || categories.some((value) => !value))
    throw new Error('Trace categories must be nonempty strings');
  const version = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json());
  const socket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  const client = createCdpRequestClient(socket, 20_000);
  let resolveComplete;
  let rejectComplete;
  const completion = new Promise((resolve) => {
    resolveComplete = resolve;
  });
  // A socket can close while Chromium is flushing, with no CDP request pending.
  const disconnected = new Promise((_, reject) => {
    rejectComplete = reject;
  });
  void disconnected.catch(() => {});
  const onClose = () => rejectComplete(new Error('Compositor trace socket closed'));
  const onError = () => rejectComplete(new Error('Compositor trace socket failed'));
  let maxBufferUsage = 0;
  let bufferSamples = 0;
  const onMessage = (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.method === 'Tracing.tracingComplete') resolveComplete(message.params);
    if (message.method === 'Tracing.bufferUsage') {
      maxBufferUsage = Math.max(
        maxBufferUsage,
        message.params.percentFull ?? message.params.value ?? 0
      );
      bufferSamples++;
    }
  };
  socket.addEventListener('message', onMessage);
  socket.addEventListener('close', onClose);
  socket.addEventListener('error', onError);
  const dispose = () => {
    socket.removeEventListener('message', onMessage);
    socket.removeEventListener('close', onClose);
    socket.removeEventListener('error', onError);
    client.dispose();
    socket.close();
  };
  try {
    await client.call('Tracing.start', {
      transferMode: 'ReturnAsStream',
      bufferUsageReportingInterval: 1000,
      traceConfig: {
        recordMode: 'recordAsMuchAsPossible',
        traceBufferSizeInKb: 512 * 1024,
        includedCategories: categories,
        enableSampling: false,
      },
    });
  } catch (error) {
    dispose();
    throw error;
  }
  let stopped;
  async function stop() {
    let timer, exportTimer, file;
    let fileCreated = false;
    let exported = false;
    const endStarted = performance.now();
    try {
      await client.call('Tracing.end');
      const complete = await Promise.race([
        completion,
        disconnected,
        new Promise((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(`Compositor trace completion timed out after ${completionTimeoutMs}ms`)
              ),
            completionTimeoutMs
          );
        }),
      ]);
      clearTimeout(timer);
      const completionMs = performance.now() - endStarted;
      if (!complete?.stream) throw new Error('Compositor trace stream unavailable');
      const chunks = [];
      let bytes = 0;
      const exportStarted = performance.now();
      const exportDeadline = new Promise((_, reject) => {
        exportTimer = setTimeout(() => {
          reject(new Error(`Compositor trace export timed out after ${exportTimeoutMs}ms`));
        }, exportTimeoutMs);
      });
      void exportDeadline.catch(() => {});
      try {
        if (outputPath) {
          file = await open(outputPath, 'wx', 0o600);
          fileCreated = true;
        }
        for (;;) {
          const part = await Promise.race([
            client.call('IO.read', {
              handle: complete.stream,
              size: 1024 * 1024,
            }),
            disconnected,
            exportDeadline,
          ]);
          const chunk = Buffer.from(part.data, part.base64Encoded ? 'base64' : 'utf8');
          bytes += chunk.length;
          if (bytes > maxBytes)
            throw new Error(`Compositor trace exceeds ${maxBytes} byte export cap`);
          if (file) await file.writeFile(chunk);
          else chunks.push(chunk);
          if (part.eof) break;
          if (!chunk.length) throw new Error('Compositor trace export made no progress');
        }
      } finally {
        clearTimeout(exportTimer);
        await file?.close();
        await client.call('IO.close', { handle: complete.stream });
      }
      exported = true;
      return {
        ...(outputPath ? { path: outputPath } : { data: Buffer.concat(chunks, bytes) }),
        bytes,
        dataLoss: complete.dataLossOccurred ?? false,
        completionMs,
        exportMs: performance.now() - exportStarted,
        maxBufferUsage,
        bufferSamples,
      };
    } finally {
      clearTimeout(timer);
      clearTimeout(exportTimer);
      dispose();
      if (fileCreated && !exported) await unlink(outputPath);
    }
  }
  return {
    // Never resend Tracing.end after a timeout or a partially completed export.
    stop() {
      return (stopped ??= stop());
    },
  };
}
