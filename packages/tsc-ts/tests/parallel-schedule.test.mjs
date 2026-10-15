// How --checkers spreads work: the order parse threads load files in (libraries first, so a large
// one such as lib.dom.d.ts does not finish last), the estimated cost of checking a file (a small file
// that alone imports a large library is expensive), and the ranges of files checkers take, with
// idle checkers taking the cheap end of another's range.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compiledDir, tempDir } from './temp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const bundledLibs = join(root, 'upstream/typescript-go/internal/bundled/libs');

const out = compiledDir('tsc-ts-parallel-schedule-');
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
const { ParseQueue } = await load('compiler/parallel-parse.js');
const {
  autoCheckers,
  checkFromQueue,
  checkGroups,
  checkOrder,
  checkersFittingMemory,
  fillScheduleCosts,
  newSchedule,
  packResult,
  planSchedule,
  retirementMemory,
  retires,
  scheduleOf,
  takePosition,
  textLengths,
  unpackResult,
} = await load('compiler/parallel-check.js');

const Root = 0;
const File = 1;
const Library = 2;

test('parse threads get library files first, one per chunk, also libraries queued later', () => {
  const queue = new ParseQueue();
  queue.push(Root, '/p/a.ts', 0);
  queue.push(Root, '/p/b.ts', 0);
  queue.push(Library, 'lib.es5.d.ts', 0);
  queue.push(Library, 'lib.es5.d.ts', 0);
  assert.deepEqual(queue.next(2).names, ['lib.es5.d.ts']);
  queue.push(File, '/p/c.ts', 0);
  queue.push(Library, 'lib.dom.d.ts', 0);
  assert.deepEqual(queue.next(2).names, ['lib.dom.d.ts']);
  assert.equal(queue.queued(), 5);
  assert.equal(queue.left(), 3);
  assert.deepEqual(queue.next(2).names, ['/p/a.ts']);
  assert.deepEqual(queue.next(1).names, ['/p/b.ts', '/p/c.ts']);
  assert.equal(queue.next(1), undefined);
});

test('parse threads get large files right after libraries, one per chunk, ahead of files queued earlier', () => {
  const queue = new ParseQueue();
  queue.push(Root, '/p/a.ts', 0);
  queue.push(File, '/p/small.d.ts', 0, 1000);
  queue.push(File, '/p/csstype.d.ts', 0, 900_000);
  queue.push(Library, 'lib.dom.d.ts', 0);
  // A root file the main thread did not size stays in program order whatever its size.
  queue.push(Root, '/p/root-of-unknown-size.ts', 0, 0);
  queue.push(File, '/p/electron.d.ts', 0, 1_100_000);
  assert.equal(queue.left(), 6);
  assert.deepEqual(queue.next(1).names, ['lib.dom.d.ts']);
  assert.deepEqual(queue.next(1).names, ['/p/csstype.d.ts']);
  assert.deepEqual(queue.next(1).names, ['/p/electron.d.ts']);
  assert.deepEqual(queue.next(1).names, ['/p/a.ts', '/p/small.d.ts', '/p/root-of-unknown-size.ts']);
  assert.equal(queue.next(1), undefined);
});

test('while root files are matched, other files go out to parse threads in full chunks only', () => {
  const queue = new ParseQueue();
  queue.push(Library, 'lib.es5.d.ts', 0);
  for (let i = 0; i < 20; i++) queue.push(Root, `/p/${i}.ts`, 0);
  assert.deepEqual(queue.next(8, true).names, ['lib.es5.d.ts']);
  assert.equal(queue.next(8, true).names.length, 16);
  assert.equal(queue.next(8, true), undefined);
  assert.deepEqual(queue.next(8).names, ['/p/16.ts']);
  assert.equal(queue.left(), 3);
});

