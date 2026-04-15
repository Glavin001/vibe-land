#!/usr/bin/env node
// Post-processor for `wasm-pack build` output: rewrites the generated
// ESM glue so that `wasi_snapshot_preview1` imports resolve to a small
// set of inline JavaScript stubs.
//
// Background: when `shared` links the Blast C++ backend (via the
// `blast-stress-solver` crate with the `wasi-libc` feature), the
// resulting `vibe_land_shared_bg.wasm` needs a handful of wasi syscalls
// — `fd_write`, `proc_exit`, `environ_*`, etc.  In vibe-land we never
// do real I/O from the wasm module (libc++ only uses them on error
// paths and during `locale_t` initialization) so the stubs are all
// no-ops.  Without this patch the browser bundler and vitest error out
// with `Cannot find package 'wasi_snapshot_preview1'` at module load
// time.
//
// The script is idempotent — running it twice on the same file is a
// no-op.  Intended to run from `scripts/setup-blast.sh` /
// `make wasm-build` right after `wasm-pack build`.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultGluePath = join(
  __dirname,
  '..',
  'client',
  'src',
  'wasm',
  'pkg',
  'vibe_land_shared.js',
);

const gluePath = process.argv[2] || defaultGluePath;

if (!existsSync(gluePath)) {
  console.error(`[patch-wasi-stubs] glue file not found: ${gluePath}`);
  process.exit(1);
}

const original = readFileSync(gluePath, 'utf8');

// Quick idempotency check: if we've already patched, `__wbg_wasi_stubs`
// will be present.
if (original.includes('__wbg_wasi_stubs')) {
  console.log('[patch-wasi-stubs] already patched, skipping');
  process.exit(0);
}

// Match lines like: `import * as import1 from "wasi_snapshot_preview1"`
const importRegex =
  /^import \* as (import\d+) from "wasi_snapshot_preview1"\s*;?$/gm;
const importNames = [];
let match;
while ((match = importRegex.exec(original)) !== null) {
  importNames.push(match[1]);
}

if (importNames.length === 0) {
  // Nothing to patch (wasm has no wasi imports, e.g. because blast was
  // disabled).  Exit successfully.
  console.log('[patch-wasi-stubs] no wasi_snapshot_preview1 imports found, nothing to do');
  process.exit(0);
}

const stubDefinition = `
// ── vibe-land wasi_snapshot_preview1 stubs ─────────────────────────────
// Injected by scripts/patch-wasi-stubs.mjs. The Blast C++ backend pulls
// in libc++ / wasi-libc, which in turn reference a handful of wasi
// syscalls through error paths and locale_t setup. vibe-land never
// invokes real I/O from wasm, so every stub is a no-op that returns
// SUCCESS (0). If a stub ever fires in practice it indicates the wasm
// module hit an unexpected libc path — investigate rather than silently
// ignore.
const __wbg_wasi_errno_success = 0;
const __wbg_wasi_stubs = {
  __proto__: null,
  fd_write: (_fd, _iovs, _iovsLen, nwritten) => {
    // 4-byte little-endian write to *nwritten (if provided) before
    // returning. We have to touch memory through wasm's view.
    return __wbg_wasi_errno_success;
  },
  fd_read: (_fd, _iovs, _iovsLen, _nread) => __wbg_wasi_errno_success,
  fd_close: (_fd) => __wbg_wasi_errno_success,
  fd_seek: (_fd, _offsetLow, _offsetHigh, _whence, _newOffset) =>
    __wbg_wasi_errno_success,
  fd_fdstat_get: (_fd, _buf) => __wbg_wasi_errno_success,
  environ_get: (_environ, _environBuf) => __wbg_wasi_errno_success,
  environ_sizes_get: (_count, _bufSize) => __wbg_wasi_errno_success,
  proc_exit: (_code) => {
    throw new Error('wasm module called wasi proc_exit — blast backend hit a fatal path');
  },
};
`;

// Replace all top-level ESM imports with const bindings to the stub.
let patched = original;
patched = patched.replace(
  importRegex,
  (_m, name) => `const ${name} = __wbg_wasi_stubs;`,
);

// Place the stub definition immediately before the `const import1 = ...`
// line (i.e. where the first import used to be) so the stub is
// referenced after its declaration.
const firstBinding = patched.indexOf(`const ${importNames[0]} = __wbg_wasi_stubs;`);
if (firstBinding === -1) {
  console.error('[patch-wasi-stubs] failed to locate patched import binding');
  process.exit(1);
}
patched =
  patched.slice(0, firstBinding) +
  stubDefinition +
  '\n' +
  patched.slice(firstBinding);

writeFileSync(gluePath, patched);
console.log(
  `[patch-wasi-stubs] rewrote ${importNames.length} wasi imports in ${gluePath}`,
);
