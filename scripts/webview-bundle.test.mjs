import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'vite';

await test('bundles diagram helpers within the VSIX file budget and keeps renderers lazy', async () => {
  const result = await build({ build: { write: false }, logLevel: 'silent' });
  assert.ok(!Array.isArray(result) && 'output' in result);
  const chunks = result.output.filter((output) => output.type === 'chunk');
  // VSCE warns above 100 .js files, including the extension host bundle.
  assert.ok(chunks.filter((chunk) => chunk.fileName.endsWith('.js')).length + 1 <= 100);
  assert.equal(chunks.filter((chunk) => chunk.name === 'diagram-utils').length, 1);
  assert.ok(chunks.some((chunk) => chunk.name.startsWith('flowDiagram-')));
  assert.ok(chunks.some((chunk) => chunk.name.startsWith('sequenceDiagram-')));

  const entry = chunks.find((chunk) => chunk.isEntry);
  assert.ok(entry);
  const initialChunks = new Set();
  function visit(fileName) {
    if (initialChunks.has(fileName)) return;
    initialChunks.add(fileName);
    const chunk = chunks.find((candidate) => candidate.fileName === fileName);
    assert.ok(chunk, `Missing static import ${fileName}`);
    for (const imported of chunk.imports) visit(imported);
  }
  visit(entry.fileName);
  for (const chunk of chunks) {
    if (chunk.name === 'diagram-utils' || chunk.name.startsWith('mermaid.core-')) {
      assert.ok(!initialChunks.has(chunk.fileName), `${chunk.name} must remain lazy`);
    }
  }
});
