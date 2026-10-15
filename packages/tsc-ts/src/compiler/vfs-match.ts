/**
 * `include`/`exclude` glob matching and directory traversal, without regular expressions.
 *
 * ```ts
 * const files = readDirectory(fs, '/app', '/app', ['.ts'], ['node_modules'], ['src/**\/*'], unlimitedDepth);
 * ```
 */
import { compareCodePoints } from './diagnostics.js';
import { DirectoryEntries, type FileSystem } from './file-system.js';
import {
  combinePaths,
  compareStringsCaseInsensitive,
  containsPath,
  equateStringsCaseInsensitive,
  fileExtensionIsOneOf,
  getBaseFileName,
  getCanonicalFileName,
  getDirectoryPath,
  getPathComponents,
  isRootedDiskPath,
  normalizePath,
  reducePathComponents,
  removeTrailingDirectorySeparator,
} from './path.js';

export const enum MatchUsage {
  Files,
  Directories,
  Exclude,
}

/** A depth for `readDirectory` without a limit. */
export const unlimitedDepth = Number.MAX_SAFE_INTEGER;

/** Whether an `include` component without an extension or wildcard stands for `component/**\/*`. */
export function isImplicitGlob(lastPathComponent: string): boolean {
  for (let i = 0; i < lastPathComponent.length; i++) {
    const ch = lastPathComponent.charCodeAt(i);
    if (ch === 0x2e /* . */ || ch === 0x2a /* * */ || ch === 0x3f /* ? */) return false;
  }
  return true;
}

function hasWildcard(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (ch === 0x2a || ch === 0x3f) return true;
  }
  return false;
}

/** Files under `path` with one of `extensions` matched by `includes` and not `excludes`, grouped by the first matching include. */
export function readDirectory(
  fs: FileSystem,
  currentDirectory: string,
  path: string,
  extensions: readonly string[],
  excludes: readonly string[],
  includes: readonly string[],
  depth: number,
  onMatch?: (path: string) => void,
): string[] {
  path = normalizePath(path);
  currentDirectory = normalizePath(currentDirectory);
  const absolutePath = combinePaths(currentDirectory, path);
  const caseSensitive = fs.useCaseSensitiveFileNames;
  const visitor = new GlobVisitor(
    fs,
    new GlobMatcher(includes, excludes, absolutePath, caseSensitive, MatchUsage.Files),
    new GlobMatcher(includes, excludes, absolutePath, caseSensitive, MatchUsage.Directories),
    extensions,
    onMatch,
  );
  for (const basePath of getBasePaths(path, includes, caseSensitive)) {
    visitor.visit(basePath, combinePaths(currentDirectory, basePath), depth, '');
  }
  const results = visitor.results;
  if (results.length === 1) return results[0];
  const flat: string[] = [];
  for (const bucket of results) for (const file of bucket) flat.push(file);
  return flat;
}

/** Matches paths against any of several specs. */
export class SpecMatcher {
  private constructor(private readonly patterns: readonly GlobPattern[]) {}

  /** `undefined` when no spec can match anything. */
  static create(
    specs: readonly string[],
    basePath: string,
    usage: MatchUsage,
    useCaseSensitiveFileNames: boolean,
  ): SpecMatcher | undefined {
    const patterns: GlobPattern[] = [];
    for (const spec of specs) {
      const pattern = GlobPattern.compile(spec, basePath, usage, useCaseSensitiveFileNames);
      if (pattern !== undefined) patterns.push(pattern);
    }
    return patterns.length === 0 ? undefined : new SpecMatcher(patterns);
  }

  matches(path: string): boolean {
    return this.matchIndex(path) !== -1;
  }

  /** Index of the first matching pattern, or -1. */
  matchIndex(path: string): number {
    for (let i = 0; i < this.patterns.length; i++) if (this.patterns[i].matches(path, '', false)) return i;
    return -1;
  }
}

// ---- Base paths

