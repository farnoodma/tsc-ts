import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { compileSources } from './temp.mjs';

const root = resolve(import.meta.dirname, '..');
const repo = resolve(root, '../..');
const libs = join(repo, 'upstream/typescript-go/internal/bundled/libs');
const oracle = join(repo, 'packages/tsgo/dist/check-oracle');

const cases = [
  {
    name: 'assignability, missing properties and arity',
    source: [
      'let x: number = "a";',
      'const y = { a: 1, b: "x" };',
      'y.c;',
      'function f(a: number, b: string): number { return a; }',
      'f(1);',
      'f(1, 2);',
      'const s: string = f(1, "a");',
      'class C { p: number; m() { return this.p; } }',
      'new C().m().toFixed();',
      '[1, 2].map(v => v.toFixed());',
    ],
    expected: [
      "/input.ts 2322 4 1 Type 'string' is not assignable to type 'number'.",
      "/input.ts 2339 51 1 Property 'c' does not exist on type '{ a: number; b: string; }'.",
      '/input.ts 2554 109 1 Expected 2 arguments, but got 1.',
      "/input.ts 2345 120 1 Argument of type 'number' is not assignable to parameter of type 'string'.",
      "/input.ts 2322 130 1 Type 'number' is not assignable to type 'string'.",
      "/input.ts 2564 163 1 Property 'p' has no initializer and is not definitely assigned in the constructor.",
    ],
  },
  {
    name: 'narrowing and definite assignment',
    source: [
      'declare const a: string | undefined;',
      'if (a) a.length;',
      'a.length;',
      'let b: number;',
      'b.toFixed();',
      'function f(x: string | number) {',
      '  if (typeof x === "string") return x.length;',
      '  return x.toFixed();',
      '}',
      'type S = { kind: "a"; a: number } | { kind: "b"; b: string };',
      'function g(s: S) {',
      '  switch (s.kind) {',
      '    case "a": return s.a;',
      '    case "b": return s.b;',
      '  }',
      '}',
    ],
    expected: [
      "/input.ts 18048 54 1 'a' is possibly 'undefined'.",
      "/input.ts 2454 79 1 Variable 'b' is used before being assigned.",
    ],
  },
  {
    name: 'unresolved names with suggestions',
    source: ['const count = 1;', 'cuont;'],
    expected: ["/input.ts 2552 17 5 Cannot find name 'cuont'. Did you mean 'count'?"],
  },
  {
    // A const type parameter makes the literals of its argument const, but not the branches of a
    // conditional or a `satisfies` operand in it (T3 Code: `Effect.all([a, b, ...(c ? [d] : [])])`).
    name: 'const type parameter contexts stop at conditionals and satisfies',
    source: [
      "declare function all<const T extends Iterable<{ readonly tag: 'e' }> | Record<string, unknown>>(arg: T): T;",
      "declare const e: { readonly tag: 'e' };",
      'declare const cond: boolean;',
      'all([e, e, e, ...(cond ? [e] : [])]);',
      'all([...(cond ? [] : [e]), e, e]);',
      'declare function f<const T>(x: T): T;',
      'const n: number = f({ a: cond ? [1] : [2, 3], b: [4] satisfies number[] });',
    ],
    expected: [
      "/input.ts 2322 294 1 Type '{ readonly a: number[]; readonly b: number[]; }' is not assignable to type 'number'.",
    ],
  },
  {
    // Inferences flow between the context-sensitive elements of an array literal only in a tuple
    // context: in `f`, `T` is fixed at `b` before the first element's return type is inferred.
    name: 'intra-expression inference in array literals needs a tuple context',
    source: [
      'declare function f<T>(fns: ((a: number, b: T) => T)[]): T;',
      'const r = f([(a) => a, (a, b) => b]);',
      'const n: number = r;',
      'declare function g<T>(fns: [(a: number) => T, (b: T) => void]): T;',
      'const s = g([(a) => a, (b) => b.toFixed()]);',
      'const m: number = s;',
    ],
    expected: ["/input.ts 2322 103 1 Type 'unknown' is not assignable to type 'number'."],
  },
  {
    // The `children` property made from an element's body is an excess property like an attribute.
    name: 'JSX children are checked as excess properties',
    file: 'input.tsx',
    source: [
      '// @jsx: preserve',
      'declare namespace JSX {',
      '  interface Element {}',
      '  interface ElementChildrenAttribute { children: {} }',
      '}',
      'interface Props { resizable?: boolean }',
      'declare function Demo(props: Props): JSX.Element;',
      'const a = <Demo resizable>text</Demo>;',
      'const b = <Demo resizable />;',
    ],
    expected: [
      "/input.tsx 2322 222 4 Type '{ resizable: true; children: string; }' is not assignable to type 'Props'.",
    ],
  },
  {
    // A function with `@param` tags has the `arguments` references of its body resolved, in TypeScript files too.
    name: '`const arguments` in a function with JSDoc parameters',
    source: [
      'class A {',
      '  /** @param {object} [foo] */',
      '  constructor(foo = {}) {',
      '    const arguments = foo;',
      '  }',
      '}',
    ],
    expected: [
      "/input.ts 1210 77 9 Code contained in a class is evaluated in JavaScript's strict mode which does not allow this use of 'arguments'. For more information, see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Strict_mode.",
      "/input.ts 2448 77 9 Block-scoped variable 'arguments' used before its declaration.",
    ],
  },
];

test(
  'checker matches tsgo on small cases',
  { skip: !existsSync(libs) && 'needs upstream sources', timeout: 300_000 },
  () => {
    const out = compileSources('tsc-ts-check-', ['drivers/check.ts']);
    for (const { name, file: fileName = 'input.ts', source, expected } of cases) {
      const file = join(out, fileName);
      writeFileSync(file, source.join('\n') + '\n');
      const actual = execFileSync(process.execPath, ['--stack-size=16000', join(out, 'drivers/check.js'), file, libs], {
        encoding: 'utf8',
      });
      const lines = actual.split('\n').filter((l) => l !== '');
      assert.deepEqual(lines, expected, name);
      if (existsSync(oracle)) {
        const reference = execFileSync(oracle, [file, libs], { encoding: 'utf8' })
          .split('\n')
          .filter((l) => l !== '');
        assert.deepEqual(lines, reference, name + ' (oracle)');
      }
    }
  },
);
