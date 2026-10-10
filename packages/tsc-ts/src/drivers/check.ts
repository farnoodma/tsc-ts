// Checks a file against the bundled libs and prints its diagnostics in the format of the reference
// check oracle: `<file> <code> <pos> <len> <message>` with UTF-8 offsets.
// A .tsx file is checked as `/input.tsx` with the JSX options of its `@jsx`, `@jsxFactory`,
// `@jsxFragmentFactory` and `@jsxImportSource` directives. A test case whose files are all JavaScript
// and that sets @checkJs is checked as `/input.js` with allowJs and checkJs.
// Usage: check FILE LIBDIR [--batch|--bench]
//   --batch  FILE lists input files, one per line; each is printed after `== <path>`
//   --bench  times parsing, binding and checking FILE
import { readFileSync, writeSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import {
  ExternalModuleIndicatorOptions,
  type Node,
  ParseOptions,
  ScriptKind,
  type SourceFile,
} from '../compiler/ast.js';
import { bindSourceFile } from '../compiler/binder.js';
import { Checker, CheckerHost, disposeChecker } from '../compiler/checker.js';
import { type Diagnostic, Locale } from '../compiler/diagnostics.js';
import { type CompilerOptions, JsxEmit, ModuleKind, ScriptTarget } from '../compiler/options.js';
import { parseSourceFile } from '../compiler/parser.js';
import { getDefaultLibFileName, getLibFileName } from '../compiler/program-utilities.js';

const libDirectory = '/libs/';

class CheckHost extends CheckerHost {
  readonly options: CompilerOptions;
  readonly files: SourceFile[];
  readonly libs: Set<SourceFile>;

  constructor(options: CompilerOptions, files: SourceFile[], libs: Set<SourceFile>) {
    super();
    this.options = options;
    this.files = files;
    this.libs = libs;
  }

  getCompilerOptions(): CompilerOptions {
    return this.options;
  }

  getSourceFiles(): readonly SourceFile[] {
    return this.files;
  }

  isSourceFileDefaultLibrary(file: SourceFile): boolean {
    return this.libs.has(file);
  }

  getJSXRuntimeImportSpecifier(_file: SourceFile): Node | undefined {
    return undefined;
  }

  getEmitSyntaxForUsageLocation(_file: SourceFile, _usage: Node): ModuleKind {
    return ModuleKind.ESNext;
  }
}

/** Parsed and bound lib files, shared by every program. */
class LibLoader {
  readonly directory: string;
  readonly cache = new Map<string, SourceFile>();
  readonly files: SourceFile[] = [];
  readonly libs = new Set<SourceFile>();

  constructor(directory: string, options: CompilerOptions) {
    this.directory = directory;
    this.add(getDefaultLibFileName(options));
  }

  private add(name: string): void {
    if (this.cache.has(name)) return;
    let text: string;
    try {
      text = readFileSync(this.directory + '/' + name, 'utf8');
    } catch {
      return;
    }
    const file = parse(libDirectory + name, text);
    this.cache.set(name, file);
    for (const ref of file.libReferenceDirectives) {
      const libName = getLibFileName(ref.fileName);
      if (libName !== '') this.add(libName);
    }
    bindSourceFile(file);
    this.files.push(file);
    this.libs.add(file);
  }
}

function parse(fileName: string, text: string): SourceFile {
  return parseSourceFile(
    fileName,
    text,
    new ParseOptions(fileName, ScriptKind.Unknown, new ExternalModuleIndicatorOptions(false, false)),
  );
}

function createOptions(): CompilerOptions {
  const options: CompilerOptions = {};
  options.strict = true;
  options.target = ScriptTarget.ESNext;
  options.noEmit = true;
  return options;
}

function jsxEmit(value: string): JsxEmit | undefined {
  switch (value) {
    case 'preserve':
      return JsxEmit.Preserve;
    case 'react-native':
      return JsxEmit.ReactNative;
    case 'react':
      return JsxEmit.React;
    case 'react-jsx':
      return JsxEmit.ReactJSX;
    case 'react-jsxdev':
      return JsxEmit.ReactJSXDev;
  }
  return undefined;
}

/** The options of a .tsx test case: the defaults and the first value of each JSX directive. */
function createJsxOptions(text: string): CompilerOptions {
  const options = createOptions();
  for (const m of text.matchAll(/^[ \t]*\/\/[ \t]*@(\w+)[ \t]*:([^\r\n]*)/gim)) {
    const value = m[2].split(',')[0]!.trim();
    switch (m[1].toLowerCase()) {
      case 'jsx':
        options.jsx = jsxEmit(value.toLowerCase());
        break;
      case 'jsxfactory':
        options.jsxFactory = value;
        break;
      case 'jsxfragmentfactory':
        options.jsxFragmentFactory = value;
        break;
      case 'jsximportsource':
        options.jsxImportSource = value;
        break;
    }
  }
  return options;
}

/** Whether a test case sets @checkJs and all its @filename units are JavaScript. */
function isCheckedJS(text: string): boolean {
  // Most inputs set no @checkJs: skip matching every directive.
  if (!text.toLowerCase().includes('@checkjs')) return false;
  let units = 0;
  let checkJs = false;
  for (const m of text.matchAll(/^[ \t]*\/\/[ \t]*@(\w+)[ \t]*:([^\r\n]*)/gim)) {
    const value = m[2].trim();
    switch (m[1].toLowerCase()) {
      case 'filename':
        if (!/\.(js|jsx|cjs|mjs)$/i.test(value)) return false;
        units++;
        break;
      case 'checkjs':
        checkJs = value.split(',')[0]!.trim().toLowerCase() === 'true';
        break;
    }
  }
  return units > 0 && checkJs;
}

function createJSOptions(): CompilerOptions {
  const options = createOptions();
  options.allowJs = true;
  options.checkJs = true;
  return options;
}

function inputName(path: string, text: string): string {
  if (path.endsWith('.tsx')) return '/input.tsx';
  return isCheckedJS(text) ? '/input.js' : '/input.ts';
}

/**
 * Parse, bind, semantic and global diagnostics of the input file, in that order. JS files add their
 * JS-only syntactic and JSDoc diagnostics as a program does for a checked JS file.
 */
function check(name: string, text: string, loader: LibLoader, defaults: CompilerOptions): Diagnostic[] {
  let options = defaults;
  if (name === '/input.tsx') options = createJsxOptions(text);
  else if (name === '/input.js') options = createJSOptions();
  const file = parse(name, text);
  bindSourceFile(file);
  const files = loader.files.slice();
  files.push(file);
  const checker = new Checker(new CheckHost(options, files, loader.libs));
  const result: Diagnostic[] = [];
  for (const d of file.diagnostics) result.push(d);
  for (const d of file.jsDiagnostics) result.push(d);
  for (const d of file.bindDiagnostics) result.push(d);
  for (const d of checker.getDiagnostics(file)) result.push(d);
  for (const d of file.jsDocDiagnostics) result.push(d);
  for (const d of checker.getGlobalDiagnostics()) result.push(d);
  disposeChecker(checker);
  return result;
}

/** UTF-8 offset of each UTF-16 offset; the middle of a surrogate pair maps to its start. */
function utf8Offsets(text: string): Int32Array {
  const offsets = new Int32Array(text.length + 1);
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    offsets[i] = bytes;
    const ch = text.charCodeAt(i);
    if (ch < 0x80) bytes += 1;
    else if (ch < 0x800) bytes += 2;
    else if (ch >= 0xd800 && ch <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        offsets[i + 1] = bytes;
        bytes += 4;
        i++;
      } else bytes += 3;
    } else bytes += 3;
  }
  offsets[text.length] = bytes;
  return offsets;
}

