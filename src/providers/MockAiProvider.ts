import type { AiProvider } from './AiProvider';
import type { AiRequest, AiResponse, AiResponseDelta } from '../types/chat';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Egyszerű demo provider Ollama nélküli fejlesztéshez/teszteléshez: nem a
 * valódi minőséget szimulálja, csak visszaigazolja, hogy az üzenet célba ért.
 * Szavanként adagol, hogy a streaming UI Ollama nélkül is tesztelhető legyen.
 */
export class MockAiProvider implements AiProvider {
  readonly id = 'mock';
  readonly statusLabel = 'Demo mód';

  async sendMessage(
    request: AiRequest,
    onDelta?: (delta: AiResponseDelta) => void
  ): Promise<AiResponse> {
    const echo = request.message.trim();
    const full =
      request.language === 'en'
        ? `**Demo mode** — this is a placeholder reply. You said:\n\n> ${echo}`
        : `**Demo mód** — ez egy helyőrző válasz. Ezt írtad:\n\n> ${echo}`;

    const words = full.split(' ');
    let acc = '';
    for (let i = 0; i < words.length; i++) {
      await delay(15);
      const piece = i === 0 ? words[i] : ` ${words[i]}`;
      acc += piece;
      onDelta?.({ content: piece });
    }
    return { message: acc };
  }
}
