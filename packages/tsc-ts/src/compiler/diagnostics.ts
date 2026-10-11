/**
 * Diagnostics: message lookup and localization, the `Diagnostic` type, and tsc's plain and
 * pretty diagnostic output.
 */
import { isDigit, isUnicodeWhiteSpace, utf8Length } from './character-codes.js';
import { Locale, translations } from './diagnostic-locales.js';
import { Diagnostics, messageCodes, messageFlags, messageKeys, messageTexts } from './diagnostic-messages.js';
import { getPathComponentsRelativeTo, getPathFromPathComponents, isRootedDiskPath, pathIsAbsolute } from './path.js';
import { computeLineOfPosition, computeLineStarts } from './scanner.js';

export { Diagnostics, Locale };
export { parseLocale } from './locale.js';

export const enum DiagnosticCategory {
  Warning = 0,
  Error = 1,
  Suggestion = 2,
  Message = 3,
}

/** A diagnostic message template, e.g. `Diagnostics.X_0_expected` for `'{0}' expected.`. */
export type DiagnosticMessage = Diagnostics;

const reportsUnnecessaryFlag = 4;
const elidedInCompatibilityPyramidFlag = 8;
const reportsDeprecatedFlag = 16;

export function categoryName(category: DiagnosticCategory): string {
  switch (category) {
    case DiagnosticCategory.Warning:
      return 'warning';
    case DiagnosticCategory.Error:
      return 'error';
    case DiagnosticCategory.Suggestion:
      return 'suggestion';
    case DiagnosticCategory.Message:
      return 'message';
  }
}

export function messageCode(message: DiagnosticMessage): number {
  return messageCodes[message]!;
}

export function messageCategory(message: DiagnosticMessage): DiagnosticCategory {
  return (messageFlags[message] & 3) as DiagnosticCategory;
}

export function messageReportsUnnecessary(message: DiagnosticMessage): boolean {
  return (messageFlags[message] & reportsUnnecessaryFlag) !== 0;
}

export function messageElidedInCompatibilityPyramid(message: DiagnosticMessage): boolean {
  return (messageFlags[message] & elidedInCompatibilityPyramidFlag) !== 0;
}

export function messageReportsDeprecated(message: DiagnosticMessage): boolean {
  return (messageFlags[message] & reportsDeprecatedFlag) !== 0;
}

// Texts are split out of the generated strings on first use. Index 0 holds English.
const texts: string[][] = [];
let keys: string[] = [];
let messagesByKey: Map<string, DiagnosticMessage> | undefined;

function textOf(locale: Locale, message: DiagnosticMessage): string {
  while (texts.length <= locale) texts.push([]);
  let table = texts[locale]!;
  if (table.length === 0) {
    table = (locale === Locale.Default ? messageTexts : translations(locale)).split('\n');
    texts[locale] = table;
  }
  return table[message] ?? '';
}

function keyList(): readonly string[] {
  if (keys.length === 0) keys = messageKeys.split('\n');
  return keys;
}

/** The message's key, e.g. `_0_expected_1005`, which identifies it in translations and build info. */
export function messageKey(message: DiagnosticMessage): string {
  return keyList()[message] ?? '';
}

/** The message's English text. */
export function messageText(message: DiagnosticMessage): string {
  return textOf(Locale.Default, message);
}

/** Finds a message by its key. */
export function messageForKey(key: string): DiagnosticMessage | undefined {
  if (messagesByKey === undefined) {
    messagesByKey = new Map();
    const all = keyList();
    for (let i = 0; i < all.length; i++) messagesByKey.set(all[i]!, i as DiagnosticMessage);
  }
  return messagesByKey.get(key);
}

/** The message's text in `locale`, with `{n}` placeholders replaced by `args[n]`. */
export function localizeMessage(locale: Locale, message: DiagnosticMessage, args: readonly string[]): string {
  const translated = locale === Locale.Default ? '' : textOf(locale, message);
  return formatMessage(translated !== '' ? translated : textOf(Locale.Default, message), args);
}

