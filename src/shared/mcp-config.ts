import { parse, printParseErrorCode } from 'jsonc-parser';
import type { ParseError } from 'jsonc-parser';
import { asRecord, isBoolean, isString } from './type-utils';
import type { UnknownRecord } from './type-utils';

export type McpConfigScope = 'global' | 'project';

export interface McpConfigSnippet {
  servers: Record<string, UnknownRecord>;
  requiresName: boolean;
}

function serverConfig(config: UnknownRecord): UnknownRecord {
  const server = { ...config };
  if (isString(server.command)) {
    if (server.args !== undefined && (!Array.isArray(server.args) || !server.args.every(isString)))
      throw new Error('MCP command args must be an array of strings.');
    server.command = [server.command, ...(Array.isArray(server.args) ? server.args : [])];
    delete server.args;
  } else if (server.args !== undefined) {
    throw new Error(
      'Put command arguments in the command array, or use a command string with args.'
    );
  }
  if (server.env !== undefined) {
    if (server.environment !== undefined)
      throw new Error('Use either env or environment, not both.');
    server.environment = server.env;
    delete server.env;
  }
  server.type ??=
    server.command !== undefined ? 'local' : server.url !== undefined ? 'remote' : undefined;
  if (server.type === 'local') {
    if (
      !Array.isArray(server.command) ||
      !server.command.length ||
      !server.command.every(isString) ||
      !server.command[0]?.trim()
    )
      throw new Error('A local MCP server needs a non-empty command array.');
  } else if (server.type === 'remote') {
    if (!isString(server.url)) throw new Error('A remote MCP server needs a URL.');
    let url: URL;
    try {
      url = new URL(server.url);
    } catch {
      throw new Error('The MCP server URL must be an absolute HTTP or HTTPS URL.');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
      throw new Error('The MCP server URL must use HTTP or HTTPS.');
  } else {
    throw new Error('An MCP server needs type local with a command, or type remote with a URL.');
  }
  for (const key of ['headers', 'environment']) {
    if (server[key] === undefined) continue;
    const values = asRecord(server[key]);
    if (!values || !Object.values(values).every(isString))
      throw new Error(`MCP ${key} must be an object of strings.`);
  }
  for (const key of ['enabled', 'disabled']) {
    if (server[key] !== undefined && !isBoolean(server[key]))
      throw new Error(`MCP ${key} must be a boolean.`);
  }
  if (server.enabled !== undefined && server.disabled !== undefined)
    throw new Error('Use either enabled or disabled, not both.');
  return server;
}

function serverName(name: string) {
  if (
    !name.trim() ||
    name !== name.trim() ||
    name.length > 512 ||
    ['__proto__', 'constructor', 'prototype'].includes(name)
  )
    throw new Error(
      'Use a non-empty MCP server name without surrounding spaces or reserved object keys.'
    );
  return name;
}

export function parseMcpConfigSnippet(json: string, name = ''): McpConfigSnippet {
  if (json.length > 100_000) throw new Error('MCP JSON must be smaller than 100 KB.');
  const errors: ParseError[] = [];
  const parsed: unknown = parse(json, errors, { allowTrailingComma: true });
  if (errors.length) throw new Error(`Invalid MCP JSON: ${printParseErrorCode(errors[0]!.error)}.`);
  let config = asRecord(parsed);
  if (!config) throw new Error('Paste an MCP server object or a named map of servers.');
  if (Object.hasOwn(config, 'mcp')) {
    config = asRecord(config.mcp);
    if (!config) throw new Error('mcp must be an object.');
    if (Object.hasOwn(config, 'servers')) config = asRecord(config.servers);
  } else if (Object.hasOwn(config, 'mcpServers')) config = asRecord(config.mcpServers);
  else if (Object.hasOwn(config, 'servers')) config = asRecord(config.servers);
  if (!config) throw new Error('The MCP servers section must be an object.');
  const requiresName =
    isString(config.type) ||
    isString(config.url) ||
    isString(config.command) ||
    Array.isArray(config.command);
  if (requiresName) {
    const server = serverConfig(config);
    return {
      servers: name.trim() ? { [serverName(name.trim())]: server } : {},
      requiresName: true,
    };
  }
  const entries = Object.entries(config);
  if (!entries.length) throw new Error('The JSON contains no MCP servers.');
  return {
    servers: Object.fromEntries(
      entries.map(([key, value]) => {
        const server = asRecord(value);
        if (!server) throw new Error('Each MCP server must be a JSON object.');
        return [serverName(key), serverConfig(server)];
      })
    ),
    requiresName: false,
  };
}
