#!/usr/bin/env node
/**
 * Generates client/src/net/sharedConstants.ts from shared/src/constants.rs.
 *
 * Run: node scripts/gen-constants.mjs
 *
 * Parses `pub const NAME: TYPE = EXPR;` lines from the Rust source and emits
 * equivalent TypeScript `export const` declarations.  Comments are preserved.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RUST_PATH = join(ROOT, 'shared', 'src', 'constants.rs');
const TS_PATH = join(ROOT, 'client', 'src', 'net', 'sharedConstants.ts');

const rustSource = readFileSync(RUST_PATH, 'utf-8');
const lines = rustSource.split('\n');

const output = [
  '// AUTO-GENERATED from shared/src/constants.rs — do not edit manually.',
  '// Regenerate with: node scripts/gen-constants.mjs',
  '',
];

for (const line of lines) {
  const trimmed = line.trim();

  // Preserve comment lines
  if (/^\/\//.test(trimmed)) {
    output.push(trimmed);
    continue;
  }

  // Parse: pub const NAME: TYPE = EXPR;
  const m = trimmed.match(
    /^pub\s+const\s+(\w+)\s*:\s*\w+\s*=\s*(.+?)\s*;\s*$/,
  );
  if (m) {
    const [, name, expr] = m;
    // Convert Rust integer suffixes and underscores for TS compatibility
    let tsExpr = expr
      .replace(/_f32|_f64|_u8|_u16|_u32|_i8|_i16|_i32/g, '') // strip type suffixes
      .replace(/(\d)_(\d)/g, '$1$2'); // strip digit grouping underscores
    output.push(`export const ${name} = ${tsExpr};`);
    continue;
  }

  // Preserve blank lines
  if (trimmed === '') {
    output.push('');
    continue;
  }
}

// Remove trailing blank lines, add final newline
while (output.length > 0 && output[output.length - 1] === '') {
  output.pop();
}
output.push('');

writeFileSync(TS_PATH, output.join('\n'), 'utf-8');
console.log(`Generated ${TS_PATH}`);
