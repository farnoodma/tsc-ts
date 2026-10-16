/**
 * The `tsc` compile step after the command line: bind and check the program, emit it, then report
 * diagnostics, listed files, the error summary and statistics like tsgo's `EmitFilesAndReportErrors`.
 */
import { mark } from './timeline.js';
import {
  CheckedProgram,
  CompilerProgram,
  CompileTimes,
  getDiagnosticsOfProgram,
  OutputWriter,
  PlainProgram,
} from './compile-program.js';
import type { Diagnostic, Locale } from './diagnostics.js';
import { EmitResult } from './emitter.js';
import { FileBuildInfoReader, IncrementalProgram, readBuildInfoProgram, TimeStampHost } from './incremental.js';
import { checkerThreads, startParallelCheck, traceSingleChecker } from './parallel-check.js';
import { getNormalizedAbsolutePath } from './path.js';
import { sortAndDeduplicateDiagnostics } from './program.js';
import {
  checksIncrementalOnThreads,
  type CommandLineResult,
  type DiagnosticReporter,
  type ErrorSummaryReporter,
  ExitStatus,
  outputLocale,
  type System,
  SystemFileSystem,
} from './tsc-cli.js';

type CompileWork = Extract<CommandLineResult, { kind: 'compile' }>;

/** Writes outputs to the system. */
export class SystemWriter extends OutputWriter {
  constructor(private readonly sys: System) {
    super();
  }

  write(fileName: string, text: string, _declarationDiagnostics: readonly Diagnostic[]): string {
    return this.sys.writeFile(fileName, text) ? '' : `Could not write file '${fileName}'.`;
  }
}

/** File times of the system. */
export class SystemTimeStamps extends TimeStampHost {
  constructor(private readonly sys: System) {
    super();
  }

  getMTime(fileName: string): number | undefined {
    return this.sys.getMTime(fileName);
  }

  setMTime(fileName: string, time: number): void {
    this.sys.setMTime(fileName, time);
  }
}

/** Binds, checks and emits the program of `work`; returns the exit status. */
export function compile(sys: System, work: CompileWork): ExitStatus {
  const program = work.program;
  const times = new CompileTimes();
  times.configTime = work.configTime;
  times.parseTime = work.parseTime;
  const bindStart = performance.now();
  const checked = new CheckedProgram(program);
  times.bindTime = performance.now() - bindStart;
  let compilerProgram: CompilerProgram;
  if (work.incremental) {
    const readStart = performance.now();
    const old = readBuildInfoProgram(
      program.commandLine,
      new FileBuildInfoReader(new SystemFileSystem(sys)),
      sys.defaultLibraryPath,
      sys.currentDirectory,
    );
    times.buildInfoReadTime = performance.now() - readStart;
    const changesStart = performance.now();
    compilerProgram = new IncrementalProgram(checked, times, old, new SystemTimeStamps(sys));
    times.changesComputeTime = performance.now() - changesStart;
  } else compilerProgram = new PlainProgram(checked, times);
  const result = emitFilesAndReportErrors(
    sys,
    compilerProgram,
    work.reporter,
    work.errorSummary,
    new SystemWriter(sys),
    outputLocale(program.options),
  );
  traceSingleChecker(checked);
  return emitStatusAndReportStatistics(sys, compilerProgram, result);
}

/**
 * The number of checker threads for `work` (`--checkers`); 1 checks on this thread with `compile`. An
 * incremental program is checked on threads only without build info (`checksIncrementalOnThreads`).
 */
export function compileThreads(sys: System, work: CompileWork): number {
  const options = work.program.options;
  if (work.incremental && !checksIncrementalOnThreads(sys, options, work.program.commandLine.buildInfoFileName()))
    return 1;
  mark('compile threads');
  return checkerThreads(options.checkers, options.singleThreaded, work.program);
}

/**
 * Like `compile`, with `threads` checker threads (parallel-check.ts): calls `done` with the exit
 * status once the threads have checked the program and it is emitted and reported.
 */