function project() {
  const dir = tempDir('tsc-ts-parallel-schedule-project-');
  const files = {
    'tsconfig.json': JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, types: [], skipLibCheck: true, module: 'nodenext' },
      include: ['src'],
    }),
    'node_modules/heavy/package.json': JSON.stringify({ name: 'heavy', types: 'index.d.ts' }),
    'node_modules/heavy/index.d.ts': "export * from './more';\n" + 'export declare const a0: number;\n'.repeat(500),
    'node_modules/heavy/more.d.ts': 'export declare const b0: string;\n'.repeat(500),
    'src/adapter.ts': "import { a0 } from 'heavy';\nexport const x = a0;\n",
    'src/big.ts': 'export const big = 1;\n'.repeat(200),
    'src/small.ts': 'export const small = 1;\n',
  };
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

function checked() {
  const work = executeCommandLine(createNodeSystem(bundledLibs, ''), ['-p', project()]);
  assert.equal(work.kind, 'compile');
  return new CheckedProgram(work.program);
}

const baseName = (program, i) => program.getSourceFiles()[i].fileName.split('/').pop();

test('planning reads the text length of each file once per program', () => {
  const program = checked().program;
  const lengths = textLengths(program);
  assert.equal(textLengths(program), lengths);
  assert.deepEqual(
    lengths,
    program.getSourceFiles().map((file) => file.text.length),
  );
});

test('a small file that alone imports a large library is checked before larger files', () => {
  const c = checked();
  assert.deepEqual(
    checkOrder(c).map((i) => baseName(c.program, i)),
    ['adapter.ts', 'big.ts', 'small.ts'],
  );
});

test('a checker resolving a library for the first time pays for all the text the library reaches', () => {
  const c = checked();
  const plan = planSchedule(c, 2);
  // The only library is heavy/index.d.ts, which reaches more.d.ts: both texts in full.
  const reach =
    "export * from './more';\n".length +
    'export declare const a0: number;\n'.length * 500 +
    'export declare const b0: string;\n'.length * 500;
  assert.deepEqual(plan.libraryCosts, [reach]);
});

test('checkers take every file once: the costliest first, then their ranges, then the end of others', () => {
  const c = checked();
  const plan = planSchedule(c, 2);
  const schedule = new Int32Array(scheduleOf(plan, 2));
  const order = plan.order;
  assert.equal(order.length, 3);
  // Checker 1 takes the two costliest files from the shared queue, then the whole range of checker 0.
  const taken = [];
  for (let k; (k = takePosition(schedule, order.length, 1)) >= 0;) taken.push(baseName(c.program, order[k]));
  assert.deepEqual(taken.slice(0, 2), ['adapter.ts', 'big.ts']);
  assert.deepEqual(taken.sort(), ['adapter.ts', 'big.ts', 'small.ts']);
  assert.equal(takePosition(schedule, order.length, 0), -1);
});

// The ranges start after the 8 header entries of the schedule.
const ranges = 8;

function ownRanges(schedule, ...bounds) {
  schedule[2] = 0; // no shared prefix
  for (let k = 0; k < bounds.length; k++) schedule[ranges + k] = bounds[k];
}

test('without costs, an idle checker takes the back half of the largest remaining range', () => {
  const schedule = new Int32Array(newSchedule(2));
  // Checker 0 owns positions 0..9, checker 1 none.
  ownRanges(schedule, 0, 10, 10, 10);
  assert.equal(takePosition(schedule, 10, 0), 0);
  assert.equal(takePosition(schedule, 10, 1), 5);
  assert.deepEqual(Array.from(schedule.slice(ranges, ranges + 4)), [1, 5, 6, 10]);
});

test('an idle checker takes the end of a range that makes both finish earliest', () => {
  // Ten files of cost 10 without libraries: checker 1 takes the last four of the nine checker 0 has
  // left (the first larger end that does not make it finish later).
  const schedule = new Int32Array(newSchedule(2, 10, 0, 0));
  fillScheduleCosts(schedule, Array(10).fill(10), Array(10).fill([]), []);
  ownRanges(schedule, 0, 10, 10, 10);
  assert.equal(takePosition(schedule, 10, 0), 0);
  assert.equal(takePosition(schedule, 10, 1), 6);
  assert.deepEqual(Array.from(schedule.slice(ranges, ranges + 4)), [1, 6, 7, 10]);
  // Uneven costs: the end that balances the estimated work, not half of the files.
  const uneven = new Int32Array(newSchedule(2, 4, 0, 0));
  fillScheduleCosts(uneven, [100, 10, 10, 10], Array(4).fill([]), []);
  ownRanges(uneven, 0, 4, 4, 4);
  assert.equal(takePosition(uneven, 4, 1), 1);
  assert.deepEqual(Array.from(uneven.slice(ranges, ranges + 4)), [0, 1, 2, 4]);
});

