// Checks that binding is the last write to a program, apart from symbol ids and TypeScript files'
// JSDoc, which are assigned and parsed on first use, and that a program prepared for sharing between
// threads (`Program.prepareForSharing`, used by `--checkers`) is not written at all: deep-freezes
// every object reachable from the prepared program and its bound source files (nodes, symbols, symbol
// tables, flow nodes, diagnostics, the program's caches), then checks the program and emits
// JavaScript, declarations and source maps. Writes to frozen objects throw in strict mode, and Map and
// Set mutators are replaced by throwing ones. The diagnostics and outputs must match those of an
// unfrozen run.
// Projects: tsc-ts itself, and test cases from TypeScript's compiler and conformance suites.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compiledDir, tempDir } from './temp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const bundledLibs = join(root, 'upstream/typescript-go/internal/bundled/libs');
const cases = join(root, 'upstream/TypeScript/tests/cases');

const out = compiledDir('tsc-ts-immutability-');
execFileSync(
  join(root, 'node_modules/.bin/tsc'),
  [
    '--outDir',
    out,
    '--rootDir',
    resolve(here, '../src'),
    '--target',
    'es2024',
    '--module',
    'nodenext',
    '--moduleResolution',
    'nodenext',
    '--strict',
    '--skipLibCheck',
    '--types',
    'node',
    resolve(here, '../src/main.ts'),
  ],
  { stdio: 'inherit', cwd: root },
);
const load = (path) => import(pathToFileURL(join(out, path)).href);
const { createNodeSystem } = await load('drivers/node-system.js');
const { executeCommandLine } = await load('compiler/tsc-cli.js');
const { bindProgram, CheckedProgram } = await load('compiler/program-checker.js');
const { NodeVisitor } = await load('compiler/ast.js');
const { getJSDoc, parseSourceFile } = await load('compiler/parser.js');
const { useThreadTextCaches } = await load('compiler/diagnostics.js');
const { Symbol, getSymbolId } = await load('compiler/symbol.js');
const { CompileTimes, OutputWriter, PlainProgram, getDiagnosticsOfProgram } = await load('compiler/compile-program.js');
// `Locale.Default`, a const enum member.
const defaultLocale = 0;

function rejectWrite(name) {
  return () => {
    throw new TypeError(`${name} on a frozen program`);
  };
}

/** Every object reachable from `roots`. */
function reachable(roots) {
  const seen = new Set();
  const stack = [...roots];
  const push = (v) => {
    if (v !== null && typeof v === 'object' && !ArrayBuffer.isView(v) && !seen.has(v)) stack.push(v);
  };
  while (stack.length > 0) {
    const o = stack.pop();
    if (seen.has(o)) continue;
    seen.add(o);
    if (o instanceof Map)
      for (const [k, v] of o) {
        push(k);
        push(v);
      }
    else if (o instanceof Set) for (const v of o) push(v);
    else for (const key of Object.keys(o)) push(o[key]);
  }
  return seen;
}

/**
 * Freezes every object reachable from the program and its source files; returns how many. Symbol ids
 * and the JSDoc comments of TypeScript files, which are created on first use, are created first (a
 * shared program assigns symbol ids at creation, and its threads keep lazily parsed JSDoc in tables).
 */
function deepFreeze(program, files) {
  for (const file of files) {
    const nodes = [file];
    while (nodes.length > 0) {
      const node = nodes.pop();
      getJSDoc(file, node);
      node.forEachChild(collector(nodes));
    }
  }
  const objects = reachable([program, ...files]);
  for (const o of objects) if (o instanceof Symbol) getSymbolId(o);
  for (const o of objects) {
    if (o instanceof Map) {
      o.set = rejectWrite('Map.set');
      o.delete = rejectWrite('Map.delete');
      o.clear = rejectWrite('Map.clear');
    } else if (o instanceof Set) {
      o.add = rejectWrite('Set.add');
      o.delete = rejectWrite('Set.delete');
      o.clear = rejectWrite('Set.clear');
    }
    Object.freeze(o);
  }
  return objects.size;
}

/** A visitor that pushes each child onto `nodes`. */
function collector(nodes) {
  const visitor = new NodeVisitor();
  visitor.visitNode = (node) => {
    nodes.push(node);
    return false;
  };
  return visitor;
}

