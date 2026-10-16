// Runs `tsc --build`, `--incremental` and related scenarios through tsgo (packages/tsgo/dist/tsgo) and tsc-ts
// (the Node build, or TSC_TS_BIN), step by step in two copies of a project, and compares output, exit status and
// every file afterwards, .tsbuildinfo included. Times in status lines are masked, as are statistics values.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './temp.mjs';
import { tscTs, tscTsMissing } from './toolchain.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const tsgo = join(root, 'packages/tsgo/dist/tsgo');
const bundledLibs = join(root, 'upstream/typescript-go/internal/bundled/libs');
const skip = (!existsSync(tsgo) && 'needs packages/tsgo/dist/tsgo') || tscTsMissing;

/**
 * @typedef {{ args: string[], edit?: Record<string, string | null>, touch?: string[], cwd?: string }} Step
 * @typedef {{ files: Record<string, string>, steps: Step[] }} Scenario
 */

/** @type {Record<string, Scenario>} */
const scenarios = {
  'stored relation errors with elaborations and related information': {
    files: {
      'tsconfig.json': '{"compilerOptions":{"strict":true,"noEmit":true,"incremental":true},"files":["a.ts","b.ts"]}',
      // TS2322 elaborated by TS2326 and TS2741, with "'b' is declared here." as related information.
      'a.ts':
        'interface P { a: number; b: string; }\ndeclare const r: { x: { a: number } };\nexport const p: { x: P } = r;\n' +
        'declare function f(x: { a: { b: number } }): void;\ndeclare const v: { a: { b: string } };\nf(v);\n' +
        // TS2769 with "The last overload is declared here." as related information of the outermost message.
        'declare function g(x: number): void;\ndeclare function g(x: { a: number }): void;\ng({ a: "s" });\n',
      'b.ts': 'export const b = 1;\n',
    },
    steps: [{ args: [] }, { args: [], edit: { 'b.ts': 'export const b = 2;\n' } }, { args: [] }],
  },
  'references with --verbose, --force, --dry and --clean': {
    files: {
      'a/tsconfig.json': '{"compilerOptions":{"composite":true,"outDir":"out"},"files":["index.ts"]}',
      'a/index.ts': 'export const a: number = 1;\n',
      'b/tsconfig.json': '{"compilerOptions":{"outDir":"out"},"references":[{"path":"../a"}],"files":["index.ts"]}',
      'b/index.ts': 'import { a } from "../a/index";\nexport const b: number = a + 1;\n',
    },
    steps: [
      { args: ['-b', 'b', '--verbose'] },
      { args: ['-b', 'b', '--verbose'] },
      {
        args: ['-b', 'b', '--verbose'],
        edit: { 'b/index.ts': 'import { a } from "../a/index";\nexport const b: string = a;\n' },
      },
      { args: ['-b', 'b', '--verbose'] },
      { args: ['-b', 'b', '-v'], edit: { 'b/index.ts': 'import { a } from "../a/index";\nexport const b = a;\n' } },
      { args: ['-b', 'b', '-v'], edit: { 'a/index.ts': 'export const a: number = 2;\n' } },
      { args: ['-b', 'b', '-v'], edit: { 'a/index.ts': 'export const a: number = 2;\n// changed\n' } },
      { args: ['-b', 'b', '--verbose', '--force'] },
      { args: ['-b', 'b', '--dry'] },
      { args: ['-b', 'b', '--clean', '--dry'] },
      { args: ['-b', 'b', '--clean'] },
      { args: ['-b', 'b', '--dry'] },
      { args: ['-b', 'b', '--pretty'] },
    ],
  },
  'signatures of files with several declaration errors': {
    files: {
      'tsconfig.json':
        '{"compilerOptions":{"strict":true,"incremental":true,"outDir":"out","module":"nodenext"},"files":["a.ts"]}',
      'package.json': '{"name":"app","type":"module"}',
      'node_modules/dep/package.json': '{"name":"dep","exports":{".":{"types":"./index.d.ts"}}}',
      'node_modules/dep/index.d.ts':
        'import type { Z, A } from "./internal.js";\nexport declare function make(): { z: Z; a: A };\n',
      'node_modules/dep/internal.d.ts': 'export interface Z { z: 1 }\nexport interface A { a: 1 }\n',
      // TS2883 for Z, then for A: the declaration emitter reports them in that order.
      'a.ts': 'import { make } from "dep";\nexport const x = make();\n',
    },
    steps: [
      { args: [] },
      { args: [], edit: { 'a.ts': 'import { make } from "dep";\nexport const x = make();\n// edit\n' } },
    ],
  },
  'upstream errors, --stopBuildOnErrors, solutions and missing references': {
    files: {
      'tsconfig.json': '{"files":[],"references":[{"path":"./b"},{"path":"./c"}]}',
      'a/tsconfig.json': '{"compilerOptions":{"composite":true},"files":["index.ts"]}',
      'a/index.ts': 'export const a: number = "one";\n',
      'b/tsconfig.json': '{"compilerOptions":{"composite":true},"references":[{"path":"../a"}],"files":["index.ts"]}',
      'b/index.ts': 'import { a } from "../a/index";\nexport const b: number = a;\n',
      'c/tsconfig.json': '{"references":[{"path":"../missing"}],"files":["index.ts"]}',
      'c/index.ts': 'export const c: number = 3;\n',
    },
    steps: [
      { args: ['-b', '-v'] },
      { args: ['-b', '-v', '--stopBuildOnErrors'] },
      { args: ['-b', '-v'], edit: { 'a/index.ts': 'export const a: number = 1;\n' } },
      { args: ['-b', '-v'] },
      { args: ['-b', 'missing', 'c'] },
    ],
  },
  // Both projects include shared/value.ts, whose import of "lib" resolves to a different file in each.
  // In the second build, a (no build info) is checked on threads and parsed on parse threads, and b
  // (incremental) on the main thread: b must load the file itself.
  'a project parsed on threads before one that is not': {
    files: {
      'shared/value.ts': 'import { v } from "lib";\nexport const n: number = v;\n',
      'a/x/lib.ts': 'export const v: number = 1;\n',
      'b/y/lib.ts': 'export const v: string = "s";\n',
      'a/tsconfig.json':
        '{"compilerOptions":{"outDir":"out","rootDir":"..","paths":{"lib":["./x/lib.ts"]}},"files":["../shared/value.ts"]}',
      'b/tsconfig.json':
        '{"compilerOptions":{"incremental":true,"outDir":"out","rootDir":"..","paths":{"lib":["./y/lib.ts"]}},"files":["../shared/value.ts"]}',
    },
    steps: [
      { args: ['-b', 'a', 'b'] },
      {
        args: ['-b', 'a', 'b'],
        edit: { 'shared/value.ts': 'import { v } from "lib";\nexport const n: number = v;\n// changed\n' },
      },
    ],
  },
  'circular references': {
    files: {
      'a/tsconfig.json': '{"compilerOptions":{"composite":true},"references":[{"path":"../b"}],"files":["a.ts"]}',
      'a/a.ts': 'export const a = 1;\n',
      'b/tsconfig.json': '{"compilerOptions":{"composite":true},"references":[{"path":"../a"}],"files":["b.ts"]}',
      'b/b.ts': 'export const b = 1;\n',
    },
    steps: [{ args: ['-b', 'a', '-v'] }, { args: ['-b', 'a', 'b'] }],
  },
  'incremental emit, errors and option changes': {
    files: {
      'tsconfig.json':
        '{"compilerOptions":{"incremental":true,"outDir":"out","declaration":true,"strict":true},"include":["src"]}',
      'src/a.ts': 'export const a: number = 1;\nexport function f(x: number): number { return x; }\n',
      'src/b.ts': 'import { a, f } from "./a";\nexport const b: number = f(a);\nlet x: string = 1;\n',
      'src/c.ts': 'import { b } from "./b";\nexport const c: number = b;\n',
      'src/g.ts': 'declare const g: number;\n',
    },
    steps: [
      { args: ['--listEmittedFiles'] },
      { args: ['--listEmittedFiles'] },
      {
        args: ['--listEmittedFiles'],
        edit: { 'src/b.ts': 'import { a, f } from "./a";\nexport const b: number = f(a);\n' },
      },
      {
        args: ['--listEmittedFiles'],
        edit: {
          'src/a.ts': 'export const a: number = 1;\nexport function f(x: number): string { return String(x); }\n',
        },
      },
      { args: ['--listEmittedFiles'] },
      {
        args: ['--listEmittedFiles'],
        edit: { 'src/a.ts': 'export const a: number = 1;\nexport function f(x: number): number { return x; }\n// c\n' },
      },
      { args: ['--listEmittedFiles', '--sourceMap'] },
      { args: ['--listEmittedFiles'], edit: { 'src/g.ts': 'declare const g: string;\n' } },
      { args: ['--listEmittedFiles'], edit: { 'src/c.ts': null } },
      { args: ['--listEmittedFiles', '--noEmit'], edit: { 'src/c.ts': 'export const c: number = "x";\n' } },
      { args: ['--listEmittedFiles'] },
      { args: ['--listFiles', '--pretty'] },
    ],
  },
  // In native builds the programs are checked and emitted on three checker threads, without old build info.
  'composite references built on checker threads': {
    files: {
      'a/tsconfig.json':
        '{"compilerOptions":{"composite":true,"declarationMap":true,"sourceMap":true,"outDir":"out"},' +
        '"include":["*.ts"]}',
      'a/shapes.ts':
        'export interface Shape { kind: string; size: number }\nexport const unit = { kind: "u", size: 1 };\n',
      'a/area.ts':
        'import { Shape, unit } from "./shapes";\nexport function area(s: Shape) { return s.size * 2; }\n' +
        'export const total = [unit].map(area);\n',
      'a/hidden.ts': 'export const instance = new (class { private secret = 1; open = 2 })();\n',
      'a/index.ts': 'export * from "./area";\nexport * from "./hidden";\nexport { unit } from "./shapes";\n',
      'b/tsconfig.json':
        '{"compilerOptions":{"composite":true,"outDir":"out"},"references":[{"path":"../a"}],"include":["*.ts"]}',
      'b/main.ts': 'import { area, unit } from "../a/index";\nexport const value = area(unit);\n',
      'b/other.ts': 'export const other: number = "x";\n',
    },
    steps: [
      { args: ['-b', 'b', '--verbose', '--checkers', '3'] },
      {
        args: ['-b', 'b', '--verbose', '--checkers', '3'],
        edit: {
          'a/shapes.ts':
            'export interface Shape { kind: string; size: number }\nexport const unit = { kind: "u", size: 2 };\n',
        },
      },
      { args: ['-b', 'b', '--verbose', '--checkers', '3', '--force'] },
    ],
  },
  // In native builds the first step checks and emits on three checker threads (no build info yet).
  'incremental program on checker threads': {
    files: {
      'tsconfig.json':
        '{"compilerOptions":{"incremental":true,"declaration":true,"declarationMap":true,"outDir":"out"},' +
        '"include":["src"]}',
      'src/shapes.ts':
        'export interface Shape { kind: string; size: number }\nexport const unit = { kind: "u", size: 1 };\n',
      'src/area.ts':
        'import { Shape, unit } from "./shapes";\nexport function area(s: Shape) { return s.size * 2; }\n' +
        'export const total = [unit].map(area);\n',
      'src/hidden.ts': 'export const instance = new (class { private secret = 1; open = 2 })();\n',
      'src/wrong.ts': 'export const n: number = "not a number";\n',
    },
    steps: [
      { args: ['--checkers', '3', '--listEmittedFiles'] },
      {
        args: ['--checkers', '3', '--listEmittedFiles'],
        edit: {
          'src/shapes.ts':
            'export interface Shape { kind: string; size: number }\nexport const unit = { kind: "u", size: 2 };\n',
        },
      },
      { args: ['--checkers', '3', '--listEmittedFiles'] },
    ],
  },
  'composite, node16 packages, tsBuildInfoFile and noEmitOnError': {
    files: {
      'tsconfig.json':
        '{"compilerOptions":{"composite":true,"module":"nodenext","declarationMap":true,' +
        '"tsBuildInfoFile":"build/info.json","noEmitOnError":true},"include":["*.ts","*.mts"]}',
      'package.json': '{"name":"p","type":"module"}',
      'node_modules/foo/package.json': '{"name":"foo","types":"index.d.ts"}',
      'node_modules/foo/index.d.ts': 'export declare const foo: number;\n',
      'a.ts': 'import { foo } from "foo";\nexport const enum E { A = 1 }\nexport const a: number = foo;\n',
      'b.ts':
        'import { E, a } from "./a.js";\nexport const b: number = E.A + a;\ndeclare module "foo" { export const z: 1; }\n',
      'c.mts': 'import type { b } from "./b.js";\nexport type C = typeof b;\n',
      'amb.d.ts': 'declare module "amb" { export const q: number; }\n',
    },
    steps: [
      { args: ['--listEmittedFiles'] },
      { args: ['--listEmittedFiles'] },
      {
        args: ['--listEmittedFiles'],
        edit: { 'a.ts': 'import { foo } from "foo";\nexport const enum E { A = 2 }\nexport const a: number = foo;\n' },
      },
      {
        args: ['--listEmittedFiles'],
        edit: {
          'c.mts':
            'import type { b } from "./b.js";\nexport type C = typeof b;\nexport const i: { x: string } = { x: 1 };\n',
        },
      },
      { args: ['--listEmittedFiles'] },
      {
        args: ['--listEmittedFiles', '--declarationMap', 'false'],
        edit: { 'c.mts': 'export const i: { x: string } = { x: "" };\n' },
      },
      { args: ['--listEmittedFiles'] },
      { args: ['-b', '-v'] },
      { args: ['-b', '-v'], touch: ['a.ts'] },
      { args: ['-b', '-v'], touch: ['package.json'] },
      { args: ['-b', '-v', '--diagnostics'] },
    ],
  },
  'stored diagnostics whose elaborations depend on the program': {
    files: {
      'tsconfig.json':
        '{"compilerOptions":{"module":"node16","strict":true,"noEmit":true,"incremental":true,"types":[]},' +
        '"files":["a.ts","c.ts","d.ts"]}',
      'package.json': '{"name":"app"}',
      'node_modules/esm/package.json': '{"name":"esm","type":"module","exports":"./index.js","types":"./index.d.ts"}',
      'node_modules/esm/index.d.ts': 'export declare const e: number;\n',
      'node_modules/esm/index.js': 'export const e = 1;\n',
      'node_modules/untyped/package.json': '{"name":"untyped","version":"1.0.0","main":"index.js"}',
      'node_modules/untyped/index.js': 'module.exports = 1;\n',
      // A CommonJS file importing an ES module, and an import of a package without types.
      'a.ts': 'import { e } from "esm";\nexport const a = e;\n',
      'c.ts': 'export const c = 1;\n',
      'd.ts': 'import * as u from "untyped";\nexport const d = u;\n',
    },
    steps: [
      { args: [] },
      { args: [] },
      { args: [], edit: { 'c.ts': 'export const c = 2;\n' } },
      { args: [], edit: { 'node_modules/@types/untyped/package.json': '{"name":"@types/untyped","version":"1.0.0"}' } },
      { args: [], edit: { 'c.ts': 'export const c = 3;\n' } },
    ],
  },
  'ambient modules augmented in module files': {
    files: {
      'tsconfig.json':
        '{"compilerOptions":{"strict":true,"noEmit":true,"incremental":true,"types":["lib"]},' +
        '"files":["a.ts","b.ts","dup1.d.ts","dup2.d.ts","dup-aug.d.ts"]}',
      // "lib" is declared in one file and augmented in a module file.
      'node_modules/@types/lib/package.json': '{"name":"@types/lib","version":"1.0.0"}',
      'node_modules/@types/lib/index.d.ts':
        '/// <reference path="base.d.ts" />\ndeclare module "lib" { export const x: number; }\n',
      'node_modules/@types/lib/base.d.ts': 'export {};\ndeclare module "lib" { export const y: number; }\n',
      // "dup" is declared in two files and augmented in a module file.
      'dup1.d.ts': 'declare module "dup" { export const d1: number; }\n',
      'dup2.d.ts': 'declare module "dup" { export const d2: number; }\n',
      'dup-aug.d.ts': 'export {};\ndeclare module "dup" { export const d3: number; }\n',
      'a.ts': 'export const a = 1;\n',
      'b.ts': 'import { x, y } from "lib";\nexport const b = x + y;\n',
    },
    steps: [
      { args: [] },
      { args: [], edit: { 'a.ts': 'export const a = 2;\n' } },
      {
        args: [],
        edit: { 'node_modules/@types/lib/base.d.ts': 'export {};\ndeclare module "lib" { export const y: string; }\n' },
      },
    ],
  },
  'dependencies of each kind of import': {
    files: {
      'tsconfig.json':
        '{"compilerOptions":{"strict":true,"incremental":true,"declaration":true,"outDir":"out","module":"nodenext"},' +
        '"files":["main.ts","d1.ts","d2.ts","d3.ts","d4.ts","d5.ts","d6.ts"]}',
      'package.json': '{"name":"app","type":"module"}',
      'main.ts':
        'import { a } from "./d1.js";\nexport { b } from "./d2.js";\nimport type { C } from "./d3.js";\n' +
        'export type D = typeof import("./d4.js");\nexport const e = () => import("./d5.js");\n' +
        'import f = require("./d6.cjs");\nexport const c: C = a;\nexport const g = f;\n',
      'd1.ts': 'export const a = 1;\n',
      'd2.ts': 'export const b = 1;\n',
      'd3.ts': 'export type C = number;\n',
      'd4.ts': 'export const d = 1;\n',
      'd5.ts': 'export const e = 1;\n',
      'd6.cts': 'export = 1;\n',
    },
    steps: [
      { args: [] },
      { args: [], edit: { 'd4.ts': 'export const d = "s";\n' } },
      { args: [], edit: { 'd6.cts': 'export = "s";\n' } },
      { args: [] },
    ],
  },
  'modules augmented in several files': {
    files: {
      'tsconfig.json':
        '{"compilerOptions":{"strict":true,"noEmit":true,"incremental":true,"esModuleInterop":true,"types":[]},' +
        '"files":["a.ts","m.ts","m-aug1.ts","m-aug2.ts"]}',
      // A package whose `export =` target is augmented in two files.
      'node_modules/@types/lib/package.json': '{"name":"@types/lib","version":"1.0.0"}',
      'node_modules/@types/lib/index.d.ts':
        '/// <reference path="./common/one.d.ts" />\n/// <reference path="./common/two.d.ts" />\n' +
        'export = _;\nexport as namespace _;\ndeclare const _: _.Static;\ndeclare namespace _ {\n  interface Static {}\n}\n',
      'node_modules/@types/lib/common/one.d.ts':
        'import _ = require("../index");\ndeclare module "../index" {\n  interface Static { one(): number; }\n}\n',
      'node_modules/@types/lib/common/two.d.ts':
        'import _ = require("../index");\ndeclare module "../index" {\n  interface Static { two(): number; }\n}\n',
      // A module of the program augmented in two files.
      'm.ts': 'export interface M { m: number; }\n',
      'm-aug1.ts': 'export {};\ndeclare module "./m" { interface M { aug1: number; } }\n',
      'm-aug2.ts': 'export {};\ndeclare module "./m" { interface M { aug2: number; } }\n',
      'a.ts':
        'import _ from "lib";\nimport type { M } from "./m";\nexport const a = (m: M) => _.one() + _.two() + m.aug1;\n',
    },
    steps: [
      { args: [] },
      { args: [], edit: { 'm-aug2.ts': 'export {};\ndeclare module "./m" { interface M { aug2: string; } }\n' } },
      {
        args: [],
        edit: {
          'node_modules/@types/lib/common/two.d.ts':
            'import _ = require("../index");\ndeclare module "../index" {\n  interface Static { two(): string; }\n}\n',
        },
      },
    ],
  },
  'type references that are not found in files whose diagnostics are not reported': {
    files: {
      'tsconfig.json':
        '{"compilerOptions":{"strict":true,"skipLibCheck":true,"composite":true,"types":[]},' +
        '"files":["a.ts","b.ts","env.d.ts"]}',
      // Not checked with skipLibCheck.
      'env.d.ts': '/// <reference types="missing-env" />\n',
      // Filtered by the directive.
      'b.ts': '// @ts-ignore\n/// <reference types="missing-b" />\nexport const b = 1;\n',
      'a.ts': 'export const a = 1;\n',
    },
    steps: [
      { args: [] },
      { args: ['-b', '-v'] },
      { args: ['-b', '-v'], edit: { 'a.ts': 'export const a = 2;\n' } },
      {
        args: ['-b', '-v'],
        edit: {
          'tsconfig.json':
            '{"compilerOptions":{"strict":true,"composite":true,"types":[]},"files":["a.ts","b.ts","env.d.ts"]}',
        },
      },
      { args: ['-b', '-v'] },
    ],
  },
  'explainFiles and statistics': {
    files: {
      'tsconfig.json': '{"compilerOptions":{"outDir":"out"},"files":["a.ts"]}',
      'a.ts': 'import "./b";\nexport const a = 1;\n',
      'b.ts': 'export {};\n',
    },
    steps: [{ args: ['--explainFiles'] }, { args: ['--diagnostics'] }, { args: ['--extendedDiagnostics', '--noEmit'] }],
  },
  'signatures of files whose declaration files are empty': {
    files: {
      'tsconfig.json': '{"compilerOptions":{"strict":true,"incremental":true,"outDir":"out"},"files":["m.ts","g.ts"]}',
      'm.ts': 'export interface I { a: number; }\n',
      // A script whose declarations are all inside a function: its declaration file is empty.
      'g.ts': '(function () {\n  type T = import("./m").I;\n  const t: T = { a: 1 };\n  console.log(t);\n})();\n',
    },
    steps: [
      { args: [] },
      { args: [], edit: { 'm.ts': 'export interface I { a: number; }\n// edit\n' } },
      { args: [], edit: { 'm.ts': 'export interface I { a: number; b?: string; }\n' } },
      { args: [] },
    ],
  },
};

