/**
 * `tsc --watch` and `tsc --build --watch`: rebuild when inputs change. Changes are found by polling
 * the time stamps of the files a build read and of the directories that may gain files.
 */
import { LifetimeRegion } from '@scriptc/experimental';
import type { ParsedBuildCommandLine, ParsedCommandLine as CommandLine } from './command-line.js';
import { CheckedProgram, CompileTimes } from './compile-program.js';
import {
  type Diagnostic,
  type DiagnosticMessage,
  Diagnostics,
  type Locale,
  localizeMessage,
  type MessageWithArgs,
} from './diagnostics.js';
import { type ExternalModuleIndicatorOptions, ParseOptions, ScriptKind, type SourceFile } from './ast.js';
import { CompilerHost } from './file-loader.js';
import { CachedFileSystem } from './file-system.js';
import { clearLibGlobalsCache } from './checker-symbols.js';
import { forgetLazyJSDocFile, parseSourceFile } from './parser.js';
import { forgetNavigationFile } from './astnav.js';
import { forgetRangeScannerFile } from './binder-utilities.js';
import { forgetIdentifierSets } from './printer/name-generator.js';
import { FileBuildInfoReader, IncrementalProgram, readBuildInfoProgram, type Snapshot } from './incremental.js';
import { combinePaths, getDirectoryPath, getNormalizedAbsolutePath, toPath } from './path.js';
import { Program } from './program.js';
import { ConfigParser, ParsedCommandLine } from './tsconfig.js';
import { DiagnosticReporter, ErrorSummaryReporter, outputLocale, type System, SystemFileSystem } from './tsc-cli.js';
import { copyCommandLine, Orchestrator, StatusReporter } from './tsc-build.js';
import { type CompilerOptions, isIncremental } from './options.js';
import { assignSymbolIdsAtCreation } from './symbol.js';
import { checkerThreads, parallelCheck, startParallelCheck } from './parallel-check.js';
import { emitFilesAndReportErrors, SystemTimeStamps, SystemWriter } from './tsc-compile.js';

/** How often inputs are polled, in milliseconds. */
const pollInterval = 250;

/** Writes watch status lines, clearing the screen where tsc does. */
class WatchStatusReporter {
  private readonly status: StatusReporter;

  constructor(
    private readonly sys: System,
    private readonly clearScreen: boolean,
    pretty: boolean | undefined,
    locale: Locale,
  ) {
    this.status = new StatusReporter(sys, pretty, false, locale);
  }

  report(message: DiagnosticMessage, ...args: string[]): void {
    if (
      this.clearScreen &&
      (message === Diagnostics.Starting_compilation_in_watch_mode ||
        message === Diagnostics.File_change_detected_Starting_incremental_compilation)
    ) {
      this.sys.write('\x1B[2J\x1B[3J\x1B[H');
    }
    this.status.report(message, ...args);
  }

  reportErrorCount(count: number): void {
    if (count === 1) this.report(Diagnostics.Found_1_error_Watching_for_file_changes);
    else this.report(Diagnostics.Found_0_errors_Watching_for_file_changes, String(count));
  }
}

/** Time stamps of files and directories, to tell when any changed. */
class Stamps {
  private readonly times = new Map<string, number | undefined>();

  constructor(private readonly sys: System) {}

  add(path: string): void {
    if (!this.times.has(path)) this.times.set(path, this.sys.getMTime(path));
  }

  /** A directory and, if `recursive`, the directories below it except `node_modules` and hidden ones. */
  addDirectory(path: string, recursive: boolean, depth = 0): void {
    if (this.times.has(path) || !this.sys.directoryExists(path)) return;
    this.add(path);
    if (!recursive || depth > 32) return;
    for (const name of this.sys.getAccessibleEntries(path).directories) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      this.addDirectory(combinePaths(path, name), true, depth + 1);
    }
  }

  changed(): boolean {
    for (const [path, time] of this.times) {
      if (this.sys.getMTime(path) !== time) return true;
    }
    return false;
  }
}

