// Emit with checker threads (parallel-check.ts `checkersEmit`) writes what one checker writes: each
// checker emits the files it checks, the main thread the files no checker checks (JSON, unchecked
// JavaScript), and the program reports the files in program order with the same diagnostics. Runs the
// tsc-ts under test (the Node build, or TSC_TS_BIN) with --singleThreaded and with checker threads in
// one directory, and compares stdout (with --listEmittedFiles), the exit status and every output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './temp.mjs';
import { tscTs, tscTsMissing } from './toolchain.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const bundledLibs = join(resolve(here, '../../..'), 'upstream/typescript-go/internal/bundled/libs');
const tsgo = join(resolve(here, '../../..'), 'packages/tsgo/dist/tsgo');
const tsgoMissing = !existsSync(tsgo) && 'needs packages/tsgo/dist/tsgo';

const files = {
  'src/shapes.ts':
    'export interface Shape { kind: string; size: number }\n' +
    'export const shapes = [{ kind: "a", size: 1 }, { kind: "b", size: 2, extra: true }];\n',
  'src/area.ts':
    'import { Shape, shapes } from "./shapes";\nexport function area(s: Shape) { return s.size * 2; }\n' +
    'export const total = shapes.map(area).reduce((a, b) => a + b, 0);\n',
  'src/hidden.ts': 'export const instance = new (class { private secret = 1; open = 2 })();\n',
  'src/wrong.ts': 'export const n: number = "not a number";\n',
  'src/decorated.ts':
    'declare function d(...args: any[]): any;\nexport type Name = `n${string}`;\n' +
    'export class Model { @d name!: Name; @d run(@d at: Date): Promise<void> { return Promise.resolve(); } }\n',
  'src/data.json': '{ "name": "data", "values": [1, 2, 3] }\n',
  'src/plain.js': 'export function plain(a) { return a + 1; }\n',
  // Not checked, but its declarations take the checker's inferred types.
  'src/generated.ts':
    '// @ts-nocheck\nimport { shapes } from "./shapes";\n' +
    'export const pick = (n: number) => (n > 0 ? shapes[0] : { kind: "none", size: 0, missing: undefined });\n',
  'src/index.ts':
    'import data from "./data.json";\nimport { plain } from "./plain.js";\nimport { total } from "./area";\n' +
    'export * from "./hidden";\nexport * from "./decorated";\nexport * from "./generated";\n' +
    'export const summary = { name: data.name, total, next: plain(total) };\n',
  'tsconfig.json': JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      strict: true,
      types: [],
      module: 'commonjs',
      esModuleInterop: true,
      resolveJsonModule: true,
      allowJs: true,
      experimentalDecorators: true,
      emitDecoratorMetadata: true,
      declaration: true,
      declarationMap: true,
      sourceMap: true,
      listEmittedFiles: true,
      rootDir: 'src',
      outDir: 'out',
    },
    include: ['src'],
  }),
};

function readOutputs(dir, root = dir, outputs = {}) {
  if (!existsSync(dir)) return outputs;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) readOutputs(path, root, outputs);
    else outputs[relative(root, path)] = readFileSync(path, 'utf8');
  }
  return outputs;
}

function run(cwd, args) {
  rmSync(join(cwd, 'out'), { recursive: true, force: true });
  let stdout;
  let status = 0;
  try {
    stdout = execFileSync(tscTs[0], [...tscTs.slice(1), '-p', '.', '--pretty', 'false', ...args], {
      cwd,
      env: { PATH: process.env.PATH ?? '', TSC_TS_LIB_DIR: bundledLibs },
      encoding: 'utf8',
    });
  } catch (error) {
    stdout = error.stdout;
    status = error.status;
  }
  return { stdout, status, outputs: readOutputs(join(cwd, 'out')) };
}

test('emit on checker threads matches emit on one checker', { skip: tscTsMissing }, () => {
  const cwd = tempDir('tsc-ts-parallel-emit-');
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), content);
  }
  const expected = run(cwd, ['--singleThreaded']);
  assert.ok(expected.stdout.includes('TS4094'), 'a declaration error is reported');
  assert.ok(expected.stdout.includes('TS2322'), 'a type error is reported');
  assert.equal(Object.keys(expected.outputs).length, 31);
  for (const checkers of ['3']) {
    const actual = run(cwd, ['--checkers', checkers]);
    assert.equal(actual.stdout, expected.stdout, `stdout with --checkers ${checkers}`);
    assert.equal(actual.status, expected.status, `status with --checkers ${checkers}`);
    assert.deepEqual(actual.outputs, expected.outputs, `outputs with --checkers ${checkers}`);
  }
});