function writeFiles(dir, files) {
  for (const [path, text] of Object.entries(files)) {
    const file = join(dir, path);
    if (text === null) rmSync(file, { force: true });
    else {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, text);
    }
  }
}

function readFiles(dir) {
  const result = {};
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else result[relative(dir, file)] = readFileSync(file, 'utf8');
    }
  };
  walk(dir);
  return result;
}

/**
 * Makes `files` newer than everything else in `dir` and older than anything written next, however long the
 * next build takes: shifts every file 10 s into the past, keeping their order, then dates `files` just after
 * the newest of them.
 */
function touch(dir, files) {
  let newest = 0;
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else {
        const time = statSync(file).mtimeMs - 10_000;
        utimesSync(file, new Date(time), new Date(time));
        newest = Math.max(newest, time);
      }
    }
  };
  walk(dir);
  const later = new Date(newest + 1000);
  for (const file of files) utimesSync(join(dir, file), later, later);
}

/** Masks what differs between runs: clock times, durations, memory, and counts that depend on checker internals. */
function normalize(text, dir) {
  return (
    text
      .replaceAll(dir, '<dir>')
      .replace(/\d\d:\d\d:\d\d [AP]M/g, '<time>')
      .replace(/^((?:Aggregate )?[A-Za-z][A-Za-z ]+:) +\S+$/gm, '$1 <value>')
      // Outputs written in the same clock tick have the same time, so which one is oldest varies.
      .replace(/(is older than output )'[^']*'/g, "$1'<output>'")
  );
}

