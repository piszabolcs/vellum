import type { AiRequest, AiResponse, AiResponseDelta } from '../types/chat';

export interface AiProvider {
  readonly id: string;
  /** Emberi olvasható státusz a footerhez, pl. "Demo mód". */
  readonly statusLabel: string;
  /**
   * Elküldi az üzenetet. Ha `onDelta` meg van adva, a provider streamel:
   * a részleteket darabonként visszahívja, a végleges (mérvadó) választ pedig
   * a promise adja vissza.
   */
  sendMessage(request: AiRequest, onDelta?: (delta: AiResponseDelta) => void): Promise<AiResponse>;
}

export type { AiRequest, AiResponse, AiResponseDelta };
