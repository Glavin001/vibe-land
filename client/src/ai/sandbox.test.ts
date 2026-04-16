import { describe, it, expect } from 'vitest';
import { executeUserCode, truncateForModel } from './sandbox';

describe('executeUserCode', () => {
  it('returns the value of the user code', async () => {
    const result = await executeUserCode({
      code: 'return 1 + ctx.bonus;',
      ctx: { bonus: 41 },
    });
    expect(result.ok).toBe(true);
    expect(result.returnValue).toBe(42);
    expect(result.logs).toEqual([]);
    expect(result.error).toBeUndefined();
  });

  it('captures console.log/info/warn/error in order', async () => {
    const result = await executeUserCode({
      code: `
        console.log('hello', 'world');
        console.info({ a: 1 });
        console.warn('warn-text');
        console.error('error-text');
        return null;
      `,
      ctx: {},
    });
    expect(result.ok).toBe(true);
    expect(result.logs).toEqual([
      { level: 'log', text: 'hello world' },
      { level: 'info', text: '{"a":1}' },
      { level: 'warn', text: 'warn-text' },
      { level: 'error', text: 'error-text' },
    ]);
  });

  it('catches synchronous errors and reports them with stack trace', async () => {
    const result = await executeUserCode({
      code: 'throw new Error("boom");',
      ctx: {},
    });
    expect(result.ok).toBe(false);
    expect(result.error?.name).toBe('Error');
    expect(result.error?.message).toBe('boom');
    expect(typeof result.error?.stack).toBe('string');
  });

  it('catches async/await errors', async () => {
    const result = await executeUserCode({
      code: `
        await Promise.resolve();
        throw new TypeError('async-fail');
      `,
      ctx: {},
    });
    expect(result.ok).toBe(false);
    expect(result.error?.name).toBe('TypeError');
    expect(result.error?.message).toBe('async-fail');
  });

  it('catches parse errors before execution', async () => {
    const result = await executeUserCode({
      code: 'this is ( not valid javascript',
      ctx: {},
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('lets ctx helpers be called and observes their mutations across calls', async () => {
    let counter = 0;
    const ctx = { bump: () => ({ next: ++counter }) };
    const first = await executeUserCode({
      code: 'return ctx.bump();',
      ctx,
    });
    const second = await executeUserCode({
      code: 'return ctx.bump();',
      ctx,
    });
    expect(first.returnValue).toEqual({ next: 1 });
    expect(second.returnValue).toEqual({ next: 2 });
  });
});

describe('truncateForModel', () => {
  it('passes primitives through', () => {
    expect(truncateForModel(1)).toBe(1);
    expect(truncateForModel(true)).toBe(true);
    expect(truncateForModel(null)).toBeNull();
    expect(truncateForModel('hi')).toBe('hi');
  });

  it('truncates very long strings', () => {
    const long = 'x'.repeat(2_500);
    const trimmed = truncateForModel(long);
    expect(typeof trimmed).toBe('string');
    expect((trimmed as string).startsWith('xxxx')).toBe(true);
    expect((trimmed as string)).toContain('truncated');
    expect((trimmed as string).length).toBeLessThan(long.length);
  });

  it('truncates oversized arrays with a marker', () => {
    const arr = Array.from({ length: 250 }, (_, i) => i);
    const trimmed = truncateForModel(arr) as unknown[];
    expect(trimmed.length).toBe(101);
    expect(trimmed[100]).toMatch(/truncated/);
  });

  it('replaces cycles with a marker', () => {
    const obj: Record<string, unknown> = { name: 'root' };
    obj.self = obj;
    const trimmed = truncateForModel(obj) as Record<string, unknown>;
    expect(trimmed.name).toBe('root');
    expect(trimmed.self).toBe('[Circular]');
  });

  it('honors max depth', () => {
    let nested: unknown = 'leaf';
    for (let i = 0; i < 10; i += 1) {
      nested = { next: nested };
    }
    const trimmed = JSON.stringify(truncateForModel(nested));
    expect(trimmed).toContain('truncated: max depth');
  });
});