test('an idle checker leaves files whose library only the owner has resolved', () => {
  // Four small files importing one library that costs 1000 to resolve; checker 0 has taken the first.
  const schedule = new Int32Array(newSchedule(2, 4, 1, 4));
  fillScheduleCosts(schedule, Array(4).fill(10), Array(4).fill([0]), [1000]);
  ownRanges(schedule, 0, 4, 4, 4);
  assert.equal(takePosition(schedule, 4, 0), 0);
  // Taking any of the other three would make checker 1 resolve the library: it is done instead.
  assert.equal(takePosition(schedule, 4, 1), -1);
  assert.deepEqual(Array.from(schedule.slice(ranges, ranges + 4)), [1, 4, 4, 4]);
  // Once checker 1 has resolved the library too, it takes the last file.
  const both = new Int32Array(newSchedule(2, 6, 1, 6));
  fillScheduleCosts(both, Array(6).fill(10), Array(6).fill([0]), [1000]);
  ownRanges(both, 0, 2, 2, 6);
  assert.equal(takePosition(both, 6, 0), 0);
  assert.equal(takePosition(both, 6, 1), 2);
  assert.equal(takePosition(both, 6, 0), 1);
  assert.deepEqual(Array.from(both.slice(ranges, ranges + 4)), [2, 2, 3, 6]);
  assert.equal(takePosition(both, 6, 0), 5);
  assert.deepEqual(Array.from(both.slice(ranges, ranges + 4)), [6, 6, 3, 5]);
});

test('auto starts a checker per CPU, at least four, fewer only when memory does not fit', () => {
  assert.equal(autoCheckers(8, 100), 8);
  assert.equal(autoCheckers(2, 100), 4);
  assert.equal(autoCheckers(16, 10), 10);
  assert.equal(autoCheckers(8, 1), 4);
  const GiB = 1024 ** 3;
  const MiB = 1024 ** 2;
  // VS Code (4209 MiB when checking starts, 16.8M characters in declaration files; 9.1 GB at 8
  // checkers, 8.6 GB at 4) gets one checker per CPU on 16 GiB and 32 GiB, and six on 12 GiB.
  assert.equal(autoCheckers(8, checkersFittingMemory(4209 * MiB, 16769893, 16 * GiB)), 8);
  assert.equal(autoCheckers(16, checkersFittingMemory(4209 * MiB, 16769893, 32 * GiB)), 16);
  assert.equal(autoCheckers(8, checkersFittingMemory(4209 * MiB, 16769893, 12 * GiB)), 6);
  // Sentry (2003 MiB, 22.1M; 7.2 GB at 8, 6.2 GB at 4) gets 8 on 16 GiB, 6 on 8 GiB and tsgo's four
  // on 6 GiB. T3 Code's apps/server (about 1.6 GB, 30.4M; 9.2 GiB at 8, 11.8 GiB at 16) gets 16 on
  // 16 GiB. Programs above the estimate retire checkers instead.
  assert.equal(autoCheckers(8, checkersFittingMemory(2003 * MiB, 22113123, 16 * GiB)), 8);
  assert.equal(autoCheckers(8, checkersFittingMemory(2003 * MiB, 22113123, 8 * GiB)), 6);
  assert.equal(autoCheckers(8, checkersFittingMemory(2003 * MiB, 22113123, 6 * GiB)), 4);
  assert.equal(autoCheckers(16, checkersFittingMemory(1600 * MiB, 30414210, 16 * GiB)), 16);
});

