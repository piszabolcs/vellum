import { describe, expect, it } from 'vitest';
import { MockAiProvider } from './MockAiProvider';
import type { AiRequest } from '../types/chat';

const provider = new MockAiProvider();

function req(partial: Partial<AiRequest>): AiRequest {
  return { conversationId: 'c1', language: 'hu', message: '', history: [], ...partial };
}

describe('MockAiProvider', () => {
  it('csak { message }-t ad vissza (pass-through)', async () => {
    const res = await provider.sendMessage(req({ message: 'szia' }));
    expect(typeof res.message).toBe('string');
  });

  it('visszaechózza a beküldött üzenetet magyarul', async () => {
    const res = await provider.sendMessage(req({ language: 'hu', message: 'teszt üzenet' }));
    expect(res.message).toContain('Demo mód');
    expect(res.message).toContain('teszt üzenet');
  });

  it('angol nyelven angol demo szöveget ad', async () => {
    const res = await provider.sendMessage(req({ language: 'en', message: 'hello' }));
    expect(res.message).toContain('Demo mode');
    expect(res.message).toContain('hello');
  });

  it('az onDelta hívások összefűzve kiadják a végleges üzenetet', async () => {
    const deltas: string[] = [];
    const res = await provider.sendMessage(req({ language: 'hu', message: 'teszt' }), (delta) => {
      if (delta.content) deltas.push(delta.content);
    });
    expect(deltas.join('')).toBe(res.message);
    expect(deltas.length).toBeGreaterThan(1);
  });
});
