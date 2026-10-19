import { create } from 'zustand';
import type { AiRequest, ChatMessage } from '../types/chat';
import type { RouterDecision, SourceRef, ToolCallRecord, ToolConfirmRequest } from '../types/bridge';
import type { AppSettings } from '../types/settings';
import { getProvider } from '../providers';
import { generateId } from '../utils/formatting';
import { loadConversation, saveConversation } from '../utils/persistence';
import { computeTimings, type TimingMarks } from '../utils/timing';
import { contextUsage } from '../utils/contextUsage';
import { notifyConversationsChanged } from './conversationsBus';
import { translate } from '../i18n';

/** Maps the stored `meta_json` back onto a chat message (sources, tool cards, stats). */
export function metaToMessageFields(meta: unknown): Partial<ChatMessage> {
  if (!meta || typeof meta !== 'object') return {};
  const m = meta as {
    toolCalls?: ToolCallRecord[];
    sources?: SourceRef[];
    routerDecision?: RouterDecision;
    stats?: { promptTokens: number; responseTokens: number; tokensPerSecond: number };
  };
  return {
    toolCalls: Array.isArray(m.toolCalls) ? m.toolCalls : undefined,
    sources: Array.isArray(m.sources) ? m.sources : undefined,
    routerDecision: m.routerDecision ?? undefined,
    stats: m.stats
      ? {
          promptTokens: m.stats.promptTokens,
          evalTokens: m.stats.responseTokens,
          tokensPerSecond: m.stats.tokensPerSecond
        }
      : undefined
  };
}

interface ChatState {
  conversationId: string;
  messages: ChatMessage[];
  sending: boolean;
  /**
   * F6: ha a modell destruktiv eszkozt hivott, itt var a kerdes. Amig ez nem
   * null, a valasz generalasa all -- a main oldalon egy nyitott igeret var rank.
   */
  pendingConfirm: ToolConfirmRequest | null;
  /** a megerosito kartya valasza */
  decideConfirm: (approved: boolean) => void;
  /** F5: a compaction osszefoglaloja, ha volt. A prompt elejere kerul. */
  summary?: string;
  sendMessage: (params: { text: string; settings: AppSettings; isRetry?: boolean }) => Promise<void>;
  /** Re-sends the user message that ended in an error bubble. */
  retryLast: (settings: AppSettings) => Promise<void>;
  clearConversation: () => Promise<void>;
  restore: () => Promise<void>;
  loadConversationById: (id: string) => Promise<void>;
}

function persist(get: () => ChatState): void {
  const { conversationId, messages } = get();
  saveConversation({ conversationId, messages });
}