function groupProject() {
  const dir = tempDir('tsc-ts-parallel-schedule-groups-');
  const files = {
    'tsconfig.json': JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, types: [], skipLibCheck: true, module: 'nodenext' },
      include: ['src'],
    }),
    // A large generated module that few files import, the files importing it, and their importer.
    'src/schema.gen.ts': 'export declare const s0: { a: number; b: string };\n'.repeat(200),
    'src/meta.gen.ts': "import { s0 } from './schema.gen.js';\nexport const meta = s0;\n",
    'src/client.ts':
      "import { s0 } from './schema.gen.js';\nimport { meta } from './meta.gen.js';\nexport const client = [s0, meta];\n",
    'src/app.ts': "import { client } from './client.js';\nexport const app = client;\n",
    'src/other.ts': 'export const other = 1;\n'.repeat(20),
    'src/more.ts': 'export const more = 1;\n'.repeat(20),
  };
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  const work = executeCommandLine(createNodeSystem(bundledLibs, ''), ['-p', dir]);
  assert.equal(work.kind, 'compile');
  return new CheckedProgram(work.program);
}

test('a large module that few files import groups with the files importing it, costliest first', () => {
  const c = groupProject();
  // The default least load is a million characters: this project has no groups.
  assert.deepEqual(checkGroups(c, 2), []);
  const groups = checkGroups(c, 2, 1000);
  assert.equal(groups.length, 1);
  const names = groups[0].map((i) => baseName(c.program, i));
  assert.equal(names[0], 'schema.gen.ts');
  assert.deepEqual(names.slice().sort(), ['app.ts', 'client.ts', 'meta.gen.ts', 'schema.gen.ts']);
  // With many checkers, the files around the schema would be too much for one checker.
  assert.deepEqual(checkGroups(c, 64, 1000), []);
});

test('a checker takes a group from the shared queue as a whole, and nobody takes it from that checker', () => {
  // Positions 0-2 are a group, 3 a file of its own, then the ranges 4-5 and 6-7.
  const schedule = new Int32Array(newSchedule(2, 8, 0, 0));
  fillScheduleCosts(schedule, Array(8).fill(10), Array(8).fill([]), [], [3, 0, 0, 1]);
  ownRanges(schedule, 4, 6, 6, 8);
  schedule[2] = 4;
  assert.equal(takePosition(schedule, 8, 1), 0);
  assert.equal(takePosition(schedule, 8, 0), 3);
  assert.equal(takePosition(schedule, 8, 1), 1);
  assert.equal(takePosition(schedule, 8, 0), 4);
  assert.equal(takePosition(schedule, 8, 0), 5);
  // Checker 0 is idle: it takes from checker 1's range, never the rest of its group.
  assert.equal(takePosition(schedule, 8, 0), 7);
  assert.equal(takePosition(schedule, 8, 1), 2);
  assert.equal(takePosition(schedule, 8, 1), 6);
  assert.equal(takePosition(schedule, 8, 0), -1);
  assert.equal(takePosition(schedule, 8, 1), -1);
});

test('one checker thread at a time retires when memory runs short, and an idle checker takes its range', () => {
  const schedule = new Int32Array(newSchedule(6, 10, 0, 0));
  fillScheduleCosts(schedule, Array(10).fill(10), Array(10).fill([]), []);
  ownRanges(schedule, 10, 10, 10, 10, 10, 10, 10, 10, 0, 10, 10, 10);
  assert.equal(retires(schedule, 4, 100, 50), false);
  // The main thread's checker never retires.
  assert.equal(retires(schedule, 0, 100, 200), false);
  assert.equal(retires(schedule, 4, 100, 200), true);
  // The next retirement waits until the first one's memory has come back.
  assert.equal(retires(schedule, 5, 100, 200), false);
  assert.equal(takePosition(schedule, 10, 0), 0);
  assert.deepEqual(Array.from(schedule.slice(ranges, ranges + 2)), [1, 10]);
  assert.deepEqual(Array.from(schedule.slice(ranges + 8, ranges + 10)), [0, 0]);
  // Beyond tsgo's four at 85% of the memory limit, checkers 1-3 only at 95%.
  assert.equal(retirementMemory(4, 1000), 850);
  assert.equal(retirementMemory(1, 1000), 950);
  assert.equal(retirementMemory(0, 1000), 0);
});

