// @ts-check
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { readFile, mkdir, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseSync, Visitor } from 'rolldown/utils';

const CACHE_VERSION = 1;
const CODE_PATTERN = /\.[cm]?[jt]sx?$/;
const RUNTIME_INPUTS = /^(?:node:)?(?:fs(?:\/promises)?|child_process|module)$/;
const GLOBAL_FILES = [
  'package.json',
  'package-lock.json',
  'vitest.setup.ts',
  'scripts/run-tests.mjs',
  'scripts/run-cached-tests.mjs',
  'scripts/test-cache.mjs',
  '.github/workflows/ci.yml',
];

/** @param {string} value */
function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

/** @param {string} root @returns {string[]} */
export function listProjectFiles(root) {
  return execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\0')
    .filter((file) => file && statSync(path.join(root, file), { throwIfNoEntry: false })?.isFile())
    .toSorted();
}

/** @param {unknown} error */
function isMissing(error) {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/** Successful results only. Unknown runtime dependencies invalidate against the whole checkout. */
export class TestCache {
  /** @type {Map<string, Promise<string>>} */
  fileHashes = new Map();
  /** @type {Map<string, Promise<{ dependencies: string[], broad: boolean }>>} */
  modules = new Map();
  /** @type {Record<string, string>} */
  entries = {};

  /** @param {string} root @param {string} filename @param {string[]} files @param {string} context */
  constructor(root, filename, files, context) {
    this.root = root;
    this.filename = filename;
    this.files = files;
    this.fileSet = new Set(files);
    this.context = context;
    this.globalFiles = [
      ...new Set([
        ...GLOBAL_FILES,
        ...files.filter(
          (file) => !file.includes('/') && /(?:\.config\.[cm]?[jt]s|^tsconfig.*\.json)$/.test(file)
        ),
      ]),
    ];
  }

  async load() {
    this.entries = {};
    try {
      const data = JSON.parse(await readFile(this.filename, 'utf8'));
      /* oxlint-disable anti-slop/no-runtime-typeof -- Validate restored JSON at the cache file boundary before trusting successful results. */
      if (
        data &&
        typeof data === 'object' &&
        data.version === CACHE_VERSION &&
        data.context === this.context &&
        data.entries &&
        typeof data.entries === 'object' &&
        !Array.isArray(data.entries)
      ) {
        this.entries = Object.fromEntries(
          Object.entries(data.entries).filter((entry) => typeof entry[1] === 'string')
        );
      }
      /* oxlint-enable anti-slop/no-runtime-typeof */
    } catch (error) {
      if (!isMissing(error) && !(error instanceof SyntaxError)) throw error;
      // Missing or truncated caches are misses, never evidence of a passing test.
    }
  }

  async save() {
    await mkdir(path.dirname(this.filename), { recursive: true });
    const temporary = `${this.filename}.${process.pid}.tmp`;
    await writeFile(
      temporary,
      JSON.stringify({
        version: CACHE_VERSION,
        context: this.context,
        entries: this.entries,
      }) + '\n'
    );
    await rename(temporary, this.filename);
  }

  /** @param {string} file */
  fileHash(file) {
    let pending = this.fileHashes.get(file);
    if (!pending) {
      pending = (async () => {
        try {
          const filename = path.join(this.root, file);
          const [content, metadata] = await Promise.all([readFile(filename), stat(filename)]);
          return createHash('sha256').update(String(metadata.mode)).update(content).digest('hex');
        } catch (error) {
          if (isMissing(error)) return 'missing';
          throw error;
        }
      })();
      this.fileHashes.set(file, pending);
    }
    return pending;
  }

  /** @param {Iterable<string>} files */
  async hashFiles(files) {
    const sorted = [...new Set(files)].toSorted();
    const values = [];
    for (let offset = 0; offset < sorted.length; offset += 32) {
      values.push(
        ...(await Promise.all(
          sorted.slice(offset, offset + 32).map(async (file) => [file, await this.fileHash(file)])
        ))
      );
    }
    return hash(JSON.stringify([this.context, values]));
  }

  /** @param {string} importer @param {string} specifier */
  resolve(importer, specifier) {
    if (specifier === 'vscode') return 'src/test/vscode.ts';
    if (!specifier.startsWith('.')) return null;
    const base = path.posix.normalize(
      path.posix.join(path.posix.dirname(importer), specifier.split('?')[0])
    );
    const candidates = [base];
    if (/\.[cm]?js$/.test(base)) {
      candidates.push(
        base
          .replace(/\.js$/, '.ts')
          .replace(/\.mjs$/, '.mts')
          .replace(/\.cjs$/, '.cts')
      );
      candidates.push(base.replace(/\.js$/, '.tsx'));
    }
    for (const extension of [
      '.ts',
      '.tsx',
      '.mts',
      '.cts',
      '.js',
      '.jsx',
      '.mjs',
      '.cjs',
      '.json',
    ]) {
      candidates.push(`${base}${extension}`, `${base}/index${extension}`);
    }
    return candidates.find((candidate) => this.fileSet.has(candidate)) ?? null;
  }

  /** @param {string} file */
  readModule(file) {
    let pending = this.modules.get(file);
    if (!pending) {
      pending = (async () => {
        /** @type {Set<string>} */
        const dependencies = new Set();
        let broad = false;
        if (!CODE_PATTERN.test(file)) return { dependencies: [], broad };
        let text;
        try {
          text = await readFile(path.join(this.root, file), 'utf8');
        } catch (error) {
          if (isMissing(error)) return { dependencies: [], broad: true };
          throw error;
        }
        const source = parseSync(file, text);
        if (source.errors.length > 0) return { dependencies: [], broad: true };
        /** @param {import('rolldown/utils').ESTree.Node | undefined} expression */
        const addImport = (expression) => {
          /* oxlint-disable anti-slop/no-runtime-typeof -- ESTree literals include numeric, regex, and string values; only strings name dependencies. */
          if (
            !expression ||
            expression.type !== 'Literal' ||
            typeof expression.value !== 'string'
          ) {
            broad = true;
            return;
          }
          /* oxlint-enable anti-slop/no-runtime-typeof */
          const specifier = expression.value;
          if (RUNTIME_INPUTS.test(specifier)) broad = true;
          const resolved = this.resolve(file, specifier);
          if (resolved) dependencies.add(resolved);
          else if (
            specifier.startsWith('.') ||
            specifier.startsWith('/') ||
            specifier.startsWith('file:')
          )
            broad = true;
        };
        const visitor = new Visitor({
          ImportDeclaration: (node) => addImport(node.source),
          ExportNamedDeclaration: (node) => {
            if (node.source) addImport(node.source);
          },
          ExportAllDeclaration: (node) => addImport(node.source),
          ImportExpression: (node) => addImport(node.source),
          TSImportEqualsDeclaration: (node) => {
            if (node.moduleReference.type === 'TSExternalModuleReference')
              addImport(node.moduleReference.expression);
          },
          CallExpression: (node) => {
            const expression = node.callee;
            if (
              expression.type === 'MemberExpression' &&
              expression.property.type === 'Identifier' &&
              (expression.object.type === 'MetaProperty' ||
                (expression.object.type === 'Identifier' &&
                  expression.object.name === 'require')) &&
              ['glob', 'globEager', 'resolve'].includes(expression.property.name)
            )
              broad = true;
            if (
              (expression.type === 'Identifier' && expression.name === 'require') ||
              (expression.type === 'MemberExpression' &&
                expression.property.type === 'Identifier' &&
                ['mock', 'doMock', 'importActual', 'importMock', 'require'].includes(
                  expression.property.name
                ))
            ) {
              addImport(node.arguments[0]);
            }
          },
        });
        visitor.visit(source.program);
        return { dependencies: [...dependencies], broad };
      })();
      this.modules.set(file, pending);
    }
    return pending;
  }

  /** @param {string[]} tests @param {boolean} [vitest] */
  async fingerprint(tests, vitest = false) {
    const dependencies = new Set(this.globalFiles);
    const queue = [...tests];
    if (vitest) queue.push('vitest.setup.ts');
    const visited = new Set();
    let broad = false;
    while (queue.length > 0) {
      const file = queue.pop();
      if (!file || visited.has(file)) continue;
      visited.add(file);
      dependencies.add(file);
      const module = await this.readModule(file);
      broad ||= module.broad;
      queue.push(...module.dependencies);
    }
    // Snapshots and other non-code test assets can be loaded without an import.
    if (vitest) {
      for (const file of this.files) {
        if (file.startsWith('src/') && !CODE_PATTERN.test(file)) dependencies.add(file);
      }
    }
    if (broad) return this.hashFiles([...this.files, ...dependencies]);
    return this.hashFiles(dependencies);
  }
}
