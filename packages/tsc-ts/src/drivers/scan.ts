// Prints a file's token stream in the format of the reference scan oracle, with
// UTF-8 byte offsets. Usage: scan FILE [--bench] [--full] [--trivia] [--jsx]
// [--target N] [--rescan] [--jsdoc]
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { messageCode, type DiagnosticMessage } from '../compiler/diagnostics.js';
import {
  Scanner,
  computeLineStarts,
  getLeadingCommentRanges,
  getTrailingCommentRanges,
  skipTrivia,
} from '../compiler/scanner.js';
import { SyntaxKind } from '../compiler/syntax-kind.js';
import { type CommentRange, LanguageVariant, ScriptTarget } from '../compiler/types.js';

const enum Rescan {
  Slash,
  Template,
  TaggedTemplate,
  GreaterThan,
  LessThan,
  Hash,
  Question,
  AsteriskEquals,
  JsxAttributeValue,
  ReJsxAttributeValue,
  JsxIdentifier,
  JsxToken,
  ReJsxToken,
  ReJsxTokenSingleLine,
}

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

function hex4(n: number): string {
  const s = n.toString(16);
  return '\\u' + '0000'.substring(s.length) + s;
}

/** The value as escaped UTF-16 units; over 64 units, its length and FNV-1a hash. */
function quote(s: string): string {
  if (s.length > 64) {
    let hash = 2166136261;
    for (let i = 0; i < s.length; i++) hash = Math.imul(hash ^ s.charCodeAt(i), 16777619) >>> 0;
    return `#${s.length}:${hash}`;
  }
  let result = '"';
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    if (ch >= 0x20 && ch < 0x7f && ch !== 0x22 && ch !== 0x5c) result += String.fromCharCode(ch);
    else result += hex4(ch);
  }
  return result + '"';
}

class Printer {
  offsets: Int32Array;

  constructor(offsets: Int32Array) {
    this.offsets = offsets;
  }

  byte(pos: number): number {
    const offsets = this.offsets;
    return offsets[pos | 0];
  }

  onError(message: DiagnosticMessage, start: number, length: number, args: readonly string[]): void {
    let line = `! ${messageCode(message)} ${this.byte(start)} ${this.byte(start + length) - this.byte(start)}`;
    for (const arg of args) line += ' ' + quote(arg);
    out.push(line);
  }

  token(prefix: string, s: Scanner, kind: SyntaxKind): void {
    out.push(
      `${prefix}${kind} ${this.byte(s.getTokenFullStart())} ${this.byte(s.getTokenStart())} ${this.byte(s.getTokenEnd())} ${s.getTokenFlags()} ${quote(s.getTokenValue())}`,
    );
  }

  comments(prefix: string, ranges: CommentRange[] | undefined): void {
    let line = prefix;
    if (ranges !== undefined)
      for (const c of ranges)
        line += ` ${this.byte(c.pos)},${this.byte(c.end)},${c.kind},${c.hasTrailingNewLine ? 1 : 0}`;
    out.push(line);
  }
}

function applyRescan(s: Scanner, rescan: Rescan): SyntaxKind {
  switch (rescan) {
    case Rescan.Slash:
      return s.reScanSlashToken(true);
    case Rescan.Template:
      return s.reScanTemplateToken(false);
    case Rescan.TaggedTemplate:
      return s.reScanTemplateToken(true);
    case Rescan.GreaterThan:
      return s.reScanGreaterThanToken();
    case Rescan.LessThan:
      return s.reScanLessThanToken();
    case Rescan.Hash:
      return s.reScanHashToken();
    case Rescan.Question:
      return s.reScanQuestionToken();
    case Rescan.AsteriskEquals:
      return s.reScanAsteriskEqualsToken();
    case Rescan.JsxAttributeValue:
      return s.scanJsxAttributeValue();
    case Rescan.ReJsxAttributeValue:
      s.scanJsxAttributeValue();
      return s.reScanJsxAttributeValue();
    case Rescan.JsxIdentifier:
      return s.scanJsxIdentifier();
    case Rescan.JsxToken:
      return s.scanJsxToken();
    case Rescan.ReJsxToken:
      return s.reScanJsxToken(true);
    case Rescan.ReJsxTokenSingleLine:
      return s.reScanJsxToken(false);
  }
}

function tryRescan(p: Printer, s: Scanner, prefix: string, rescan: Rescan): void {
  const state = s.mark();
  p.token(prefix, s, applyRescan(s, rescan));
  s.rewind(state);
}