function getIncludeBasePath(absolute: string): string {
  let wildcard = -1;
  for (let i = 0; i < absolute.length; i++) {
    const ch = absolute.charCodeAt(i);
    if (ch === 0x2a || ch === 0x3f) {
      wildcard = i;
      break;
    }
  }
  if (wildcard < 0) {
    return hasExtension(absolute) ? removeTrailingDirectorySeparator(getDirectoryPath(absolute)) : absolute;
  }
  return absolute.slice(0, Math.max(absolute.lastIndexOf('/', wildcard - 1), 0));
}

/** Whether the base name of `path` has a `.`. */
export function hasExtension(path: string): boolean {
  return getBaseFileName(path).includes('.');
}

/** `path` and the literal prefixes of `includes` that are not inside it or each other. */
function getBasePaths(path: string, includes: readonly string[], caseSensitive: boolean): string[] {
  const basePaths = [path];
  if (includes.length === 0) return basePaths;
  const includeBasePaths: string[] = [];
  for (const include of includes) {
    const absolute = isRootedDiskPath(include) ? include : normalizePath(combinePaths(path, include));
    includeBasePaths.push(getIncludeBasePath(absolute));
  }
  includeBasePaths.sort(caseSensitive ? compareCodePoints : compareStringsCaseInsensitive);
  for (const includeBasePath of includeBasePaths) {
    let contained = false;
    for (const basePath of basePaths) {
      if (containsPath(basePath, includeBasePath, caseSensitive, path)) {
        contained = true;
        break;
      }
    }
    if (!contained) basePaths.push(includeBasePath);
  }
  return basePaths;
}

// ---- Patterns

const enum ComponentKind {
  Literal,
  Wildcard,
  /** `**`: zero or more directories. */
  DoubleAsterisk,
}

const enum SegmentKind {
  Literal,
  /** `*`: any characters but `/`. */
  Star,
  /** `?`: one character but `/`. */
  Question,
}

class Segment {
  constructor(
    readonly kind: SegmentKind,
    readonly literal: string,
  ) {}
}

class Component {
  constructor(
    readonly kind: ComponentKind,
    readonly literal: string,
    readonly segments: readonly Segment[],
    /** Include wildcards don't match `node_modules`, `bower_components` or `jspm_packages`. */
    readonly skipPackageFolders: boolean,
    /** A literal segment mentions `.min.`, so `.min.js` files aren't skipped. */
    readonly mentionsMinSuffix: boolean,
  ) {}
}

function parseComponent(text: string, isInclude: boolean, caseSensitive: boolean): Component {
  if (text === '**') return new Component(ComponentKind.DoubleAsterisk, '', [], false, false);
  if (!hasWildcard(text)) return new Component(ComponentKind.Literal, text, [], false, false);
  const segments: Segment[] = [];
  let mentionsMinSuffix = false;
  let start = 0;
  for (let i = 0; i <= text.length; i++) {
    const ch = i < text.length ? text.charCodeAt(i) : -1;
    if (ch !== 0x2a && ch !== 0x3f && ch !== -1) continue;
    if (i > start) {
      const literal = text.slice(start, i);
      if ((caseSensitive ? literal : literal.toLowerCase()).includes('.min.')) mentionsMinSuffix = true;
      segments.push(new Segment(SegmentKind.Literal, literal));
    }
    if (ch !== -1) segments.push(new Segment(ch === 0x2a ? SegmentKind.Star : SegmentKind.Question, ''));
    start = i + 1;
  }
  return new Component(ComponentKind.Wildcard, '', segments, isInclude, mentionsMinSuffix);
}

/**
 * Reads the components of `prefix + suffix` without concatenating them, where `prefix` is empty or
 * a directory ending in `/` and `suffix` is a single name. `read` sets `text`, `start` and `end` to the
 * component and `next` to the offset after it, in combined coordinates.
 */
class PathReader {
  text = '';
  start = 0;
  end = 0;
  next = 0;

