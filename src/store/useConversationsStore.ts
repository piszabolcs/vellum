import { create } from 'zustand';
import type { Conversation, ConversationSearchResult } from '../types/bridge';
import { useChatStore } from './useChatStore';
import { notifyConversationsChanged } from './conversationsBus';

/**
 * A beszelgetes-lista allapota (F4).
 *
 * Szandekosan kulon all a chat store-tol: az a FUTO beszelgetesrol szol
 * (uzenetek, streamelés), ez pedig az elozmenyrol. Igy a ConversationList
 * komponens vekony marad, es a lista logikaja a UI nelkul is tesztelheto.
 */
interface ConversationsState {
  items: Conversation[];
  loading: boolean;
  showArchived: boolean;
  /** keresesi talalatok; null = nincs aktiv kereses, a teljes lista latszik */
  results: ConversationSearchResult[] | null;
  query: string;

  refresh: () => Promise<void>;
  setShowArchived: (value: boolean) => Promise<void>;
  search: (query: string) => Promise<void>;
  select: (id: string) => Promise<void>;
  rename: (id: string, title: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  archive: (id: string, archived: boolean) => Promise<void>;
  exportMarkdown: (id: string) => Promise<string | null>;
  fork: (sourceId: string, uptoMessageId?: string) => Promise<void>;
}

/** ennel rovidebb keresokifejezesre nem inditunk keresest */
const MIN_QUERY_LENGTH = 2;

export const useConversationsStore = create<ConversationsState>((set, get) => ({
  items: [],
  loading: false,
  showArchived: false,
  results: null,
  query: '',

  refresh: async () => {
    const bridge = window.companion;
    if (!bridge) return;

    set({ loading: true });

    try {
      const items = await bridge.conversations.list({
        limit: 200,
        includeArchived: get().showArchived
      });
      set({ items, loading: false });
    } catch {
      // adatbazis nelkul a lista ures marad, a chat viszont megy tovabb
      set({ items: [], loading: false });
    }
  },

  setShowArchived: async (value: boolean) => {
    set({ showArchived: value });
    await get().refresh();
  },

  search: async (query: string) => {
    const bridge = window.companion;
    set({ query });

    if (!bridge || query.trim().length < MIN_QUERY_LENGTH) {
      set({ results: null });
      return;
    }

    try {
      const results = await bridge.conversations.search(query.trim(), 30);
      set({ results });
    } catch {
      set({ results: null });
    }
  },

  select: async (id: string) => {
    if (id === useChatStore.getState().conversationId) return;
    await useChatStore.getState().loadConversationById(id);
  },

  rename: async (id: string, title: string) => {
    const trimmed = title.trim();
    if (trimmed.length === 0) return;

    await window.companion?.conversations.rename(id, trimmed).catch(() => false);
    await get().refresh();
  },

  remove: async (id: string) => {
    await window.companion?.conversations.remove(id).catch(() => false);

    // ha epp azt toroltuk, amiben allunk, nyitunk egy uresat -- kulonben a
    // chat egy mar nem letezo beszelgetesbe irna tovabb az uzeneteket
    if (id === useChatStore.getState().conversationId) {
      await useChatStore.getState().clearConversation();
    }

    await get().refresh();
  },

  archive: async (id: string, archived: boolean) => {
    await window.companion?.conversations.archive(id, archived).catch(() => false);
    await get().refresh();
  },

  exportMarkdown: async (id: string) => {
    try {
      return (await window.companion?.conversations.export(id)) ?? null;
    } catch {
      return null;
    }
  },

  fork: async (sourceId: string, uptoMessageId?: string) => {
    const created = await window.companion?.conversations
      .fork(sourceId, uptoMessageId)
      .catch(() => null);

    if (!created) return;

    await useChatStore.getState().loadConversationById(created.id);
    notifyConversationsChanged();
  }
}));