export function compileInParallel(
  sys: System,
  work: CompileWork,
  threads: number,
  done: (status: ExitStatus) => void,
): void {
  const program = work.program;
  const times = new CompileTimes();
  times.configTime = work.configTime;
  times.parseTime = work.parseTime;
  const bindStart = performance.now();
  mark(`${threads} checkers`);
  const checked = new CheckedProgram(program);
  times.bindTime = performance.now() - bindStart;
  mark('checker created');
  startParallelCheck(checked, threads, (checkTime) => {
    // An incremental program here has no build info (`compileThreads`).
    let compilerProgram: CompilerProgram;
    if (work.incremental) {
      const changesStart = performance.now();
      compilerProgram = new IncrementalProgram(checked, times, undefined, new SystemTimeStamps(sys));
      times.changesComputeTime = performance.now() - changesStart;
    } else compilerProgram = new PlainProgram(checked, times);
    mark('report start');
    const result = emitFilesAndReportErrors(
      sys,
      compilerProgram,
      work.reporter,
      work.errorSummary,
      new SystemWriter(sys),
      outputLocale(program.options),
    );
    times.checkTime = checkTime;
    mark(`reported ${result.diagnostics.length} diagnostics`);
    done(emitStatusAndReportStatistics(sys, compilerProgram, result));
  });
}

export class CompileResult {
  constructor(
    readonly diagnostics: Diagnostic[],
    readonly emitResult: EmitResult,
  ) {}
}

/** Reports diagnostics, emits, and lists files. */
export function emitFilesAndReportErrors(
  sys: System,
  program: CompilerProgram,
  reporter: DiagnosticReporter,
  errorSummary: ErrorSummaryReporter,
  writer: OutputWriter,
  locale: Locale,
): CompileResult {
  const diagnostics = getDiagnosticsOfProgram(program, false);
  mark('diagnostics collected');
  let emitResult = new EmitResult();
  emitResult.emitSkipped = true;
  if (program.options.listFilesOnly !== true) {
    const emitStart = performance.now();
    emitResult = program.emit(writer);
    program.times.emitTime = performance.now() - emitStart;
  }
  for (const diagnostic of emitResult.diagnostics) diagnostics.push(diagnostic);
  const all = sortAndDeduplicateDiagnostics(diagnostics);
  reporter.reportAll(all);
  listFiles(sys, program, emitResult, locale);
  errorSummary.report(all);
  return new CompileResult(all, emitResult);
}

/** The exit status of a compilation, after printing `--diagnostics` statistics. */
export function emitStatusAndReportStatistics(
  sys: System,
  program: CompilerProgram,
  result: CompileResult,
): ExitStatus {
  const options = program.options;
  if (options.diagnostics === true || options.extendedDiagnostics === true) {
    program.times.totalTime = sys.sinceStart();
    statisticsOf(program).report(sys);
  }
  return exitStatusOf(result);
}

export function exitStatusOf(result: CompileResult): ExitStatus {
  if (result.diagnostics.length === 0) return ExitStatus.Success;
  return result.emitResult.emitSkipped
    ? ExitStatus.DiagnosticsPresent_OutputsSkipped
    : ExitStatus.DiagnosticsPresent_OutputsGenerated;
}

function listFiles(sys: System, compilerProgram: CompilerProgram, emitResult: EmitResult, locale: Locale): void {
  const program = compilerProgram.program;
  const options = program.options;
  if (options.listEmittedFiles === true) {
    let out = '';
    for (const file of emitResult.emittedFiles) {
      out += 'TSFILE: ' + getNormalizedAbsolutePath(file, program.currentDirectory) + '\n';
    }
    sys.write(out);
  }
  if (options.explainFiles === true) sys.write(program.explainFiles(locale));
  else if (options.listFiles === true || options.listFilesOnly === true) {
    let out = '';
    for (const file of program.getSourceFiles()) out += file.fileName + '\n';
    sys.write(out);
  }
}

// ---- Statistics

/** What `--diagnostics` and `--extendedDiagnostics` print. */
export class Statistics {
  isAggregate = false;
  projects = 0;
  projectsBuilt = 0;
  timestampUpdates = 0;
  files = 0;
  lines = 0;
  identifiers = 0;
  symbols = 0;
  types = 0;
  instantiations = 0;
  memoryUsed = 0;
  memoryAllocs = 0;
  readonly times = new CompileTimes();

