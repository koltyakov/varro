import { parse, type ParseError } from 'jsonc-parser';
import { describe, expect, it } from 'vitest';
import { editNativePermissionConfig } from './opencode-permission-config';

const shell = { action: 'shell', resource: '*', effect: 'ask' };
const webfetch = { action: 'webfetch', resource: 'https://example.com/*', effect: 'allow' };

function expectRules(raw: string, rules: unknown[]) {
  const errors: ParseError[] = [];
  const config = parse(raw, errors, { allowTrailingComma: true });
  expect(errors).toEqual([]);
  expect(config).toEqual({ permissions: rules });
}

describe('editNativePermissionConfig', () => {
  it.each([false, true])(
    'preserves compact entries and comments when appending, trailing comma: %s',
    (trailing) => {
      const entry = '    { "action": "shell", "resource": "*", "effect": "ask" }';
      const raw = `{\n  "permissions": [\n    // baseline\n${entry}${trailing ? ',' : ''} // keep attached\n  ]\n}\n`;
      const result = editNativePermissionConfig(raw, [shell, webfetch]);
      expect(result).toBe(
        `{\n  "permissions": [\n    // baseline\n${entry}, // keep attached\n    { "action": "webfetch", "resource": "https://example.com/*", "effect": "allow" }${trailing ? ',' : ''}\n  ]\n}\n`
      );
      expectRules(result, [shell, webfetch]);
    }
  );

  it('edits compact entries in place and leaves unrelated entries byte-for-byte unchanged', () => {
    const raw =
      '{\n  "permissions": [\n    { "action": "shell", "resource": "*", "effect": "ask" }, // baseline\n    {"resource":"https://example.com/*", "effect":"allow", "action":"webfetch"}\n  ]\n}\n';
    const changed = { ...shell, resource: 'git *', effect: 'allow' };
    const result = editNativePermissionConfig(raw, [changed, webfetch]);
    expect(result).toBe(
      raw
        .replace('"resource": "*"', '"resource": "git *"')
        .replace('"effect": "ask"', '"effect": "allow"')
    );
    expectRules(result, [changed, webfetch]);
  });

  it('preserves multiline entries, tabs, CRLF, and comments while appending', () => {
    const raw =
      '{\r\n\t"permissions": [\r\n\t\t{\r\n\t\t\t"action": "shell",\r\n\t\t\t// retain this comment\r\n\t\t\t"resource": "*",\r\n\t\t\t"effect": "ask"\r\n\t\t}\r\n\t]\r\n}\r\n';
    const result = editNativePermissionConfig(raw, [shell, webfetch]);
    expect(result).toContain(raw.slice(0, raw.indexOf('\r\n\t]')).replace(/\}$/, '},'));
    expect(result).toContain('\r\n\t\t{\r\n\t\t\t"action": "webfetch",\r\n');
    expect(result.replaceAll('\r\n', '')).not.toContain('\n');
    expectRules(result, [shell, webfetch]);
  });

  it('removes rules without reformatting the surviving compact entry', () => {
    const raw =
      '{\n  "permissions": [\n    // keep baseline\n    { "action": "shell", "resource": "*", "effect": "ask" },\n    { "action": "webfetch", "resource": "https://example.com/*", "effect": "allow" }\n  ]\n}\n';
    const result = editNativePermissionConfig(raw, [shell]);
    expect(result).toContain(
      '// keep baseline\n    { "action": "shell", "resource": "*", "effect": "ask" }'
    );
    expectRules(result, [shell]);
    expectRules(editNativePermissionConfig(result, []), []);
  });

  it.each([
    '{"permissions":[]}',
    '{"permissions":[/* keep empty-array comment */]}',
    `{"permissions":[${JSON.stringify(shell)}]}`,
    `{"permissions":[${JSON.stringify(shell)},]}`,
  ])('handles inline and empty arrays: %s', (raw) => {
    const existing = parse(raw, [], { allowTrailingComma: true }).permissions;
    const result = editNativePermissionConfig(raw, [...existing, webfetch]);
    expectRules(result, [...existing, webfetch]);
    if (raw.includes('/*')) expect(result).toContain('/* keep empty-array comment */');
  });

  it('does not rewrite unchanged rules or reorder duplicate rules', () => {
    const raw = `{"permissions":[${JSON.stringify(shell)}, ${JSON.stringify(webfetch)}, ${JSON.stringify(shell)}]}`;
    expect(editNativePermissionConfig(raw, [shell, webfetch, shell])).toBe(raw);
    expectRules(editNativePermissionConfig(raw, [webfetch, shell]), [webfetch, shell]);
  });

  it('creates the native array without changing unrelated legacy config', () => {
    const result = editNativePermissionConfig(
      '{\n  // retain legacy\n  "permission": {"bash":"ask"}\n}',
      [shell]
    );
    expect(result).toContain('// retain legacy\n  "permission": {"bash":"ask"}');
    expect(parse(result)).toEqual({ permission: { bash: 'ask' }, permissions: [shell] });
  });
});
