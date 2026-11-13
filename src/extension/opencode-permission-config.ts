import {
  applyEdits,
  createScanner,
  findNodeAtLocation,
  getNodeValue,
  modify,
  parseTree,
} from 'jsonc-parser';
import { isDeepStrictEqual } from 'node:util';
import { asRecord } from '../shared/type-utils';

/** Edit native rules without reserializing existing entries or their comments. */
export function editNativePermissionConfig(raw: string, rules: unknown[]): string {
  const root = parseTree(raw)!;
  const array = findNodeAtLocation(root, ['permissions']);
  if (array?.type !== 'array') {
    const eol = /\r\n|\n|\r/.exec(raw)?.[0] ?? '\n';
    const edits = modify(raw, ['permissions'], [], {});
    if (!array) {
      for (const edit of edits) {
        edit.content = edit.content.replace('"permissions": []', `${eol}  "permissions": []`);
        if (!root.children?.length) edit.content += eol;
      }
    }
    return editNativePermissionConfig(applyEdits(raw, edits), rules);
  }

  const children = array.children ?? [];
  const sample = children[0];
  const eol = /\r\n|\n|\r/.exec(raw)?.[0] ?? '\n';
  const linePrefix = (offset: number) => raw.slice(raw.lastIndexOf('\n', offset - 1) + 1, offset);
  const arrayIndent = /^\s*/.exec(linePrefix(array.offset))![0];
  const samplePrefix = sample ? linePrefix(sample.offset) : '';
  const indentUnit =
    samplePrefix.startsWith(arrayIndent) && /^[\t ]+$/.test(samplePrefix.slice(arrayIndent.length))
      ? samplePrefix.slice(arrayIndent.length)
      : arrayIndent.includes('\t')
        ? '\t'
        : '  ';
  const entryIndent =
    sample && /^[\t ]*$/.test(samplePrefix) ? samplePrefix : arrayIndent + indentUnit;
  const compact = sample
    ? !/[\r\n]/.test(raw.slice(sample.offset, sample.offset + sample.length))
    : false;
  const multiline = !sample || /[\r\n]/.test(raw.slice(array.offset, array.offset + array.length));
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Values come from parsed JSONC or validated rules; retain existing config values without imposing a new schema.
  const render = (value: unknown) => {
    const record = asRecord(value);
    if (compact && record) {
      return `{ ${Object.entries(record)
        .map(([key, item]) => `${JSON.stringify(key)}: ${JSON.stringify(item)}`)
        .join(', ')} }`;
    }
    return JSON.stringify(value, null, indentUnit).replace(/\n/g, eol + entryIndent);
  };

  for (let index = Math.min(children.length, rules.length) - 1; index >= 0; index--) {
    const node = children[index]!;
    const previous: unknown = getNodeValue(node);
    const next = rules[index];
    if (isDeepStrictEqual(previous, next)) continue;
    const previousRecord = asRecord(previous);
    const nextRecord = asRecord(next);
    if (previousRecord && nextRecord) {
      for (const key of new Set([...Object.keys(previousRecord), ...Object.keys(nextRecord)])) {
        if (isDeepStrictEqual(previousRecord[key], nextRecord[key])) continue;
        raw = applyEdits(raw, modify(raw, ['permissions', index, key], nextRecord[key], {}));
      }
    } else {
      raw = raw.slice(0, node.offset) + render(next) + raw.slice(node.offset + node.length);
    }
  }
  for (let index = children.length - 1; index >= rules.length; index--) {
    const current = findNodeAtLocation(parseTree(raw)!, ['permissions'])!;
    const node = current.children![index]!;
    const previous = current.children![index - 1];
    const scanner = createScanner(raw, true);
    scanner.setPosition(previous ? previous.offset + previous.length : node.offset + node.length);
    const edits = [{ offset: node.offset, length: node.length, content: '' }];
    scanner.scan();
    if (raw[scanner.getTokenOffset()] === ',') {
      edits.push({ offset: scanner.getTokenOffset(), length: 1, content: '' });
    }
    raw = applyEdits(raw, edits);
  }
  if (rules.length <= children.length) return raw;

  const updated = findNodeAtLocation(parseTree(raw)!, ['permissions'])!;
  const last = updated.children?.at(-1);
  const scanner = createScanner(raw, true);
  scanner.setPosition(last ? last.offset + last.length : updated.offset + 1);
  scanner.scan();
  const trailingComma = raw[scanner.getTokenOffset()] === ',';
  const close = updated.offset + updated.length - 1;
  const closePrefix = linePrefix(close);
  const closeOnOwnLine = /^[\t ]*$/.test(closePrefix);
  const insertion = multiline && closeOnOwnLine ? close - closePrefix.length : close;
  const separator = multiline ? `,${eol}${entryIndent}` : ', ';
  const added = rules.slice(children.length).map(render).join(separator);
  let text = multiline
    ? `${closeOnOwnLine ? '' : eol}${entryIndent}${added}${trailingComma ? ',' : ''}${eol}${closeOnOwnLine ? '' : arrayIndent}`
    : `${last ? ' ' : ''}${added}${trailingComma ? ',' : ''}`;
  if (last && !trailingComma && insertion === last.offset + last.length) text = ',' + text;
  const edits = [{ offset: insertion, length: 0, content: text }];
  if (last && !trailingComma && insertion !== last.offset + last.length)
    edits.push({ offset: last.offset + last.length, length: 0, content: ',' });
  return applyEdits(raw, edits);
}