function run(command, args, cwd) {
  const env = { PATH: process.env.PATH ?? '', TSC_TS_BUNDLED_LIBS: bundledLibs, NO_COLOR: '1' };
  const result = spawnSync(command[0], [...command.slice(1), ...args], { cwd, env, encoding: 'utf8' });
  return { output: result.stdout + result.stderr, status: result.status };
}

for (const [name, scenario] of Object.entries(scenarios)) {
  test(name, { skip }, () => {
    const dirs = { tsgo: tempDir('tsc-ts-build-tsgo-'), ours: tempDir('tsc-ts-build-ours-') };
    for (const dir of Object.values(dirs)) writeFiles(dir, scenario.files);
    const failures = [];
    for (const [index, step] of scenario.steps.entries()) {
      const results = {};
      for (const [which, dir] of Object.entries(dirs)) {
        if (step.edit) writeFiles(dir, step.edit);
        if (step.touch) touch(dir, step.touch);
        const { output, status } = run(which === 'tsgo' ? [tsgo] : tscTs, step.args, join(dir, step.cwd ?? '.'));
        const files = readFiles(dir);
        for (const [file, text] of Object.entries(files)) files[file] = normalize(text, dir);
        results[which] = { output: normalize(output, dir), status, files };
      }
      const label = `step ${index + 1} (tsc ${step.args.join(' ')})`;
      const { tsgo: expected, ours: actual } = results;
      if (expected.output !== actual.output) {
        failures.push(`${label}: output\n--- tsgo\n${expected.output}\n--- ours\n${actual.output}`);
      }
      if (expected.status !== actual.status)
        failures.push(`${label}: status tsgo ${expected.status}, ours ${actual.status}`);
      const files = new Set([...Object.keys(expected.files), ...Object.keys(actual.files)]);
      for (const file of [...files].sort()) {
        if (expected.files[file] === actual.files[file]) continue;
        if (expected.files[file] === undefined || actual.files[file] === undefined) {
          failures.push(`${label}: ${file} written only by ${expected.files[file] === undefined ? 'tsc-ts' : 'tsgo'}`);
        } else {
          failures.push(`${label}: ${file}\n--- tsgo\n${expected.files[file]}\n--- ours\n${actual.files[file]}`);
        }
      }
      if (failures.length > 0) break;
    }
    assert.deepEqual(failures, []);
  });
}

