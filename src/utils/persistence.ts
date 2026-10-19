import type { ChatMessage } from '../types/chat';

const KEY = 'vellum-conversation-v1';

export interface PersistedConversation {
  conversationId: string;
  messages: ChatMessage[];
}

export function saveConversation(data: PersistedConversation): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch {
    /* kvóta / privát mód – csendben kihagyjuk */
  }
}

export function loadConversation(): PersistedConversation | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as PersistedConversation) : null;
  } catch {
    return null;
  }
}

export function clearPersistedConversation(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nincs teendő */
  }
}
