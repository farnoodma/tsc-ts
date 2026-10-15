// Compiles small projects reduced from real-world code through tsgo (packages/tsgo/dist/tsgo) and
// tsc-ts (the Node build, or TSC_TS_BIN), and compares stdout, stderr, exit status and the files
// written to `out`.
// Set PROJECTS_FILTER to a substring of project names to run only those.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './temp.mjs';
import { tscTs, tscTsMissing } from './toolchain.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const tsgo = join(root, 'packages/tsgo/dist/tsgo');
const bundledLibs = join(root, 'upstream/typescript-go/internal/bundled/libs');
const skip = (!existsSync(tsgo) && 'needs packages/tsgo/dist/tsgo') || tscTsMissing;

const base = { target: 'ES2022', strict: true, noEmit: true, types: [] };

const nestedKeyOf =
  'export type NestedKeyOf<T, K = keyof T> = K extends keyof T & (string | number)\n' +
  '  ? `${K}` | (T[K] extends object ? `${K}.${NestedKeyOf<T[K]>}` : never)\n' +
  '  : never;\n';

/** Projects as `[name, files, args]`; files without a tsconfig.json get one with `base` options. */
const projects = [
  [
    'JSON default import',
    {
      'a.ts':
        'import data from "./data.json";\nimport * as ns from "./data.json";\n' +
        'export const n: number = data;\nexport const m: number = ns.labels.paste;\n',
      'data.json': '{ "labels": { "paste": "Paste", "count": 1 }, "list": [1, 2] }\n',
      'tsconfig.json': JSON.stringify({
        compilerOptions: { ...base, module: 'ESNext', moduleResolution: 'bundler', resolveJsonModule: true },
        files: ['a.ts'],
      }),
    },
  ],
  [
    'nested keys of a JSON module',
    {
      'a.ts':
        'import data from "./en.json";\n' +
        nestedKeyOf +
        'export type Keys = NestedKeyOf<typeof data>;\n' +
        'export const t = (path: Keys) => path;\nt("labels.paste");\nt("labels.missing");\n',
      'en.json': '{ "labels": { "paste": "Paste", "copy": "Copy" }, "empty": {}, "title": "Title" }\n',
      'tsconfig.json': JSON.stringify({
        compilerOptions: { ...base, module: 'ESNext', moduleResolution: 'bundler', resolveJsonModule: true },
        files: ['a.ts'],
      }),
    },
  ],
  [
    'object literal returned by a contextually generic arrow',
    {
      'a.ts':
        'declare function walker<N>(visit: <U>(f: (data: N) => U) => { get: () => U[] }): N;\n' +
        'export const make = <N>(m: <U>(f: (data: N) => U) => U[]): N =>\n' +
        '  walker((f) => ({ get: () => m((data) => f(data)) }));\n' +
        'export const wrong = <N>(m: <U>(f: (data: N) => U) => U[]): N =>\n' +
        '  walker((f) => ({ get: () => m((data) => String(f(data))) }));\n',
    },
  ],
  [
    'iterable walker built from a generic iterator factory',
    {
      'a.ts':
        'export class Walker<T, N> {\n' +
        '  constructor(readonly visit: <U>(f: (index: T, data: N) => U) => Iterable<U>) {}\n' +
        '}\n' +
        'export const walk = <N>(\n' +
        '  make: <U>(f: (index: number, data: N) => U) => Iterator<U>,\n' +
        '): Walker<number, N> =>\n' +
        '  new Walker((f) => ({ [Symbol.iterator]: () => make((index, data) => f(index, data)) }));\n' +
        'export const nodes = <N>(data: N[]): Walker<number, N> =>\n' +
        '  walk<N>((f) => {\n' +
        '    let i = 0;\n' +
        '    return {\n' +
        '      next() {\n' +
        '        if (i < data.length) return { done: false, value: f(i, data[i++]!) };\n' +
        '        return { done: true, value: undefined } as const;\n' +
        '      },\n' +
        '    };\n' +
        '  });\n',
      'tsconfig.json': JSON.stringify({
        compilerOptions: { ...base, lib: ['ES2022'], exactOptionalPropertyTypes: true },
        files: ['a.ts'],
      }),
    },
  ],
  [
    'asserted unique symbol in an inferred object literal',
    {
      'a.ts':
        'export const TypeId: unique symbol = Symbol.for("x");\n' +
        'export type TypeId = typeof TypeId;\n' +
        'interface Client { readonly [TypeId]: TypeId; config: string; other: number }\n' +
        'declare function identity<A>(a: A): A;\n' +
        'declare function assign<T, U>(t: T, u: U): T & U;\n' +
        'declare const base: { other: number };\n' +
        'export const c = identity<Client>(assign(base, { [TypeId]: TypeId as TypeId, config: "x" }));\n' +
        'export const d = identity<Client>(assign(base, { [TypeId]: (<TypeId>TypeId), config: "x" }));\n' +
        'export const e = identity<Client>(assign(base, { [TypeId]: TypeId, config: "x" }));\n' +
        'export const f = assign(base, { n: 1 as 1, s: "s" as "s" });\n' +
        'export const g: { n: 1 } = f;\n',
      'tsconfig.json': JSON.stringify({ compilerOptions: { ...base, lib: ['ES2022'] }, files: ['a.ts'] }),
    },
  ],
  [
    'narrowing a NoInfer parameter',
    {
      'a.ts':
        'declare function transform<T, E>(o: { readonly decode: (input: E) => T }): { readonly decode: (e: E) => T };\n' +
        'type Decode<E, T> = { readonly decode: (e: NoInfer<E>) => NoInfer<T> };\n' +
        'export const x: Decode<ArrayBuffer | Uint8Array, Uint8Array> = transform({\n' +
        '  decode: (value) => (value instanceof ArrayBuffer ? new Uint8Array(value) : value),\n' +
        '});\n' +
        'export const y: Decode<ArrayBuffer | Uint8Array, Uint8Array> = transform({ decode: (value) => value });\n' +
        'export function f<T>(v: NoInfer<T | undefined>, d: T): T {\n' +
        '  return v === undefined ? d : v;\n' +
        '}\n',
      'tsconfig.json': JSON.stringify({ compilerOptions: { ...base, lib: ['ES2022'] }, files: ['a.ts'] }),
    },
  ],
  [
    'JSON required from checked JavaScript',
    {
      'a.js':
        'const data = require("./data.json");\n/** @type {number} */\nconst n = data.name;\nmodule.exports = n;\n',
      'data.json': '{ "name": "x", "version": 1 }\n',
      'empty.json': '',
      'tsconfig.json': JSON.stringify({
        compilerOptions: {
          ...base,
          module: 'CommonJS',
          allowJs: true,
          checkJs: true,
          resolveJsonModule: true,
        },
        files: ['a.js'],
      }),
    },
  ],
  [
    'excess property check against a union with a union-constrained type parameter',
    {
      'a.ts':
        'export function f<T extends { a: number } | { b: string }>(): void {\n' +
        '  const ok: { c: boolean } | T = { c: true };\n' +
        '  const wrong: { c: boolean } | T = { c: 1 };\n' +
        '  void ok, wrong;\n' +
        '}\n',
    },
  ],
];

