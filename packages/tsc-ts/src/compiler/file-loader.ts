/**
 * Finds every file of a program: root files, libraries, references, imports and type directives, in tsgo's order.
 */
import {
  ImportDeclaration,
  NodeFlags,
  ParseOptions,
  ScriptKind,
  StringLiteral,
  getText,
  type ExternalModuleIndicatorOptions,
  type Node,
  type SourceFile,
} from './ast.js';
import { Diagnostics, type DiagnosticMessage, type MessageWithArgs } from './diagnostics.js';
import { FileIncludeKind, FileIncludeReason, IncludeProcessor, ProcessingDiagnostic } from './file-include.js';
import type { FileSystem } from './file-system.js';
import { ModuleResolutionHost, Resolver, getAutomaticTypeDirectiveNames } from './module-resolution.js';
import {
  getResolutionDiagnostic,
  inferredTypesContainingFile,
  type PackageId,
  type ResolvedModule,
  type ResolvedTypeReferenceDirective,
} from './module-resolution-types.js';
import {
  getAllowJS,
  getIsolatedModules,
  getModuleResolutionKind,
  ModuleKind,
  ModuleResolutionKind,
  type CompilerOptions,
} from './options.js';
import { LoadKind, type LoadJobs, type PreparedFile, preparedLoad, takePreparedFile } from './parallel-parse.js';
import { parseSourceFile } from './parser.js';
import { mark } from './timeline.js';
import {
  combinePaths,
  fileExtensionIsOneOf,
  getCanonicalFileName,
  getDirectoryPath,
  getNormalizedAbsolutePath,
  getRootLength,
  hasJSFileExtension,
  isRootedDiskPath,
  normalizePath,
  normalizeSlashes,
  removeTrailingDirectorySeparator,
  supportedTSExtensionsWithJsonFlat,
  toFileNameLowerCase,
  toPath,
} from './path.js';
import {
  getDefaultLibFileName,
  getDefaultResolutionModeForFile,
  getExternalModuleIndicatorOptions,
  getImpliedNodeFormatForFile,
  getJSXImplicitImportBase,
  getJSXRuntimeImport,
  getLibFileName,
  getModeForUsageLocation,
  isExternalModule,
  isSourceFileJS,
  libFileMetadata,
  libNames,
  SourceFileMetadata,
} from './program-utilities.js';
import { SyntaxKind } from './syntax-kind.js';
import { hasExtension } from './vfs-match.js';
import { TokenFlags } from './types.js';
import {
  ConfigParser,
  flattenExtensions,
  getSupportedExtensions,
  getSupportedExtensionsWithJsonIfResolveJsonModule,
  type ParsedCommandLine,
  type SourceOutputAndProjectReference,
} from './tsconfig.js';

/** Files and services the compiler reads through. */
export class CompilerHost extends ModuleResolutionHost {
  private readonly configParser: ConfigParser;

  constructor(
    readonly fs: FileSystem,
    readonly currentDirectory: string,
    /** Where bundled `lib.*.d.ts` files are. */
    readonly defaultLibraryPath: string,
  ) {
    super();
    this.configParser = new ConfigParser(fs, currentDirectory);
  }

  useCaseSensitiveFileNames(): boolean {
    return this.fs.useCaseSensitiveFileNames;
  }

  getCurrentDirectory(): string {
    return this.currentDirectory;
  }

  fileExists(path: string): boolean {
    return this.fs.fileExists(path);
  }

  directoryExists(path: string): boolean {
    return this.fs.directoryExists(path);
  }

  readFile(path: string): string | undefined {
    return this.fs.readFile(path);
  }

  realpath(path: string): string {
    return this.fs.realpath(path);
  }

  getDirectories(path: string): readonly string[] {
    return this.fs.getAccessibleEntries(path).directories;
  }

  /** Parses a file, or returns `undefined` if it can't be read. */
  getSourceFile(
    fileName: string,
    path: string,
    externalModuleIndicatorOptions: ExternalModuleIndicatorOptions,
  ): SourceFile | undefined {
    // A file that parse threads prepared (parallel-parse.ts).
    const prepared = takePreparedFile(fileName, path, externalModuleIndicatorOptions);
    if (prepared !== undefined) return prepared;
    const text = this.fs.readFile(fileName);
    if (text === undefined) return undefined;
    return parseSourceFile(fileName, text, new ParseOptions(path, ScriptKind.Unknown, externalModuleIndicatorOptions));
  }

  /** The config of a referenced project, or `undefined` if it can't be read. */
  getResolvedProjectReference(fileName: string): ParsedCommandLine | undefined {
    return this.configParser.parseConfigFile(fileName, undefined, undefined, []);
  }

  /** Called with module resolution traces under `--traceResolution`. */
  trace(_message: MessageWithArgs): void {}
}

/** A bundled library file. */
export class LibFile {
  constructor(
    readonly name: string,
    readonly path: string,
    /** Found through `libReplacement` in `node_modules/@typescript/lib-*`. */
    readonly replaced: boolean,
  ) {}
}

/** The JSX runtime import of a file, synthesized for resolution. */
export class JsxRuntimeImport {
  constructor(
    readonly moduleReference: string,
    readonly specifier: StringLiteral,
  ) {}
}

/** A file found through a package installed at several places, kept only once. */
export class RedirectFile {
  constructor(
    /** Where in `getSourceFiles()` order it is explained. */
    public index: number,
    readonly fileName: string,
    readonly path: string,
    /** The path of the file it redirects to. */
    readonly target: string,
  ) {}
}

/** Module resolution results of a file, by name and mode. */
export type ModeAwareCache<T> = Map<string, T>;

export function modeAwareKey(name: string, mode: ModuleKind): string {
  return mode + '|' + name;
}

/** A file a loaded file adds (`ParseTask.addSubTask`), as a parse thread recorded it (`LoadedFile`). */
export class LoadedReference {
  constructor(
    readonly normalizedFilePath: string,
    /** The library file's name, or `''`. */
    readonly libName: string,
    readonly reason: FileIncludeReason,
    readonly increaseDepth: boolean,
    readonly elideOnDepth: boolean,
    readonly packageId: PackageId | undefined,
  ) {}
}

/**
 * What a parse thread's FileLoader found loading a file it prepared (parallel-parse.ts): the same
 * as the program's FileLoader finds, since both load with the same options and file system. The
 * program's FileLoader takes it instead of resolving the file's references, imports and type
 * directives again. Published with the file, so the reasons are copied when taken.
 */
export class LoadedFile {
  constructor(
    readonly file: SourceFile,
    readonly isLibFile: boolean,
    readonly metadata: SourceFileMetadata,
    readonly references: LoadedReference[],
    readonly resolutionsInFile: ModeAwareCache<ResolvedModule> | undefined,
    readonly typeResolutionsInFile: ModeAwareCache<ResolvedTypeReferenceDirective> | undefined,
    readonly processingDiagnostics: ProcessingDiagnostic[],
    readonly importHelpersImportSpecifier: StringLiteral | undefined,
    readonly jsxRuntimeImport: JsxRuntimeImport | undefined,
  ) {}
}

