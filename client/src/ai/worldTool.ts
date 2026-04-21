import { tool } from 'ai';
import { z } from 'zod';
import { executeUserCode, type SandboxResult } from './sandbox';
import { buildWorldCtx, type WorldAccessors } from './worldToolHelpers';
import { cloneWorldDocument } from '../world/worldDocument';
import { generateCommitId } from '../pages/godModeHistory';

export type ToolRuntimeOptions = {
  toolCallId?: string;
  messages?: unknown[];
  abortSignal?: AbortSignal;
};

export const executeJsInputSchema = z.object({
  code: z
    .string()
    .min(1)
    .describe(
      'Async JavaScript snippet BODY to run in the user\'s browser. Do NOT provide `async (ctx, console) => { ... }` or any other wrapper function; the runner already wraps your code. Write only the statements that go inside that function body, for example: `const info = ctx.getTerrainInfo(); return info;`. The runner exposes a `ctx` object with helpers for reading and mutating the world (see system prompt) and a captured `console`. Use `return ...` to send a value back to yourself. Each call gets a fresh ctx but mutations persist across calls.',
    ),
  commitMessage: z
    .string()
    .min(1)
    .max(120)
    .describe(
      'Short description of what this code does, like a git commit message (e.g. "Flatten area for lake bed", "Add 3 pine trees along ridge"). Shown to the user in the commit history.',
    ),
});

export type ExecuteJsInput = z.infer<typeof executeJsInputSchema>;

export type ExecuteJsResult = SandboxResult & { commitId?: string };

export const executeJsToolDescription =
  'Run JavaScript in the browser to inspect or edit the live World document. IMPORTANT: the `code` input must be only the BODY of the wrapped async function, not a full function like `async (ctx, console) => { ... }`. The runner already provides the wrapper and passes in `ctx` and `console`. Example valid code: `const info = ctx.getTerrainInfo(); return info;`. Use `ctx.*` helpers (getWorld, listStaticProps, addStaticCuboid, applyTerrainBrush, etc.) to read state or push edits. The result echoes your `return` value, captured console logs, any thrown error, and a `commitId` if edits were made.';

export async function executeJsToolExecute(
  accessors: WorldAccessors,
  input: ExecuteJsInput,
  _options?: ToolRuntimeOptions,
): Promise<ExecuteJsResult> {
  // 1. Snapshot world before execution
  const snapshotBefore = cloneWorldDocument(accessors.getWorld());

  // 2. Track edits — writes apply to world state without creating
  //    individual history entries. We commit once at the end.
  let editCount = 0;
  const wrappedAccessors: WorldAccessors = {
    ...accessors,
    commitEdit: (updater) => {
      const result = accessors.applyWithoutCommit(updater);
      if (result) editCount++;
      return result;
    },
  };

  // 3. Build ctx and execute
  const ctx = buildWorldCtx(wrappedAccessors);
  const result = await executeUserCode({
    code: input.code,
    ctx: ctx as unknown as Record<string, unknown>,
  });

  // 4. If error, restore snapshot — no edits saved
  if (!result.ok) {
    if (editCount > 0) {
      accessors.restoreWorld(snapshotBefore);
    }
    return result;
  }

  // 5. If success and edits were made, commit as a single entry
  if (editCount > 0) {
    const commitId = generateCommitId();
    accessors.commitAsAi(snapshotBefore, commitId, input.commitMessage);
    return { ...result, commitId };
  }

  return result;
}

export function createExecuteJsTool(accessors: WorldAccessors) {
  return tool({
    description: executeJsToolDescription,
    inputSchema: executeJsInputSchema,
    async execute(input, options): Promise<ExecuteJsResult> {
      return executeJsToolExecute(accessors, input, options);
    },
  });
}

// ---- Rollback Tool ----

export const rollbackInputSchema = z.object({
  commitId: z
    .string()
    .min(1)
    .describe('The commit ID to roll back to. The world will be restored to its state before that commit was applied.'),
});

export type RollbackInput = z.infer<typeof rollbackInputSchema>;
export type RollbackResult = { ok: boolean; message: string; commitId?: string };
export const rollbackToolDescription =
  'Roll back the world to the state before a given commit. The rollback itself becomes a new commit and can be undone. Use this to revert a previous edit by its commit ID.';

export async function rollbackToolExecute(
  accessors: WorldAccessors,
  input: RollbackInput,
  _options?: ToolRuntimeOptions,
): Promise<RollbackResult> {
  return accessors.rollbackToCommit(input.commitId);
}

export function createRollbackTool(accessors: WorldAccessors) {
  return tool({
    description: rollbackToolDescription,
    inputSchema: rollbackInputSchema,
    async execute(input, options): Promise<RollbackResult> {
      return rollbackToolExecute(accessors, input, options);
    },
  });
}