/** Prints diagnostics with UTF-8 offsets in the input file `input`. */
function format(diagnostics: Diagnostic[], input: string, text: string, out: string[]): void {
  // UTF-8 and UTF-16 offsets agree in ASCII text.
  const ascii = Buffer.byteLength(text) === text.length;
  const offsets = ascii ? new Int32Array(0) : utf8Offsets(text);
  for (const d of diagnostics) {
    const name = d.file !== undefined ? d.file.fileName : '';
    let pos = d.pos;
    let len = d.end - d.pos;
    if (d.file !== undefined && d.file.fileName === input) {
      const start = Math.min(d.pos, text.length);
      const end = Math.min(d.end, text.length);
      pos = ascii ? start : offsets[start];
      len = (ascii ? end : offsets[end]) - pos;
    }
    out.push(`${name} ${d.code} ${pos} ${len} ${d.localize(Locale.Default)}`);
  }
}

function main(): void {
  const args = process.argv.slice(2);
  const path = args[0]!;
  const libDir = args[1]!;
  const mode = args.length > 2 ? args[2]! : '';
  const options = createOptions();
  const loader = new LibLoader(libDir, options);
  const out: string[] = [];
  if (mode === '--batch') {
    const list = readFileSync(path, 'utf8').split('\n');
    for (const line of list) {
      if (line === '') continue;
      let input: string;
      try {
        input = readFileSync(line, 'utf8');
      } catch {
        continue;
      }
      out.push('== ' + line);
      const start = out.length;
      try {
        const name = inputName(line, input);
        format(check(name, input, loader, options), name, input, out);
      } catch {
        out.length = start;
        out.push('!! panic');
      }
    }
  } else if (mode === '--bench') {
    const text = readFileSync(path, 'utf8');
    let count = 0;
    const start = performance.now();
    const name = inputName(path, text);
    for (let i = 0; i < 5; i++) count = check(name, text, loader, options).length;
    const ms = (performance.now() - start) / 5;
    out.push(`diagnostics ${count} time ${ms.toFixed(2)}ms`);
  } else {
    const text = readFileSync(path, 'utf8');
    const name = inputName(path, text);
    format(check(name, text, loader, options), name, text, out);
  }
  if (out.length > 0) write(out.join('\n') + '\n');
}

/** Writes to stdout synchronously, so exiting right after loses nothing. */
function write(text: string): void {
  // A pipe may be non-blocking (EAGAIN): retry a while until everything is written.
  const bytes = Buffer.from(text);
  let offset = 0;
  let failures = 0;
  while (offset < bytes.length) {
    try {
      offset += writeSync(1, bytes, offset);
      failures = 0;
    } catch {
      if (++failures > 100000) throw new Error('cannot write to stdout');
    }
  }
}

main();
// Exit without tearing down the libraries and programs: process.exit skips the final cycle collection.
process.exit(0);
