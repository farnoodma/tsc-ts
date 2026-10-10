// Usage: cli [tsc arguments]
// Runs the tsc command line up to compilation, which tsc-ts itself (src/main.ts) carries on with.
// Lib files come from TSC_TS_LIB_DIR, or the script's directory. With TSC_TS_BUNDLED_LIBS set, they
// are read from that directory as `bundled:///libs/`, like tsgo's embedded libraries.
import { dirname } from 'node:path';
import { ExitStatus, executeCommandLine } from '../compiler/tsc-cli.js';
import { createNodeSystem } from './node-system.js';

const bundledLibs = process.env.TSC_TS_BUNDLED_LIBS ?? '';
const libraryPath =
  bundledLibs !== '' ? 'bundled:///libs' : (process.env.TSC_TS_LIB_DIR ?? dirname(process.argv[1] ?? '.'));
const result = executeCommandLine(createNodeSystem(libraryPath, bundledLibs), process.argv.slice(2));
// Exit without tearing down the program: process.exit skips the final cycle collection.
if (result.kind === 'exit') process.exit(result.status);
const stage = result.kind === 'compile' ? 'checking and emit' : result.kind;
process.stderr.write(`tsc-ts: ${stage} is not implemented yet\n`);
process.exit(ExitStatus.NotImplemented);
