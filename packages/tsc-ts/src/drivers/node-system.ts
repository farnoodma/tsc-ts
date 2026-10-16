// The tsc command line on the disk, for `tsc-ts` and the cli driver.
import { mark, markMemory } from '../compiler/timeline.js';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { DirectoryEntries } from '../compiler/file-system.js';
import { normalizePath } from '../compiler/path.js';
import type { Program } from '../compiler/program.js';
import { ParseThread } from '../compiler/parse-thread.js';
import { type CommandLineResult, System, executeCommandLine, readThreadProject } from '../compiler/tsc-cli.js';
import type { OutputWriter } from '../compiler/compile-program.js';
import { compile, compileInParallel, compileThreads, SystemWriter } from '../compiler/tsc-compile.js';
import { buildWithThreads } from '../compiler/tsc-build.js';
import { watch, watchBuild } from '../compiler/tsc-watch.js';

const bundledPrefix = 'bundled:///libs/';

class NodeSystem extends System {
  constructor(
    currentDirectory: string,
    writeOutputIsTTY: boolean,
    terminalWidth: number,
    defaultLibraryPath: string,
    /** The directory `bundled:///libs/` maps to, or `''`. */
    private readonly bundledLibs: string,
  ) {
    super(currentDirectory, writeOutputIsTTY, terminalWidth, true, defaultLibraryPath);
  }

  getEnvironmentVariable(name: string): string {
    return process.env[name] ?? '';
  }

  write(text: string): void {
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

  private toOsPath(path: string): string {
    if (this.bundledLibs !== '' && path.startsWith(bundledPrefix)) {
      return this.bundledLibs + '/' + path.slice(bundledPrefix.length);
    }
    return path;
  }

  readFile(path: string): string | undefined {
    try {
      return readFileSync(this.toOsPath(path), 'utf8');
    } catch {
      return undefined;
    }
  }

  writeFile(path: string, text: string): boolean {
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
      return true;
    } catch {
      return false;
    }
  }

  fileExists(path: string): boolean {
    try {
      return statSync(this.toOsPath(path)).isFile();
    } catch {
      return false;
    }
  }

  directoryExists(path: string): boolean {
    try {
      return statSync(this.toOsPath(path)).isDirectory();
    } catch {
      return false;
    }
  }

  getAccessibleEntries(path: string): DirectoryEntries {
    const files: string[] = [];
    const directories: string[] = [];
    const symlinks = new Set<string>();
    let entries;
    try {
      entries = readdirSync(this.toOsPath(path), { withFileTypes: true });
    } catch {
      return new DirectoryEntries(files, directories, symlinks);
    }
    const names = entries.map((entry) => entry.name).sort(compareUtf8);
    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    for (const name of names) {
      const entry = byName.get(name);
      if (entry === undefined) continue;
      if (entry.isDirectory()) directories.push(name);
      else if (entry.isFile()) files.push(name);
      else if (entry.isSymbolicLink()) {
        try {
          const stat = statSync(this.toOsPath(path) + '/' + name);
          if (stat.isDirectory()) directories.push(name);
          else if (stat.isFile()) files.push(name);
          else continue;
          symlinks.add(name);
        } catch {
          // A broken link.
        }
      }
    }
    return new DirectoryEntries(files, directories, symlinks);
  }

  realpath(path: string): string {
    try {
      return normalizePath(realpathSync(path));
    } catch {
      return path;
    }
  }

  getMTime(path: string): number | undefined {
    try {
      return statSync(this.toOsPath(path)).mtimeMs;
    } catch {
      return undefined;
    }
  }

  setMTime(path: string, time: number): boolean {
    try {
      const date = new Date(time);
      utimesSync(path, date, date);
      return true;
    } catch {
      return false;
    }
  }

  removeFile(path: string): boolean {
    try {
      unlinkSync(path);
      return true;
    } catch {
      return false;
    }
  }
}

/** Orders names by UTF-8 bytes, as Go's directory listing does. */
function compareUtf8(a: string, b: string): number {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return Buffer.compare(x, y);
}

