# tsc-ts

The TypeScript 7.0.2 compiler (tsgo), ported to TypeScript and compiled to a native executable with [scriptc](https://scriptc.dev). Experimental.

## Installation

```sh
npm install -D tsc-ts
```

npm installs the executable for your platform from an optional dependency:

| Platform             | Package                    |
| -------------------- | -------------------------- |
| macOS, Apple silicon | `@tsc-ts/darwin-arm64`     |
| macOS, Intel         | `@tsc-ts/darwin-x64`       |
| Linux arm64, glibc   | `@tsc-ts/linux-arm64-gnu`  |
| Linux arm64, musl    | `@tsc-ts/linux-arm64-musl` |
| Linux x64, glibc     | `@tsc-ts/linux-x64-gnu`    |
| Linux x64, musl      | `@tsc-ts/linux-x64-musl`   |
| Windows x64          | `@tsc-ts/win32-x64-msvc`   |

Don't install with `--omit=optional` or `--no-optional`.

## Usage

`tsc-ts` takes the same arguments as `tsc`:

```sh
npx tsc-ts -p tsconfig.json
npx tsc-ts --noEmit src/index.ts
```

`tsc-ts --api` serves the TypeScript API over stdin and stdout, like `tsc --api`.

`--checkers N` checks the program on N threads. Unless `--checkers` or `--singleThreaded` is given, the native executable uses one checker per CPU it may run on (up to 16), and at least tsgo's four; it uses fewer than the CPUs, but never fewer than four, when the estimated peak memory of more checkers would not fit 85% of the machine's memory (`TSC_TS_CHECKERS=fixed` keeps tsgo's four), and checkers beyond the fourth stop taking files, one at a time, when the process's memory reaches that share; it shares one program between its threads and also parses and binds the program's files on them. Files that share costly declarations, such as a large generated schema and the few files importing it, are checked together on one checker. Under Node.js, where every thread builds its own copy of the program, tsc-ts checks on one thread unless `--checkers` is given. `--incremental`, `--watch` and `--build` always check on one thread. The diagnostics are the same as with one checker.

The native executable never frees syntax trees, types, signatures or symbols: it keeps them until it exits, which saves the cost of tracking them during a build. A one-shot build is unaffected, but a long-running `--watch` or `--api` process grows with each rebuild or project update; restart it to reclaim the memory.

The default lib files (`lib.*.d.ts`) ship next to the executable. Set `TSC_TS_LIB_DIR` to use another directory.
