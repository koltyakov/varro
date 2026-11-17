import { createCdpRequestClient } from './vscode-launch-process.mjs';

export const PAINT_TRACE_CATEGORIES = [
  'benchmark',
  'cc',
  'gpu',
  'input',
  'latencyInfo',
  'viz',
  'devtools.timeline',
  'disabled-by-default-devtools.timeline',
  'disabled-by-default-devtools.timeline.invalidationTracking',
];

export async function startPaintTrace(port) {
  const version = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json());
  const socket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  const client = createCdpRequestClient(socket, 20_000);
  let resolveComplete;
  const completion = new Promise((resolve) => {
    resolveComplete = resolve;
  });
  const onMessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.method === 'Tracing.tracingComplete') resolveComplete(message.params);
  };
  socket.addEventListener('message', onMessage);
  try {
    await client.call('Tracing.start', {
      transferMode: 'ReturnAsStream',
      traceConfig: {
        recordMode: 'recordAsMuchAsPossible',
        traceBufferSizeInKb: 512 * 1024,
        includedCategories: PAINT_TRACE_CATEGORIES,
        enableSampling: false,
      },
    });
  } catch (error) {
    client.dispose();
    socket.close();
    throw error;
  }
  return {
    async stop() {
      let timer;
      try {
        await client.call('Tracing.end');
        const complete = await Promise.race([
          completion,
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('Compositor trace completion timed out')),
              20_000
            );
          }),
        ]);
        if (!complete?.stream) throw new Error('Compositor trace stream unavailable');
        const chunks = [];
        try {
          for (;;) {
            const part = await client.call('IO.read', {
              handle: complete.stream,
              size: 1024 * 1024,
            });
            chunks.push(Buffer.from(part.data, part.base64Encoded ? 'base64' : 'utf8'));
            if (part.eof) break;
          }
        } finally {
          await client.call('IO.close', { handle: complete.stream });
        }
        return { data: Buffer.concat(chunks), dataLoss: complete.dataLossOccurred ?? false };
      } finally {
        clearTimeout(timer);
        socket.removeEventListener('message', onMessage);
        client.dispose();
        socket.close();
      }
    },
  };
}
