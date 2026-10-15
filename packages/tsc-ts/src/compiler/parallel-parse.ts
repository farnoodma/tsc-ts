/**
 * Parsing and binding on several threads, before checking on several threads (`--checkers N` in
 * scriptc builds).
 *
 * Before the main thread creates the Program, N parse threads load the program's files ahead of it,
 * the way tsgo's loader does: the main thread queues the root files, the default libraries and the
 * automatic type directives, and hands the queue out to the threads in small chunks. Each thread
 * parses and binds the files of a chunk through a FileLoader of its own (parse-thread.ts), which
 * resolves their references, imports and type directives exactly as the program's FileLoader will,
 * and sends back the bound source files, published with `@scriptc/threads` so that they reach the
 * main thread by reference, together with the files they add. The main thread queues the files it
 * has not seen yet, and loading ends when the queue is empty and every thread is idle. Node and
 * symbol ids come in chunks from one shared counter, so they stay unique in the program.
 *
 * The FileLoader then takes a prepared file instead of parsing when the file name, canonical path and
 * module-indicator options match; anything else (a file that was not loaded ahead, or that is parsed
 * with other options) is parsed as usual, so the program does not depend on what was loaded ahead.
 */
import type { Worker } from 'node:worker_threads';
import { publish } from '@scriptc/threads';
import { type SourceFile, type ExternalModuleIndicatorOptions, lastNodeIdValue, shareNodeIds } from './ast.js';
import type { LoadedFile } from './file-loader.js';
import type { CompilerOptions } from './options.js';
import { useThreadTextCaches } from './diagnostics.js';
import { useLazyJSDocTable } from './parser.js';
import { getNormalizedAbsolutePath } from './path.js';
import { getDefaultLibFileName, getLibFileName } from './program-utilities.js';
import { lastSymbolIdValue, shareSymbolIds } from './symbol.js';
import { mark, timeline } from './timeline.js';

/** What a queued file is. */
export const enum LoadKind {
  /** A root file of the config, as the config names it. */
  Root = 0,
  /** A file another file adds, by normalized file name. */
  File = 1,
  /** A library file, by its name (`lib.es2020.d.ts`). */
  Library = 2,
  /** The automatic type directives (`types`, or every package in `node_modules/@types`). */
  AutomaticTypes = 3,
}

/**
 * Files to load: kind, name and `maxNodeModuleJsDepth` depth of each, and the size in bytes of the
 * files a parse thread adds (0 where unknown).
 */
export class LoadJobs {
  readonly kinds: number[] = [];
  readonly names: string[] = [];
  readonly depths: number[] = [];
  readonly sizes: number[] = [];

  push(kind: LoadKind, name: string, depth: number, size = 0): void {
    this.kinds.push(kind);
    this.names.push(name);
    this.depths.push(depth);
    this.sizes.push(size);
  }
}

/**
 * A parsed and bound source file, with the inputs it was parsed from and what the parse thread's
 * FileLoader found loading it (its references and their resolutions), which the program's
 * FileLoader takes instead of resolving them again.
 */
export class PreparedFile {
  loaded: LoadedFile | undefined = undefined;

  constructor(
    readonly fileName: string,
    readonly path: string,
    readonly jsx: boolean,
    readonly force: boolean,
    readonly file: SourceFile,
  ) {}
}

/** What a parse thread's FileLoader found loading `fileName`, if the thread prepared it. */
export function preparedLoad(fileName: string): LoadedFile | undefined {
  if (parallelParse.files.size === 0) return undefined;
  return parallelParse.files.get(fileName)?.loaded;
}

/** What a parse thread sends back for a chunk: its bound files and the files they add. */
export class PreparedBatch {
  constructor(
    readonly files: PreparedFile[],
    readonly added: LoadJobs,
    readonly parseMs: number,
  ) {}
}

/**
 * What the main thread posts a parse thread: a chunk of files to load, or `stop`. A plain object:
 * posting copies it.
 */
export type LoadMessage = {
  readonly stop: boolean;
  readonly kinds: number[];
  readonly names: string[];
  readonly depths: number[];
};

/**
 * Starts a parse thread (main.ts owns the worker entry point). It reads the config `configFileName`
 * (`''` for none) with the command line of this run, takes ids from `counter`, and loads the chunks
 * posted to it (`LoadMessage`) until it is told to stop.
 */
export type ParserSpawn = (configFileName: string, counter: SharedArrayBuffer, index: number) => Worker;

