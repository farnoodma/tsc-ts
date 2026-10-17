// Lays out the tsc-ts npm packages and packs them into dist/npm:
//
//   tsc-ts             the launcher (bin/tsc-ts.js), with an optional
//                      dependency on each platform package
//   @tsc-ts/<platform> the native executable for this host, with
//                      TypeScript 7.0.2's lib files next to it in lib/
//
// Usage: node scripts/pack.mjs [main] [platform] [--binary <path>] [--check]
//
// With neither main nor platform, packs both. Builds the executable with
// scriptc unless --binary names one. --check installs the tarballs into a
// temporary project and compiles it with npx tsc-ts.
//
// The optional dependencies are added here rather than in package.json, so
// the workspace installs without the platform packages.
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { executableName, hostDescription, hostPlatform, packageName, platforms } from '../bin/platforms.js';

const root = resolve(import.meta.dirname, '..');
const repo = resolve(root, '../..');
const out = join(root, 'dist/npm');
const windows = process.platform === 'win32';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { binary: { type: 'string' }, check: { type: 'boolean' } },
});
for (const kind of positionals) if (kind !== 'main' && kind !== 'platform') throw new Error(`unknown package ${kind}`);
const kinds = positionals.length === 0 ? ['main', 'platform'] : positionals;

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const common = {
  version: manifest.version,
  license: manifest.license,
  repository: manifest.repository,
};

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const tarballs = {};
if (kinds.includes('main')) tarballs.main = packMain();
if (kinds.includes('platform')) tarballs.platform = packPlatform();
for (const tarball of Object.values(tarballs)) console.log(tarball);
if (values.check) check(tarballs);

function packMain() {
  const dir = join(out, 'tsc-ts');
  for (const file of manifest.files) cpSync(join(root, file), join(dir, file), { recursive: true });
  copyFileSync(join(repo, 'LICENSE'), join(dir, 'LICENSE'));
  copyFileSync(join(repo, 'THIRD_PARTY_NOTICES.md'), join(dir, 'THIRD_PARTY_NOTICES.md'));
  const { scripts: _scripts, devDependencies: _devDependencies, private: _private, ...fields } = manifest;
  fields.files = [...manifest.files, 'THIRD_PARTY_NOTICES.md'];
  fields.optionalDependencies = Object.fromEntries(platforms.map((p) => [packageName(p), manifest.version]));
  writeJson(join(dir, 'package.json'), fields);
  return pack(dir);
}

function packPlatform() {
  const platform = hostPlatform();
  if (platform === undefined) throw new Error(`tsc-ts has no platform package for ${hostDescription()}`);
  const dir = join(out, platform.name);
  const lib = join(dir, 'lib');
  mkdirSync(lib, { recursive: true });
  const executable = join(lib, executableName());
  copyFileSync(values.binary ? resolve(values.binary) : build(), executable);
  chmodSync(executable, 0o755);
  const libs = typescriptLib();
  for (const name of readdirSync(libs))
    if (/^lib\..*\.d\.ts$/.test(name)) copyFileSync(join(libs, name), join(lib, name));
  copyFileSync(join(repo, 'LICENSE'), join(dir, 'LICENSE'));
  copyFileSync(join(repo, 'THIRD_PARTY_NOTICES.md'), join(dir, 'THIRD_PARTY_NOTICES.md'));
  writeJson(join(dir, 'package.json'), {
    name: packageName(platform),
    ...common,
    description: `The tsc-ts executable for ${platform.name}.`,
    os: [platform.os],
    cpu: [platform.cpu],
    ...(platform.libc && { libc: [platform.libc] }),
    files: ['lib', 'THIRD_PARTY_NOTICES.md'],
  });
  return pack(dir);
}

// Builds dist/tsc with scriptc and returns its path.
function build() {
  run('npm', ['run', 'build:native'], { cwd: root });
  const path = join(root, 'dist/tsc');
  if (windows && existsSync(path + '.exe')) return path + '.exe';
  if (!existsSync(path)) throw new Error(`scriptc did not write ${path}`);
  return path;
}

// TypeScript 7.0.2's lib files, from the tsc bundled with the installed scriptc.
function typescriptLib() {
  const require = createRequire(join(root, 'package.json'));
  const scriptc = JSON.parse(readFileSync(require.resolve('scriptc/package.json'), 'utf8'));
  for (const name of Object.keys(scriptc.optionalDependencies ?? {})) {
    let path;
    try {
      path = require.resolve(`${name}/package.json`);
    } catch {
      continue;
    }
    const lib = join(dirname(path), 'dist/lib/typescript/lib');
    if (existsSync(join(lib, 'lib.d.ts'))) return lib;
  }
  throw new Error('no scriptc platform package with TypeScript lib files is installed');
}

function pack(dir) {
  const result = run('npm', ['pack', '--json', '--pack-destination', out], { cwd: dir, stdio: 'pipe' });
  return join(out, JSON.parse(result.stdout)[0].filename);
}

// Installs the tarballs into a new project, then checks --version, a clean
// compile, and the exit code of a compile with errors.
function check({ main, platform }) {
  if (!main || !platform) throw new Error('--check needs both packages');
  const dir = join(tmpdir(), `tsc-ts-pack-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  try {
    writeJson(join(dir, 'package.json'), { name: 'tsc-ts-pack-check', private: true, type: 'module' });
    writeJson(join(dir, 'tsconfig.json'), {
      compilerOptions: { target: 'es2022', module: 'nodenext', strict: true, rootDir: 'src', outDir: 'out' },
      include: ['src'],
    });
    writeFileSync(join(dir, 'src/index.ts'), 'export const greeting: string = ["hello", "world"].join(" ");\n');
    run('npm', ['install', '--no-audit', '--no-fund', main, platform], { cwd: dir });

    const version = run('npx', ['tsc-ts', '--version'], { cwd: dir, stdio: 'pipe' }).stdout.trim();
    console.log(`npx tsc-ts --version: ${version}`);
    run('npx', ['tsc-ts', '-p', '.'], { cwd: dir });
    const emitted = readFileSync(join(dir, 'out/index.js'), 'utf8');
    if (!emitted.includes('greeting')) throw new Error(`unexpected output:\n${emitted}`);

    writeFileSync(join(dir, 'src/error.ts'), 'export const count: number = "one";\n');
    const failed = spawn('npx', ['tsc-ts', '-p', '.'], { cwd: dir, stdio: 'pipe' });
    if (failed.status !== 2 || !failed.stdout.includes('TS2322')) {
      throw new Error(`expected TS2322 and exit code 2, got ${failed.status}:\n${failed.stdout}${failed.stderr}`);
    }
    console.log('npx tsc-ts -p .: ok');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function run(command, args, options) {
  const result = spawn(command, args, options);
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} exited with ${result.status}\n${result.stdout ?? ''}${result.stderr ?? ''}`,
    );
  }
  return result;
}

function spawn(command, args, { stdio = 'inherit', ...options }) {
  // npm and npx are batch files on Windows.
  return spawnSync(command, args, { ...options, stdio, encoding: 'utf8', shell: windows });
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}
