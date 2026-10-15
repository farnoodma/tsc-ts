/**
 * What `tsc` compiles: a checked program, plain or incremental, with the diagnostics it reports and
 * the emit it does, like tsgo's `ProgramLike`.
 */
import type { Node, SourceFile } from './ast.js';
import type { Diagnostic } from './diagnostics.js';
import { EmitHost, EmitOnly, EmitResult, emitFiles, skippedWrite, sourceFileMayBeEmitted } from './emitter.js';
import { Resolver } from './module-resolution.js';
import { getEmitDeclarations, type CompilerOptions, type ModuleKind } from './options.js';
import type { Program } from './program.js';
import { CheckedProgram } from './program-checker.js';
import { CheckerDeclarationEmitResolver } from './checker-emit-resolver.js';
import { getEmitModuleFormatOfFile } from './program-utilities.js';
import { SyntacticDeclarationEmitResolver } from './transformers/declarations-syntactic.js';
import { mark } from './timeline.js';
import { type EmitResolver, SyntacticEmitResolver } from './transformers/emit-resolver.js';
import { ModuleFormatHost } from './transformers/module.js';
import { ModuleLookup, ReferenceResolver } from './transformers/reference-resolver.js';

/** Where emit writes files. */
export abstract class OutputWriter {
  /**
   * Writes `text` to `fileName`; returns an error message, `''`, or `skippedWrite` for a file left
   * alone. `declarationDiagnostics` are the errors of a forced declaration emit.
   */
  abstract write(fileName: string, text: string, declarationDiagnostics: readonly Diagnostic[]): string;
}

/** Collects what a forced declaration emit produces instead of writing it. */
export class CapturingWriter extends OutputWriter {
  text = '';
  diagnostics: readonly Diagnostic[] = [];

  write(_fileName: string, text: string, declarationDiagnostics: readonly Diagnostic[]): string {
    this.text = text;
    this.diagnostics = declarationDiagnostics;
    return skippedWrite;
  }
}

/** Phase timings in milliseconds, for `--diagnostics`. */
export class CompileTimes {
  configTime = 0;
  buildInfoReadTime = 0;
  parseTime = 0;
  bindTime = 0;
  checkTime = 0;
  emitTime = 0;
  changesComputeTime = 0;
  totalTime = 0;
}

/** Module formats from the program's file metadata. */
class ProgramFormats extends ModuleFormatHost {
  constructor(private readonly program: Program) {
    super();
  }

  getEmitModuleFormat(fileName: string): ModuleKind {
    const program = this.program;
    return getEmitModuleFormatOfFile(fileName, program.options, program.sourceFileMetadata(program.toPath(fileName)));
  }
}

/** Module specifiers resolved to files of the program. */
class ProgramModules extends ModuleLookup {
  private readonly resolver: Resolver;

  constructor(private readonly program: Program) {
    super();
    this.resolver = new Resolver(program.host, program.options);
  }

  resolveModule(location: Node, file: SourceFile, specifier: string): SourceFile | undefined {
    const mode = this.program.getModeForUsageLocation(file, location);
    const resolved = this.resolver.resolveModuleName(specifier, file.fileName, mode).resolvedFileName;
    return resolved === '' ? undefined : this.program.getSourceFile(resolved);
  }
}

class ProgramEmitHost extends EmitHost {
  writer: OutputWriter | undefined = undefined;

  constructor(
    private readonly program: Program,
    resolver: EmitResolver,
  ) {
    super(
      program.options,
      resolver,
      new ProgramFormats(program),
      program.commonSourceDirectory(),
      program.currentDirectory,
      program.useCaseSensitiveFileNames,
    );
  }

  isEmitBlocked(fileName: string): boolean {
    return this.program.isEmitBlocked(fileName);
  }

  writeFile(fileName: string, text: string, declarationDiagnostics?: readonly Diagnostic[]): string {
    const writer = this.writer;
    if (writer === undefined) return skippedWrite;
    return writer.write(fileName, text, declarationDiagnostics ?? []);
  }
}

