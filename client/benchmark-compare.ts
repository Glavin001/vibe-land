import { readFile } from 'node:fs/promises';
import { renderSuiteComparisonMarkdown } from './src/benchmark/compare.js';
import type { BenchmarkSuiteResult } from './src/benchmark/contracts.js';

function parseArgs(argv: string[]): { baseline: string; candidate: string } {
  if (argv.length < 2) {
    throw new Error('Usage: npm run benchmark:compare -- <baseline.json> <candidate.json>');
  }
  return {
    baseline: argv[0],
    candidate: argv[1],
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const baseline = JSON.parse(await readFile(args.baseline, 'utf8')) as BenchmarkSuiteResult;
  const candidate = JSON.parse(await readFile(args.candidate, 'utf8')) as BenchmarkSuiteResult;
  process.stdout.write(`${renderSuiteComparisonMarkdown(baseline, candidate)}\n`);
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exit(1);
});