// Module specifiers of inferred types: `import("…")` types in declaration emit and the TS2883
// portability check. Projects write declarations to `out`, which must match too.
const emit = { ...base, noEmit: false, declaration: true, emitDeclarationOnly: true, outDir: 'out' };
const link = (target) => ({ link: target });
const dependency = (name, types) => ({
  [`node_modules/${name}/package.json`]: JSON.stringify({ name, version: '1.0.0', types: 'index.d.ts' }),
  [`node_modules/${name}/index.d.ts`]: types,
});

projects.push(
  [
    'package name of a dependency of a dependency',
    {
      ...dependency('dep', 'export interface Inner { x: number }\n'),
      ...dependency('lib', 'import { Inner } from "dep";\nexport declare function make(): { inner: Inner };\n'),
      'src/index.ts': 'import { make } from "lib";\nexport const v = make();\nexport const w = () => make().inner;\n',
      'tsconfig.json': JSON.stringify({
        compilerOptions: { ...emit, module: 'preserve', rootDir: 'src' },
        include: ['src'],
      }),
    },
  ],
  [
    'package names through pnpm symlinks',
    {
      'package.json': JSON.stringify({ name: 'app', dependencies: { lib: '1.0.0', dep: '1.0.0' } }),
      'node_modules/.pnpm/dep@1.0.0/node_modules/dep/package.json': JSON.stringify({
        name: 'dep',
        version: '1.0.0',
        types: 'index.d.ts',
      }),
      'node_modules/.pnpm/dep@1.0.0/node_modules/dep/index.d.ts': 'export interface Inner { x: number }\n',
      'node_modules/.pnpm/lib@1.0.0/node_modules/lib/package.json': JSON.stringify({
        name: 'lib',
        version: '1.0.0',
        types: 'index.d.ts',
      }),
      'node_modules/.pnpm/lib@1.0.0/node_modules/lib/index.d.ts':
        'import { Inner } from "dep";\nexport declare function make(): { inner: Inner };\n',
      'node_modules/.pnpm/lib@1.0.0/node_modules/dep': link('../../dep@1.0.0/node_modules/dep'),
      'node_modules/lib': link('.pnpm/lib@1.0.0/node_modules/lib'),
      'node_modules/dep': link('.pnpm/dep@1.0.0/node_modules/dep'),
      'src/index.ts': 'import { make } from "lib";\nexport const v = make();\n',
      'tsconfig.json': JSON.stringify({
        compilerOptions: { ...emit, module: 'preserve', rootDir: 'src' },
        include: ['src'],
      }),
    },
  ],
  [
    'pnpm dependency the project does not declare',
    {
      'package.json': JSON.stringify({ name: 'app', dependencies: { lib: '1.0.0' } }),
      'node_modules/.pnpm/dep@1.0.0/node_modules/dep/package.json': JSON.stringify({
        name: 'dep',
        types: 'index.d.ts',
      }),
      'node_modules/.pnpm/dep@1.0.0/node_modules/dep/index.d.ts': 'export interface Inner { x: number }\n',
      'node_modules/.pnpm/lib@1.0.0/node_modules/lib/package.json': JSON.stringify({
        name: 'lib',
        types: 'index.d.ts',
      }),
      'node_modules/.pnpm/lib@1.0.0/node_modules/lib/index.d.ts':
        'import { Inner } from "dep";\nexport declare function make(): { inner: Inner };\n',
      'node_modules/.pnpm/lib@1.0.0/node_modules/dep': link('../../dep@1.0.0/node_modules/dep'),
      'node_modules/lib': link('.pnpm/lib@1.0.0/node_modules/lib'),
      'src/index.ts': 'import { make } from "lib";\nexport const v = make();\n',
      'tsconfig.json': JSON.stringify({
        compilerOptions: { ...emit, module: 'preserve', rootDir: 'src' },
        include: ['src'],
      }),
    },
  ],
  [
    'workspace package linked into node_modules',
    {
      'package.json': JSON.stringify({ name: 'root', private: true, workspaces: ['packages/*'] }),
      'packages/a/package.json': JSON.stringify({ name: '@ws/a', version: '1.0.0', types: 'dist/index.d.ts' }),
      'packages/a/dist/index.d.ts':
        'import type { Options } from "./options";\nexport interface Config { options: Options }\nexport declare function config(): Config;\n',
      'packages/a/dist/options.d.ts': 'export interface Options { strict: boolean }\n',
      'packages/b/package.json': JSON.stringify({ name: '@ws/b', version: '1.0.0', dependencies: { '@ws/a': '*' } }),
      'packages/b/src/index.ts':
        'import { config } from "@ws/a";\nexport const c = config();\nexport const o = () => config().options;\n',
      'packages/b/tsconfig.json': JSON.stringify({
        compilerOptions: { ...emit, module: 'preserve', rootDir: 'src' },
        include: ['src'],
      }),
      'node_modules/@ws/a': link('../../packages/a'),
      'node_modules/@ws/b': link('../../packages/b'),
    },
    ['-p', 'packages/b'],
  ],
  [
    'package exports with import and require conditions',
    {
      'node_modules/lib/package.json': JSON.stringify({
        name: 'lib',
        version: '1.0.0',
        type: 'module',
        exports: {
          '.': { types: './types/index.d.ts', default: './index.js' },
          './feature': {
            import: { types: './types/feature.d.mts', default: './feature.mjs' },
            require: { types: './types/feature.d.cts', default: './feature.cjs' },
          },
          './utils/*': { types: './types/utils/*.d.ts' },
        },
      }),
      'node_modules/lib/types/index.d.ts':
        'export { make } from "./internal.js";\nexport * from "./utils/strings.js";\n',
      'node_modules/lib/types/internal.d.ts':
        'export interface Hidden { h: 1 }\nexport declare function make(): Hidden;\n',
      'node_modules/lib/types/utils/strings.d.ts':
        'export interface Str { s: string }\nexport declare function str(): Str;\n',
      'node_modules/lib/types/feature.d.mts': 'export interface F { f: 1 }\nexport declare function feature(): F;\n',
      'node_modules/lib/types/feature.d.cts': 'export interface FC { f: 2 }\nexport declare function feature(): FC;\n',
      'src/a.mts':
        'import { feature } from "lib/feature";\nimport { str } from "lib";\nexport const f = () => feature();\nexport const s = () => str();\n',
      'src/b.cts': 'import { feature } from "lib/feature";\nexport const f = () => feature();\n',
      'src/c.mts': 'import { make } from "lib";\nexport const h = make();\n',
      'tsconfig.json': JSON.stringify({
        compilerOptions: { ...emit, module: 'nodenext', rootDir: 'src' },
        include: ['src'],
      }),
    },
  ],
  [
    'typesVersions of a dependency',
    {
      'node_modules/tv/package.json': JSON.stringify({
        name: 'tv',
        version: '1.0.0',
        types: 'index.d.ts',
        typesVersions: { '*': { '*': ['ts/*'] } },
      }),
      'node_modules/tv/ts/index.d.ts': 'export * from "./sub";\n',
      'node_modules/tv/ts/sub.d.ts':
        'import { Deep } from "./deep/thing";\nexport declare function s(): { deep: Deep };\n',
      'node_modules/tv/ts/deep/thing.d.ts': 'export interface Deep { d: 1 }\n',
      'src/index.ts': 'import { s } from "tv";\nexport const v = s();\n',
      'tsconfig.json': JSON.stringify({
        compilerOptions: { ...emit, module: 'preserve', rootDir: 'src' },
        include: ['src'],
      }),
    },
  ],
  [
    'paths to a directory outside the project',
    {
      'lib/deep/thing.ts':
        'import type { Inner } from "@lib/other/inner";\nexport function thing(): { inner: Inner } { return { inner: { i: 1 } }; }\n',
      'lib/other/inner.ts': 'export interface Inner { i: number }\n',
      'app/src/index.ts': 'import { thing } from "@lib/deep/thing";\nexport const v = thing();\n',
      'app/tsconfig.json': JSON.stringify({
        compilerOptions: { ...emit, module: 'preserve', rootDir: '..', paths: { '@lib/*': ['../lib/*'] } },
        include: ['src'],
      }),
    },
    ['-p', 'app'],
  ],
  [
    'paths inside the project',
    {
      'src/lib/deep/thing.ts':
        'import type { Inner } from "@lib/other/inner";\nexport function thing(): { inner: Inner } { return { inner: { i: 1 } }; }\n',
      'src/lib/other/inner.ts': 'export interface Inner { i: number }\n',
      'src/app/index.ts': 'import { thing } from "@lib/deep/thing";\nexport const v = thing();\n',
      'tsconfig.json': JSON.stringify({
        compilerOptions: { ...emit, module: 'preserve', rootDir: 'src', paths: { '@lib/*': ['./src/lib/*'] } },
        include: ['src'],
      }),
    },
  ],
  [
    'rootDirs',
    {
      'src/index.ts': 'import { make } from "./generated";\nexport const v = make();\n',
      'generated/generated.ts':
        'import type { Shape } from "./shape";\nexport function make(): { shape: Shape } { return { shape: { n: 1 } }; }\n',
      'generated/shape.ts': 'export interface Shape { n: number }\n',
      'tsconfig.json': JSON.stringify({
        compilerOptions: { ...emit, module: 'preserve', rootDir: '.', rootDirs: ['src', 'generated'] },
        include: ['src'],
      }),
    },
  ],
  [
    'node16 endings of ES modules and CommonJS files',
    {
      'package.json': JSON.stringify({ name: 'app', type: 'module' }),
      'src/lib/util.ts': 'export interface U { u: 1 }\nexport function u(): U { return { u: 1 }; }\n',
      'src/lib/index.ts': 'export { u } from "./util.js";\n',
      'src/main.ts': 'import { u } from "./lib/index.js";\nexport const v = u();\n',
      'src/c/helper.cts': 'export interface H { h: 1 }\nexport function h(): H { return { h: 1 }; }\n',
      'src/c/index.cts': 'export { h } from "./helper.cjs";\n',
      'src/d.cts': 'import { h } from "./c/index.cjs";\nexport const x = h();\n',
      'node_modules/esm-only/package.json': JSON.stringify({
        name: 'esm-only',
        version: '1.0.0',
        type: 'module',
        exports: { '.': { import: { types: './index.d.ts', default: './index.js' } } },
      }),
      'node_modules/esm-only/index.d.ts': 'export interface E { e: 1 }\nexport declare function e(): E;\n',
      'src/e.cts': 'export const p = import("esm-only").then((m) => m.e());\n',
      'tsconfig.json': JSON.stringify({
        compilerOptions: { ...emit, module: 'node16', rootDir: 'src', lib: ['ES2022'] },
        include: ['src'],
      }),
    },
  ],
  [
    'import types reused from another directory',
    {
      'src/deep/a.ts':
        'export function f(): import("./b").B { return { b: 1 }; }\n' +
        'export declare const holder: { item: import("./b").B; list: import("./b").B[] };\n' +
        'export class K { m(): import("./b").B { return { b: 1 }; } p!: import("./b").B; }\n',
      'src/deep/b.ts': 'export interface B { b: number }\n',
      'src/index.ts':
        'import { f, holder, K } from "./deep/a";\n' +
        'export const h = { ...holder };\nexport const mm = new K().m;\nexport const pp = { p: new K().p, f };\n',
      'tsconfig.json': JSON.stringify({
        compilerOptions: { ...emit, module: 'preserve', rootDir: 'src' },
        include: ['src'],
      }),
    },
  ],
);

