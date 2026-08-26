import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { API } from 'typescript/unstable/sync';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configPath = path.join(projectRoot, 'tsconfig.json');

function normalizePath(value) {
  return value.replaceAll('\\', '/');
}

function writeLine(stream, value) {
  stream.write(`${value}\n`);
}

function formatDiagnostic(project, diagnostic) {
  const fileName = diagnostic.fileName;
  if (!fileName) return `TS${String(diagnostic.code)} ${diagnostic.text}`;
  const source = project.program.getSourceFile(fileName);
  const location = source?.getLineAndCharacterOfPosition(diagnostic.pos);
  const relativePath = normalizePath(path.relative(projectRoot, fileName));
  return `${relativePath}:${String((location?.line ?? 0) + 1)}:${String((location?.character ?? 0) + 1)} TS${String(diagnostic.code)} ${diagnostic.text}`;
}

export function checkTypeScriptSuggestions() {
  const api = new API({ cwd: projectRoot });
  let snapshot;
  try {
    snapshot = api.updateSnapshot({ openProjects: [configPath] });
    const project =
      snapshot.getProject(configPath) ??
      snapshot
        .getProjects()
        .find((candidate) => path.resolve(candidate.configFileName) === configPath);
    if (!project) throw new Error(`TypeScript project was not loaded from ${configPath}`);

    const diagnostics = project.program
      .getSuggestionDiagnostics()
      .filter(
        (diagnostic) =>
          !diagnostic.fileName ||
          (!diagnostic.fileName.includes(`${path.sep}node_modules${path.sep}`) &&
            path.relative(projectRoot, diagnostic.fileName).split(path.sep)[0] !== '..')
      )
      .map((diagnostic) => formatDiagnostic(project, diagnostic))
      .toSorted();

    for (const diagnostic of diagnostics) writeLine(process.stderr, diagnostic);
    if (diagnostics.length > 0) {
      writeLine(process.stderr, `TypeScript suggestion diagnostics: ${String(diagnostics.length)}`);
      return false;
    }

    writeLine(process.stdout, 'TypeScript suggestion diagnostics: 0');
    return true;
  } finally {
    snapshot?.dispose();
    api.close();
  }
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    if (!checkTypeScriptSuggestions()) process.exitCode = 1;
  } catch (error) {
    writeLine(process.stderr, error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
