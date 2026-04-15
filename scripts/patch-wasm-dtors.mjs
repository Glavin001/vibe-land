#!/usr/bin/env node
// Post-processor for `wasm-pack build` output: neutralises the
// `__funcs_on_exit` and `__stdio_exit` function bodies inside
// `vibe_land_shared_bg.wasm`.
//
// Background: when the Blast C++ backend is compiled in (via the
// `blast-stress-solver` crate with the `wasi-libc` feature), the wasm
// module ends up importing a handful of `wasi_snapshot_preview1`
// syscalls.  wasm-bindgen detects those imports and wraps every
// exported helper in a "command_export" shim that invokes
// `__wasm_call_ctors` → real export → `__wasm_call_dtors`.
//
// `__wasm_call_dtors` then calls `__funcs_on_exit` and `__stdio_exit`,
// which walk wasi-libc's atexit table and close stdio handles.  That
// table is never initialised in our environment because we run the
// wasm as a library (not a wasi command), so the walk traps on the
// first call — every subsequent wbindgen helper (`__wbindgen_malloc`,
// `__wbindgen_free`, …) dies with `null function or function
// signature mismatch`.
//
// We tried to override the symbols from the Rust side (see
// `wasm_cxa_stubs.rs`) but `rust-lld` rejects duplicate strong
// definitions and `--allow-multiple-definition` emitted from a
// dependency's `build.rs` doesn't propagate to the cdylib link step.
//
// Instead, we rewrite the bytes in-place here.  Each target function
// body is overwritten with `[locals_count=0, nop * (N-2), end]` so
// the body size stays unchanged and no section offsets shift.  This
// makes `__wasm_call_dtors` a sequence of trivial no-ops — wasi-libc
// is happy, wasm-bindgen is happy, and the wbindgen helpers no
// longer trap on every call.
//
// The script is idempotent (detects already-neutralised bodies) and a
// no-op if the target functions are absent (e.g. because blast was
// disabled at build time).  Intended to run from
// `scripts/setup-blast.sh` / `make setup-wasm` right after
// `wasm-pack build`.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultWasmPath = join(
  __dirname,
  '..',
  'client',
  'src',
  'wasm',
  'pkg',
  'vibe_land_shared_bg.wasm',
);

const TARGETS = ['__funcs_on_exit', '__stdio_exit'];

const wasmPath = process.argv[2] || defaultWasmPath;

if (!existsSync(wasmPath)) {
  console.error(`[patch-wasm-dtors] wasm file not found: ${wasmPath}`);
  process.exit(1);
}

const bytes = readFileSync(wasmPath);

// ── LEB128 helpers ────────────────────────────────────────────────────
function readULEB128(buf, offset) {
  let result = 0;
  let shift = 0;
  let pos = offset;
  while (true) {
    const b = buf[pos++];
    result |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
    if (shift > 35) throw new Error('LEB128 overflow');
  }
  return { value: result >>> 0, next: pos };
}

// ── Validate magic + version ──────────────────────────────────────────
if (
  bytes[0] !== 0x00 ||
  bytes[1] !== 0x61 ||
  bytes[2] !== 0x73 ||
  bytes[3] !== 0x6d
) {
  console.error('[patch-wasm-dtors] not a wasm file (bad magic)');
  process.exit(1);
}

// ── Walk top-level sections ───────────────────────────────────────────
const sections = [];
let offset = 8;
while (offset < bytes.length) {
  const id = bytes[offset];
  const sizeStart = offset + 1;
  const { value: size, next: contentStart } = readULEB128(bytes, sizeStart);
  sections.push({ id, contentStart, contentEnd: contentStart + size });
  offset = contentStart + size;
}

// Locate Import (id=2), Code (id=10), and Name (custom, id=0).
const importSection = sections.find((s) => s.id === 2);
const codeSection = sections.find((s) => s.id === 10);
if (!codeSection) {
  console.error('[patch-wasm-dtors] wasm has no Code section');
  process.exit(1);
}

// Count imported functions (they occupy indices 0..numImportedFuncs-1).
let numImportedFuncs = 0;
if (importSection) {
  let p = importSection.contentStart;
  const { value: importCount, next } = readULEB128(bytes, p);
  p = next;
  for (let i = 0; i < importCount; i++) {
    // module name
    const mod = readULEB128(bytes, p);
    p = mod.next + mod.value;
    // field name
    const fld = readULEB128(bytes, p);
    p = fld.next + fld.value;
    // external kind
    const kind = bytes[p++];
    if (kind === 0x00) {
      // function import: type index (LEB)
      const ti = readULEB128(bytes, p);
      p = ti.next;
      numImportedFuncs++;
    } else if (kind === 0x01) {
      // table: elemtype (1) + limits
      p += 1;
      const flags = bytes[p++];
      const min = readULEB128(bytes, p);
      p = min.next;
      if (flags & 0x01) {
        const max = readULEB128(bytes, p);
        p = max.next;
      }
    } else if (kind === 0x02) {
      // memory: limits
      const flags = bytes[p++];
      const min = readULEB128(bytes, p);
      p = min.next;
      if (flags & 0x01) {
        const max = readULEB128(bytes, p);
        p = max.next;
      }
    } else if (kind === 0x03) {
      // global: valtype (1) + mut (1)
      p += 2;
    } else {
      throw new Error(`unknown import kind ${kind}`);
    }
  }
}