/** Writes `files`; a `{ link }` value is a symlink to the relative path `link`. */
function writeFiles(dir, files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    if (typeof content === 'string') writeFileSync(join(dir, path), content);
    else symlinkSync(content.link, join(dir, path));
  }
}

/** The files under `dir`, by path relative to `root`. */
function readOutputs(root, dir, outputs = {}) {
  if (!existsSync(dir)) return outputs;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) readOutputs(root, path, outputs);
    else outputs[relative(root, path)] = readFileSync(path, 'utf8');
  }
  return outputs;
}

function run(command, files, args) {
  const cwd = tempDir('tsc-ts-projects-');
  writeFiles(cwd, files);
  const env = { PATH: process.env.PATH ?? '', TSC_TS_LIB_DIR: bundledLibs, NO_COLOR: '1' };
  return new Promise((done) => {
    execFile(
      command[0],
      [...command.slice(1), ...(args.includes('-p') ? [] : ['-p', '.']), '--pretty', 'false', ...args],
      { cwd, env, encoding: 'utf8', maxBuffer: 1 << 26 },
      (error, stdout, stderr) => {
        const status = error ? (typeof error.code === 'number' ? error.code : -1) : 0;
        const project = args.includes('-p') ? args[args.indexOf('-p') + 1] : '.';
        done({ stdout, stderr, status, outputs: readOutputs(cwd, join(cwd, project, 'out')) });
      },
    );
  });
}

