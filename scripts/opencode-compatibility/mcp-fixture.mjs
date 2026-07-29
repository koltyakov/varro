import { createInterface } from 'node:readline';
import { appendFile } from 'node:fs/promises';

const PAGE_MARKER_PATH = '/tmp/varro-mcp-pages';

const lines = createInterface({ input: process.stdin });

for await (const line of lines) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    continue;
  }
  if (request.method === 'notifications/initialized') {
    setTimeout(() => {
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })}\n`
      );
    }, 50);
    continue;
  }
  if (request.id === undefined) continue;

  let result;
  switch (request.method) {
    case 'initialize':
      result = {
        protocolVersion: request.params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'varro-compatibility', version: '1.0.0' },
      };
      break;
    case 'ping':
      result = {};
      break;
    case 'tools/list':
      await appendFile(PAGE_MARKER_PATH, request.params?.cursor ? 'second\n' : 'first\n');
      result = request.params?.cursor
        ? {
            tools: [
              {
                name: 'second_page',
                description: 'Second paginated compatibility tool',
                inputSchema: { type: 'object', properties: {} },
              },
            ],
          }
        : {
            tools: [
              {
                name: 'first_page',
                description: 'First paginated compatibility tool',
                inputSchema: { type: 'object', properties: {} },
              },
            ],
            nextCursor: 'page-2',
          };
      break;
    case 'tools/call':
      result = { content: [{ type: 'text', text: 'fixture response' }] };
      break;
    default:
      process.stdout.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          error: { code: -32601, message: `Method not found: ${request.method}` },
        })}\n`
      );
      continue;
  }

  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
}