  read(prefix: string, suffix: string, offset: number): boolean {
    if (suffix === '') return this.readSingle(prefix, offset, 0);
    if (prefix === '') return this.readSingle(suffix, offset, 0);
    if (offset >= prefix.length + suffix.length) return false;
    if (offset === 0 && prefix.charCodeAt(0) === 0x2f) return this.found(prefix, 0, 0, 1);
    if (offset < prefix.length) {
      while (offset < prefix.length && prefix.charCodeAt(offset) === 0x2f) offset++;
      if (offset < prefix.length) {
        const end = prefix.indexOf('/', offset);
        return this.found(prefix, offset, end, end);
      }
    }
    const start = offset - prefix.length;
    if (start >= suffix.length) return false;
    return this.found(suffix, start, suffix.length, prefix.length + suffix.length);
  }

  /** Reads from `text`, whose offset 0 is `base` in combined coordinates. */
  private readSingle(text: string, offset: number, base: number): boolean {
    if (offset >= text.length) return false;
    if (offset === 0 && text.charCodeAt(0) === 0x2f) return this.found(text, 0, 0, base + 1);
    while (offset < text.length && text.charCodeAt(offset) === 0x2f) offset++;
    if (offset >= text.length) return false;
    let end = text.indexOf('/', offset);
    if (end === -1) end = text.length;
    return this.found(text, offset, end, base + end);
  }

  private found(text: string, start: number, end: number, next: number): boolean {
    this.text = text;
    this.start = start;
    this.end = end;
    this.next = next;
    return true;
  }
}

/** A compiled glob spec such as `src/**\/*.ts`. */
class GlobPattern {
  private readonly reader = new PathReader();

  private constructor(
    private readonly components: readonly Component[],
    private readonly isExclude: boolean,
    private readonly caseSensitive: boolean,
    /** `files` patterns skip `.min.js` files unless the pattern mentions them. */
    private readonly excludeMinJs: boolean,
  ) {}

  /** `undefined` if the spec matches nothing. */
  static compile(spec: string, basePath: string, usage: MatchUsage, caseSensitive: boolean): GlobPattern | undefined {
    const parts = reducePathComponents(getPathComponents(spec, basePath));
    if (usage !== MatchUsage.Exclude && parts[parts.length - 1] === '**') return undefined;
    parts[0] = removeTrailingDirectorySeparator(parts[0]);
    if (isImplicitGlob(parts[parts.length - 1])) parts.push('**', '*');
    const isInclude = usage !== MatchUsage.Exclude;
    const components: Component[] = [];
    for (const part of parts) components.push(parseComponent(part, isInclude, caseSensitive));
    return new GlobPattern(components, !isInclude, caseSensitive, usage === MatchUsage.Files);
  }

  /** Whether `prefix + suffix` matches, or with `prefixOnly`, whether files below it could. */
  matches(prefix: string, suffix: string, prefixOnly: boolean): boolean {
    return this.matchFrom(prefix, suffix, 0, 0, prefixOnly);
  }

  private matchFrom(prefix: string, suffix: string, offset: number, index: number, prefixOnly: boolean): boolean {
    const reader = this.reader;
    const components = this.components;
    for (;;) {
      if (!reader.read(prefix, suffix, offset)) return prefixOnly || this.satisfiedFrom(index);
      if (index >= components.length) return this.isExclude && !prefixOnly;
      const text = reader.text;
      const start = reader.start;
      const end = reader.end;
      const next = reader.next;
      const component = components[index];
      if (component.kind === ComponentKind.DoubleAsterisk) {
        if (this.matchFrom(prefix, suffix, offset, index + 1, prefixOnly)) return true;
        if (!this.isExclude && (isHidden(text, start, end) || isPackageFolder(text, start, end))) return false;
        offset = next;
        continue;
      }
      if (component.kind === ComponentKind.Literal) {
        if (!this.equalAt(component.literal, text, start, end)) return false;
      } else {
        if (component.skipPackageFolders && isPackageFolder(text, start, end)) return false;
        if (!this.matchWildcard(component, text, start, end)) return false;
      }
      offset = next;
      index++;
    }
  }

  /** Whether the components from `index` on can match nothing: only `**` remain. */
  private satisfiedFrom(index: number): boolean {
    for (let i = index; i < this.components.length; i++) {
      if (this.components[i].kind !== ComponentKind.DoubleAsterisk) return false;
    }
    return true;
  }