function rescanAll(p: Printer, s: Scanner, kind: SyntaxKind, text: string): void {
  switch (kind) {
    case SyntaxKind.SlashToken:
    case SyntaxKind.SlashEqualsToken:
      tryRescan(p, s, 'R/ ', Rescan.Slash);
      break;
    case SyntaxKind.CloseBraceToken:
      tryRescan(p, s, 'Rt ', Rescan.Template);
      tryRescan(p, s, 'RT ', Rescan.TaggedTemplate);
      break;
    case SyntaxKind.GreaterThanToken:
      tryRescan(p, s, 'R> ', Rescan.GreaterThan);
      break;
    case SyntaxKind.LessThanLessThanToken:
      tryRescan(p, s, 'R< ', Rescan.LessThan);
      break;
    case SyntaxKind.PrivateIdentifier:
      tryRescan(p, s, 'R# ', Rescan.Hash);
      break;
    case SyntaxKind.QuestionQuestionToken:
      tryRescan(p, s, 'R? ', Rescan.Question);
      break;
    case SyntaxKind.AsteriskEqualsToken:
      tryRescan(p, s, 'R* ', Rescan.AsteriskEquals);
      break;
    case SyntaxKind.EqualsToken:
      tryRescan(p, s, 'Ra ', Rescan.JsxAttributeValue);
      tryRescan(p, s, 'RA ', Rescan.ReJsxAttributeValue);
      break;
  }
  if (kind >= SyntaxKind.Identifier) tryRescan(p, s, 'Ri ', Rescan.JsxIdentifier);
  if (kind === SyntaxKind.GreaterThanToken || kind === SyntaxKind.CloseBraceToken)
    tryRescan(p, s, 'Rs ', Rescan.JsxToken);
  tryRescan(p, s, 'Rj ', Rescan.ReJsxToken);
  tryRescan(p, s, 'RJ ', Rescan.ReJsxTokenSingleLine);
  const full = s.getTokenFullStart();
  out.push(
    `U ${p.byte(skipTrivia(text, full))} ${p.byte(skipTrivia(text, full, true))} ${p.byte(skipTrivia(text, full, false, true))} ${p.byte(skipTrivia(text, full, false, false, true))}`,
  );
  p.comments('L', getLeadingCommentRanges(text, full));
  p.comments('T', getTrailingCommentRanges(text, s.getTokenEnd()));
}

function jsdoc(p: Printer, text: string, target: ScriptTarget): void {
  const trivia = new Scanner(text);
  trivia.setSkipTrivia(false);
  const starts: number[] = [];
  const ends: number[] = [];
  for (let k = trivia.scan(); k !== SyntaxKind.EndOfFile; k = trivia.scan()) {
    if (
      k === SyntaxKind.MultiLineCommentTrivia &&
      text.startsWith('/**', trivia.getTokenStart()) &&
      trivia.getTokenEnd() - trivia.getTokenStart() >= 5
    ) {
      starts.push(trivia.getTokenStart());
      ends.push(trivia.getTokenEnd());
    }
  }
  const s = new Scanner(text);
  s.setScriptTarget(target);
  s.setOnError((message, start, length, args) => p.onError(message, start, length, args));
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i];
    const end = ends[i];
    out.push(`C ${p.byte(start)} ${p.byte(end)}`);
    s.resetTokenState(start + 3);
    while (s.getTokenEnd() < end) {
      const state = s.mark();
      p.token('Jc ', s, s.scanJSDocCommentTextToken(false));
      s.rewind(state);
      p.token('JC ', s, s.scanJSDocCommentTextToken(true));
      s.rewind(state);
      out.push(`J@ ${s.canFollowJSDocAt() ? 1 : 0}`);
      const k = s.scanJSDocToken();
      p.token('J ', s, k);
      if (k === SyntaxKind.EndOfFile) break;
    }
    s.resetTokenState(start + 3);
    s.setSkipJSDocLeadingAsterisks(true);
    for (;;) {
      const k = s.scan();
      p.token('JS ', s, k);
      if (k === SyntaxKind.EndOfFile || s.getTokenEnd() >= end) break;
    }
    s.setSkipJSDocLeadingAsterisks(false);
  }
}

function bench(text: string): void {
  const start = performance.now();
  let count = 0;
  for (let round = 0; round < 20; round++) {
    const s = new Scanner(text);
    s.setScriptTarget(ScriptTarget.Latest);
    while (s.scan() !== SyntaxKind.EndOfFile) count++;
  }
  console.log(`tokens ${count} time ${((performance.now() - start) / 20).toFixed(2)}ms`);
}

function main(): void {
  const args = process.argv.slice(2);
  const text = readFileSync(args[0], 'utf8');
  let isBench = false;
  let full = false;
  let trivia = false;
  let jsx = false;
  let rescan = false;
  let withJSDoc = false;
  let target = ScriptTarget.Latest;
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--bench') isBench = true;
    else if (arg === '--full') full = true;
    else if (arg === '--trivia') trivia = true;
    else if (arg === '--jsx') jsx = true;
    else if (arg === '--rescan') rescan = true;
    else if (arg === '--jsdoc') withJSDoc = true;
    else if (arg === '--target') target = Number(args[++i]) as ScriptTarget;
  }
  if (isBench) {
    bench(text);
    return;
  }
  const p = new Printer(utf8Offsets(text));
  const s = new Scanner(text);
  s.setScriptTarget(target);
  if (jsx) s.setLanguageVariant(LanguageVariant.JSX);
  if (trivia) s.setSkipTrivia(false);
  if (!full && !rescan && !withJSDoc) {
    for (;;) {
      const k = s.scan();
      out.push(`${k} ${p.byte(s.getTokenStart())} ${p.byte(s.getTokenEnd())} ${s.getTokenFlags()}`);
      if (k === SyntaxKind.EndOfFile) break;
    }
  } else {
    s.setOnError((message, start, length, args) => p.onError(message, start, length, args));
    if (rescan) {
      let line = 'LS';
      for (const start of computeLineStarts(text)) line += ' ' + p.byte(start);
      out.push(line);
    }
    for (;;) {
      const k = s.scan();
      p.token('', s, k);
      if (rescan) rescanAll(p, s, k, text);
      if (k === SyntaxKind.EndOfFile) break;
    }
    for (const d of s.getCommentDirectives()) out.push(`D ${d.kind} ${p.byte(d.pos)} ${p.byte(d.end)}`);
    if (withJSDoc) jsdoc(p, text, target);
  }
  out.push('');
  process.stdout.write(out.join('\n'));
}

main();