class RecordingWriter extends OutputWriter {
  outputs = [];

  write(fileName, text, declarationDiagnostics) {
    this.outputs.push(fileName + '\n' + text + format(declarationDiagnostics).join('\n'));
    return '';
  }
}

function format(diagnostics) {
  return diagnostics.map((d) => {
    // Line and column, as reporters print them, from the file's line starts.
    const starts = d.file?.getLineStarts() ?? [0];
    let line = 0;
    while (line + 1 < starts.length && starts[line + 1] <= d.pos) line++;
    const at = `${line + 1}:${d.pos - starts[line] + 1}`;
    return `${d.file?.fileName ?? ''}(${d.pos},${d.end}) ${at} TS${d.code}: ${d.localize(defaultLocale)}`;
  });
}

/** Diagnostics and emitted files of the project of `args`, optionally frozen after binding. */
function compile(args, freeze) {
  const sys = createNodeSystem(bundledLibs, '');
  const work = executeCommandLine(sys, args);
  assert.equal(work.kind, 'compile');
  const program = work.program;
  bindProgram(program);
  if (freeze) program.prepareForSharing();
  const frozen = freeze ? deepFreeze(program, program.getSourceFiles()) : 0;
  const compiled = new PlainProgram(new CheckedProgram(program), new CompileTimes());
  // Semantic and declaration diagnostics of every file, even after syntax errors.
  const diagnostics = format([
    ...getDiagnosticsOfProgram(compiled, true),
    ...compiled.getSemanticDiagnostics(),
    ...compiled.getDeclarationDiagnostics(),
  ]);
  const writer = new RecordingWriter();
  const emitted = compiled.emit(writer);
  // The line counts of `--extendedDiagnostics`.
  const lines = program.getSourceFiles().map((file) => `${file.fileName} ${file.lineStarts().length}`);
  return { frozen, diagnostics, outputs: writer.outputs, emitDiagnostics: format(emitted.diagnostics), lines };
}

function assertImmutable(args, minimumFrozen = 100000) {
  const frozen = compile(args, true);
  assert.ok(frozen.frozen > minimumFrozen, `froze only ${frozen.frozen} objects`);
  assert.ok(frozen.outputs.length > 0);
  const plain = compile(args, false);
  assert.deepEqual(frozen.diagnostics, plain.diagnostics);
  assert.deepEqual(frozen.emitDiagnostics, plain.emitDiagnostics);
  assert.deepEqual(frozen.outputs, plain.outputs);
  assert.deepEqual(frozen.lines, plain.lines);
}

const emitOptions = (dir) => ['--noEmit', 'false', '--outDir', dir, '--declaration', '--declarationMap', '--sourceMap'];

// The parser leaves the line starts and UTF-8 offsets of declaration files to first use; once files
// may be shared (`useThreadTextCaches`), a thread computes them in a copy of its own.
test('a shared declaration file gets its line starts and UTF-8 offsets without being written', () => {
  const text = "declare const a: '\u00e9';\r\n/** \u{1f600} */\rdeclare const b: string;\u2028export {};\n";
  const plain = parseSourceFile('/p/plain.d.ts', text).diagnosticFile();
  const shared = parseSourceFile('/p/shared.d.ts', text);
  const file = shared.diagnosticFile();
  // Other files get their caches from the scanner's code units at parse time: reading them writes
  // nothing, before this thread computes caches in copies too.
  const units = parseSourceFile('/p/units.ts', text).diagnosticFile();
  Object.freeze(units);
  assert.deepEqual(units.getLineStarts(), plain.getLineStarts());
  for (let pos = 0; pos <= text.length; pos++) assert.equal(units.toUtf8Offset(pos), plain.toUtf8Offset(pos));
  for (let pos = 0; pos <= Buffer.byteLength(text, 'utf8'); pos++)
    assert.equal(units.fromUtf8Offset(pos), plain.fromUtf8Offset(pos));
  Object.freeze(shared);
  Object.freeze(file);
  useThreadTextCaches();
  assert.deepEqual(file.getLineStarts(), [0, 23, 33, 58, 69]);
  assert.deepEqual(file.getLineStarts(), plain.getLineStarts());
  for (let pos = 0; pos <= text.length; pos++) assert.equal(file.toUtf8Offset(pos), plain.toUtf8Offset(pos));
  for (let pos = 0; pos <= Buffer.byteLength(text, 'utf8'); pos++)
    assert.equal(file.fromUtf8Offset(pos), plain.fromUtf8Offset(pos));
  assert.equal(file.toUtf8Offset(text.length), Buffer.byteLength(text, 'utf8'));
});

