import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createLoopState, executeToolCall } from './guard';
import { clearRegistry, registerTool } from './registry';

const ctx = {
  conversationId: null,
  settings: { filesRootPath: '', ollamaHost: 'http://localhost:11434', webSearchEnabled: true },
};

function registerTestTool(execute: () => Promise<{ ok: boolean; forModel: string; durationMs: number }>) {
  registerTool({
    name: 'probe',
    category: 'compute',
    shortDescription: 'test',
    description: 'test tool',
    schema: z.object({ n: z.number() }),
    jsonSchema: { type: 'object', properties: { n: { type: 'number' } } },
    destructive: false,
    needsNetwork: false,
    maxCallsPerTurn: 3,
    priority: 50,
    execute,
  });
}

afterEach(() => clearRegistry());

describe('executeToolCall', () => {
  it('answers a schema violation with a targeted nudge instead of running the tool', async () => {
    let runs = 0;
    registerTestTool(async () => {
      runs += 1;
      return { ok: true, forModel: 'ok', durationMs: 1 };
    });

    const outcome = await executeToolCall('probe', { n: 'seven' }, { state: createLoopState(), ctx });

    expect(outcome.kind).toBe('nudge');
    expect(runs).toBe(0);
  });

  it('stops waiting for a tool that exceeds its deadline', async () => {
    registerTestTool(() => new Promise(() => undefined));

    const outcome = await executeToolCall(
      'probe',
      { n: 1 },
      { state: createLoopState(), ctx, config: { toolTimeoutMs: 20 } },
    );

    expect(outcome.kind).toBe('nudge');
    expect(outcome.kind === 'nudge' && outcome.message).toMatch(/időtúllépés/);
  });

  it('serves a repeated identical call from the cache', async () => {
    let runs = 0;
    registerTestTool(async () => {
      runs += 1;
      return { ok: true, forModel: 'result', durationMs: 1 };
    });
    const state = createLoopState();

    await executeToolCall('probe', { n: 2 }, { state, ctx });
    const second = await executeToolCall('probe', { n: 2 }, { state, ctx });

    expect(runs).toBe(1);
    expect(second.kind).toBe('ok');
  });
});