/** Sub-tasks of a prepared file built ahead (`FileLoader.takeAhead`), and what they were built from. */
class SubTasksAhead {
  constructor(
    readonly loaded: LoadedFile,
    readonly subTasks: ParseTask[],
  ) {}
}

class ParseTask {
  path = '';
  file: SourceFile | undefined = undefined;
  redirectedParseTask: ParseTask | undefined = undefined;
  subTasks: ParseTask[] = [];
  loaded = false;
  startedSubTasks = false;
  metadata: SourceFileMetadata = libFileMetadata;
  resolutionsInFile: ModeAwareCache<ResolvedModule> | undefined = undefined;
  readonly resolutionsTrace: MessageWithArgs[] = [];
  typeResolutionsInFile: ModeAwareCache<ResolvedTypeReferenceDirective> | undefined = undefined;
  readonly typeResolutionsTrace: MessageWithArgs[] = [];
  readonly processingDiagnostics: ProcessingDiagnostic[] = [];
  importHelpersImportSpecifier: StringLiteral | undefined = undefined;
  jsxRuntimeImport: JsxRuntimeImport | undefined = undefined;
  /** The task of the same file name that was loaded instead of this one. */
  loadedTask: ParseTask | undefined = undefined;

  constructor(
    readonly normalizedFilePath: string,
    readonly libFile: LibFile | undefined,
    readonly includeReason: FileIncludeReason | undefined,
    readonly isForAutomaticTypeDirective: boolean,
    readonly increaseDepth: boolean,
    /** A JavaScript file found in `node_modules`, loaded only within `maxNodeModuleJsDepth`. */
    readonly elideOnDepth: boolean,
    readonly packageId: PackageId | undefined,
  ) {}

  addSubTask(
    fileName: string,
    libFile: LibFile | undefined,
    reason: FileIncludeReason,
    increaseDepth: boolean,
    elideOnDepth: boolean,
    packageId: PackageId | undefined,
  ): void {
    this.subTasks.push(
      new ParseTask(normalizePath(fileName), libFile, reason, false, increaseDepth, elideOnDepth, packageId),
    );
  }
}

/** The tasks of one path, by file name casing. */
class ParseTaskData {
  readonly tasks = new Map<string, ParseTask>();
  lowestDepth = Number.MAX_SAFE_INTEGER;
  startedSubTasks = false;
  packageId: PackageId | undefined = undefined;

  constructor(task: ParseTask) {
    this.tasks.set(task.normalizedFilePath, task);
  }
}

/** Pending processing of `tasks[index]`. */
class ParseWork {
  constructor(
    readonly tasks: ParseTask[],
    readonly index: number,
    readonly data: ParseTaskData,
    readonly loaded: boolean,
    readonly depth: number,
  ) {}
}

/** Referenced projects, and how their sources map to declaration outputs. */
export class ProjectReferenceMapper {
  readonly configToProjectReference = new Map<string, ParsedCommandLine | undefined>();
  readonly referencesInConfigFile = new Map<string, readonly string[]>();
  readonly sourceToProjectReference = new Map<string, SourceOutputAndProjectReference>();
  readonly outputDtsToProjectReference = new Map<string, SourceOutputAndProjectReference>();
  private readonly realpathDtsToSource = new Map<string, SourceOutputAndProjectReference | null>();
  /** Set while loading files, for symlink lookups. */
  loader: FileLoader | undefined = undefined;

  constructor(readonly config: ParsedCommandLine) {}

  /** The declaration output to load instead of a source of a referenced project, or `''`. */
  getParseFileRedirect(path: string): string {
    const output = this.sourceToProjectReference.get(path);
    return output !== undefined ? output.outputDts : '';
  }

  /** The referenced project whose options apply to a file. */
  getRedirectForResolution(path: string, fileName: string): SourceOutputAndProjectReference | undefined {
    return (
      this.sourceToProjectReference.get(path) ??
      this.outputDtsToProjectReference.get(path) ??
      this.getSourceToDtsIfSymlink(path, fileName)
    );
  }

  getCompilerOptionsForFile(path: string, fileName: string): CompilerOptions {
    return this.getRedirectForResolution(path, fileName)?.resolved.options ?? this.config.options;
  }

  /** Under `preserveSymlinks`, a symlinked declaration in `node_modules` may be the output of a reference. */
  private getSourceToDtsIfSymlink(path: string, fileName: string): SourceOutputAndProjectReference | undefined {
    const known = this.realpathDtsToSource.get(path);
    if (known !== undefined) return known ?? undefined;
    const loader = this.loader;
    if (loader === undefined || this.config.options.preserveSymlinks !== true) return undefined;
    let result: SourceOutputAndProjectReference | undefined;
    if (fileName.includes('/node_modules/')) {
      const realPath = loader.toPath(loader.host.realpath(fileName));
      if (realPath !== path) result = this.outputDtsToProjectReference.get(realPath);
    }
    this.realpathDtsToSource.set(path, result ?? null);
    return result;
  }

  /** The configs of the root config's references, `undefined` for those that couldn't be read. */
  resolvedProjectReferences(): (ParsedCommandLine | undefined)[] {
    const result: (ParsedCommandLine | undefined)[] = [];
    const configFile = this.config.configFile;
    if (configFile === undefined) return result;
    for (const path of this.referencesInConfigFile.get(configFile.sourceFile.path) ?? []) {
      result.push(this.configToProjectReference.get(path));
    }
    return result;
  }
}

/** A referenced project to read. */
class ProjectReferenceTask {
  resolved: ParsedCommandLine | undefined = undefined;
  subTasks: ProjectReferenceTask[] = [];

  constructor(readonly configName: string) {}
}

class ReferenceDiagnostic {
  constructor(
    readonly message: DiagnosticMessage,
    readonly args: readonly string[],
  ) {}
}

/** What loading produced. */
export class ProcessedFiles {
  constructor(
    readonly resolver: Resolver,
    /** Libraries first, sorted, then other files in load order. */
    readonly files: readonly SourceFile[],
    readonly filesByPath: ReadonlyMap<string, SourceFile>,
    readonly missingFiles: readonly string[],
    readonly resolvedModules: ReadonlyMap<string, ModeAwareCache<ResolvedModule> | undefined>,
    readonly typeResolutionsInFile: ReadonlyMap<string, ModeAwareCache<ResolvedTypeReferenceDirective> | undefined>,
    readonly sourceFileMetadata: ReadonlyMap<string, SourceFileMetadata>,
    readonly jsxRuntimeImports: ReadonlyMap<string, JsxRuntimeImport>,
    readonly importHelpersImportSpecifiers: ReadonlyMap<string, StringLiteral>,
    readonly libFiles: ReadonlyMap<string, LibFile>,
    /** Files found while searching `node_modules`. */
    readonly sourceFilesFoundSearchingNodeModules: ReadonlySet<string>,
    readonly includeProcessor: IncludeProcessor,
    /** Declaration outputs of referenced projects loaded for their sources, mapped back to the sources. */
    readonly outputFileToProjectReferenceSource: ReadonlyMap<string, string>,
    readonly redirectTargets: ReadonlyMap<string, string[]>,
    readonly redirectFilesByPath: ReadonlyMap<string, RedirectFile>,
    readonly projectReferenceMapper: ProjectReferenceMapper,
  ) {}
}