/** A checked program and the emit of its files. */
export class ProgramEmitter {
  private host: ProgramEmitHost | undefined = undefined;

  readonly program: Program;

  constructor(readonly checked: CheckedProgram) {
    this.program = checked.program;
  }

  private getHost(): ProgramEmitHost {
    let host = this.host;
    if (host === undefined) {
      const program = this.program;
      const options = program.options;
      const files = program.getSourceFiles();
      const references = new ReferenceResolver(options, files, new ProgramModules(program));
      const emitResolver = new SyntacticEmitResolver(options, references);
      // Declaration emit is also needed for the shape signatures of incremental builds.
      let resolver: EmitResolver = emitResolver;
      if (getEmitDeclarations(options) || options.incremental === true || options.composite === true) {
        const syntactic = new SyntacticDeclarationEmitResolver(options, files, program.currentDirectory, emitResolver);
        resolver = new CheckerDeclarationEmitResolver(this.checked.checker, syntactic);
      }
      host = new ProgramEmitHost(program, resolver);
      this.host = host;
    }
    return host;
  }

  emit(files: readonly SourceFile[], emitOnly: EmitOnly, writer: OutputWriter): EmitResult {
    // Where `emitFiles` would emit nothing, it is not given a host, whose resolvers index every file.
    const options = this.program.options;
    if (
      (options.noEmit === true && emitOnly !== EmitOnly.ForcedDts) ||
      !files.some((file) => sourceFileMayBeEmitted(file, options))
    ) {
      const result = new EmitResult();
      result.emitSkipped = options.noEmit === true && emitOnly !== EmitOnly.ForcedDts;
      return result;
    }
    const host = this.getHost();
    host.writer = writer;
    const result = emitFiles(host, files, emitOnly);
    host.writer = undefined;
    return result;
  }

  /** The declaration text and errors of `file`, emitted even without `declaration`. */
  forcedDeclaration(file: SourceFile): CapturingWriter {
    const writer = new CapturingWriter();
    this.emit([file], EmitOnly.ForcedDts, writer);
    return writer;
  }
}

/** A program as `tsc` compiles it. */
export abstract class CompilerProgram {
  readonly emitter: ProgramEmitter;

  constructor(
    readonly checked: CheckedProgram,
    readonly times: CompileTimes,
  ) {
    this.emitter = new ProgramEmitter(checked);
  }

  get program(): Program {
    return this.checked.program;
  }

  get options(): CompilerOptions {
    return this.checked.program.options;
  }

  getConfigFileParsingDiagnostics(): readonly Diagnostic[] {
    return this.program.getConfigFileParsingDiagnostics();
  }

  getSyntacticDiagnostics(): Diagnostic[] {
    return this.program.getSyntacticDiagnostics();
  }

  getProgramDiagnostics(): Diagnostic[] {
    return this.program.getProgramDiagnostics();
  }

  getGlobalDiagnostics(): Diagnostic[] {
    return this.checked.getGlobalDiagnostics();
  }

  /** Semantic diagnostics of every file. */
  abstract getSemanticDiagnostics(): Diagnostic[];

  /** Declaration emit errors of every file. */
  abstract getDeclarationDiagnostics(): Diagnostic[];

  /** Emits the program (or what changed) with `writer`. */
  abstract emit(writer: OutputWriter): EmitResult;
}

/** Collects declaration emit errors without writing anything. */
class DiscardingWriter extends OutputWriter {
  write(_fileName: string, _text: string, _declarationDiagnostics: readonly Diagnostic[]): string {
    return skippedWrite;
  }
}

export const discardingWriter: OutputWriter = new DiscardingWriter();

/** The declaration emit errors of `file` (none if it is not emitted). */
export function declarationDiagnosticsOfFile(emitter: ProgramEmitter, file: SourceFile): Diagnostic[] {
  return emitter.emit([file], EmitOnly.ForcedDts, discardingWriter).diagnostics;
}