// tsgo leaves out of build info the modules of JavaScript `require` calls that do not initialize a variable, and its
// incremental builds then keep outputs that depend on them; tsc-ts records them, so its output matches a clean build.
test('JavaScript require dependencies are rebuilt', { skip: tscTsMissing }, () => {
  const files = {
    'tsconfig.json':
      '{"compilerOptions":{"allowJs":true,"checkJs":true,"declaration":true,"incremental":true,"outDir":"out",' +
      '"module":"commonjs"},"files":["main.js","dep.js","dep2.js","dep3.js"]}',
    'main.js':
      'exports.value = require("./dep").value;\nmodule.exports.other = require("./dep2");\n' +
      '/** @type {number} */\nexports.m = require("./dep3").m;\n',
    'dep.js': 'exports.value = 1;\n',
    'dep2.js': 'exports.other = 1;\n',
    'dep3.js': 'module.exports = { m: 1 };\n',
  };
  const edit = {
    'dep.js': 'exports.value = "s";\n',
    'dep2.js': 'exports.other = "s";\n',
    'dep3.js': 'module.exports = { m: "s" };\n',
  };
  const incremental = tempDir('tsc-ts-build-require-');
  writeFiles(incremental, files);
  run(tscTs, [], incremental);
  writeFiles(incremental, edit);
  const rebuilt = run(tscTs, [], incremental);
  const clean = tempDir('tsc-ts-build-require-clean-');
  writeFiles(clean, files);
  writeFiles(clean, edit);
  const expected = run(tscTs, [], clean);
  assert.equal(normalize(rebuilt.output, incremental), normalize(expected.output, clean));
  assert.equal(rebuilt.status, expected.status);
  const outputs = (dir) =>
    Object.fromEntries(Object.entries(readFiles(join(dir, 'out'))).filter(([file]) => !file.endsWith('.tsbuildinfo')));
  assert.deepEqual(outputs(incremental), outputs(clean));
});