export class ParallelParse {
  /** Set where parse threads can be started and share what they parse (scriptc builds). */
  spawn: ParserSpawn | undefined = undefined;
  /** Prepared files by file name, taken by the FileLoader. */
  readonly files = new Map<string, PreparedFile>();
  /** Files the FileLoader took, found with other parse inputs, and did not find. */
  used = 0;
  missed = 0;
  unprepared = 0;
}

export const parallelParse = new ParallelParse();

/** The FileLoader's lookup: the prepared file for these parse inputs, or `undefined`. */
export function takePreparedFile(
  fileName: string,
  path: string,
  options: ExternalModuleIndicatorOptions,
): SourceFile | undefined {
  if (parallelParse.files.size === 0) return undefined;
  const prepared = parallelParse.files.get(fileName);
  if (prepared === undefined) {
    parallelParse.unprepared++;
    return undefined;
  }
  if (prepared.path !== path || prepared.jsx !== options.jsx || prepared.force !== options.force) {
    parallelParse.missed++;
    return undefined;
  }
  parallelParse.used++;
  return prepared.file;
}

/** Files per chunk at most: small enough that the files a chunk adds are queued again soon. */
const maxChunk = 16;

/** Files from this size (bytes) on take a parse thread 25 ms or more, and go out ahead of others. */
const largeFile = 256 * 1024;

/**
 * The files to hand out to parse threads, each queued once. Library files go out first, one per
 * chunk, also those found later through `/// <reference lib>`: a large one (`lib.dom.d.ts`) takes a
 * thread 100–150 ms, and queued behind other files it would be the last file the program waits for.
 * Then, for the same reason, large files the parse threads found (`csstype`'s 0.9 MB of
 * declarations, found through React's), one per chunk. The other files go out in program order, in
 * chunks of up to `maxChunk`.
 */
export class ParseQueue {
  private readonly libraries = new LoadJobs();
  private readonly large = new LoadJobs();
  private readonly others = new LoadJobs();
  private libraryHead = 0;
  private largeHead = 0;
  private head = 0;
  private readonly seen = new Set<string>();

  push(kind: LoadKind, name: string, depth: number, size = 0): void {
    const key = kind === LoadKind.Library ? 'lib:' + name : kind === LoadKind.AutomaticTypes ? 'types:' : name;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    const jobs =
      kind === LoadKind.Library
        ? this.libraries
        : kind === LoadKind.File && size >= largeFile
          ? this.large
          : this.others;
    jobs.push(kind, name, depth, size);
  }

  /** Files queued so far. */
  queued(): number {
    return this.seen.size;
  }

  /** Files not handed out yet. */
  left(): number {
    return (
      this.libraries.names.length -
      this.libraryHead +
      this.large.names.length -
      this.largeHead +
      this.others.names.length -
      this.head
    );
  }

  /**
   * The next chunk for one of `threads` parse threads, or `undefined` when nothing is left. With
   * `full`, other files only go out `maxChunk` at a time, and stay queued until there are as many.
   */
  next(threads: number, full = false): LoadMessage | undefined {
    const libraries = this.libraries;
    if (this.libraryHead < libraries.names.length) {
      const k = this.libraryHead++;
      return {
        stop: false,
        kinds: [libraries.kinds[k]!],
        names: [libraries.names[k]!],
        depths: [libraries.depths[k]!],
      };
    }
    const large = this.large;
    if (this.largeHead < large.names.length) {
      const k = this.largeHead++;
      return {
        stop: false,
        kinds: [large.kinds[k]!],
        names: [large.names[k]!],
        depths: [large.depths[k]!],
      };
    }
    const queue = this.others;
    const left = queue.names.length - this.head;
    if (left <= 0 || (full && left < maxChunk)) return undefined;
    const size = full ? maxChunk : Math.min(maxChunk, Math.max(1, Math.floor(left / threads)));
    const start = this.head;
    const end = start + size;
    this.head = end;
    return {
      stop: false,
      kinds: queue.kinds.slice(start, end),
      names: queue.names.slice(start, end),
      depths: queue.depths.slice(start, end),
    };
  }
}

/**
 * Chunks a parse thread may have queued while the main thread matches the config's `include`
 * patterns: the main thread cannot hand out chunks as threads finish them then, so it queues them on
 * the threads ahead, up to about 80 ms of parsing per thread at 16 files per chunk (TypeORM's 3,276
 * root files take the main thread 35-45 ms to match).
 */
const maxQueuedWhileMatching = 12;

/** Libraries that take a parse thread 50 ms or more: nothing is queued behind them. */
const largeLibraries = new Set(['lib.dom.d.ts', 'lib.webworker.d.ts']);