test('checking and emitting tsc-ts never writes to its bound, prepared program', () => {
  assertImmutable(['-p', resolve(here, '..'), ...emitOptions(tempDir('tsc-ts-immutability-out-'))]);
});

// Declaration emit writes module specifiers for inferred types, which probes files and `package.json`
// scopes that loading the program never looked at; JSON modules and the config file are source files
// too, whose line starts reporters and line counts read.
test('declaration emit, JSON files and their line starts never write to a bound, prepared program', () => {
  const dir = tempDir('tsc-ts-immutability-specifiers-');
  const files = {
    'tsconfig.json': JSON.stringify({
      compilerOptions: {
        strict: true,
        declaration: true,
        resolveJsonModule: true,
        module: 'nodenext',
        moduleResolution: 'nodenext',
        types: [],
        // A config diagnostic.
        notAnOption: true,
      },
      include: ['src'],
    }),
    'package.json': JSON.stringify({ name: 'fixture', version: '1.0.0' }),
    'src/box.ts':
      'export interface Box {\n  value: number;\n}\nexport function box(value: number): Box {\n  return { value };\n}\n',
    'src/nested/deep.ts': 'import { box } from "../box";\nexport const boxed = () => box(1);\n',
    // `Widget` is named `./widgets` (index stripped), unless a file like `src/widgets.js` exists.
    'src/widgets/index.ts': 'export interface Widget {\n  id: number;\n}\n',
    'src/widgets/make.ts': 'import type { Widget } from "./index";\nexport const make = (): Widget => ({ id: 1 });\n',
    'src/main.ts': [
      'import { boxed } from "./nested/deep";',
      'import { make } from "./widgets/make";',
      'export const widget = make();',
      'import { thing } from "dep";',
      'import * as data from "./data.json";',
      'export const made = boxed();',
      'export const named = thing();',
      'export const count = data.count;',
      '',
    ].join('\n'),
    'src/data.json': '{\n  "count": 1\n}\n',
    'node_modules/dep/package.json': JSON.stringify({ name: 'dep', version: '1.0.0', types: 'lib/index.d.ts' }),
    'node_modules/dep/lib/index.d.ts':
      'import type { Thing } from "./thing";\nexport declare function thing(): Thing;\n',
    'node_modules/dep/lib/thing.d.ts': 'export interface Thing {\n  name: string;\n}\n',
  };
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  assertImmutable(['-p', dir, ...emitOptions(join(dir, 'out'))], 1000);
});

/** Every `step`th single-file test case of `suite`, written as one project. */
function sampleProject(suite, step, offset) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) files.push(path);
    }
  };
  walk(join(cases, suite));
  const dir = tempDir('tsc-ts-immutability-cases-');
  let count = 0;
  for (let i = offset; i < files.length; i += step) {
    const text = readFileSync(files[i], 'utf8');
    if (/^\s*\/\/\s*@(filename|nolib|lib|types|module|jsx)\b/im.test(text)) continue;
    // Each case is a module of its own, so that their declarations don't collide.
    writeFileSync(join(dir, `case${count++}${files[i].endsWith('x') ? '.tsx' : '.ts'}`), text + '\nexport {};\n');
  }
  return { dir, count };
}

for (const [suite, options] of [
  ['compiler', ['--target', 'es2015', '--jsx', 'react', '--experimentalDecorators', '--emitDecoratorMetadata']],
  ['conformance', ['--target', 'es2016', '--module', 'commonjs', '--esModuleInterop', '--downlevelIteration']],
]) {
  test(`checking and emitting ${suite} test cases never writes to their bound, prepared program`, () => {
    const { dir, count } = sampleProject(suite, 12, 0);
    assert.ok(count > 300);
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, types: [] } }));
    assertImmutable(['-p', dir, ...options, ...emitOptions(join(dir, 'out'))]);
  });
}