  private matchWildcard(component: Component, text: string, start: number, end: number): boolean {
    const segments = component.segments;
    // Leading wildcards of includes don't match hidden names.
    if (!this.isExclude && isHidden(text, start, end) && segments[0].kind !== SegmentKind.Literal) return false;
    if (segments.length === 2 && segments[0].kind === SegmentKind.Star && segments[1].kind === SegmentKind.Literal) {
      const literal = segments[1].literal;
      if (end - start < literal.length || !this.equalAt(literal, text, end - literal.length, end)) return false;
    } else if (!this.matchSegments(segments, text, start, end)) {
      return false;
    }
    return !this.excludeMinJs || component.mentionsMinSuffix || !this.hasMinJsSuffix(text, start, end);
  }

  /** Matches with backtracking to the last star only, in O(length × segments). */
  private matchSegments(segments: readonly Segment[], text: string, start: number, end: number): boolean {
    let index = 0;
    let position = start;
    let starIndex = -1;
    let starPosition = start;
    while (position < end) {
      if (index < segments.length) {
        const segment = segments[index];
        if (segment.kind === SegmentKind.Literal) {
          const literalEnd = position + segment.literal.length;
          if (literalEnd <= end && this.equalAt(segment.literal, text, position, literalEnd)) {
            position = literalEnd;
            index++;
            continue;
          }
        } else if (segment.kind === SegmentKind.Question) {
          if (text.charCodeAt(position) !== 0x2f) {
            position += codePointLength(text, position);
            index++;
            continue;
          }
        } else {
          starIndex = index;
          starPosition = position;
          index++;
          continue;
        }
      }
      if (starIndex >= 0 && starPosition < end && text.charCodeAt(starPosition) !== 0x2f) {
        starPosition += codePointLength(text, starPosition);
        position = starPosition;
        index = starIndex + 1;
        continue;
      }
      return false;
    }
    while (index < segments.length && segments[index].kind === SegmentKind.Star) index++;
    return index >= segments.length;
  }

  private hasMinJsSuffix(text: string, start: number, end: number): boolean {
    if (end - start < 7) return false;
    return this.caseSensitive
      ? text.startsWith('.min.js', end - 7)
      : equalIgnoringCaseAt('.min.js', text, end - 7, end);
  }

  private equalAt(literal: string, text: string, start: number, end: number): boolean {
    if (this.caseSensitive) return end - start === literal.length && text.startsWith(literal, start);
    return equalIgnoringCaseAt(literal, text, start, end);
  }
}

function codePointLength(text: string, position: number): number {
  const ch = text.charCodeAt(position);
  return ch >= 0xd800 && ch <= 0xdbff && position + 1 < text.length ? 2 : 1;
}

/** Whether `text.slice(start, end)` equals `literal` under case folding. */
function equalIgnoringCaseAt(literal: string, text: string, start: number, end: number): boolean {
  if (end - start !== literal.length) return equateStringsCaseInsensitive(literal, text.slice(start, end));
  for (let i = 0; i < literal.length; i++) {
    const a = literal.charCodeAt(i);
    const b = text.charCodeAt(start + i);
    if (a === b) continue;
    if (a >= 0x80 || b >= 0x80) return equateStringsCaseInsensitive(literal, text.slice(start, end));
    const lower = a | 0x20;
    if (lower !== (b | 0x20) || lower < 0x61 || lower > 0x7a) return false;
  }
  return true;
}

function isHidden(text: string, start: number, end: number): boolean {
  return end > start && text.charCodeAt(start) === 0x2e;
}

function isPackageFolder(text: string, start: number, end: number): boolean {
  switch (end - start) {
    case 12:
      return equalIgnoringCaseAt('node_modules', text, start, end);
    case 13:
      return equalIgnoringCaseAt('jspm_packages', text, start, end);
    case 16:
      return equalIgnoringCaseAt('bower_components', text, start, end);
  }
  return false;
}

// ---- Traversal

