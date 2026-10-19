import type { ChatMessage } from '../types/chat';
import { formatTime } from './formatting';

type Lang = 'hu' | 'en';

const ROLE: Record<Lang, { user: string; assistant: string; title: string }> = {
  hu: { user: 'Felhasználó', assistant: 'Vellum', title: 'Vellum — beszélgetés' },
  en: { user: 'User', assistant: 'Vellum', title: 'Vellum — conversation' }
};

/** A beszélgetést Markdown szöveggé alakítja (vágólapra másoláshoz). */
export function conversationToMarkdown(messages: ChatMessage[], lang: Lang): string {
  const L = ROLE[lang];
  const lines = [`# ${L.title}`, ''];
  for (const m of messages) {
    const who = m.role === 'user' ? L.user : L.assistant;
    lines.push(`**${who}** (${formatTime(m.timestamp)}):`);
    lines.push(m.content || '');
    lines.push('');
  }
  return lines.join('\n');
}