// Under `noEmitOnError` checker threads hold what they emit, and the main thread writes it only when
// there are no errors; with errors only the build info is written.
test('under noEmitOnError, emit on checker threads matches emit on one checker', { skip: tscTsMissing }, () => {
  const config = JSON.parse(files['tsconfig.json']);
  config.compilerOptions.noEmitOnError = true;
  config.compilerOptions.incremental = true;
  config.compilerOptions.tsBuildInfoFile = 'out/build.tsbuildinfo';
  const clean = { ...files, 'tsconfig.json': JSON.stringify(config) };
  delete clean['src/hidden.ts'];
  delete clean['src/wrong.ts'];
  clean['src/index.ts'] = clean['src/index.ts'].replace('export * from "./hidden";\n', '');
  for (const [project, withErrors] of [
    [clean, false],
    [{ ...files, 'tsconfig.json': JSON.stringify(config) }, true],
  ]) {
    const cwd = tempDir('tsc-ts-parallel-emit-no-emit-on-error-');
    for (const [path, content] of Object.entries(project)) {
      mkdirSync(dirname(join(cwd, path)), { recursive: true });
      writeFileSync(join(cwd, path), content);
    }
    const expected = run(cwd, ['--singleThreaded']);
    const outputs = Object.keys(expected.outputs);
    if (withErrors) assert.deepEqual(outputs, ['build.tsbuildinfo']);
    else assert.ok(outputs.length > 10 && outputs.includes('index.js'), `outputs: ${outputs.join(' ')}`);
    const actual = run(cwd, ['--checkers', '3']);
    assert.equal(actual.stdout, expected.stdout);
    assert.equal(actual.status, expected.status);
    assert.deepEqual(actual.outputs, expected.outputs);
  }
});

// With a program error (here TS5102: `baseUrl`, which TypeScript 7 removed), the report has no semantic diagnostics
// (getDiagnosticsOfProgram), so checker threads only emit the files, as one checker emits them without
// checking; under `noEmit` and `noEmitOnError` nothing is emitted and no thread starts.
test('with a program error, emit on checker threads matches emit on one checker', { skip: tscTsMissing }, () => {
  for (const extra of [{}, { noEmit: true }, { noEmitOnError: true }]) {
    const config = JSON.parse(files['tsconfig.json']);
    Object.assign(config.compilerOptions, { baseUrl: '.' }, extra);
    const cwd = tempDir('tsc-ts-parallel-emit-program-error-');
    for (const [path, content] of Object.entries({ ...files, 'tsconfig.json': JSON.stringify(config) })) {
      mkdirSync(dirname(join(cwd, path)), { recursive: true });
      writeFileSync(join(cwd, path), content);
    }
    const expected = run(cwd, ['--singleThreaded']);
    assert.ok(expected.stdout.includes('TS5102'), 'the program error is reported');
    assert.ok(!expected.stdout.includes('TS2322'), 'no semantic error is reported');
    if (Object.keys(extra).length === 0) assert.equal(Object.keys(expected.outputs).length, 31);
    else assert.deepEqual(Object.keys(expected.outputs), []);
    const actual = run(cwd, ['--checkers', '3']);
    assert.equal(actual.stdout, expected.stdout, `stdout with ${JSON.stringify(extra)}`);
    assert.equal(actual.status, expected.status, `status with ${JSON.stringify(extra)}`);
    assert.deepEqual(actual.outputs, expected.outputs, `outputs with ${JSON.stringify(extra)}`);
  }
});

// A union's constituents tie in compareTypes when they differ only in their mappers, as two
// instantiations of one mapped type do, and are then ordered by type id, which follows the order in
// which the emitting checker created them. With one checker, `defs.ts` is checked first and creates
// `a` before `b`; with checker threads, the checker of `pick.ts` may not have checked `defs.ts`, and
// `pick.ts` needs `b` first. Declaration files are written in the same order either way.
test('declaration files are the same with any number of checkers', { skip: tscTsMissing }, () => {
  const cwd = tempDir('tsc-ts-parallel-declaration-order-');
  const project = {
    'src/view.ts': 'export function view<F>(fields: F): { readonly [K in keyof F]: F[K] } {\n  return fields;\n}\n',
    'src/defs.ts':
      'import { view } from "./view";\n' +
      'export const a = view({ kind: "a" as const, x: 1 });\n' +
      'export const b = view({ kind: "b" as const, y: "s" });\n',
    'src/pick.ts':
      'import { a, b } from "./defs";\nexport const first = b;\nexport const pick = Math.random() > 0.5 ? a : b;\n',
    'tsconfig.json': JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        strict: true,
        types: [],
        module: 'commonjs',
        declaration: true,
        emitDeclarationOnly: true,
        rootDir: 'src',
        outDir: 'out',
      },
      include: ['src'],
    }),
  };
  for (const [path, content] of Object.entries(project)) {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), content);
  }
  const expected = run(cwd, ['--singleThreaded']);
  assert.match(expected.outputs['pick.d.ts'], /pick: \{\n {4}readonly kind: "a";[^]*\} \| \{\n {4}readonly kind: "b";/);
  for (const checkers of ['2', '3', '4']) {
    const actual = run(cwd, ['--checkers', checkers]);
    assert.deepEqual(actual.outputs, expected.outputs, `outputs with --checkers ${checkers}`);
  }
});