/**
 * Main thread: loads the program's files ahead of it on parse threads. Started with the compiler
 * options, before the config's root files are known (`ParseSession.start` takes them), so that the
 * threads load the libraries, the automatic type directives and the root files the `include`
 * patterns match (`hint`) while the main thread is still matching them.
 */
export class ParseSession {
  private readonly startTime = performance.now();
  private readonly trace = process.env.TSC_TS_CHECKERS_TRACE !== undefined;
  private readonly verbose = process.env.TSC_TS_CHECKERS_TRACE === '3';
  private readonly queue = new ParseQueue();
  private readonly workers: Worker[] = [];
  /** Chunks posted to each thread and not yet returned. */
  private readonly outstanding: number[] = [];
  /** Whether a thread has a large library to load (`largeLibraries`). */
  private readonly blocked: boolean[] = [];
  private readonly alive: boolean[] = [];
  /** Parse threads with no chunk; `busy` counts the chunks out on threads. */
  private readonly idle: number[] = [];
  private busy = 0;
  private chunks = 0;
  private finished = false;
  /** Until `start`: root files are still being matched, and more may come. */
  private matching = true;
  private done: (() => void) | undefined = undefined;
  /**
   * Main-thread work done a little at a time while the threads load files: called with each batch
   * a thread returns, once its files are available and the next chunk is out.
   */
  onIdle: ((batch: PreparedBatch) => void) | undefined = undefined;

  /**
   * Starts `count` parse threads for a program with `options`, with or without root files
   * (`hasRootFiles`; `true` when not known yet). They read the config `configFileName` (`''` for none).
   */
  constructor(
    private readonly count: number,
    options: CompilerOptions,
    private readonly currentDirectory: string,
    configFileName: string,
    hasRootFiles: boolean,
  ) {
    mark(`parse start, ${count} threads`);
    // Prepared files are published (immutable): this thread keeps lazily parsed JSDoc, and the text
    // caches of declaration files, in tables.
    useLazyJSDocTable();
    useThreadTextCaches();
    const queue = this.queue;
    if (hasRootFiles) {
      if (options.noLib !== true) {
        const lib = options.lib;
        if (lib === undefined) queue.push(LoadKind.Library, getDefaultLibFileName(options), 0);
        else
          for (const name of lib) {
            const fileName = getLibFileName(name);
            if (fileName !== '') queue.push(LoadKind.Library, fileName, 0);
          }
      }
      queue.push(LoadKind.AutomaticTypes, '', 0);
    }

    const counter = new SharedArrayBuffer(8);
    const ids = new Int32Array(counter);
    ids[0] = lastNodeIdValue();
    ids[1] = lastSymbolIdValue();
    shareNodeIds(new Int32Array(counter, 0, 1));
    shareSymbolIds(new Int32Array(counter, 4, 1));

    for (let i = 0; i < count; i++) {
      const worker = parallelParse.spawn!(configFileName, counter, i);
      this.workers.push(worker);
      this.alive.push(true);
      this.outstanding.push(0);
      this.blocked.push(false);
      this.idle.push(i);
      worker.on('message', (message: unknown) =>
        this.received(i, publish((message as { batch: PreparedBatch }).batch)),
      );
      worker.on('error', (error: unknown) => {
        // The files of its chunks are parsed by the program's FileLoader.
        if (this.trace) process.stderr.write(`parsers: thread ${i} failed: ${String(error)}\n`);
        this.alive[i] = false;
        const waiting = this.idle.indexOf(i);
        if (waiting >= 0) this.idle.splice(waiting, 1);
        this.busy -= this.outstanding[i]!;
        this.outstanding[i] = 0;
        if (!this.finished) this.dispatch();
      });
    }
    mark('parse threads spawned');
    this.dispatch();
  }

  /** A root file the config's `include` patterns matched, while they are still being matched. */
  hint(fileName: string): void {
    this.queue.push(LoadKind.Root, getNormalizedAbsolutePath(fileName, this.currentDirectory), 0);
    this.dispatch();
  }

  /** Queues the program's root files, and calls `done` once every prepared file is available. */
  start(rootNames: readonly string[], done: () => void): void {
    for (const name of rootNames)
      this.queue.push(LoadKind.Root, getNormalizedAbsolutePath(name, this.currentDirectory), 0);
    this.matching = false;
    this.done = done;
    if (this.trace && this.chunks > 0)
      process.stderr.write(`parsers: ${this.chunks} chunks out while the config was read\n`);
    mark(`root files queued, ${this.chunks} chunks out`);
    this.dispatch();
  }