export const useChatStore = create<ChatState>((set, get) => {
  function patchMessage(
    id: string,
    patch: Partial<ChatMessage> | ((m: ChatMessage) => Partial<ChatMessage>)
  ): void {
    set((state) => ({
      messages: state.messages.map((m) =>
        m.id === id ? { ...m, ...(typeof patch === 'function' ? patch(m) : patch) } : m
      )
    }));
  }

  /**
   * Elmenti az uzenetet az adatbazisba, es sorba allitja indexelesre.
   *
   * Csendben elbukik, ha nincs adatbazis (pl. a nativ modul nem fordult le) --
   * a chatnek e nelkul is mukodnie kell.
   */
  async function storeMessage(
    conversationId: string,
    role: 'user' | 'assistant',
    content: string,
    extra?: { thinking?: string | null; isError?: boolean; meta?: unknown }
  ): Promise<void> {
    const bridge = window.companion;
    if (!bridge || !content.trim()) return;
    try {
      const stored = await bridge.conversations.appendMessage({
        conversationId,
        role,
        content,
        thinking: extra?.thinking ?? null,
        isError: extra?.isError,
        meta: extra?.meta
      });
      // a hibauzeneteket NEM indexeljuk: nem a beszelgetes tartalma
      if (stored && !extra?.isError) {
        await bridge.index.enqueue(stored.id, conversationId, content, role);
      }
    } catch (error) {
      // the chat keeps working without the archive; the main process has
      // already shown a notice about the failed write
      console.warn('[vellum] message not archived:', error);
    }
  }

  // F6: a main innentol megkerdezhet minket destruktiv eszkozhivas elott.
  // Bongeszos dev modban nincs hid, ilyenkor ez egyszeruen nem fut le.
  window.companion?.onToolConfirmRequest((request) => set({ pendingConfirm: request }));

  return {
    conversationId: generateId('conv'),
    messages: [],
    sending: false,
    summary: undefined,
    pendingConfirm: null,

    decideConfirm: (approved: boolean) => {
      const request = get().pendingConfirm;
      if (!request) return;
      set({ pendingConfirm: null });
      window.companion?.confirmTool(request.callId, approved);
    },

    sendMessage: async ({ text, settings, isRetry }) => {
      if (get().sending) return;
      const trimmed = text.trim();
      if (!trimmed) return;

      // A history-t a user uzenet HOZZAADASA ELOTT mentjuk le, kulonben a
      // providernek kuldott history az aktualis uzenetet is tartalmazna duplan.
      // A hibabuborekok (pl. idotullepes) nem a modell szavai - ha bemennenek a
      // kontextusba, a modell rajuk reagalna ("nem fut az Ollama").
      const history = get().messages.filter((m) => !m.error);

      const userMessage: ChatMessage = {
        id: generateId('msg'),
        role: 'user',
        content: trimmed,
        timestamp: Date.now()
      };

      // Az ures placeholder azonnal bekerul a listaba; a streamelt darabok
      // ezt toltik fel eloben.
      const assistantId = generateId('msg');
      const placeholder: ChatMessage = {
        id: assistantId,
        role: 'assistant',
        content: '',
        thinking: '',
        streaming: true,
        timestamp: Date.now()
      };

      set((state) => ({
        messages: [...state.messages, userMessage, placeholder],
        sending: true
      }));

      const conversationId = get().conversationId;
      // a retried message is already in the archive
      if (!isRetry) {
        void storeMessage(conversationId, 'user', trimmed).then(() => {
          // the first message creates the conversation row: refresh the list
          if (history.length === 0) notifyConversationsChanged();
        });
      }

      const request: AiRequest = {
        conversationId,
        language: settings.language,
        message: trimmed,
        history,
        summary: get().summary
      };

      // A gondolkodasi/valaszido meresehez rogzitjuk, mikor erkezett az elso
      // gondolkodas-darab es az elso valodi valasz-tartalom darab.
      const marks: TimingMarks = { start: Date.now(), end: Date.now() };

      try {
        const provider = getProvider(settings);
        const response = await provider.sendMessage(request, (delta) => {
          if (delta.thinking && marks.firstThinking === undefined) {
            marks.firstThinking = Date.now();
          }
          if (delta.content && marks.firstContent === undefined) {
            marks.firstContent = Date.now();
          }

          patchMessage(assistantId, (m) => ({
            content: m.content + (delta.content ?? ''),
            thinking: (m.thinking ?? '') + (delta.thinking ?? ''),
            searches: delta.searchQuery ? [...(m.searches ?? []), delta.searchQuery] : m.searches,
            loadedSkills: delta.skillLoaded
              ? [...(m.loadedSkills ?? []), delta.skillLoaded]
              : m.loadedSkills,
            routerDecision: delta.routerDecision ?? m.routerDecision
          }));
        });
        marks.end = Date.now();

        // A vegleges valaszt a provider adja (nem a delta-akkumulacio), igy
        // egy kimaradt chunk sem ronthatja el a megmarado szoveget.
        patchMessage(assistantId, {
          content: response.message,
          thinking: response.thinking,
          stats: response.stats,
          searches: response.searches,
          contextFallback: response.contextFallback,
          toolCalls: response.toolCalls,
          sources: response.sources,
          routerDecision: response.routerDecision,
          selfConsistency: response.selfConsistency,
          timings: computeTimings(marks),
          streaming: false
        });
        set({ sending: false });
        persist(get);

        void storeMessage(conversationId, 'assistant', response.message, {
          thinking: response.thinking ?? null,
          meta: {
            toolCalls: response.toolCalls,
            sources: response.sources,
            routerDecision: response.routerDecision as RouterDecision | undefined,
            stats: response.stats
              ? {
                  promptTokens: response.stats.promptTokens,
                  responseTokens: response.stats.evalTokens,
                  tokensPerSecond: response.stats.tokensPerSecond
                }
              : undefined
          }
        });

        // --- F4: cimadas ---
        // Az elso valasz utan kap cimet a beszelgetes. A generateTitle magatol
        // kihagyja azt, aminek mar van cime, igy ezt minden korben hivhatjuk.
        // Szandekosan nem varunk ra: a valasz mar a kepernyon van, a cim
        // pedig csak a listaban szamit.
        void window.companion?.conversations
          .generateTitle(conversationId)
          .then((result) => {
            if (result?.ok) notifyConversationsChanged();
          })
          .catch(() => {
            /* cim nelkul is hasznalhato a lista */
          });

        // --- F5: compaction, ha megtelt a kontextus ---
        // Az OFFLOAD (artifact) mar a tool-retegben megtortent, ez a masodik
        // lepcso: a beszelgetes regebbi resze strukturalt osszefoglaloba kerul.
        // Az eredeti uzenetek NEM tunnek el az adatbazisbol.
        if (settings.compactionEnabled) {
          const usage = contextUsage(get().messages, settings.ollamaContextSize, get().summary);
          if (usage.ratio >= settings.compactionThreshold) {
            const result = await window.companion?.compaction
              .run(conversationId)
              .catch(() => null);
            if (result?.ok && result.summaryText) {
              set({ summary: result.summaryText });
            }
          }
        }
      } catch (err) {
        // Hibanal a reszleges szoveget eldobjuk - ne tunjon kesz valasznak.
        patchMessage(assistantId, {
          content:
            err instanceof Error && err.message
              ? err.message
              : translate(settings.language, 'chat.connectionError'),
          thinking: undefined,
          error: true,
          streaming: false
        });
        // ha epp kerdes volt a kepernyon, az mar targytalan: a valasz elszallt
        set({ sending: false, pendingConfirm: null });
        persist(get);
      }
    },

    retryLast: async (settings) => {
      const messages = get().messages;
      const failed = messages[messages.length - 1];
      const question = messages[messages.length - 2];
      if (get().sending || !failed?.error || question?.role !== 'user') return;
      set({ messages: messages.slice(0, -2) });
      await get().sendMessage({ text: question.content, settings, isRetry: true });
    },

    clearConversation: async () => {
      // az uj beszelgetes az adatbazisban is uj sor lesz, hogy visszakereshetо legyen
      const created = await window.companion?.conversations.create().catch(() => null);
      set({
        conversationId: created?.id ?? generateId('conv'),
        messages: [],
        sending: false,
        summary: undefined
      });
      persist(get);
      notifyConversationsChanged();
    },

    restore: async () => {
      const saved = loadConversation();
      if (saved && saved.messages.length > 0) {
        set({ conversationId: saved.conversationId, messages: saved.messages });
        return;
      }
      // ha nincs localStorage-ban semmi, az adatbazisbol hozzuk a legutolsot
      try {
        const list = await window.companion?.conversations.list({ limit: 1 });
        if (list && list.length > 0) {
          await get().loadConversationById(list[0].id);
        }
      } catch {
        // nincs adatbazis -> ures beszelgetessel indulunk
      }
    },

    loadConversationById: async (id: string) => {
      const bridge = window.companion;
      if (!bridge) return;
      try {
        const [conversation, stored] = await Promise.all([
          bridge.conversations.get(id),
          bridge.conversations.messages(id)
        ]);
        const messages: ChatMessage[] = stored
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .map((m) => ({
            id: m.id,
            role: m.role as 'user' | 'assistant',
            content: m.content,
            thinking: m.thinking ?? undefined,
            timestamp: m.createdAt,
            error: m.isError,
            ...metaToMessageFields(m.meta)
          }));
        set({
          conversationId: id,
          messages,
          summary: conversation?.summary ?? undefined,
          sending: false
        });
        persist(get);
      } catch {
        // ha nem sikerul, a jelenlegi beszelgetes marad
      }
    }
  };
});