/** Replaces `{n}` placeholders in `text` with `args[n]`. With no arguments, `text` is returned as is. */
export function formatMessage(text: string, args: readonly string[]): string {
  if (args.length === 0) return text;
  let result = '';
  let start = 0;
  for (let open = text.indexOf('{'); open >= 0; open = text.indexOf('{', open + 1)) {
    let close = open + 1;
    while (close < text.length && isDigit(text.charCodeAt(close))) close++;
    if (close === open + 1 || close >= text.length || text.charCodeAt(close) !== 0x7d) continue;
    const index = Number(text.slice(open + 1, close));
    if (index >= args.length) throw new Error('Invalid formatting placeholder');
    result += text.slice(start, open) + toWellFormed(args[index]!);
    start = close + 1;
    open = close;
  }
  return result + text.slice(start);
}

/** Replaces lone surrogates with U+FFFD, as tsgo makes arguments valid UTF-8. */
function toWellFormed(text: string): string {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0xd800 || c > 0xdfff) continue;
    if (c <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++;
        continue;
      }
    }
    text = text.slice(0, i) + '�' + text.slice(i + 1);
  }
  return text;
}

/** The text of a file diagnostics point into. */
export class DiagnosticFile {
  readonly fileName: string;
  readonly text: string;
  // Computed on first use; never empty once computed.
  private lineStarts: number[] = [];

  constructor(fileName: string, text: string) {
    this.fileName = fileName;
    this.text = text;
  }

  /** Computes the line starts and UTF-8 offsets, so that later reads never write to the file. */
  computeCaches(): void {
    this.getLineStarts();
    this.getNonASCIIStarts();
  }

  /** Start offsets of each line, split at CR, LF, CRLF, LS and PS. */
  getLineStarts(): readonly number[] {
    if (this.lineStarts.length === 0) this.lineStarts = computeLineStarts(this.text);
    return this.lineStarts;
  }

  // The non-ASCII characters, in order: their UTF-16 offsets, UTF-8 lengths, and the UTF-8 bytes
  // beyond one per UTF-16 code unit of the text up to and including each. Unset until first used.
  private nonASCIIStarts: number[] | undefined = undefined;
  private nonASCIILengths: number[] = [];
  private extraBytes: number[] = [];

  private getNonASCIIStarts(): number[] {
    let starts = this.nonASCIIStarts;
    if (starts === undefined) {
      starts = [];
      const text = this.text;
      if (Buffer.byteLength(text, 'utf8') !== text.length) {
        // Scanning the UTF-8 encoding is faster than reading each code unit.
        const bytes = Buffer.from(text, 'utf8');
        const lengths = this.nonASCIILengths;
        const extraBytes = this.extraBytes;
        let extra = 0;
        for (let i = 0; i < bytes.length; i++) {
          const b = bytes[i]!;
          if (b < 0x80) continue;
          // A lone surrogate is encoded as U+FFFD, in 3 bytes.
          const length = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : 2;
          starts.push(i - extra);
          lengths.push(length);
          extra += length === 4 ? 2 : length - 1;
          extraBytes.push(extra);
          i += length - 1;
        }
      }
      this.nonASCIIStarts = starts;
    }
    return starts;
  }