class LibResolution {
  constructor(
    readonly libraryName: string,
    readonly resolution: ResolvedModule,
    readonly trace: readonly MessageWithArgs[],
  ) {}
}

/** Loads files depth-first in tsgo's single-threaded order; the result does not depend on that order. */
export class FileLoader {
  readonly resolver: Resolver;
  readonly mapper: ProjectReferenceMapper;
  private readonly options: CompilerOptions;
  private readonly defaultLibraryPath: string;
  private readonly supportedExtensions: readonly (readonly string[])[];
  private readonly supportedExtensionsWithJson: readonly (readonly string[])[];
  private readonly maxNodeModuleJsDepth: number;
  private readonly rootTasks: ParseTask[] = [];
  private readonly taskDataByPath = new Map<string, ParseTaskData>();
  /** Work queued by `start`, run last-in first-out like tsgo's single-threaded work group. */
  private readonly work: ParseWork[] = [];
  private readonly libFileCache = new Map<string, LibFile>();
  private readonly libResolutions = new Map<string, LibResolution>();
  private readonly referenceTasks = new Map<string, ProjectReferenceTask>();
  /** `toPath` of each file name seen: every reference to a file asks again. */
  private readonly paths = new Map<string, string>();
  /** The normalized config file name root files are found from, once computed. */
  private rootContainingFile: string | undefined = undefined;
  /** Root files whose tasks `addRootFiles` added. */
  private rootFilesAdded = 0;
  /** The sub-tasks of prepared files, by file name, built ahead by `takeAhead`. */
  private readonly subTasksAhead = new Map<string, SubTasksAhead>();

  constructor(
    readonly host: CompilerHost,
    private readonly config: ParsedCommandLine,
  ) {
    const options = config.options;
    this.options = options;
    this.defaultLibraryPath = getNormalizedAbsolutePath(host.defaultLibraryPath, host.currentDirectory);
    this.supportedExtensions = getSupportedExtensions(options);
    this.supportedExtensionsWithJson = getSupportedExtensionsWithJsonIfResolveJsonModule(options);
    this.maxNodeModuleJsDepth = options.maxNodeModuleJsDepth ?? 0;
    this.mapper = new ProjectReferenceMapper(config);
    this.loadProjectReferences();
    this.resolver = new Resolver(host, options);
  }

  toPath(fileName: string): string {
    let path = this.paths.get(fileName);
    if (path === undefined) {
      path = toPath(fileName, this.host.currentDirectory, this.host.fs.useCaseSensitiveFileNames);
      this.paths.set(fileName, path);
    }
    return path;
  }

  /**
   * Adds the tasks of up to `count` more root files, the first step of `load`: the main thread does
   * this while parse threads load the files (parallel-parse.ts). Returns whether every root file's
   * task is added.
   */
  addRootFiles(count: number): boolean {
    const rootFiles = this.config.fileNames;
    const end = Math.min(rootFiles.length, this.rootFilesAdded + count);
    for (let i = this.rootFilesAdded; i < end; i++) this.addRootFileTask(rootFiles[i], FileIncludeReason.rootFile(i));
    this.rootFilesAdded = end;
    return end === rootFiles.length;
  }

  /**
   * Builds ahead what loading takes from each of `files` (`takeLoadedFile`): the main thread does
   * this while parse threads load more files (parallel-parse.ts).
   */
  takeAhead(files: readonly PreparedFile[]): void {
    for (const prepared of files) {
      const loaded = prepared.loaded;
      if (loaded === undefined) continue;
      const subTasks = this.subTasksOf(loaded);
      for (const task of subTasks) task.path = this.toPath(task.normalizedFilePath);
      this.subTasksAhead.set(prepared.fileName, new SubTasksAhead(loaded, subTasks));
    }
  }

  load(): ProcessedFiles {
    const rootFiles = this.config.fileNames;
    this.addRootFiles(rootFiles.length);
    if (rootFiles.length > 0 && this.options.noLib !== true) {
      const lib = this.options.lib;
      if (lib === undefined) {
        const libFile = this.pathForLibFile(getDefaultLibFileName(this.options));
        this.addRootTask(libFile.path, libFile, FileIncludeReason.libFile(-1));
      } else {
        for (let i = 0; i < lib.length; i++) {
          const name = getLibFileName(lib[i]);
          if (name === '') continue;
          const libFile = this.pathForLibFile(name);
          this.addRootTask(libFile.path, libFile, FileIncludeReason.libFile(i));
        }
      }
    }
    if (rootFiles.length > 0) {
      const containingDirectory =
        this.options.configFilePath !== undefined
          ? getDirectoryPath(this.options.configFilePath)
          : this.host.currentDirectory;
      this.rootTasks.push(
        new ParseTask(
          combinePaths(containingDirectory, inferredTypesContainingFile),
          undefined,
          undefined,
          true,
          false,
          false,
          undefined,
        ),
      );
    }

    mark('loader roots added');
    this.start(this.rootTasks, 0);
    for (let work = this.work.pop(); work !== undefined; work = this.work.pop()) this.run(work);
    mark('loader walked');
    const result = this.collect();
    mark('loader collected');
    this.mapper.loader = undefined;
    return result;
  }