/** The directories a config's `include` specs can add files to, and whether recursively. */
function includeDirectories(config: ParsedCommandLine): { path: string; recursive: boolean }[] {
  const result: { path: string; recursive: boolean }[] = [];
  const specs = config.configFile?.configFileSpecs;
  if (specs === undefined) return result;
  for (const spec of specs.validatedIncludeSpecs) {
    const absolute = getNormalizedAbsolutePath(spec, config.currentDirectory);
    const components = absolute.split('/');
    let base = '';
    let wildcard = false;
    for (let i = 0; i < components.length; i++) {
      const component = components[i];
      if (component.includes('*') || component.includes('?')) {
        wildcard = true;
        break;
      }
      base = i === 0 ? (component === '' ? '/' : component) : combinePaths(base, component);
    }
    result.push({ path: wildcard ? base : getDirectoryPath(absolute), recursive: wildcard });
  }
  return result;
}

/**
 * A compiler host writing `--traceResolution` output to the system, which takes the parsed and bound
 * source file of the last build when a file's text is unchanged, as tsgo's watch reuses the files of
 * its old program. A file parses the same for the same text, name, path and module detection options,
 * and binding a bound file does nothing. Natively, syntax trees and symbols are never freed
 * (ProgramLifetime), so parsing every file again made each rebuild keep another copy of the program.
 */
class WatchCompilerHost extends CompilerHost {
  constructor(
    private readonly sys: System,
    fs: CachedFileSystem,
    private readonly locale: Locale,
    /**
     * The source files of the last build and those of this one, by name, path and module detection
     * options. Not the watcher's: a program shared with checker threads is frozen with its host.
     */
    private readonly previous: ReadonlyMap<string, SourceFile>,
    private readonly current: Map<string, SourceFile>,
  ) {
    super(fs, sys.currentDirectory, sys.defaultLibraryPath);
  }

  getSourceFile(
    fileName: string,
    path: string,
    externalModuleIndicatorOptions: ExternalModuleIndicatorOptions,
  ): SourceFile | undefined {
    const text = this.fs.readFile(fileName);
    if (text === undefined) return undefined;
    const key =
      fileName +
      '\u0000' +
      path +
      (externalModuleIndicatorOptions.jsx ? '\u0000j' : '\u0000') +
      (externalModuleIndicatorOptions.force ? 'f' : '');
    let file = this.current.get(key);
    if (file !== undefined && file.text === text) return file;
    file = this.previous.get(key);
    if (file === undefined || file.text !== text)
      file = parseSourceFile(
        fileName,
        text,
        new ParseOptions(path, ScriptKind.Unknown, externalModuleIndicatorOptions),
      );
    this.current.set(key, file);
    return file;
  }

  trace(message: MessageWithArgs): void {
    this.sys.write(localizeMessage(this.locale, message.message, message.args) + '\n');
  }
}

/** Keeps `poll` running every `pollInterval` milliseconds. */
function startPolling(poll: () => void): void {
  setInterval(poll, pollInterval);
}

class Watcher {
  private snapshot: Snapshot | undefined = undefined;
  private stamps: Stamps;
  private configStamps: Stamps;
  private readonly locale: Locale;
  private readonly reporter: DiagnosticReporter;
  private readonly status: WatchStatusReporter;
  /** The source files of the last build (`WatchCompilerHost`). */
  private files: ReadonlyMap<string, SourceFile> = new Map<string, SourceFile>();
  /** Whether a build is checking on checker threads. */
  private building = false;
  /** The region of the last build's checking on this thread, released by the next build. */
  private previousRegion: LifetimeRegion | undefined = undefined;

  constructor(
    private readonly sys: System,
    private config: ParsedCommandLine,
    private readonly commandLine: CommandLine,
  ) {
    const options = config.options;
    this.locale = outputLocale(commandLine.options);
    this.reporter = new DiagnosticReporter(sys, commandLine.options, this.locale);
    this.status = new WatchStatusReporter(
      sys,
      options.preserveWatchOutput !== true && options.extendedDiagnostics !== true && options.diagnostics !== true,
      options.pretty,
      this.locale,
    );
    this.stamps = new Stamps(sys);
    this.configStamps = new Stamps(sys);
  }