  aggregate(other: Statistics): void {
    this.isAggregate = true;
    this.files += other.files;
    this.lines += other.lines;
    this.identifiers += other.identifiers;
    this.symbols += other.symbols;
    this.types += other.types;
    this.instantiations += other.instantiations;
    this.memoryUsed += other.memoryUsed;
    this.memoryAllocs += other.memoryAllocs;
    const t = this.times;
    const o = other.times;
    t.configTime += o.configTime;
    t.buildInfoReadTime += o.buildInfoReadTime;
    t.parseTime += o.parseTime;
    t.bindTime += o.bindTime;
    t.checkTime += o.checkTime;
    t.emitTime += o.emitTime;
    t.changesComputeTime += o.changesComputeTime;
  }

  report(sys: System): void {
    const rows: [string, string][] = [];
    const prefix = this.isAggregate ? 'Aggregate ' : '';
    if (this.isAggregate) {
      rows.push(['Projects in scope', String(this.projects)]);
      rows.push(['Projects built', String(this.projectsBuilt)]);
      rows.push(['Timestamps only updates', String(this.timestampUpdates)]);
    }
    rows.push([prefix + 'Files', String(this.files)]);
    rows.push([prefix + 'Lines', String(this.lines)]);
    rows.push([prefix + 'Identifiers', String(this.identifiers)]);
    rows.push([prefix + 'Symbols', String(this.symbols)]);
    rows.push([prefix + 'Types', String(this.types)]);
    rows.push([prefix + 'Instantiations', String(this.instantiations)]);
    rows.push([prefix + 'Memory used', `${Math.floor(this.memoryUsed / 1024)}K`]);
    rows.push([prefix + 'Memory allocs', String(this.memoryAllocs)]);
    const t = this.times;
    if (t.configTime !== 0) rows.push([prefix + 'Config time', formatDuration(t.configTime)]);
    if (t.buildInfoReadTime !== 0) rows.push([prefix + 'BuildInfo read time', formatDuration(t.buildInfoReadTime)]);
    rows.push([prefix + 'Parse time', formatDuration(t.parseTime)]);
    if (t.bindTime !== 0) rows.push([prefix + 'Bind time', formatDuration(t.bindTime)]);
    if (t.checkTime !== 0) rows.push([prefix + 'Check time', formatDuration(t.checkTime)]);
    if (t.emitTime !== 0) rows.push([prefix + 'Emit time', formatDuration(t.emitTime)]);
    if (t.changesComputeTime !== 0) rows.push([prefix + 'Changes compute time', formatDuration(t.changesComputeTime)]);
    rows.push([prefix + 'Total time', formatDuration(t.totalTime)]);
    let nameWidth = 0;
    let valueWidth = 0;
    for (const [name, value] of rows) {
      nameWidth = Math.max(nameWidth, name.length);
      valueWidth = Math.max(valueWidth, value.length);
    }
    let out = '';
    for (const [name, value] of rows) {
      out += (name + ':').padEnd(nameWidth + 1) + ' ' + value.padStart(valueWidth) + '\n';
    }
    sys.write(out);
  }
}

function formatDuration(milliseconds: number): string {
  return (milliseconds / 1000).toFixed(3) + 's';
}

export function statisticsOf(compilerProgram: CompilerProgram): Statistics {
  const program = compilerProgram.program;
  const statistics = new Statistics();
  const files = program.getSourceFiles();
  statistics.files = files.length;
  for (const file of files) {
    statistics.lines += file.diagnosticFile().getLineStarts().length;
    statistics.identifiers += file.identifierCount;
    statistics.symbols += file.symbolCount;
  }
  statistics.types = compilerProgram.checked.checker.typeCount;
  const t = statistics.times;
  const source = compilerProgram.times;
  t.configTime = source.configTime;
  t.buildInfoReadTime = source.buildInfoReadTime;
  t.parseTime = source.parseTime;
  t.bindTime = source.bindTime;
  t.checkTime = source.checkTime;
  t.emitTime = source.emitTime;
  t.changesComputeTime = source.changesComputeTime;
  t.totalTime = source.totalTime;
  return statistics;
}