/** Include and exclude patterns together. */
class GlobMatcher {
  readonly includes: GlobPattern[] = [];
  private readonly excludes: GlobPattern[] = [];
  /** Include specs were given, even if none compiled. */
  private readonly hadIncludes: boolean;

  constructor(
    includeSpecs: readonly string[],
    excludeSpecs: readonly string[],
    basePath: string,
    caseSensitive: boolean,
    usage: MatchUsage,
  ) {
    this.hadIncludes = includeSpecs.length > 0;
    for (const spec of includeSpecs) {
      const pattern = GlobPattern.compile(spec, basePath, usage, caseSensitive);
      if (pattern !== undefined) this.includes.push(pattern);
    }
    for (const spec of excludeSpecs) {
      const pattern = GlobPattern.compile(spec, basePath, MatchUsage.Exclude, caseSensitive);
      if (pattern !== undefined) this.excludes.push(pattern);
    }
  }

  /** The index of the first include matching `directory + name`, or -1; 0 without includes. */
  matchFile(directory: string, name: string): number {
    if (this.isExcluded(directory, name)) return -1;
    if (this.includes.length === 0) return this.hadIncludes ? -1 : 0;
    for (let i = 0; i < this.includes.length; i++) {
      if (this.includes[i].matches(directory, name, false)) return i;
    }
    return -1;
  }

  /** Whether files below `directory + name` could match. */
  matchesDirectory(directory: string, name: string): boolean {
    if (this.isExcluded(directory, name)) return false;
    if (this.includes.length === 0) return !this.hadIncludes;
    for (const include of this.includes) if (include.matches(directory, name, true)) return true;
    return false;
  }

  private isExcluded(directory: string, name: string): boolean {
    for (const exclude of this.excludes) if (exclude.matches(directory, name, false)) return true;
    return false;
  }
}

class GlobVisitor {
  private readonly visited = new Set<string>();
  readonly results: string[][];

  constructor(
    private readonly fs: FileSystem,
    private readonly fileMatcher: GlobMatcher,
    private readonly directoryMatcher: GlobMatcher,
    private readonly extensions: readonly string[],
    /** Called with each file as it matches. */
    private readonly onMatch: ((path: string) => void) | undefined,
  ) {
    const buckets = Math.max(fileMatcher.includes.length, 1);
    this.results = [];
    for (let i = 0; i < buckets; i++) this.results.push([]);
  }

  /** Walks `absolutePath`; `realPath` is its known real path, or `''` to look it up. */
  visit(path: string, absolutePath: string, depth: number, realPath: string): void {
    if (realPath === '') realPath = this.fs.realpath(absolutePath);
    const canonical = getCanonicalFileName(realPath, this.fs.useCaseSensitiveFileNames);
    if (this.visited.has(canonical)) return;
    this.visited.add(canonical);

    const entries: DirectoryEntries = this.fs.getAccessibleEntries(absolutePath);
    const pathPrefix = withTrailingSlash(path);
    const absolutePrefix = withTrailingSlash(absolutePath);
    for (const file of entries.files) {
      if (this.extensions.length > 0 && !fileExtensionIsOneOf(file, this.extensions)) continue;
      const include = this.fileMatcher.matchFile(absolutePrefix, file);
      if (include === -1) continue;
      const match = pathPrefix + file;
      this.results[include].push(match);
      if (this.onMatch !== undefined) this.onMatch(match);
    }

    if (depth !== unlimitedDepth) {
      depth--;
      if (depth === 0) return;
    }

    for (const directory of entries.directories) {
      if (!this.directoryMatcher.matchesDirectory(absolutePrefix, directory)) continue;
      // Real paths of plain subdirectories follow from the parent's; symlinks need a lookup.
      const symlinks = entries.symlinks;
      const childRealPath = symlinks !== undefined && !symlinks.has(directory) ? combinePaths(realPath, directory) : '';
      this.visit(pathPrefix + directory, absolutePrefix + directory, depth, childRealPath);
    }
  }
}

function withTrailingSlash(path: string): string {
  return path.length > 0 && path.charCodeAt(path.length - 1) !== 0x2f ? path + '/' : path;
}
