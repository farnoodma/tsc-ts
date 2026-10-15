// Widening a union of object literals adds each literal's missing properties as optional `undefined`
// properties, which carry the declaration of a sibling literal's property and are printed in
// declaration order. A file's diagnostics must not depend on which files its checker checked first:
// with --checkers that varies from run to run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compiledDir, tempDir } from './temp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const bundledLibs = join(root, 'upstream/typescript-go/internal/bundled/libs');

const out = compiledDir('tsc-ts-undefined-properties-');
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
const { CheckedProgram } = await load('compiler/program-checker.js');

// Both files widen a union in which a literal lacks `a`. In a.ts the missing `a` stands for a
// property declared before b.ts, so a checker that kept one `a?: undefined` per name for a.ts would
// print it first in b.ts's union. tsc 7.0.2 does: it prints b.ts's union as below by default and with
// --checkers 2 (a.ts and b.ts on different checkers), but `{ a?: undefined; b: number; } | ...` with
// --singleThreaded.
const dir = tempDir('tsc-ts-undefined-properties-project-');
writeFileSync(
  join(dir, 'tsconfig.json'),
  JSON.stringify({ compilerOptions: { strict: true, noEmit: true, types: [] }, files: ['a.ts', 'b.ts'] }),
);
writeFileSync(
  join(dir, 'a.ts'),
  ['declare const c: boolean;', 'export const x = c ? { b: 1 } : { a: 1, b: 2 };', ''].join('\n'),
);
writeFileSync(
  join(dir, 'b.ts'),
  ['declare const c: boolean;', 'export const y = c ? { b: 3 } : { a: 4 };', 'export const z: number = y;', ''].join(
    '\n',
  ),
);

function setup() {
  const work = executeCommandLine(createNodeSystem(bundledLibs, ''), ['-p', dir]);
  assert.equal(work.kind, 'compile');
  const checked = new CheckedProgram(work.program);
  const file = (name) => work.program.getSourceFiles().find((f) => f.fileName.endsWith('/' + name));
  return { checker: checked.createChecker(), a: file('a.ts'), b: file('b.ts') };
}

const sourceTypes = (diagnostics) => diagnostics.map((d) => `${d.code} ${d.args[0]}`);
const expectedB = ['2322 { b: number; a?: undefined; } | { b?: undefined; a: number; }'];

test("a widened union prints its missing properties after the sibling's declarations", () => {
  const { checker, b } = setup();
  assert.deepEqual(sourceTypes(checker.getDiagnostics(b)), expectedB);
});

test('a widened union prints the same after another file widened the same name', () => {
  const { checker, a, b } = setup();
  assert.deepEqual(sourceTypes(checker.getDiagnostics(a)), []);
  assert.deepEqual(sourceTypes(checker.getDiagnostics(b)), expectedB);
});