  start(): void {
    const sys = this.sys;
    if (this.config.options.incremental === true || this.config.options.composite === true) {
      this.snapshot = readBuildInfoProgram(
        this.config,
        new FileBuildInfoReader(new SystemFileSystem(sys)),
        sys.defaultLibraryPath,
        sys.currentDirectory,
      );
    }
    this.status.report(Diagnostics.Starting_compilation_in_watch_mode);
    // A program shared with checker threads is never written: symbols get their ids when created.
    const options = this.config.options;
    if (mayCheckOnThreads(options) && checkerThreads(options.checkers, options.singleThreaded) > 1) {
      assignSymbolIdsAtCreation();
      parallelCheck.regions = true;
    }
    this.build();
    startPolling(() => this.poll());
  }

  private configFiles(): string[] {
    const configFile = this.config.configFile;
    if (configFile === undefined) return [];
    return [configFile.sourceFile.fileName, ...configFile.extendedSourceFiles];
  }

  private poll(): void {
    // A build on checker threads finishes in a callback; changes during it are picked up after.
    if (this.building) return;
    const configChanged = this.configStamps.changed();
    if (!configChanged && !this.stamps.changed()) return;
    if (configChanged && !this.reloadConfig()) return;
    this.status.report(Diagnostics.File_change_detected_Starting_incremental_compilation);
    this.build();
  }

  /** Rereads the config file; false (after reporting) if it can't be used. */
  private reloadConfig(): boolean {
    const configName = this.config.configName;
    if (configName === '') return true;
    const sys = this.sys;
    const errors: Diagnostic[] = [];
    const parser = new ConfigParser(new CachedFileSystem(new SystemFileSystem(sys)), sys.currentDirectory);
    const parsed = parser.parseConfigFile(configName, this.commandLine.options, this.commandLine.raw, errors);
    if (parsed === undefined) {
      this.reporter.reportAll(errors);
      this.status.reportErrorCount(errors.length);
      this.configStamps = new Stamps(sys);
      for (const file of this.configFiles()) this.configStamps.add(file);
      return false;
    }
    this.config = parsed;
    return true;
  }

  private build(): void {
    releaseProgramCaches();
    const sys = this.sys;
    const fs = new CachedFileSystem(new SystemFileSystem(sys));
    if (this.config.configName !== '') {
      // Pick up files added to or removed from included directories.
      const parsed = new ConfigParser(fs, sys.currentDirectory).parseConfigFile(
        this.config.configName,
        this.commandLine.options,
        this.commandLine.raw,
        [],
      );
      if (parsed !== undefined) this.config = parsed;
    }
    // A program checked by threads is shared with them and can't change after: it gets a copy of the
    // config.
    const config = this.config;
    const options = config.options;
    const count = mayCheckOnThreads(options) ? checkerThreads(options.checkers, options.singleThreaded) : 1;
    const files = new Map<string, SourceFile>();
    const program = new Program(
      count > 1 ? copyCommandLine(config) : config,
      new WatchCompilerHost(sys, fs, this.locale, this.files, files),
    );
    this.files = files;
    const checked = new CheckedProgram(program);
    if (count > 1) {
      // Checker threads check every file, as a build without old state does; the incremental program
      // then takes the semantic diagnostics of the files it rechecks from them, and emits on this thread.
      // What this thread's checkers allocate is in a region freed once the next build replaces it.
      this.building = true;
      const region = new LifetimeRegion();
      region.run(() =>
        startParallelCheck(
          checked,
          checkerThreads(options.checkers, options.singleThreaded, program),
          () => {
            this.building = false;
            region.run(() => this.finishBuild(checked));
            this.previousRegion?.release();
            this.previousRegion = region;
          },
          false,
        ),
      );
      return;
    }
    this.finishBuild(checked);
  }

  /** Emits and reports the checked program of a build, and watches its inputs. */
  private finishBuild(checked: CheckedProgram): void {
    const sys = this.sys;
    const program = checked.program;
    const incremental = new IncrementalProgram(checked, new CompileTimes(), this.snapshot, new SystemTimeStamps(sys));
    const result = emitFilesAndReportErrors(
      sys,
      incremental,
      this.reporter,
      new ErrorSummaryReporter(sys, this.config.options, this.locale),
      new SystemWriter(sys),
      this.locale,
    );
    this.snapshot = incremental.snapshot;
    this.watchInputs(program);
    this.status.reportErrorCount(result.diagnostics.length);
  }

