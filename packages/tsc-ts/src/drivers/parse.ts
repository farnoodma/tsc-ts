// Parses a file like the reference encode oracle and writes the API's binary encoding
// of it, a tree dump in encoder order with UTF-8 offsets (--tree), or timings.
// Usage: parse FILE [--tree|--bench|--bench-encode] [--jsx] [--force]
import { readFileSync, writeSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import {
  ExternalModuleIndicatorOptions,
  type FileReference,
  JSDocParameterOrPropertyTag,
  type ModifierList,
  type Node,
  type NodeList,
  NodeVisitor,
  ParseOptions,
  ScriptKind,
  type SourceFile,
} from '../compiler/ast.js';
import { type Diagnostic, Locale } from '../compiler/diagnostics.js';
import { encodeSourceFile } from '../compiler/encoder.js';
import { getJSDoc, parseSourceFile } from '../compiler/parser.js';
import './lowering.js';

const out: string[] = [];

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

function hex(n: number, digits: number): string {
  const s = n.toString(16);
  return '0000'.substring(0, digits - s.length) + s;
}

/** Go's `%q`, for the strings these files contain. */
function quote(s: string): string {
  let result = '"';
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    if (ch === 0x22) result += '\\"';
    else if (ch === 0x5c) result += '\\\\';
    else if (ch === 0x0a) result += '\\n';
    else if (ch === 0x0d) result += '\\r';
    else if (ch === 0x09) result += '\\t';
    else if (ch < 0x20 || ch === 0x7f) result += '\\x' + hex(ch, 2);
    else if (ch >= 0x80 && ch < 0xa0) result += '\\u' + hex(ch, 4);
    else result += String.fromCharCode(ch);
  }
  return result + '"';
}

class TreePrinter extends NodeVisitor {
  readonly file: SourceFile;
  readonly offsets: Int32Array;
  depth: number;
  // The node whose children are being visited.
  container: Node | undefined;

  constructor(file: SourceFile) {
    super();
    this.file = file;
    this.offsets = utf8Offsets(file.text);
    this.depth = 0;
    this.container = undefined;
  }

  byte(pos: number): number {
    const offsets = this.offsets;
    return pos < 0 || pos >= offsets.length ? pos : offsets[pos];
  }

  visitNode(node: Node): boolean {
    let line = `${this.depth} ${node.kind} ${this.byte(node.pos)} ${this.byte(node.end)} ${node.flags}`;
    // A parent other than the visiting node.
    const parent = node.parent;
    if (parent !== this.container) line += parent === undefined ? ' ^nil' : ` ^${parent.kind}@${this.byte(parent.pos)}`;
    out.push(line);
    const saveContainer = this.container;
    this.container = node;
    this.depth++;
    if (node instanceof JSDocParameterOrPropertyTag) {
      this.visitNode(node.tagName);
      this.visitNode(node.name);
      if (node.typeExpression !== undefined) this.visitNode(node.typeExpression);
      if (node.comment !== undefined) this.visitList(node.comment);
    } else node.forEachChild(this);
    const jsDoc = getJSDoc(this.file, node);
    for (let i = 0; i < jsDoc.length; i++) this.visitNode(jsDoc[i]!);
    this.depth--;
    this.container = saveContainer;
    return false;
  }

  visitList(list: NodeList): boolean {
    out.push(`${this.depth} L ${this.byte(list.pos)} ${this.byte(list.end)} ${list.nodes.length}`);
    this.depth++;
    const nodes = list.nodes;
    for (let i = 0; i < nodes.length; i++) this.visitNode(nodes[i]!);
    this.depth--;
    return false;
  }

  visitModifiers(list: ModifierList): boolean {
    if (list.nodes.length > 0) this.visitList(list);
    return false;
  }

  diagnostics(label: string, diagnostics: readonly Diagnostic[]): number {
    for (const d of diagnostics) {
      const pos = this.byte(d.pos);
      out.push(`${label} ${d.code} ${pos} ${this.byte(d.end) - pos} ${d.localize(Locale.Default)}`);
    }
    return diagnostics.length;
  }