  /**
   * Parse threads (parallel-parse.ts): loads one file as `load` would, parsing it through
   * `host.getSourceFile`, and adds the files it references, imports and type directives add to `out`
   * (libraries by name). `depth` is the file's `maxNodeModuleJsDepth` depth.
   */
  loadAhead(kind: LoadKind, name: string, depth: number, out: LoadJobs): LoadedFile | undefined {
    let task: ParseTask;
    if (kind === LoadKind.Library) {
      const libFile = this.pathForLibFile(name);
      task = new ParseTask(
        getNormalizedAbsolutePath(libFile.path, this.host.currentDirectory),
        libFile,
        undefined,
        false,
        false,
        false,
        undefined,
      );
    } else if (kind === LoadKind.AutomaticTypes) {
      const containingDirectory =
        this.options.configFilePath !== undefined
          ? getDirectoryPath(this.options.configFilePath)
          : this.host.currentDirectory;
      task = new ParseTask(
        combinePaths(containingDirectory, inferredTypesContainingFile),
        undefined,
        undefined,
        true,
        false,
        false,
        undefined,
      );
    } else {
      let fileName = name;
      if (kind === LoadKind.Root) {
        const configFile = this.config.configFile;
        const containingFile =
          configFile !== undefined
            ? getNormalizedAbsolutePath(configFile.sourceFile.fileName, this.host.currentDirectory)
            : this.host.currentDirectory;
        const resolved = this.getSourceFileFromReference(name, name, containingFile, FileIncludeReason.rootFile(0));
        if (typeof resolved !== 'string') return undefined;
        fileName = resolved;
      }
      task = new ParseTask(fileName, undefined, undefined, false, false, false, undefined);
    }
    task.path = this.toPath(task.normalizedFilePath);
    this.loadTask(task);
    const references: LoadedReference[] = [];
    for (const sub of task.subTasks) {
      references.push(
        new LoadedReference(
          sub.normalizedFilePath,
          sub.libFile !== undefined ? sub.libFile.name : '',
          sub.includeReason!,
          sub.increaseDepth,
          sub.elideOnDepth,
          sub.packageId,
        ),
      );
      const subDepth = sub.increaseDepth ? depth + 1 : depth;
      // `run` skips these.
      if (sub.elideOnDepth && subDepth > this.maxNodeModuleJsDepth) continue;
      if (sub.libFile !== undefined) out.push(LoadKind.Library, sub.libFile.name, subDepth);
      else out.push(LoadKind.File, sub.normalizedFilePath, subDepth);
    }
    const file = task.file;
    // Traces are reported in the program's order: such programs resolve on their own.
    if (file === undefined || task.redirectedParseTask !== undefined || this.options.traceResolution === true)
      return undefined;
    return new LoadedFile(
      file,
      task.libFile !== undefined,
      task.metadata,
      references,
      task.resolutionsInFile,
      task.typeResolutionsInFile,
      task.processingDiagnostics,
      task.importHelpersImportSpecifier,
      task.jsxRuntimeImport,
    );
  }

  // ---- Project references

  private loadProjectReferences(): void {
    const references = this.config.resolvedProjectReferencePaths();
    if (references.length === 0) return;
    const configFile = this.config.configFile;
    if (configFile === undefined) return;
    this.mapper.loader = this;
    const tasks = createProjectReferenceTasks(references);
    this.parseProjectReferences(tasks);
    this.mapper.referencesInConfigFile.set(configFile.sourceFile.path, this.mapProjectReferences(tasks, new Set()));
  }