function erroneous() {
  const dir = tempDir('tsc-ts-parallel-schedule-errors-');
  const files = {
    'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, noEmit: true, types: [] }, include: ['src'] }),
    // A message chain (elaboration), related information (redeclaration) and an argument-free error.
    'src/a.ts': 'interface P { x: { y: number } }\nconst p: P = { x: { y: "no" } };\nlet d = 1;\nlet d = 2;\n',
    'src/b.ts': 'export const n: number = "s";\ndeclare const q: { x: string };\nexport const r: { x: number } = q;\n',
    'src/c.ts': 'export const fine = 1;\n',
  };
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  const work = executeCommandLine(createNodeSystem(bundledLibs, ''), ['-p', dir]);
  assert.equal(work.kind, 'compile');
  return new CheckedProgram(work.program);
}

const described = (d) => ({
  file: d.file?.fileName,
  pos: d.pos,
  end: d.end,
  code: d.code,
  category: d.category,
  message: d.message,
  args: [...d.args],
  skipped: d.skippedOnNoEmit,
  chain: d.messageChain.map(described),
  related: d.relatedInformation.map(described),
});

test('a checker result packed as plain data comes back with the same diagnostics on the same files', () => {
  const c = erroneous();
  const plan = planSchedule(c, 1);
  const result = checkFromQueue(c, 0, new Int32Array(scheduleOf(plan, 1)), plan.order, 0);
  const all = result.diagnostics.flat();
  assert.ok(all.length >= 3);
  assert.ok(all.some((d) => d.messageChain.length > 0));
  assert.ok(all.some((d) => d.relatedInformation.length > 0));
  // Through a structured clone, as postMessage copies it.
  const packed = structuredClone(packResult(result, c.program));
  assert.ok(
    packed.strs.every((s) => !s.includes('interface P')),
    'file texts the program has stay behind',
  );
  const files = new Map();
  const back = unpackResult(packed, c.program, files);
  assert.deepEqual(back.files, result.files);
  assert.deepEqual(
    back.diagnostics.map((list) => list.map(described)),
    result.diagnostics.map((list) => list.map(described)),
  );
  assert.deepEqual(back.globals.map(described), result.globals.map(described));
  assert.equal(back.more, false);
  // Diagnostics refer to the program's own files.
  const a = back.diagnostics.flat().find((d) => d.file?.fileName.endsWith('a.ts'));
  assert.equal(
    a.file,
    c.program
      .getSourceFiles()
      .find((f) => f.fileName.endsWith('a.ts'))
      .diagnosticFile(),
  );
});

test('a checker at its file limit stops, and a new one on its schedule index checks the rest once', () => {
  const c = erroneous();
  const plan = planSchedule(c, 1);
  const schedule = new Int32Array(scheduleOf(plan, 1));
  const first = checkFromQueue(c, 0, schedule, plan.order, 0, true, 1);
  assert.deepEqual([first.files.length, first.more], [1, true]);
  const rest = checkFromQueue(new CheckedProgram(c.program), 0, schedule, plan.order, 0, true, 100000);
  assert.equal(rest.more, false);
  assert.deepEqual([...first.files, ...rest.files].sort(), [...plan.order].sort());
});

test('a checker at its file limit inside a group hands the rest of the group to its successor', () => {
  const c = erroneous();
  const order = planSchedule(c, 1).order;
  assert.ok(order.length >= 4);
  // Positions 0-2 are a group in the shared queue, then checker 0's range.
  const schedule = new Int32Array(newSchedule(1, order.length, 0, 0));
  fillScheduleCosts(schedule, Array(order.length).fill(10), Array(order.length).fill([]), [], [3, 0, 0]);
  ownRanges(schedule, 3, order.length);
  schedule[2] = 3;
  const first = checkFromQueue(c, 0, schedule, order, 0, true, 1);
  assert.deepEqual([first.files, first.more, first.reserved], [[order[0]], true, [1, 2]]);
  const rest = checkFromQueue(new CheckedProgram(c.program), 0, schedule, order, 0, true, 100000, first.reserved);
  assert.equal(rest.more, false);
  assert.deepEqual(rest.files.slice(0, 2), [order[1], order[2]]);
  assert.deepEqual([...first.files, ...rest.files].sort(), [...order].sort());
});