// ── Name section: find function subsection & resolve target indices ──
const nameSections = sections.filter((s) => s.id === 0);
let functionIndicesByName = new Map();
for (const sec of nameSections) {
  let p = sec.contentStart;
  const nameLen = readULEB128(bytes, p);
  p = nameLen.next;
  const name = bytes.slice(p, p + nameLen.value).toString('utf8');
  p += nameLen.value;
  if (name !== 'name') continue;
  while (p < sec.contentEnd) {
    const subId = bytes[p++];
    const subSize = readULEB128(bytes, p);
    p = subSize.next;
    const subEnd = p + subSize.value;
    if (subId === 1) {
      // Function names: vec<{ idx, name }>
      const count = readULEB128(bytes, p);
      p = count.next;
      for (let i = 0; i < count.value; i++) {
        const idx = readULEB128(bytes, p);
        p = idx.next;
        const n = readULEB128(bytes, p);
        p = n.next;
        const fname = bytes.slice(p, p + n.value).toString('utf8');
        p += n.value;
        functionIndicesByName.set(fname, idx.value);
      }
    }
    p = subEnd;
  }
}

if (functionIndicesByName.size === 0) {
  console.error('[patch-wasm-dtors] could not resolve function names');
  process.exit(1);
}

// ── Parse Code section to locate target bodies ────────────────────────
const codeStart = codeSection.contentStart;
const codeCountLeb = readULEB128(bytes, codeStart);
const codeCount = codeCountLeb.value;
let bodyPos = codeCountLeb.next;

// Build an index → { bodyStart, bodyEnd } map for just our targets.
const targetIndices = new Set();
for (const name of TARGETS) {
  const idx = functionIndicesByName.get(name);
  if (idx == null) {
    console.log(`[patch-wasm-dtors] ${name} not found — skipping`);
    continue;
  }
  targetIndices.add(idx);
}

if (targetIndices.size === 0) {
  console.log('[patch-wasm-dtors] no target functions present, nothing to do');
  process.exit(0);
}

const bodyRangesByFuncIdx = new Map();
for (let i = 0; i < codeCount; i++) {
  const funcIdx = numImportedFuncs + i;
  const sizeLeb = readULEB128(bytes, bodyPos);
  const bodyStart = sizeLeb.next;
  const bodyEnd = bodyStart + sizeLeb.value;
  if (targetIndices.has(funcIdx)) {
    bodyRangesByFuncIdx.set(funcIdx, { bodyStart, bodyEnd });
  }
  bodyPos = bodyEnd;
}

// ── Patch each target body in place ───────────────────────────────────
let patched = 0;
let alreadyPatched = 0;
const buf = Buffer.from(bytes); // mutable copy
for (const name of TARGETS) {
  const idx = functionIndicesByName.get(name);
  if (idx == null) continue;
  const range = bodyRangesByFuncIdx.get(idx);
  if (!range) continue;
  const { bodyStart, bodyEnd } = range;
  const len = bodyEnd - bodyStart;
  if (len < 2) {
    console.error(`[patch-wasm-dtors] ${name} body too small (${len})`);
    process.exit(1);
  }
  // Idempotency: already-neutralised body looks like [0x00, 0x01*, 0x0b].
  const alreadyNoop =
    buf[bodyStart] === 0x00 &&
    buf[bodyEnd - 1] === 0x0b &&
    (() => {
      for (let i = bodyStart + 1; i < bodyEnd - 1; i++) {
        if (buf[i] !== 0x01) return false;
      }
      return true;
    })();
  if (alreadyNoop) {
    alreadyPatched++;
    continue;
  }
  // Write neutralised body: locals_count=0, nop*(len-2), end.
  buf[bodyStart] = 0x00; // 0 local groups
  buf.fill(0x01, bodyStart + 1, bodyEnd - 1); // nop
  buf[bodyEnd - 1] = 0x0b; // end
  patched++;
  console.log(
    `[patch-wasm-dtors] neutralised ${name} (func[${idx}], ${len} bytes)`,
  );
}

if (patched === 0 && alreadyPatched > 0) {
  console.log(
    `[patch-wasm-dtors] already patched (${alreadyPatched} of ${TARGETS.length}), skipping write`,
  );
  process.exit(0);
}

if (patched === 0) {
  console.log('[patch-wasm-dtors] no matching functions found');
  process.exit(0);
}

writeFileSync(wasmPath, buf);
console.log(
  `[patch-wasm-dtors] patched ${patched} function(s) in ${wasmPath}`,
);