// Type text in diagnostics lists a union's constituents in the union's order, as tsgo does; only
// declaration files reorder the ones the union orders by type id (above). The function expression has
// a written return type, so its body is checked after the file's statements, and `a` is created after
// `b`, which is declared later: the message has `b | a`.
test('diagnostics list union constituents in the order tsgo does', { skip: tscTsMissing || tsgoMissing }, () => {
  const cwd = tempDir('tsc-ts-diagnostic-union-order-');
  const project = {
    'src/pick.ts':
      'function view<F>(fields: F): { readonly [K in keyof F]: F[K] } {\n  return fields;\n}\n' +
      'export const f = (): number => {\n' +
      "  const a = view({ kind: 'a' as const, x: 1 });\n  const n: number = Math.random() > 0.5 ? a : b;\n" +
      '  return n;\n};\n' +
      "const b = view({ kind: 'b' as const, y: 's' });\n",
    'tsconfig.json': JSON.stringify({
      compilerOptions: { target: 'ES2022', strict: true, types: [], declaration: true, rootDir: 'src', outDir: 'out' },
      include: ['src'],
    }),
  };
  for (const [path, content] of Object.entries(project)) {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), content);
  }
  const actual = run(cwd, ['--singleThreaded']);
  rmSync(join(cwd, 'out'), { recursive: true, force: true });
  const expected = spawnSync(tsgo, ['-p', '.', '--pretty', 'false', '--singleThreaded'], { cwd, encoding: 'utf8' });
  assert.match(expected.stdout, /Type '\{ readonly kind: "b"; readonly y: string; \} \| \{ readonly kind: "a";/);
  assert.equal(actual.stdout, expected.stdout);
  assert.equal(actual.status, expected.status);
});

// A thread that fails leaves its files to the main thread, so the output alone doesn't show it: the threads' trace
// does. In native builds this runs parse and checker threads, under Node.js checker threads.
test('parse and checker threads start and finish without failing', { skip: tscTsMissing }, () => {
  const cwd = tempDir('tsc-ts-parallel-threads-');
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), content);
  }
  const result = spawnSync(tscTs[0], [...tscTs.slice(1), '-p', '.', '--pretty', 'false', '--checkers', '3'], {
    cwd,
    env: { PATH: process.env.PATH ?? '', TSC_TS_LIB_DIR: bundledLibs, TSC_TS_CHECKERS_TRACE: '1' },
    encoding: 'utf8',
  });
  assert.match(result.stderr, /checkers: finished/);
  assert.doesNotMatch(result.stderr, /thread \d+ failed/);
});

// Declaration serialization can resolve a recursive alias that semantic checking never instantiates.
// Its internal checker diagnostic is not a declaration diagnostic, and must not leak into the
// semantic globals collected from a checker thread.
test(
  'declaration serialization preserves the semantic diagnostic phase',
  { skip: tscTsMissing || tsgoMissing },
  async (t) => {
    for (const scenario of ['clean', 'semantic globals', 'semantic recursion']) {
      for (const mode of ['noEmit', 'emitDeclarationOnly', 'emit', 'noEmitOnError']) {
        await t.test(`${scenario}: ${mode}`, () => {
          const cwd = tempDir('tsc-ts-declaration-diagnostic-phase-');
          const project = {
            'src/library.d.ts':
              'type Recursive<T> = T extends { value: unknown } ? Recursive<T> : T;\n' +
              'export declare const object: { property: Recursive<{ value: 1 }> };\n',
            'src/index.ts':
              'import { object } from "./library";\n' +
              (scenario === 'semantic recursion'
                ? 'export const result = object.property;\n'
                : 'export const result = object;\n'),
            'tsconfig.json': JSON.stringify({
              compilerOptions: {
                target: 'es2015',
                lib: ['es5'],
                strict: true,
                types: [],
                module: 'esnext',
                moduleResolution: 'bundler',
                skipLibCheck: true,
                declaration: true,
                rootDir: 'src',
                outDir: 'out',
              },
              include: ['src'],
            }),
          };
          if (scenario === 'semantic globals')
            project['src/errors.ts'] = 'export function* generator() { yield 1; }\nexport const n: number = "s";\n';
          for (const [path, content] of Object.entries(project)) {
            mkdirSync(dirname(join(cwd, path)), { recursive: true });
            writeFileSync(join(cwd, path), content);
          }
          const args = mode === 'emit' ? [] : [`--${mode}`];
          const oracle = spawnSync(tsgo, ['-p', '.', '--pretty', 'false', ...args], { cwd, encoding: 'utf8' });
          assert.equal(oracle.stderr, '');
          assert.equal(oracle.status, scenario === 'clean' ? 0 : mode === 'noEmit' || mode === 'noEmitOnError' ? 1 : 2);
          if (scenario === 'semantic globals') {
            assert.match(oracle.stdout, /TS2318/);
            assert.match(oracle.stdout, /TS2322/);
          } else if (scenario === 'semantic recursion') assert.match(oracle.stdout, /src\/index.ts\([^]*TS2589/);
          const expected = { stdout: oracle.stdout, status: oracle.status, outputs: readOutputs(join(cwd, 'out')) };
          for (const checkers of ['1', '2', '4']) {
            const actual = run(cwd, [...args, '--checkers', checkers]);
            assert.deepEqual(actual, expected, `diagnostics and outputs with --checkers ${checkers}`);
          }
        });
      }
    }
  },
);