test('projects reduced from real-world code match tsgo', { skip, timeout: 300_000 }, async () => {
  const filter = process.env.PROJECTS_FILTER;
  const failures = [];
  await Promise.all(
    projects
      .filter(([name]) => filter === undefined || name.includes(filter))
      .map(async ([name, source, args = []]) => {
        const files =
          'tsconfig.json' in source
            ? source
            : { ...source, 'tsconfig.json': JSON.stringify({ compilerOptions: base }) };
        const [expected, actual] = await Promise.all([run([tsgo], files, args), run(tscTs, files, args)]);
        const problems = [];
        if (expected.stdout !== actual.stdout)
          problems.push(`stdout\n  tsgo: ${expected.stdout}\n  ours: ${actual.stdout}`);
        if (expected.stderr !== actual.stderr)
          problems.push(`stderr\n  tsgo: ${expected.stderr}\n  ours: ${actual.stderr}`);
        if (expected.status !== actual.status) problems.push(`status tsgo ${expected.status}, ours ${actual.status}`);
        for (const path of new Set([...Object.keys(expected.outputs), ...Object.keys(actual.outputs)]))
          if (expected.outputs[path] !== actual.outputs[path])
            problems.push(`${path}\n  tsgo: ${expected.outputs[path]}\n  ours: ${actual.outputs[path]}`);
        if (problems.length > 0) failures.push(`${name}: ${problems.join('\n')}`);
      }),
  );
  assert.deepEqual(failures, []);
});
