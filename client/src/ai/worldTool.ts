import { tool } from 'ai';
import { z } from 'zod';
import { executeUserCode, type SandboxResult } from './sandbox';
import { buildWorldCtx, type WorldAccessors } from './worldToolHelpers';

const inputSchema = z.object({
  code: z
    .string()
    .min(1)
    .describe(
      'Async JavaScript snippet to run in the user\'s browser. The runner exposes a `ctx` object with helpers for reading and mutating the world (see system prompt) and a captured `console`. Use `return ...` to send a value back to yourself. Each call gets a fresh ctx but mutations persist across calls.',
    ),
});

export type ExecuteJsInput = z.infer<typeof inputSchema>;

export function createExecuteJsTool(accessors: WorldAccessors) {
  return tool({
    description:
      'Run JavaScript in the browser to inspect or edit the live World document. The wrapped function signature is `async (ctx, console) => { ... }`. Use `ctx.*` helpers (getWorld, listStaticProps, addStaticCuboid, applyTerrainBrush, etc.) to read state or push edits. The result echoes your `return` value, captured console logs, and any thrown error so you can iterate.',
    inputSchema,
    async execute(input): Promise<SandboxResult> {
      const ctx = buildWorldCtx(accessors);
      return executeUserCode({
        code: input.code,
        ctx: ctx as unknown as Record<string, unknown>,
      });
    },
  });
}