  private parseProjectReferences(tasks: ProjectReferenceTask[]): void {
    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      const path = this.toPath(task.configName);
      const existing = this.referenceTasks.get(path);
      if (existing !== undefined) {
        tasks[i] = existing;
        continue;
      }
      this.referenceTasks.set(path, task);
      task.resolved = this.host.getResolvedProjectReference(task.configName);
      if (task.resolved !== undefined) {
        const subReferences = task.resolved.resolvedProjectReferencePaths();
        if (subReferences.length > 0) task.subTasks = createProjectReferenceTasks(subReferences);
      }
      this.parseProjectReferences(task.subTasks);
    }
  }

  private mapProjectReferences(tasks: readonly ProjectReferenceTask[], seen: Set<ProjectReferenceTask>): string[] {
    const results: string[] = [];
    for (const task of tasks) {
      const path = this.toPath(task.configName);
      results.push(path);
      if (seen.has(task)) continue;
      seen.add(task);
      this.mapper.configToProjectReference.set(path, task.resolved);
      const resolved = task.resolved;
      if (resolved !== undefined && resolved.configFile !== this.config.configFile) {
        // A project's files are mapped before its references', which win for files in both.
        for (const [source, reference] of resolved.sourceToProjectReference()) {
          this.mapper.sourceToProjectReference.set(source, reference);
        }
        for (const [output, reference] of resolved.outputDtsToProjectReference()) {
          this.mapper.outputDtsToProjectReference.set(output, reference);
        }
      }
      this.mapper.referencesInConfigFile.set(path, this.mapProjectReferences(task.subTasks, seen));
    }
    return results;
  }

  // ---- Root tasks

  private addRootTask(fileName: string, libFile: LibFile | undefined, reason: FileIncludeReason): void {
    const absolute = getNormalizedAbsolutePath(fileName, this.host.currentDirectory);
    if (this.options.allowNonTsExtensions === true || hasExtension(absolute)) {
      this.rootTasks.push(new ParseTask(absolute, libFile, reason, false, false, false, undefined));
    }
  }

  private addRootFileTask(fileName: string, reason: FileIncludeReason): void {
    const currentDirectory = this.host.currentDirectory;
    const absolute = getNormalizedAbsolutePath(fileName, currentDirectory);
    let containingFile = this.rootContainingFile;
    if (containingFile === undefined) {
      const configFile = this.config.configFile;
      containingFile =
        configFile !== undefined
          ? getNormalizedAbsolutePath(configFile.sourceFile.fileName, currentDirectory)
          : currentDirectory;
      this.rootContainingFile = containingFile;
    }
    const resolved = this.getSourceFileFromReference(absolute, fileName, containingFile, reason);
    if (typeof resolved === 'string') {
      this.rootTasks.push(new ParseTask(resolved, undefined, reason, false, false, false, undefined));
      return;
    }
    const task = new ParseTask(absolute, undefined, reason, false, false, false, undefined);
    task.processingDiagnostics.push(
      ProcessingDiagnostic.explainingFileInclude('', reason, resolved.message, resolved.args),
    );
    this.rootTasks.push(task);
  }

  private isSupportedExtension(canonicalFileName: string): boolean {
    for (const group of this.supportedExtensionsWithJson) {
      if (fileExtensionIsOneOf(canonicalFileName, group)) return true;
    }
    return false;
  }

  private supportedExtensionsList(): string {
    return "'" + flattenExtensions(this.supportedExtensions).join("', '") + "'";
  }

  /** The file a root file or `/// <reference path>` names, trying extensions, or why there is none. */
  private getSourceFileFromReference(
    fileName: string,
    referenceText: string,
    containingFile: string,
    reason: FileIncludeReason,
  ): string | ReferenceDiagnostic {
    const allowNonTsExtensions = this.options.allowNonTsExtensions === true;
    const diagnosticFileName = normalizeSlashes(referenceText);
    const fs = this.host.fs;
    if (hasExtension(fileName)) {
      const canonicalFileName = getCanonicalFileName(fileName, fs.useCaseSensitiveFileNames);
      if (!allowNonTsExtensions && !this.isSupportedExtension(canonicalFileName)) {
        if (hasJSFileExtension(canonicalFileName)) {
          return new ReferenceDiagnostic(
            Diagnostics.File_0_is_a_JavaScript_file_Did_you_mean_to_enable_the_allowJs_option,
            [diagnosticFileName],
          );
        }
        return new ReferenceDiagnostic(
          Diagnostics.File_0_has_an_unsupported_extension_The_only_supported_extensions_are_1,
          [diagnosticFileName, this.supportedExtensionsList()],
        );
      }
      if (!fs.fileExists(fileName)) return new ReferenceDiagnostic(Diagnostics.File_0_not_found, [diagnosticFileName]);
      if (
        reason.isReferencedFile() &&
        getCanonicalFileName(containingFile, fs.useCaseSensitiveFileNames) === canonicalFileName
      ) {
        return new ReferenceDiagnostic(Diagnostics.A_file_cannot_have_a_reference_to_itself, []);
      }
      return fileName;
    }
    if (allowNonTsExtensions) {
      return fs.fileExists(fileName)
        ? fileName
        : new ReferenceDiagnostic(Diagnostics.File_0_not_found, [diagnosticFileName]);
    }
    for (const extension of this.supportedExtensions[0]) {
      const candidate = fileName + extension;
      if (fs.fileExists(candidate)) return candidate;
    }
    return new ReferenceDiagnostic(Diagnostics.Could_not_resolve_the_path_0_with_the_extensions_Colon_1, [
      diagnosticFileName,
      this.supportedExtensionsList(),
    ]);
  }

  // ---- Libraries

  private pathForLibFile(name: string): LibFile {
    const cached = this.libFileCache.get(name);
    if (cached !== undefined) return cached;
    let path = combinePaths(this.defaultLibraryPath, name);
    let replaced = false;
    if (this.options.libReplacement === true && name !== 'lib.d.ts') {
      const libraryName = getLibraryNameFromLibFileName(name);
      const containingDirectory =
        this.options.configFilePath !== undefined
          ? getDirectoryPath(this.options.configFilePath)
          : this.host.currentDirectory;
      const resolveFrom = combinePaths(containingDirectory, '__lib_node_modules_lookup_' + name + '__.ts');
      const trace: MessageWithArgs[] = [];
      const resolution = this.resolver.resolveModuleName(
        libraryName,
        resolveFrom,
        ModuleKind.CommonJS,
        undefined,
        trace,
      );
      if (resolution.resolvedFileName !== '') {
        path = resolution.resolvedFileName;
        replaced = true;
      }
      const key = this.toPath(resolveFrom);
      if (!this.libResolutions.has(key))
        this.libResolutions.set(key, new LibResolution(libraryName, resolution, trace));
    }
    const libFile = new LibFile(name, path, replaced);
    this.libFileCache.set(name, libFile);
    return libFile;
  }

  private libFilePriority(file: SourceFile): number {
    const directory = removeTrailingDirectorySeparator(this.defaultLibraryPath);
    const fileName = file.fileName;
    if (
      fileName.startsWith(directory) &&
      fileName.length > directory.length &&
      fileName.charCodeAt(directory.length) === 0x2f
    ) {
      const baseName = fileName.slice(fileName.lastIndexOf('/') + 1);
      if (baseName === 'lib.d.ts' || baseName === 'lib.es6.d.ts') return 0;
      let name = baseName.startsWith('lib.') ? baseName.slice(4) : baseName;
      if (name.endsWith('.d.ts')) name = name.slice(0, -5);
      const index = libNames.indexOf(name);
      if (index !== -1) return index + 1;
    }
    return libNames.length + 2;
  }

  // ---- Loading

  private start(tasks: ParseTask[], depth: number): void {
    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      // Sub-tasks built ahead have their paths.
      if (task.path === '') task.path = this.toPath(task.normalizedFilePath);
      let data = this.taskDataByPath.get(task.path);
      const loaded = data !== undefined;
      if (data === undefined) {
        data = new ParseTaskData(task);
        this.taskDataByPath.set(task.path, data);
      }
      this.work.push(new ParseWork(tasks, i, data, loaded, depth));
    }
  }

  private run(work: ParseWork): void {
    const task = work.tasks[work.index];
    const data = work.data;
    let startSubTasks = false;
    if (work.loaded) {
      const existing = data.tasks.get(task.normalizedFilePath);
      if (existing !== undefined) {
        task.loadedTask = existing;
      } else {
        data.tasks.set(task.normalizedFilePath, task);
        // A new casing of a file: load its references if another casing's were.
        startSubTasks = data.startedSubTasks;
      }
    }
    if (data.packageId === undefined && task.packageId !== undefined) data.packageId = task.packageId;
    const depth = task.increaseDepth ? work.depth + 1 : work.depth;
    if (depth < data.lowestDepth) {
      // Reached at a lower depth than before: load references again.
      data.lowestDepth = depth;
      startSubTasks = true;
      data.startedSubTasks = true;
    }
    if (task.elideOnDepth && depth > this.maxNodeModuleJsDepth) return;
    for (const taskByFileName of data.tasks.values()) {
      let loadSubTasks = startSubTasks;
      if (!taskByFileName.loaded) {
        this.loadTask(taskByFileName);
        if (taskByFileName.redirectedParseTask !== undefined) {
          loadSubTasks = true;
          data.startedSubTasks = true;
        }
      }
      if (!taskByFileName.startedSubTasks && loadSubTasks) {
        taskByFileName.startedSubTasks = true;
        this.start(taskByFileName.subTasks, data.lowestDepth);
      }
    }
  }

  private loadTask(task: ParseTask): void {
    task.loaded = true;
    if (task.isForAutomaticTypeDirective) {
      this.loadAutomaticTypeDirectives(task);
      return;
    }
    const redirect = this.mapper.getParseFileRedirect(task.path);
    if (redirect !== '') {
      const redirected = new ParseTask(
        normalizePath(redirect),
        task.libFile,
        task.includeReason,
        false,
        false,
        false,
        undefined,
      );
      task.redirectedParseTask = redirected;
      task.subTasks = [redirected];
      return;
    }

    const fs = this.host.fs;
    if (hasExtension(task.normalizedFilePath) && this.options.allowNonTsExtensions !== true) {
      const canonicalFileName = getCanonicalFileName(task.normalizedFilePath, fs.useCaseSensitiveFileNames);
      if (!this.isSupportedExtension(canonicalFileName)) {
        task.processingDiagnostics.push(
          hasJSFileExtension(canonicalFileName)
            ? ProcessingDiagnostic.explainingFileInclude(
                '',
                task.includeReason,
                Diagnostics.File_0_is_a_JavaScript_file_Did_you_mean_to_enable_the_allowJs_option,
                [task.normalizedFilePath],
              )
            : ProcessingDiagnostic.explainingFileInclude(
                '',
                task.includeReason,
                Diagnostics.File_0_has_an_unsupported_extension_The_only_supported_extensions_are_1,
                [task.normalizedFilePath, this.supportedExtensionsList()],
              ),
        );
        return;
      }
    }

    // What a parse thread found loading this file, if it prepared it as the same kind of file.
    let loaded = preparedLoad(task.normalizedFilePath);
    if (loaded !== undefined && loaded.isLibFile !== (task.libFile !== undefined)) loaded = undefined;
    // Default libraries are scripts: skip looking up their package.json.
    task.metadata =
      task.libFile !== undefined
        ? libFileMetadata
        : (loaded?.metadata ?? this.loadSourceFileMetadata(task.normalizedFilePath));
    const options = this.mapper.getCompilerOptionsForFile(task.path, task.normalizedFilePath);
    const file = this.host.getSourceFile(
      task.normalizedFilePath,
      task.path,
      getExternalModuleIndicatorOptions(task.normalizedFilePath, options, task.metadata),
    );
    if (file === undefined) return;
    task.file = file;
    if (loaded !== undefined && loaded.file === file) {
      this.takeLoadedFile(task, loaded);
      return;
    }

    if (this.options.noResolve !== true) {
      for (let i = 0; i < file.referencedFiles.length; i++) this.resolveTripleSlashPathReference(task, file, i);
      this.resolveTypeReferenceDirectives(task, file);
    }
    if (this.options.noLib !== true) {
      for (let i = 0; i < file.libReferenceDirectives.length; i++) {
        const reason = FileIncludeReason.reference(FileIncludeKind.LibReferenceDirective, task.path, i, undefined);
        const name = getLibFileName(file.libReferenceDirectives[i].fileName);
        if (name === '') {
          task.processingDiagnostics.push(ProcessingDiagnostic.unknownReference(reason));
          continue;
        }
        const libFile = this.pathForLibFile(name);
        task.addSubTask(libFile.path, libFile, reason, false, false, undefined);
      }
    }
    this.resolveImportsAndModuleAugmentations(task, file);
  }

  /** Loads `task` from what a parse thread found loading the same file (`LoadedFile`). */
  private takeLoadedFile(task: ParseTask, loaded: LoadedFile): void {
    const ahead = this.subTasksAhead.get(task.normalizedFilePath);
    if (ahead !== undefined && ahead.loaded === loaded) {
      this.subTasksAhead.delete(task.normalizedFilePath);
      task.subTasks = ahead.subTasks;
    } else task.subTasks = this.subTasksOf(loaded);
    for (const diagnostic of loaded.processingDiagnostics) task.processingDiagnostics.push(diagnostic.copy());
    task.resolutionsInFile = loaded.resolutionsInFile;
    task.typeResolutionsInFile = loaded.typeResolutionsInFile;
    task.importHelpersImportSpecifier = loaded.importHelpersImportSpecifier;
    task.jsxRuntimeImport = loaded.jsxRuntimeImport;
  }

  /** New tasks of the references a parse thread found loading a file. */
  private subTasksOf(loaded: LoadedFile): ParseTask[] {
    const subTasks: ParseTask[] = [];
    for (const reference of loaded.references) {
      const libFile = reference.libName !== '' ? this.pathForLibFile(reference.libName) : undefined;
      subTasks.push(
        new ParseTask(
          reference.normalizedFilePath,
          libFile,
          reference.reason.copy(),
          false,
          reference.increaseDepth,
          reference.elideOnDepth,
          reference.packageId,
        ),
      );
    }
    return subTasks;
  }

  private loadSourceFileMetadata(fileName: string): SourceFileMetadata {
    const scope = this.resolver.getPackageScopeForPath(getDirectoryPath(fileName));
    const kind = getModuleResolutionKind(this.options);
    let packageJsonType = '';
    let packageJsonDirectory = '';
    const contents = scope?.contents;
    if (scope !== undefined && contents !== undefined) {
      packageJsonDirectory = scope.packageDirectory;
      const type = contents.type.value;
      if (
        type !== undefined &&
        ((!fileExtensionIsOneOf(fileName, ['.mts', '.cts', '.mjs', '.cjs']) &&
          ModuleResolutionKind.Node16 <= kind &&
          kind <= ModuleResolutionKind.NodeNext) ||
          fileName.includes('/node_modules/'))
      ) {
        packageJsonType = type;
      }
    }
    return new SourceFileMetadata(
      packageJsonType,
      packageJsonDirectory,
      getImpliedNodeFormatForFile(fileName, packageJsonType),
    );
  }

  private resolveTripleSlashPathReference(task: ParseTask, file: SourceFile, index: number): void {
    const moduleName = file.referencedFiles[index].fileName;
    const containingFile = file.fileName;
    const referencedFileName = isRootedDiskPath(moduleName)
      ? moduleName
      : combinePaths(getDirectoryPath(containingFile), moduleName);
    const reason = FileIncludeReason.reference(
      FileIncludeKind.ReferenceFile,
      this.toPath(containingFile),
      index,
      undefined,
    );
    const resolved = this.getSourceFileFromReference(
      normalizePath(referencedFileName),
      moduleName,
      containingFile,
      reason,
    );
    if (typeof resolved !== 'string') {
      task.processingDiagnostics.push(
        ProcessingDiagnostic.explainingFileInclude('', reason, resolved.message, resolved.args),
      );
      return;
    }
    task.addSubTask(resolved, undefined, reason, false, false, undefined);
  }

  private resolveTypeReferenceDirectives(task: ParseTask, file: SourceFile): void {
    const references = file.typeReferenceDirectives;
    if (references.length === 0) return;
    const resolutions: ModeAwareCache<ResolvedTypeReferenceDirective> = new Map();
    for (let i = 0; i < references.length; i++) {
      const reference = references[i];
      const redirect = this.mapper.getRedirectForResolution(file.path, file.fileName);
      const containingFile = redirect !== undefined ? redirect.source : file.fileName;
      const options = redirect !== undefined ? redirect.resolved.options : this.options;
      const mode =
        reference.resolutionMode !== ModuleKind.None
          ? reference.resolutionMode
          : getDefaultResolutionModeForFile(file.fileName, task.metadata, options);
      const resolved = this.resolver.resolveTypeReferenceDirective(
        reference.fileName,
        containingFile,
        mode,
        redirect?.resolved,
        task.typeResolutionsTrace,
      );
      resolutions.set(modeAwareKey(reference.fileName, mode), resolved);
      const reason = FileIncludeReason.reference(FileIncludeKind.TypeReferenceDirective, task.path, i, undefined);
      if (resolved.resolvedFileName !== '') {
        task.addSubTask(
          resolved.resolvedFileName,
          undefined,
          reason,
          resolved.isExternalLibraryImport,
          false,
          resolved.packageId,
        );
      } else {
        task.processingDiagnostics.push(ProcessingDiagnostic.unknownReference(reason));
      }
    }
    task.typeResolutionsInFile = resolutions;
  }

  private loadAutomaticTypeDirectives(task: ParseTask): void {
    const names = getAutomaticTypeDirectiveNames(this.options, this.host);
    if (names.length === 0) return;
    const resolutions: ModeAwareCache<ResolvedTypeReferenceDirective> = new Map();
    for (const name of names) {
      // Resolved without a mode: CommonJS under node16/nodenext, `import` conditions under bundler.
      const resolved = this.resolver.resolveTypeReferenceDirective(
        name,
        task.normalizedFilePath,
        ModuleKind.None,
        undefined,
        task.typeResolutionsTrace,
      );
      resolutions.set(modeAwareKey(name, ModuleKind.None), resolved);
      if (resolved.resolvedFileName !== '') {
        task.addSubTask(
          resolved.resolvedFileName,
          undefined,
          FileIncludeReason.automaticTypeDirective(name, resolved.packageId),
          resolved.isExternalLibraryImport,
          false,
          resolved.packageId,
        );
      } else {
        task.processingDiagnostics.push(
          ProcessingDiagnostic.explainingFileInclude(
            '',
            FileIncludeReason.automaticTypeDirective(name, undefined),
            Diagnostics.Cannot_find_type_definition_file_for_0,
            [name],
          ),
        );
      }
    }
    task.typeResolutionsInFile = resolutions;
  }

  private resolveImportsAndModuleAugmentations(task: ParseTask, file: SourceFile): void {
    const moduleNames: Node[] = [];
    const redirect = this.mapper.getRedirectForResolution(file.path, file.fileName);
    const containingFile = redirect !== undefined ? redirect.source : file.fileName;
    const options = redirect !== undefined ? redirect.resolved.options : this.options;
    const isJavaScriptFile = isSourceFileJS(file);
    if (isJavaScriptFile || (!file.isDeclarationFile && (getIsolatedModules(options) || isExternalModule(file)))) {
      if (options.importHelpers === true) {
        const specifier = createSyntheticImport('tslib', file);
        moduleNames.push(specifier);
        task.importHelpersImportSpecifier = specifier;
      }
    }
    if (file.scriptKind === ScriptKind.JSX || file.scriptKind === ScriptKind.TSX) {
      const jsxImport = getJSXRuntimeImport(getJSXImplicitImportBase(options, file), options);
      if (jsxImport !== '') {
        const specifier = createSyntheticImport(jsxImport, file);
        moduleNames.push(specifier);
        task.jsxRuntimeImport = new JsxRuntimeImport(jsxImport, specifier);
      }
    }
    const importsStart = moduleNames.length;
    for (const specifier of file.imports) moduleNames.push(specifier);
    for (const augmentation of file.moduleAugmentations) {
      // `declare global` needs no resolution.
      if (augmentation.kind === SyntaxKind.StringLiteral) moduleNames.push(augmentation);
    }
    if (moduleNames.length === 0) return;

    const resolutions: ModeAwareCache<ResolvedModule> = new Map();
    for (let index = 0; index < moduleNames.length; index++) {
      const entry = moduleNames[index];
      const moduleName = getText(entry);
      if (moduleName === '') continue;
      const mode = getModeForUsageLocation(file.fileName, task.metadata, entry, options);
      const resolved = this.resolver.resolveModuleName(
        moduleName,
        containingFile,
        mode,
        redirect?.resolved,
        task.resolutionsTrace,
      );
      resolutions.set(modeAwareKey(moduleName, mode), resolved);
      const resolvedFileName = resolved.resolvedFileName;
      if (resolvedFileName === '') continue;
      // Redirected files are not JavaScript files.
      const isJsFile =
        !fileExtensionIsOneOf(resolvedFileName, supportedTSExtensionsWithJsonFlat) &&
        this.mapper.getRedirectForResolution(this.toPath(resolvedFileName), resolvedFileName) === undefined;
      const isJsFileFromNodeModules =
        resolved.isExternalLibraryImport && isJsFile && resolvedFileName.includes('/node_modules/');
      const importIndex = index - importsStart;
      const imports = file.imports;
      // Imports from JSDoc of TypeScript files only resolve; module augmentations aren't added either.
      const shouldAddFile =
        getResolutionDiagnostic(options, resolved, file.isDeclarationFile) === undefined &&
        options.noResolve !== true &&
        !(isJsFile && !getAllowJS(options)) &&
        (importIndex < 0 ||
          (importIndex < imports.length &&
            ((imports[importIndex].flags & NodeFlags.JavaScriptFile) !== 0 ||
              (imports[importIndex].flags & NodeFlags.JSDoc) === 0)));
      if (!shouldAddFile) continue;
      // `as`: scriptc loses instanceof narrowing here.
      const specifier = importIndex < 0 && entry instanceof StringLiteral ? (entry as StringLiteral) : undefined;
      task.addSubTask(
        resolvedFileName,
        undefined,
        FileIncludeReason.reference(FileIncludeKind.Import, task.path, importIndex, specifier),
        resolved.isExternalLibraryImport,
        isJsFileFromNodeModules,
        resolved.packageId,
      );
    }
    task.resolutionsInFile = resolutions;
  }

  // ---- Collecting

  private collect(): ProcessedFiles {
    const host = this.host;
    const cs = host.fs.useCaseSensitiveFileNames;
    const missingFiles: string[] = [];
    const files: SourceFile[] = [];
    const libFiles: SourceFile[] = [];
    const filesByPath = new Map<string, SourceFile>();
    const tasksSeenByNameIgnoreCase = cs ? new Map<string, ParseTask>() : undefined;
    const includeProcessor = new IncludeProcessor();
    const outputFileToProjectReferenceSource = new Map<string, string>();
    const resolvedModules = new Map<string, ModeAwareCache<ResolvedModule> | undefined>();
    const typeResolutionsInFile = new Map<string, ModeAwareCache<ResolvedTypeReferenceDirective> | undefined>();
    const sourceFileMetadata = new Map<string, SourceFileMetadata>();
    const jsxRuntimeImports = new Map<string, JsxRuntimeImport>();
    const importHelpersImportSpecifiers = new Map<string, StringLiteral>();
    const sourceFilesFoundSearchingNodeModules = new Set<string>();
    const libFilesByPath = new Map<string, LibFile>();
    const deduplicatePackages = this.options.deduplicatePackages !== false;
    const redirectTargets = new Map<string, string[]>();
    const redirectFilesByPath = new Map<string, RedirectFile>();
    const packageIdToSourceFile = new Map<string, SourceFile>();
    const checkCasing = this.options.forceConsistentCasingInFileNames !== false;
    const seen = new Map<ParseTaskData, string>();

    const collectFiles = (tasks: readonly ParseTask[]): void => {
      for (let task of tasks) {
        const includeReason = task.includeReason;
        // Automatic type directive tasks are an implementation detail, not a reason.
        if (task.redirectedParseTask === undefined && !task.isForAutomaticTypeDirective) {
          if (task.loadedTask !== undefined) task = task.loadedTask;
          if (includeReason !== undefined) addIncludeReason(includeProcessor, task, includeReason);
        }
        const data = this.taskDataByPath.get(task.path);
        if (!task.loaded || data === undefined) continue;

        const checkedName = seen.get(data);
        if (checkedName !== undefined) {
          // The same name normalizes the same: only another spelling needs comparing.
          if (
            checkCasing &&
            checkedName !== task.normalizedFilePath &&
            withoutRoot(getNormalizedAbsolutePath(checkedName, host.currentDirectory)) !==
              withoutRoot(getNormalizedAbsolutePath(task.normalizedFilePath, host.currentDirectory))
          ) {
            includeProcessor.addCasingDiagnostic(task.path, checkedName, task.normalizedFilePath, includeReason);
          }
          continue;
        }
        seen.set(data, task.normalizedFilePath);

        if (tasksSeenByNameIgnoreCase !== undefined) {
          const lowerCasePath = toFileNameLowerCase(task.path);
          const existing = tasksSeenByNameIgnoreCase.get(lowerCasePath);
          if (existing !== undefined) {
            includeProcessor.addCasingDiagnostic(
              existing.path,
              existing.normalizedFilePath,
              task.normalizedFilePath,
              includeReason,
            );
          } else {
            tasksSeenByNameIgnoreCase.set(lowerCasePath, task);
          }
        }

        for (const trace of task.typeResolutionsTrace) host.trace(trace);
        for (const trace of task.resolutionsTrace) host.trace(trace);

        const file = task.file;
        const packageId = data.packageId;
        if (deduplicatePackages && packageId !== undefined && packageId.name !== '') {
          const key = packageIdKey(packageId);
          const packageIdFile = packageIdToSourceFile.get(key);
          if (packageIdFile !== undefined) {
            const targets = redirectTargets.get(packageIdFile.path);
            if (targets === undefined) redirectTargets.set(packageIdFile.path, [task.normalizedFilePath]);
            else targets.push(task.normalizedFilePath);
            redirectFilesByPath.set(
              task.path,
              new RedirectFile(
                files.length + redirectFilesByPath.size,
                task.normalizedFilePath,
                task.path,
                packageIdFile.path,
              ),
            );
            filesByPath.set(task.path, packageIdFile);
            if (data.lowestDepth > 0) sourceFilesFoundSearchingNodeModules.add(task.path);
            continue;
          }
          if (file !== undefined) packageIdToSourceFile.set(key, file);
        }

        if (task.subTasks.length > 0) collectFiles(task.subTasks);

        const redirected = task.redirectedParseTask;
        if (redirected !== undefined) {
          outputFileToProjectReferenceSource.set(redirected.path, task.normalizedFilePath);
          continue;
        }
        if (task.isForAutomaticTypeDirective) {
          typeResolutionsInFile.set(task.path, task.typeResolutionsInFile);
          for (const diagnostic of task.processingDiagnostics) includeProcessor.addProcessingDiagnostic(diagnostic);
          continue;
        }
        const path = task.path;
        for (const diagnostic of task.processingDiagnostics) includeProcessor.addProcessingDiagnostic(diagnostic);
        if (file === undefined) {
          missingFiles.push(task.normalizedFilePath);
          continue;
        }
        if (task.libFile !== undefined) {
          libFiles.push(file);
          libFilesByPath.set(path, task.libFile);
        } else {
          files.push(file);
        }
        filesByPath.set(path, file);
        resolvedModules.set(path, task.resolutionsInFile);
        typeResolutionsInFile.set(path, task.typeResolutionsInFile);
        sourceFileMetadata.set(path, task.metadata);
        if (task.jsxRuntimeImport !== undefined) jsxRuntimeImports.set(path, task.jsxRuntimeImport);
        if (task.importHelpersImportSpecifier !== undefined) {
          importHelpersImportSpecifiers.set(path, task.importHelpersImportSpecifier);
        }
        if (data.lowestDepth > 0) sourceFilesFoundSearchingNodeModules.add(path);
      }
    };
    collectFiles(this.rootTasks);

    const priorities = new Map<SourceFile, number>();
    for (const file of libFiles) priorities.set(file, this.libFilePriority(file));
    libFiles.sort((a, b) => (priorities.get(a) ?? 0) - (priorities.get(b) ?? 0));
    const allFiles = [...libFiles, ...files];
    for (const redirect of redirectFilesByPath.values()) redirect.index += libFiles.length;

    const keys = [...this.libResolutions.keys()].sort();
    for (const key of keys) {
      const resolution = this.libResolutions.get(key);
      if (resolution === undefined) continue;
      const cache: ModeAwareCache<ResolvedModule> = new Map();
      cache.set(modeAwareKey(resolution.libraryName, ModuleKind.CommonJS), resolution.resolution);
      resolvedModules.set(key, cache);
      for (const trace of resolution.trace) host.trace(trace);
    }

    return new ProcessedFiles(
      this.resolver,
      allFiles,
      filesByPath,
      missingFiles,
      resolvedModules,
      typeResolutionsInFile,
      sourceFileMetadata,
      jsxRuntimeImports,
      importHelpersImportSpecifiers,
      libFilesByPath,
      sourceFilesFoundSearchingNodeModules,
      includeProcessor,
      outputFileToProjectReferenceSource,
      redirectTargets,
      redirectFilesByPath,
      this.mapper,
    );
  }
}