  /** The number of non-ASCII characters starting before UTF-16 offset `pos`. */
  private countNonASCIIBefore(starts: readonly number[], pos: number): number {
    let low = 0;
    let high = starts.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (starts[middle]! < pos) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  /** The UTF-8 offset of UTF-16 offset `pos`, as tsgo counts positions. */
  toUtf8Offset(pos: number): number {
    const starts = this.getNonASCIIStarts();
    if (starts.length === 0 || pos <= 0 || pos > this.text.length) return pos;
    const count = this.countNonASCIIBefore(starts, pos);
    if (count === 0) return pos;
    const last = count - 1;
    // The middle of a surrogate pair shares its start's offset.
    if (this.nonASCIILengths[last] === 4 && starts[last]! + 1 === pos)
      return starts[last]! + (last === 0 ? 0 : this.extraBytes[last - 1]!);
    return pos + this.extraBytes[last]!;
  }

  /** The UTF-16 offset of UTF-8 offset `pos`; inside a character, the offset of its start. */
  fromUtf8Offset(pos: number): number {
    const starts = this.getNonASCIIStarts();
    if (starts.length === 0 || pos <= 0) return pos;
    const extraBytes = this.extraBytes;
    // The last non-ASCII character starting at or before `pos`, in UTF-8.
    let low = 0;
    let high = starts.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      const start8 = starts[middle]! + (middle === 0 ? 0 : extraBytes[middle - 1]!);
      if (start8 <= pos) low = middle + 1;
      else high = middle;
    }
    if (low === 0) return pos;
    const index = low - 1;
    const start = starts[index]!;
    const end8 = start + (index === 0 ? 0 : extraBytes[index - 1]!) + this.nonASCIILengths[index]!;
    if (pos < end8) return start;
    return pos - extraBytes[index]!;
  }
}

/**
 * A diagnostic: a message with arguments, optionally at a span of a file. Positions are UTF-16
 * offsets; compiler diagnostics have no file and a position of -1.
 *
 * `messageChain` holds the elaborations printed indented below the message; they are diagnostics
 * whose file and position are unused.
 */
export class Diagnostic {
  file: DiagnosticFile | undefined;
  pos: number;
  end: number;
  code: number;
  category: DiagnosticCategory;
  readonly message: DiagnosticMessage;
  readonly args: readonly string[];
  messageChain: Diagnostic[] = [];
  relatedInformation: Diagnostic[] = [];
  readonly reportsUnnecessary: boolean;
  readonly reportsDeprecated: boolean;
  skippedOnNoEmit = false;

  constructor(
    file: DiagnosticFile | undefined,
    pos: number,
    end: number,
    message: DiagnosticMessage,
    args: readonly string[] = [],
  ) {
    this.file = file;
    this.pos = pos;
    this.end = end;
    this.code = messageCode(message);
    this.category = messageCategory(message);
    this.message = message;
    this.args = args;
    this.reportsUnnecessary = messageReportsUnnecessary(message);
    this.reportsDeprecated = messageReportsDeprecated(message);
  }

  localize(locale: Locale): string {
    return localizeMessage(locale, this.message, this.args);
  }

  addMessageChain(chain: Diagnostic | undefined): Diagnostic {
    if (chain !== undefined) this.messageChain.push(chain);
    return this;
  }

  addRelatedInfo(related: Diagnostic | undefined): Diagnostic {
    if (related !== undefined) this.relatedInformation.push(related);
    return this;
  }

  clone(): Diagnostic {
    const result = new Diagnostic(this.file, this.pos, this.end, this.message, this.args);
    result.code = this.code;
    result.category = this.category;
    result.messageChain = this.messageChain;
    result.relatedInformation = this.relatedInformation;
    result.skippedOnNoEmit = this.skippedOnNoEmit;
    return result;
  }
}

/** A message with its arguments and no location, such as a module resolution trace. */
export interface MessageWithArgs {
  readonly message: DiagnosticMessage;
  readonly args: readonly string[];
}

export function messageWithArgs(message: DiagnosticMessage, ...args: string[]): MessageWithArgs {
  return { message, args };
}

/** An entry of `Diagnostic.messageChain`. */
export type DiagnosticMessageChain = Diagnostic;

export function createDiagnostic(
  file: DiagnosticFile | undefined,
  pos: number,
  end: number,
  message: DiagnosticMessage,
  ...args: string[]
): Diagnostic {
  return new Diagnostic(file, pos, end, message, args);
}

/** A diagnostic without a file, such as an options error. */
export function createCompilerDiagnostic(message: DiagnosticMessage, ...args: string[]): Diagnostic {
  return new Diagnostic(undefined, -1, -1, message, args);
}

