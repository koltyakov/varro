import { describe, expect, it } from 'vitest';
import { parseMcpConfigSnippet } from './mcp-config';

describe('parseMcpConfigSnippet', () => {
  const server = { type: 'remote', url: 'https://example.com/mcp' };
  it.each([
    { docs: server },
    { mcp: { docs: server } },
    { servers: { docs: server } },
    { mcp: { timeout: { startup: 1000 }, servers: { docs: server } }, model: 'keep/me' },
    { mcpServers: { docs: server } },
  ])('detects server nesting in %j', (config) => {
    expect(parseMcpConfigSnippet(JSON.stringify(config))).toEqual({
      servers: { docs: server },
      requiresName: false,
    });
  });

  it('requires a name for a bare server and accepts JSONC', () => {
    const json = '{ // paste from config\n "url": "https://example.com/mcp", }';
    expect(parseMcpConfigSnippet(json)).toEqual({ servers: {}, requiresName: true });
    expect(parseMcpConfigSnippet(json, ' docs ')).toEqual({
      servers: { docs: server },
      requiresName: true,
    });
  });

  it('normalizes command/args/env snippets without changing secret references', () => {
    expect(
      parseMcpConfigSnippet(
        JSON.stringify({
          mcpServers: {
            browser: {
              command: 'npx',
              args: ['-y', 'browser-mcp'],
              env: { TOKEN: '{env:MCP_TOKEN}' },
            },
          },
        })
      ).servers
    ).toEqual({
      browser: {
        type: 'local',
        command: ['npx', '-y', 'browser-mcp'],
        environment: { TOKEN: '{env:MCP_TOKEN}' },
      },
    });
  });

  it.each([
    '',
    '[]',
    'null',
    '{}',
    '{"mcp":null}',
    '{"mcp":{"servers":[]}}',
    '{"docs":true}',
    '{"docs":{"url":"file:///secret"}}',
    '{"docs":{"type":"local","command":[]}}',
    '{"docs":{"command":["node",5]}}',
    '{"docs":{"command":"node","args":"bad"}}',
    '{"docs":{"command":["node"],"args":[]}}',
    '{"docs":{"url":"https://example.com","enabled":"yes"}}',
    '{"docs":{"url":"https://example.com","enabled":true,"disabled":false}}',
    '{"docs":{"url":"https://example.com","headers":{"Key":42}}}',
    '{"__proto__":{"url":"https://example.com"}}',
    '{" docs ":{"url":"https://example.com"}}',
  ])('rejects invalid or unsafe snippets: %s', (json) => {
    expect(() => parseMcpConfigSnippet(json)).toThrow();
  });

  it('bounds pasted JSON size', () => {
    expect(() => parseMcpConfigSnippet(' '.repeat(100_001))).toThrow('100 KB');
  });
});
