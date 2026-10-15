import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { Checker } from './checker/relater.js';
import type { Graph } from './checker/types.js';

function run(): void {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === '--help') {
    console.log(
      'relater — experimental tsgo assignability port, compiled statically with scriptc v0.3.0\nUsage: relater graph.json [--rounds N] [--cold]\nInput: relater.type-graph.v11 resolved type arena.',
    );
    return;
  }
  if (args[0] === '--version') {
    console.log('relater 0.0.0 (scriptc 0.3.0)');
    return;
  }
  const graph = JSON.parse(readFileSync(args[0], 'utf8')) as Graph;
  if (graph.schema !== 'relater.type-graph.v11')
    throw new Error('Expected relater.type-graph.v11; re-export older graphs');
  let rounds = 1;
  let cold = false;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--cold') cold = true;
    else if (args[i] === '--rounds') {
      i++;
      if (i >= args.length) throw new Error('--rounds requires a number');
      rounds = Number(args[i]);
      if (!Number.isInteger(rounds) || rounds < 1 || rounds > 100000000) throw new Error('Invalid round count');
    } else throw new Error('Unknown option: ' + args[i]);
  }
  const checker = new Checker(graph);
  const results: boolean[] = [];
  const queries = graph.queries;
  const sources = new Uint32Array(queries.length);
  const targets = new Uint32Array(queries.length);
  for (let i = 0; i < queries.length; i++) {
    const query = queries[i];
    if (
      !Number.isInteger(query.source) ||
      !Number.isInteger(query.target) ||
      query.source < 0 ||
      query.target < 0 ||
      query.source >= checker.types.length ||
      query.target >= checker.types.length
    )
      throw new Error('Invalid query type ID');
    sources[i] = query.source;
    targets[i] = query.target;
    results.push(checker.isTypeAssignableTo(Number(query.source), Number(query.target)));
  }
  // Lazy type resolution, graph decoding, construction, and output are outside timing.
  let checksum = 0;
  const started = performance.now();
  for (let round = 0; round < rounds; round++) {
    if (cold) checker.resetRelations();
    for (let i = 0; i < sources.length; i++) {
      if (checker.isTypeAssignableTo(Number(sources[i]), Number(targets[i]))) checksum++;
    }
  }
  const elapsedMs = performance.now() - started;
  console.log(JSON.stringify({ results, elapsedMs, rounds, checks: rounds * sources.length, checksum, cold }));
}

try {
  run();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