  private watchInputs(program: Program): void {
    const sys = this.sys;
    const stamps = new Stamps(sys);
    const configStamps = new Stamps(sys);
    for (const file of this.configFiles()) configStamps.add(file);
    for (const file of program.getSourceFiles()) {
      if (program.isSourceFileDefaultLibrary(file.path)) continue;
      stamps.add(file.fileName);
      stamps.addDirectory(getDirectoryPath(file.fileName), false);
    }
    for (const fileName of this.config.fileNames) stamps.addDirectory(getDirectoryPath(fileName), false);
    for (const directory of includeDirectories(this.config)) stamps.addDirectory(directory.path, directory.recursive);
    if (this.config.configName === '') stamps.addDirectory(sys.currentDirectory, false);
    this.stamps = stamps;
    this.configStamps = configStamps;
  }
}

/**
 * Whether checker threads may check a watch build: they report a file's semantic diagnostics filtered
 * for `noEmit`, while a program that keeps incremental state stores them unfiltered (as in build mode).
 */
function mayCheckOnThreads(options: CompilerOptions): boolean {
  return !(options.noEmit === true && isIncremental(options));
}

/** Starts `tsc --watch`; the process keeps running. */
export function watch(sys: System, config: ParsedCommandLine, commandLine: CommandLine): void {
  new Watcher(sys, config, commandLine).start();
}

/** The inputs of every project of a build, from their configs and build infos. */
function buildInputs(sys: System, command: ParsedBuildCommandLine): Stamps {
  const stamps = new Stamps(sys);
  const fs = new CachedFileSystem(new SystemFileSystem(sys));
  const parser = new ConfigParser(fs, sys.currentDirectory);
  const seen = new Set<string>();
  const visit = (configName: string): void => {
    const path = toPath(configName, sys.currentDirectory, sys.useCaseSensitiveFileNames);
    if (seen.has(path)) return;
    seen.add(path);
    stamps.add(configName);
    stamps.addDirectory(getDirectoryPath(configName), false);
    const config = parser.parseConfigFile(configName, command.compilerOptions, command.raw, []);
    if (config === undefined) return;
    const configFile = config.configFile;
    if (configFile !== undefined) for (const extended of configFile.extendedSourceFiles) stamps.add(extended);
    for (const fileName of config.fileNames) {
      stamps.add(fileName);
      stamps.addDirectory(getDirectoryPath(fileName), false);
    }
    for (const directory of includeDirectories(config)) stamps.addDirectory(directory.path, directory.recursive);
    for (const reference of config.resolvedProjectReferencePaths()) visit(reference);
  };
  for (const project of command.projects) {
    const absolute = getNormalizedAbsolutePath(project, sys.currentDirectory);
    visit(absolute.endsWith('.json') ? absolute : combinePaths(absolute, 'tsconfig.json'));
  }
  return stamps;
}

/** Starts `tsc --build --watch`; the process keeps running. */
export function watchBuild(sys: System, command: ParsedBuildCommandLine): void {
  const options = command.compilerOptions;
  const locale = outputLocale(options);
  const status = new WatchStatusReporter(
    sys,
    options.preserveWatchOutput !== true && options.extendedDiagnostics !== true && options.diagnostics !== true,
    options.pretty,
    locale,
  );
  status.report(Diagnostics.Starting_compilation_in_watch_mode);
  const run = (): Stamps => {
    releaseProgramCaches();
    const orchestrator = new Orchestrator(sys, command);
    orchestrator.watching = true;
    orchestrator.start();
    status.reportErrorCount(orchestrator.errorCount);
    return buildInputs(sys, command);
  };
  let stamps = run();
  startPolling(() => {
    if (!stamps.changed()) return;
    status.report(Diagnostics.File_change_detected_Starting_incremental_compilation);
    stamps = run();
  });
}

/**
 * Drops the module-level caches that still point at the last build's files and library globals: before
 * a rebuild, and on a checker thread before it releases its region (main.ts).
 */
export function releaseProgramCaches(): void {
  clearLibGlobalsCache();
  forgetLazyJSDocFile();
  forgetNavigationFile();
  forgetRangeScannerFile();
  forgetIdentifierSets();
}