// tsgo's file watching doesn't report changes in every environment, so watch mode is checked against the output
// tsgo prints for the same sequence.
test('--watch rebuilds on changes', { skip: tscTsMissing, timeout: 120_000 }, async () => {
  const dir = tempDir('tsc-ts-watch-');
  writeFiles(dir, {
    'tsconfig.json': '{"compilerOptions":{"outDir":"out","rootDir":"src"},"include":["src"]}',
    'src/a.ts': 'export const a: number = 1;\n',
  });
  const env = { PATH: process.env.PATH ?? '', TSC_TS_BUNDLED_LIBS: bundledLibs, NO_COLOR: '1' };
  const child = spawn(tscTs[0], [...tscTs.slice(1), '--watch', '--preserveWatchOutput'], { cwd: dir, env });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  const waitFor = async (count) => {
    const deadline = Date.now() + 60_000;
    while ((output.match(/Watching for file changes/g) ?? []).length < count) {
      if (Date.now() > deadline) throw new Error('timed out; output so far:\n' + output);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  try {
    await waitFor(1);
    writeFiles(dir, { 'src/a.ts': 'export const a: string = 1;\n' });
    await waitFor(2);
    writeFiles(dir, { 'src/b.ts': 'export const b = 2;\n' });
    await waitFor(3);
  } finally {
    child.kill();
  }
  const error = "src/a.ts(1,14): error TS2322: Type 'number' is not assignable to type 'string'.\n";
  assert.equal(
    normalize(output, dir),
    '<time> - Starting compilation in watch mode...\n\n' +
      '<time> - Found 0 errors. Watching for file changes.\n\n' +
      '<time> - File change detected. Starting incremental compilation...\n\n' +
      error +
      '<time> - Found 1 error. Watching for file changes.\n\n' +
      '<time> - File change detected. Starting incremental compilation...\n\n' +
      error +
      '<time> - Found 1 error. Watching for file changes.\n\n',
  );
  assert.deepEqual(Object.keys(readFiles(join(dir, 'out'))).sort(), ['a.js', 'b.js']);
});
