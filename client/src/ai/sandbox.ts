/**
 * Tiny in-process JS code runner for the AI's `execute_js` tool.
 *
 * SECURITY NOTE: This is **not** a real sandbox. It executes the provided code
 * in the same realm as the rest of the page (no iframe, no Worker, no isolated
 * realm). The trust model is: the user pasted their own provider API key into
 * their own browser to chat with their own AI. Any code that runs originated
 * from a model the user explicitly chose. Treat this the same as a developer
 * console — powerful, and the user is responsible for what they ask the model
 * to do.
 */

export type LogLevel = 'log' | 'info' | 'warn' | 'error';
export type LogEntry = { level: LogLevel; text: string };

export type SandboxResult = {
  ok: boolean;
  returnValue?: unknown;
  logs: LogEntry[];
  error?: { name: string; message: string; stack?: string };
};

const MAX_STRING_LENGTH = 2_000;
const MAX_ARRAY_LENGTH = 100;
const MAX_DEPTH = 6;

export async function executeUserCode(options: {
  code: string;
  ctx: Record<string, unknown>;
}): Promise<SandboxResult> {
  const { code, ctx } = options;
  const logs: LogEntry[] = [];

  const capturedConsole = {
    log: (...args: unknown[]) => logs.push({ level: 'log', text: formatArgs(args) }),
    info: (...args: unknown[]) => logs.push({ level: 'info', text: formatArgs(args) }),
    warn: (...args: unknown[]) => logs.push({ level: 'warn', text: formatArgs(args) }),
    error: (...args: unknown[]) => logs.push({ level: 'error', text: formatArgs(args) }),
  };

  let runner: (ctx: unknown, console: unknown) => unknown;
  try {
    // The wrapping IIFE lets the user's code use `await` and `return` directly.
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    runner = new Function(
      'ctx',
      'console',
      `"use strict";\nreturn (async () => {\n${code}\n})();`,
    ) as (ctx: unknown, console: unknown) => unknown;
  } catch (parseError) {
    return {
      ok: false,
      logs,
      error: normalizeError(parseError),
    };
  }

  try {
    const rawValue = await Promise.resolve(runner(ctx, capturedConsole));
    return {
      ok: true,
      returnValue: truncateForModel(rawValue),
      logs,
    };
  } catch (runError) {
    return {
      ok: false,
      logs,
      error: normalizeError(runError),
    };
  }
}

function formatArgs(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === 'string') return arg;
      if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(' ');
}

function normalizeError(err: unknown): { name: string; message: string; stack?: string } {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack };
  }
  return { name: 'Error', message: String(err) };
}

/**
 * Walk the value and trim oversized arrays/strings so the model's tool result
 * stays within a reasonable token budget. Cycles are replaced with a marker.
 */
export function truncateForModel(value: unknown): unknown {
  const seen = new WeakSet<object>();

  function walk(node: unknown, depth: number): unknown {
    if (node === null) return null;
    if (typeof node === 'undefined') return undefined;
    if (typeof node === 'string') {
      return node.length > MAX_STRING_LENGTH
        ? `${node.slice(0, MAX_STRING_LENGTH)}…[truncated ${node.length - MAX_STRING_LENGTH} chars]`
        : node;
    }
    if (typeof node === 'number' || typeof node === 'boolean') return node;
    if (typeof node === 'bigint') return node.toString();
    if (typeof node === 'symbol') return node.toString();
    if (typeof node === 'function') return `[Function ${node.name || 'anonymous'}]`;
    if (depth >= MAX_DEPTH) return '[truncated: max depth]';
    if (typeof node !== 'object') return String(node);

    if (seen.has(node as object)) return '[Circular]';
    seen.add(node as object);

    if (Array.isArray(node)) {
      if (node.length > MAX_ARRAY_LENGTH) {
        const head = node.slice(0, MAX_ARRAY_LENGTH).map((item) => walk(item, depth + 1));
        head.push(`…[truncated ${node.length - MAX_ARRAY_LENGTH} items]`);
        return head;
      }
      return node.map((item) => walk(item, depth + 1));
    }
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(node as Record<string, unknown>)) {
      out[key] = walk(val, depth + 1);
    }
    return out;
  }

  return walk(value, 0);
}