function addIncludeReason(processor: IncludeProcessor, task: ParseTask, reason: FileIncludeReason): void {
  const redirected = task.redirectedParseTask;
  if (redirected !== undefined) addIncludeReason(processor, redirected, reason);
  else if (task.loaded) processor.addReason(task.path, reason);
}

function createProjectReferenceTasks(paths: readonly string[]): ProjectReferenceTask[] {
  const tasks: ProjectReferenceTask[] = [];
  for (const path of paths) tasks.push(new ProjectReferenceTask(path));
  return tasks;
}

function packageIdKey(id: PackageId): string {
  return id.name + '\0' + id.subModuleName + '\0' + id.version + '\0' + id.peerDependencies;
}

function withoutRoot(path: string): string {
  return path.slice(getRootLength(path));
}

/** A specifier of an import the compiler adds, such as `tslib` for `importHelpers`. */
function createSyntheticImport(text: string, file: SourceFile): StringLiteral {
  const specifier = new StringLiteral(text, TokenFlags.None);
  const declaration = new ImportDeclaration(SyntaxKind.ImportDeclaration, undefined, undefined, specifier, undefined);
  specifier.parent = declaration;
  declaration.parent = file;
  return specifier;
}

/** `lib.dom.iterable.d.ts` to `@typescript/lib-dom/iterable`, `lib.es2015.symbol.wellknown.d.ts` to `@typescript/lib-es2015/symbol-wellknown`. */
function getLibraryNameFromLibFileName(libFileName: string): string {
  const components = libFileName.split('.');
  let path = '@typescript/lib-';
  if (components.length > 1) path += components[1];
  for (let i = 2; i < components.length && components[i] !== '' && components[i] !== 'd'; i++) {
    path += (i === 2 ? '/' : '-') + components[i];
  }
  return path;
}