  nodes(label: string, nodes: readonly Node[]): number {
    for (const n of nodes) out.push(`${label} ${n.kind} ${this.byte(n.pos)} ${this.byte(n.end)}`);
    return nodes.length;
  }

  references(label: string, refs: readonly FileReference[]): number {
    for (const ref of refs)
      out.push(
        `${label} ${this.byte(ref.pos)} ${this.byte(ref.end)} ${quote(ref.fileName)} ${ref.resolutionMode} ${ref.preserve}`,
      );
    return refs.length;
  }
}

function tree(file: SourceFile): void {
  const p = new TreePrinter(file);
  p.visitNode(file);
  p.diagnostics('diag', file.diagnostics);
  p.diagnostics('jsdiag', file.jsDiagnostics);
  p.diagnostics('jsdocdiag', file.jsDocDiagnostics);
  p.nodes('import', file.imports);
  p.nodes('augmentation', file.moduleAugmentations);
  for (const name of file.ambientModuleNames) out.push(`ambient ${quote(name)}`);
  const indicator = file.externalModuleIndicator;
  if (indicator !== undefined) p.nodes('module', [indicator]);
  p.references('reference', file.referencedFiles);
  p.references('types', file.typeReferenceDirectives);
  p.references('lib', file.libReferenceDirectives);
  for (const pragma of file.pragmas) out.push(`pragma ${pragma.name}`);
  const checkJs = file.checkJsDirective;
  if (checkJs !== undefined)
    out.push(`checkjs ${checkJs.enabled} ${p.byte(checkJs.range.pos)} ${p.byte(checkJs.range.end)}`);
  for (const d of file.commentDirectives) out.push(`directive ${d.kind} ${p.byte(d.pos)} ${p.byte(d.end)}`);
  out.push(`file ${file.languageVariant} ${file.scriptKind} ${file.isDeclarationFile}`);
}

const forcedExtensions = ['.cjs', '.cts', '.mjs', '.mts'];

/** As tspath.IsDeclarationFileName. */
function isDeclarationFileName(name: string): boolean {
  const base = baseName(name);
  if (base.endsWith('.d.ts') || base.endsWith('.d.mts') || base.endsWith('.d.cts')) return true;
  return base.endsWith('.ts') && base.includes('.d.');
}

function baseName(path: string): string {
  return path.substring(path.lastIndexOf('/') + 1);
}

function main(): void {
  const args = process.argv.slice(2);
  const text = readFileSync(args[0], 'utf8');
  const fileName = '/' + baseName(args[0]);
  let mode = '';
  let jsx = false;
  let force = false;
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--jsx') jsx = true;
    else if (arg === '--force') force = true;
    else mode = arg;
  }
  if (!isDeclarationFileName(fileName)) {
    for (const ext of forcedExtensions) if (fileName.endsWith(ext)) force = true;
  }
  const options = new ParseOptions(fileName, ScriptKind.Unknown, new ExternalModuleIndicatorOptions(jsx, force));
  if (mode === '--bench') {
    const start = performance.now();
    let nodes = 0;
    for (let round = 0; round < 20; round++) nodes += parseSourceFile(fileName, text, options).nodeCount;
    console.log(`nodes ${Math.floor(nodes / 20)} time ${((performance.now() - start) / 20).toFixed(2)}ms`);
    return;
  }
  const file = parseSourceFile(fileName, text, options);
  if (mode === '--bench-encode') {
    let size = 0;
    const start = performance.now();
    for (let round = 0; round < 20; round++) size = encodeSourceFile(file).length;
    console.log(`bytes ${size} time ${((performance.now() - start) / 20).toFixed(2)}ms`);
    return;
  }
  if (mode === '--tree') {
    tree(file);
    out.push('');
    process.stdout.write(out.join('\n'));
    return;
  }
  const bytes = encodeSourceFile(file);
  let written = 0;
  while (written < bytes.length) written += writeSync(1, bytes, written, bytes.length - written);
}

main();