  private received(i: number, batch: PreparedBatch): void {
    const queue = this.queue;
    if (timeline) mark(`chunk from p${i}: ${batch.files.length} files, ${queue.left()} left, ${this.busy - 1} busy`);
    for (const prepared of batch.files) parallelParse.files.set(prepared.fileName, prepared);
    const added = batch.added;
    for (let k = 0; k < added.names.length; k++)
      queue.push(added.kinds[k]!, added.names[k]!, added.depths[k]!, added.sizes[k]!);
    if (this.verbose)
      process.stderr.write(
        `parsers: thread ${i} loaded ${batch.files.length} files in ${batch.parseMs.toFixed(1)}ms, at ${(performance.now() - this.startTime).toFixed(1)}ms\n`,
      );
    this.busy--;
    const outstanding = this.outstanding[i]! - 1;
    this.outstanding[i] = outstanding;
    if (outstanding === 0) {
      this.blocked[i] = false;
      this.idle.push(i);
    }
    this.dispatch();
    if (!this.finished && this.onIdle !== undefined) this.onIdle(batch);
  }

  private post(i: number, chunk: LoadMessage): void {
    this.workers[i]!.postMessage(chunk);
    this.outstanding[i] = this.outstanding[i]! + 1;
    if (chunk.kinds[0] === LoadKind.Library && largeLibraries.has(chunk.names[0]!)) this.blocked[i] = true;
    this.busy++;
    this.chunks++;
  }

  private dispatch(): void {
    const queue = this.queue;
    // While root files are matched, only full chunks of other files go out, so that a few matched
    // files do not go out alone.
    const full = this.matching;
    while (this.idle.length > 0) {
      const chunk = queue.next(this.count, full);
      if (chunk === undefined) break;
      this.post(this.idle.pop()!, chunk);
    }
    if (this.matching) {
      // Queue more on threads, except behind a large library: none of them returns a chunk before the
      // config is read.
      for (;;) {
        let target = -1;
        for (let i = 0; i < this.count; i++) {
          if (!this.alive[i]! || this.blocked[i]! || this.outstanding[i]! >= maxQueuedWhileMatching) continue;
          if (target < 0 || this.outstanding[i]! < this.outstanding[target]!) target = i;
        }
        if (target < 0) break;
        const chunk = queue.next(this.count, true);
        if (chunk === undefined) break;
        this.post(target, chunk);
      }
      return;
    }
    // Every thread is idle (or failed) and nothing is left to hand out: what is not prepared now is
    // parsed by the program's FileLoader.
    if (this.busy === 0 && !this.finished) this.finish();
  }

  private finish(): void {
    this.finished = true;
    const stop: LoadMessage = { stop: true, kinds: [], names: [], depths: [] };
    for (let i = 0; i < this.workers.length; i++) if (this.alive[i]!) this.workers[i]!.postMessage(stop);
    shareNodeIds(undefined);
    shareSymbolIds(undefined);
    mark(`parse done, ${parallelParse.files.size} files, ${this.chunks} chunks`);
    if (this.trace)
      process.stderr.write(
        `parsers: ${parallelParse.files.size} files prepared in ${(performance.now() - this.startTime).toFixed(1)}ms (${this.chunks} chunks, ${this.queue.queued()} queued, ${this.queue.left()} left)\n`,
      );
    this.done!();
  }
}

/**
 * Main thread: loads the program's files ahead of it on `count` parse threads, and calls `done` once
 * every prepared file is available to the FileLoader.
 */
export function startParallelParse(
  count: number,
  rootNames: readonly string[],
  options: CompilerOptions,
  currentDirectory: string,
  configFileName: string,
  done: () => void,
): void {
  new ParseSession(count, options, currentDirectory, configFileName, rootNames.length > 0).start(rootNames, done);
}

/** With TSC_TS_CHECKERS_TRACE: how many prepared files the program took, and how many it parsed. */
export function reportPreparedFiles(fileNames: readonly string[]): void {
  const trace = process.env.TSC_TS_CHECKERS_TRACE;
  if (trace === undefined || parallelParse.files.size === 0) return;
  process.stderr.write(
    `parsers: program took ${parallelParse.used} prepared files, ${parallelParse.missed} mismatched, ${parallelParse.missed + parallelParse.unprepared} parsed on the main thread, ${parallelParse.files.size - parallelParse.used} prepared but not taken (${fileNames.length} files)\n`,
  );
  if (trace === '2')
    for (const fileName of fileNames)
      if (!parallelParse.files.has(fileName)) process.stderr.write(`  not prepared: ${fileName}\n`);
}