/** A program compiled from scratch. */
export class PlainProgram extends CompilerProgram {
  getSemanticDiagnostics(): Diagnostic[] {
    return this.checked.getSemanticDiagnostics(undefined);
  }

  getDeclarationDiagnostics(): Diagnostic[] {
    const files = this.program.getSourceFiles();
    const parallel = this.checked.declarationsInParallel;
    if (parallel === undefined) return this.emitter.emit(files, EmitOnly.ForcedDts, discardingWriter).diagnostics;
    // Declaration emit is per file: the files checker threads emitted, the others here, in order.
    const result: Diagnostic[] = [];
    for (let i = 0; i < files.length; i++) {
      const diagnostics = parallel[i] ?? declarationDiagnosticsOfFile(this.emitter, files[i]!);
      for (const d of diagnostics) result.push(d);
    }
    return result;
  }

  emit(writer: OutputWriter): EmitResult {
    const options = this.options;
    if (options.noEmit !== true) {
      const skipped = handleNoEmitOnError(this);
      if (skipped !== undefined) return skipped;
    }
    const program = this.program;
    const files = program.getSourceFiles();
    const result = this.emitter.emit(files, EmitOnly.All, writer);
    // Emit is skipped only for files that would have been emitted.
    if (options.noEmit === true) result.emitSkipped = files.some((file) => program.sourceFileMayBeEmitted(file, false));
    return result;
  }
}

/** Under `noEmitOnError`, a skipped emit with the errors that prevent it; otherwise `undefined`. */
export function handleNoEmitOnError(program: CompilerProgram): EmitResult | undefined {
  if (program.options.noEmitOnError !== true) return undefined;
  const diagnostics = getDiagnosticsOfProgram(program, true);
  if (diagnostics.length === 0) return undefined;
  const result = new EmitResult();
  for (const d of diagnostics) result.diagnostics.push(d);
  result.emitSkipped = true;
  return result;
}

/**
 * Config and syntax errors; without syntax errors, program, global and semantic errors too, and
 * declaration errors under `noEmit` (or `withDeclarationDiagnostics`).
 */
export function getDiagnosticsOfProgram(program: CompilerProgram, withDeclarationDiagnostics: boolean): Diagnostic[] {
  const result: Diagnostic[] = [...program.getConfigFileParsingDiagnostics()];
  const configCount = result.length;
  for (const d of program.getSyntacticDiagnostics()) result.push(d);
  mark('syntactic diagnostics');
  if (result.length !== configCount) return result;
  for (const d of program.getProgramDiagnostics()) result.push(d);
  mark('program diagnostics');
  const options = program.options;
  if (options.listFilesOnly === true) return result;
  for (const d of program.getGlobalDiagnostics()) result.push(d);
  if (result.length === configCount) {
    const checkStart = performance.now();
    const semantic = program.getSemanticDiagnostics();
    program.times.checkTime = performance.now() - checkStart;
    for (const d of semantic) result.push(d);
    // Checking may have found more, such as missing global types.
    for (const d of program.getGlobalDiagnostics()) result.push(d);
    mark('semantic diagnostics');
  }
  if (
    (withDeclarationDiagnostics || options.noEmit === true) &&
    getEmitDeclarations(options) &&
    result.length === configCount
  ) {
    for (const d of program.getDeclarationDiagnostics()) result.push(d);
  }
  return result;
}

/** Combines emit results in order. */
export function combineEmitResults(results: readonly EmitResult[]): EmitResult {
  const result = new EmitResult();
  for (const r of results) {
    if (r.emitSkipped) result.emitSkipped = true;
    for (const d of r.diagnostics) result.diagnostics.push(d);
    for (const f of r.emittedFiles) result.emittedFiles.push(f);
    for (const e of r.errors) result.errors.push(e);
    for (const u of r.unsupported) result.unsupported.push(u);
  }
  return result;
}

export { CheckedProgram };