/** A diagnostic for `message` that elaborates with `chain`, taking its location and related information. */
export function chainDiagnostic(
  chain: Diagnostic | undefined,
  message: DiagnosticMessage,
  ...args: string[]
): Diagnostic {
  if (chain === undefined) return new Diagnostic(undefined, 0, 0, message, args);
  const result = new Diagnostic(chain.file, chain.pos, chain.end, message, args).addMessageChain(chain);
  result.relatedInformation = chain.relatedInformation;
  return result;
}

//// Ordering

/** Orders strings by code point, like Go's byte-wise comparison of UTF-8. */
export function compareCodePoints(a: string, b: string): number {
  if (a === b) return 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    let x = a.charCodeAt(i);
    let y = b.charCodeAt(i);
    if (x === y) continue;
    // Surrogates encode code points above every other UTF-16 unit.
    if (x >= 0xd800 && x <= 0xdfff) x += 0x10000;
    if (y >= 0xd800 && y <= 0xdfff) y += 0x10000;
    return x < y ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

function compareArgs(a: readonly string[], b: readonly string[]): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const c = compareCodePoints(a[i]!, b[i]!);
    if (c !== 0) return c;
  }
  return a.length - b.length;
}

function equalArgs(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function fileNameOf(d: Diagnostic): string {
  return d.file === undefined ? '' : d.file.fileName;
}

function compareChainSize(a: readonly Diagnostic[], b: readonly Diagnostic[]): number {
  if (a.length !== b.length) return b.length - a.length;
  for (let i = 0; i < a.length; i++) {
    const c = compareChainSize(a[i]!.messageChain, b[i]!.messageChain);
    if (c !== 0) return c;
  }
  return 0;
}

function compareChainContent(a: readonly Diagnostic[], b: readonly Diagnostic[]): number {
  for (let i = 0; i < a.length; i++) {
    let c = compareArgs(a[i]!.args, b[i]!.args);
    if (c !== 0) return c;
    c = compareChainContent(a[i]!.messageChain, b[i]!.messageChain);
    if (c !== 0) return c;
  }
  return 0;
}

function compareRelatedInfo(a: readonly Diagnostic[], b: readonly Diagnostic[]): number {
  if (a.length !== b.length) return b.length - a.length;
  for (let i = 0; i < a.length; i++) {
    const c = compareDiagnostics(a[i]!, b[i]!);
    if (c !== 0) return c;
  }
  return 0;
}

/** The order tsc reports diagnostics in: by file, position, code, arguments, then elaboration. */
export function compareDiagnostics(a: Diagnostic, b: Diagnostic): number {
  if (a === b) return 0;
  let c = compareCodePoints(fileNameOf(a), fileNameOf(b));
  if (c !== 0) return c;
  c = a.pos - b.pos;
  if (c !== 0) return c;
  c = a.end - b.end;
  if (c !== 0) return c;
  c = a.code - b.code;
  if (c !== 0) return c;
  c = compareArgs(a.args, b.args);
  if (c !== 0) return c;
  c = compareChainSize(a.messageChain, b.messageChain);
  if (c !== 0) return c;
  c = compareChainContent(a.messageChain, b.messageChain);
  if (c !== 0) return c;
  return compareRelatedInfo(a.relatedInformation, b.relatedInformation);
}

function equalChain(a: readonly Diagnostic[], b: readonly Diagnostic[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    if (a[i].code !== b[i].code || !equalArgs(a[i].args, b[i].args)) return false;
    if (!equalChain(a[i].messageChain, b[i].messageChain)) return false;
  }
  return true;
}

/** Whether two diagnostics report the same thing, ignoring related information. */
export function equalDiagnosticsNoRelatedInfo(a: Diagnostic, b: Diagnostic): boolean {
  if (a === b) return true;
  return (
    fileNameOf(a) === fileNameOf(b) &&
    a.pos === b.pos &&
    a.end === b.end &&
    a.code === b.code &&
    equalArgs(a.args, b.args) &&
    equalChain(a.messageChain, b.messageChain)
  );
}

export function equalDiagnostics(a: Diagnostic, b: Diagnostic): boolean {
  if (a === b) return true;
  if (!equalDiagnosticsNoRelatedInfo(a, b)) return false;
  if (a.relatedInformation.length !== b.relatedInformation.length) return false;
  for (let i = 0; i < a.relatedInformation.length; i++) {
    if (!equalDiagnostics(a.relatedInformation[i]!, b.relatedInformation[i]!)) return false;
  }
  return true;
}

//// Output

export interface DiagnosticFormatOptions {
  readonly locale: Locale;
  readonly currentDirectory: string;
  readonly useCaseSensitiveFileNames: boolean;
  readonly newLine: string;
}

const grey = '\u001b[90m';
const red = '\u001b[91m';
const yellow = '\u001b[93m';
const blue = '\u001b[94m';
const cyan = '\u001b[96m';
const gutterStyle = '\u001b[7m';
const gutterSeparator = ' ';
const reset = '\u001b[0m';
const ellipsis = '...';

function relativeFileName(fileName: string, options: DiagnosticFormatOptions): string {
  if (!isRootedDiskPath(fileName)) return fileName;
  return getPathFromPathComponents(
    getPathComponentsRelativeTo(
      options.currentDirectory,
      fileName,
      options.useCaseSensitiveFileNames,
      options.currentDirectory,
    ),
  );
}

function flattenChain(chain: readonly Diagnostic[], newLine: string, locale: Locale, level: number): string {
  let result = '';
  for (const entry of chain) {
    result += newLine + '  '.repeat(level) + entry.localize(locale);
    result += flattenChain(entry.messageChain, newLine, locale, level + 1);
  }
  return result;
}

/** The message followed by its chain, each level indented by two more spaces. */
export function flattenDiagnosticMessage(diagnostic: Diagnostic, newLine: string, locale: Locale): string {
  return diagnostic.localize(locale) + flattenChain(diagnostic.messageChain, newLine, locale, 1);
}

/** `file(line,col): error TS1005: message`, as tsc prints without `--pretty`. */
export function formatDiagnostic(diagnostic: Diagnostic, options: DiagnosticFormatOptions): string {
  let result = '';
  const file = diagnostic.file;
  if (file !== undefined) {
    const lineStarts = file.getLineStarts();
    const line = computeLineOfPosition(lineStarts, diagnostic.pos);
    const character = diagnostic.pos - lineStarts[line];
    result += `${relativeFileName(file.fileName, options)}(${line + 1},${character + 1}): `;
  }
  result += `${categoryName(diagnostic.category)} TS${diagnostic.code}: `;
  return result + flattenDiagnosticMessage(diagnostic, options.newLine, options.locale) + options.newLine;
}

export function formatDiagnostics(diagnostics: readonly Diagnostic[], options: DiagnosticFormatOptions): string {
  let result = '';
  for (const diagnostic of diagnostics) result += formatDiagnostic(diagnostic, options);
  return result;
}

function categoryColor(category: DiagnosticCategory): string {
  switch (category) {
    case DiagnosticCategory.Error:
      return red;
    case DiagnosticCategory.Warning:
      return yellow;
    case DiagnosticCategory.Suggestion:
      return grey;
    case DiagnosticCategory.Message:
      return blue;
  }
}

function styled(text: string, style: string): string {
  return style + text + reset;
}

function formatLocation(file: DiagnosticFile, pos: number, options: DiagnosticFormatOptions): string {
  const lineStarts = file.getLineStarts();
  const line = computeLineOfPosition(lineStarts, pos);
  const character = pos - lineStarts[line];
  return `${styled(relativeFileName(file.fileName, options), cyan)}:${styled(String(line + 1), yellow)}:${styled(String(character + 1), yellow)}`;
}

function trimEndSpace(text: string): string {
  let end = text.length;
  while (end > 0 && isUnicodeWhiteSpace(text.charCodeAt(end - 1))) end--;
  return text.slice(0, end);
}

function codeSnippet(
  file: DiagnosticFile,
  start: number,
  length: number,
  squiggleColor: string,
  indent: string,
  options: DiagnosticFormatOptions,
): string {
  const newLine = options.newLine;
  const text = file.text;
  const lineStarts = file.getLineStarts();
  const firstLine = computeLineOfPosition(lineStarts, start);
  const firstLineChar = start - lineStarts[firstLine];
  const lastLine = computeLineOfPosition(lineStarts, start + length);
  let lastLineChar = start + length - lineStarts[lastLine];
  // With no length, squiggle the character after the start.
  if (length === 0) lastLineChar++;
  const lastLineOfFile = computeLineOfPosition(lineStarts, text.length);

  const hasMoreThanFiveLines = lastLine - firstLine >= 4;
  let gutterWidth = String(lastLine + 1).length;
  if (hasMoreThanFiveLines) gutterWidth = Math.max(ellipsis.length, gutterWidth);

  let result = '';
  for (let i = firstLine; i <= lastLine; i++) {
    result += newLine;
    // For spans over five lines, show the first two and last two.
    if (hasMoreThanFiveLines && firstLine + 1 < i && i < lastLine - 1) {
      result += indent + gutterStyle + ellipsis.padStart(gutterWidth) + reset + gutterSeparator + newLine;
      i = lastLine - 1;
    }
    const lineStart = lineStarts[i]!;
    const lineEnd = i < lastLineOfFile ? lineStarts[i + 1]! : text.length;
    const lineContent = trimEndSpace(text.slice(lineStart, lineEnd)).replaceAll('\t', ' ');

    result += indent + gutterStyle + String(i + 1).padStart(gutterWidth) + reset + gutterSeparator;
    result += lineContent + newLine;
    result += indent + gutterStyle + ''.padStart(gutterWidth) + reset + gutterSeparator + squiggleColor;
    if (i === firstLine) {
      const lastCharForLine = i === lastLine ? lastLineChar : lineContent.length;
      result += ' '.repeat(firstLineChar) + '~'.repeat(lastCharForLine - firstLineChar);
    } else if (i === lastLine) {
      result += '~'.repeat(lastLineChar);
    } else {
      result += '~'.repeat(lineContent.length);
    }
    result += reset;
  }
  return result;
}

/** The colored form with source snippets, as tsc prints with `--pretty`. */
export function formatDiagnosticWithColorAndContext(diagnostic: Diagnostic, options: DiagnosticFormatOptions): string {
  const newLine = options.newLine;
  let result = '';
  const file = diagnostic.file;
  if (file !== undefined) result += formatLocation(file, diagnostic.pos, options) + ' - ';
  const color = categoryColor(diagnostic.category);
  result += styled(categoryName(diagnostic.category), color);
  result += `${grey} TS${diagnostic.code}: ${reset}`;
  result += flattenDiagnosticMessage(diagnostic, newLine, options.locale);
  if (file !== undefined && diagnostic.code !== messageCode(Diagnostics.File_appears_to_be_binary)) {
    result +=
      newLine + codeSnippet(file, diagnostic.pos, diagnostic.end - diagnostic.pos, color, '', options) + newLine;
  }
  for (const related of diagnostic.relatedInformation) {
    const relatedFile = related.file;
    if (relatedFile !== undefined) {
      result += newLine + '  ' + formatLocation(relatedFile, related.pos, options) + ' - ';
      result += flattenDiagnosticMessage(related, newLine, options.locale);
      result += codeSnippet(relatedFile, related.pos, related.end - related.pos, cyan, '    ', options);
    }
    result += newLine;
  }
  return result;
}

export function formatDiagnosticsWithColorAndContext(
  diagnostics: readonly Diagnostic[],
  options: DiagnosticFormatOptions,
): string {
  let result = '';
  for (let i = 0; i < diagnostics.length; i++) {
    if (i > 0) result += options.newLine;
    result += formatDiagnosticWithColorAndContext(diagnostics[i]!, options);
  }
  return result;
}

/** A watch or build status line: `time - message`. */
export function formatDiagnosticStatus(time: string, diagnostic: Diagnostic, options: DiagnosticFormatOptions): string {
  return `${time} - ${flattenDiagnosticMessage(diagnostic, options.newLine, options.locale)}`;
}

/** A watch or build status line with a colored time: `[time] message`. */
export function formatDiagnosticStatusWithColor(
  time: string,
  diagnostic: Diagnostic,
  options: DiagnosticFormatOptions,
): string {
  return `[${styled(time, grey)}] ${flattenDiagnosticMessage(diagnostic, options.newLine, options.locale)}`;
}

class FileErrors {
  readonly file: DiagnosticFile;
  readonly errors: Diagnostic[] = [];

  constructor(file: DiagnosticFile) {
    this.file = file;
  }
}

function prettyPathForFileError(entry: FileErrors | undefined, options: DiagnosticFormatOptions): string {
  if (entry === undefined || entry.errors.length === 0) return '';
  const line = computeLineOfPosition(entry.file.getLineStarts(), entry.errors[0].pos);
  let fileName = entry.file.fileName;
  if (pathIsAbsolute(fileName) && pathIsAbsolute(options.currentDirectory)) {
    fileName = relativeFileName(fileName, options);
  }
  return `${fileName}${grey}:${line + 1}${reset}`;
}

/**
 * The summary tsc prints after diagnostics with `--pretty`, e.g. "Found 2 errors in 2 files."
 * followed by a table of files; empty when there are no errors.
 */
export function formatErrorSummary(diagnostics: readonly Diagnostic[], options: DiagnosticFormatOptions): string {
  const locale = options.locale;
  const newLine = options.newLine;
  let totalErrorCount = 0;
  let globalErrorCount = 0;
  const byFile = new Map<DiagnosticFile, FileErrors>();
  for (const diagnostic of diagnostics) {
    if (diagnostic.category !== DiagnosticCategory.Error) continue;
    totalErrorCount++;
    const file = diagnostic.file;
    if (file === undefined) {
      globalErrorCount++;
      continue;
    }
    let entry = byFile.get(file);
    if (entry === undefined) {
      entry = new FileErrors(file);
      byFile.set(file, entry);
    }
    entry.errors.push(diagnostic);
  }
  if (totalErrorCount === 0) return '';

  const sorted = [...byFile.values()].sort((a, b) => compareCodePoints(a.file.fileName, b.file.fileName));
  const firstFileName = prettyPathForFileError(sorted.length > 0 ? sorted[0]! : undefined, options);
  const fileCount = sorted.length;
  let message: string;
  if (totalErrorCount === 1) {
    message =
      globalErrorCount > 0 || firstFileName === ''
        ? localizeMessage(locale, Diagnostics.Found_1_error, [])
        : localizeMessage(locale, Diagnostics.Found_1_error_in_0, [firstFileName]);
  } else if (fileCount === 0) {
    message = localizeMessage(locale, Diagnostics.Found_0_errors, [String(totalErrorCount)]);
  } else if (fileCount === 1) {
    message = localizeMessage(locale, Diagnostics.Found_0_errors_in_the_same_file_starting_at_Colon_1, [
      String(totalErrorCount),
      firstFileName,
    ]);
  } else {
    message = localizeMessage(locale, Diagnostics.Found_0_errors_in_1_files, [
      String(totalErrorCount),
      String(fileCount),
    ]);
  }
  let result = newLine + message + newLine + newLine;
  if (fileCount > 1) {
    let maxErrors = 0;
    for (const entry of sorted) maxErrors = Math.max(maxErrors, entry.errors.length);
    const headerRow = localizeMessage(locale, Diagnostics.Errors_Files, []);
    const leftColumnHeadingLength = utf8Length(headerRow.split(' ')[0] ?? '');
    const lengthOfBiggestErrorCount = String(maxErrors).length;
    const leftPaddingGoal = Math.max(leftColumnHeadingLength, lengthOfBiggestErrorCount);
    const headerPadding = Math.max(lengthOfBiggestErrorCount - leftColumnHeadingLength, 0);
    result += ' '.repeat(headerPadding) + headerRow + newLine;
    for (const entry of sorted) {
      result += String(entry.errors.length).padStart(leftPaddingGoal) + '  ';
      result += prettyPathForFileError(entry, options) + newLine;
    }
    result += newLine;
  }
  return result;
}