/** Columns of the terminal, from `stty` since there's no portable API for it. */
function terminalWidth(): number {
  const result = spawnSync('stty', ['size'], { encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'] });
  if (result.status !== 0) return 0;
  const columns = Number(result.stdout.trim().split(' ')[1]);
  return Number.isInteger(columns) ? columns : 0;
}

/**
 * The system of a `tsc` run in the current directory. Lib files are read from `libraryPath`;
 * `bundled:///libs/` maps to `bundledLibs` when it isn't `''`.
 */
export function createNodeSystem(libraryPath: string, bundledLibs: string): System {
  const isTTY = process.stdout.isTTY === true;
  return new NodeSystem(
    normalizePath(process.cwd()),
    isTTY,
    isTTY ? terminalWidth() : 0,
    normalizePath(libraryPath),
    bundledLibs,
  );
}

/** Writes the files checker threads emit (parallel-check.ts) as the system of `runTsc` does. */
export function outputWriterOfThread(libraryPath: string): OutputWriter {
  return new SystemWriter(new NodeSystem(normalizePath(process.cwd()), false, 0, normalizePath(libraryPath), ''));
}

/** What `runTsc` returns when it keeps watching for changes instead of exiting. */
export const watching = -1;

/** Runs the tsc command line `args` and returns the exit status, or `watching`. */
export function runTsc(args: readonly string[], libraryPath: string): number {
  const sys = tscSystem(libraryPath);
  return runCommandLineResult(sys, executeCommandLine(sys, args));
}

/** The program the tsc command line `args` compiles, if it compiles one: a checker thread's own copy. */
export function programOfCommandLine(args: readonly string[], libraryPath: string): Program | undefined {
  const result = executeCommandLine(tscSystem(libraryPath), args);
  return result.kind === 'compile' ? result.program : undefined;
}

/**
 * A parse thread (parallel-parse.ts) for the compile command line `args`, whose main thread found its
 * config at `configFileName`; `undefined` if the project cannot be read.
 */
export function parseThreadOfCommandLine(
  args: readonly string[],
  configFileName: string,
  libraryPath: string,
): ParseThread | undefined {
  const sys = tscSystem(libraryPath);
  const project = readThreadProject(sys, args, configFileName);
  return project === undefined
    ? undefined
    : new ParseThread(project.config, project.fs, sys.currentDirectory, sys.defaultLibraryPath);
}

function tscSystem(libraryPath: string): System {
  // With TSC_TS_BUNDLED_LIBS set, lib files are read from there as `bundled:///libs/`, like tsgo's embedded ones.
  const bundledLibs = process.env.TSC_TS_BUNDLED_LIBS ?? '';
  return createNodeSystem(bundledLibs !== '' ? 'bundled:///libs' : libraryPath, bundledLibs);
}

function runCommandLineResult(sys: System, result: CommandLineResult): number {
  if (result.kind === 'exit') return result.status;
  if (result.kind === 'compile') {
    const threads = compileThreads(sys, result);
    if (threads <= 1) return compile(sys, result);
    // Checker threads report back on this thread's event loop.
    compileInParallel(sys, result, threads, (status) => {
      markMemory();
      mark('exit');
      process.exit(status);
    });
    return watching;
  }
  if (result.kind === 'deferred') {
    // Parse threads prepare the program's files first (parallel-parse.ts).
    result.run((ready) => {
      const status = runCommandLineResult(sys, ready);
      if (status !== watching) {
        markMemory();
        mark('exit');
        process.exit(status);
      }
    });
    return watching;
  }
  if (result.kind === 'build') {
    if (result.commandLine.compilerOptions.watch === true) {
      watchBuild(sys, result.commandLine);
      return watching;
    }
    const status = buildWithThreads(sys, result.commandLine, (s) => {
      markMemory();
      mark('exit');
      process.exit(s);
    });
    return status ?? watching;
  }
  watch(sys, result.config, result.commandLine);
  return watching;
}
