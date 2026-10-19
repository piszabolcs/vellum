import type { RouterDecision, SourceRef, ToolCallRecord } from './bridge';

export interface OllamaStats {
  promptTokens: number;
  evalTokens: number;
  tokensPerSecond: number;
}

export interface MessageTimings {
  totalMs: number;
  /** Csak akkor van, ha volt gondolkodás ÉS utána valódi válasz-tartalom is érkezett. */
  thinkingMs?: number;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  /** A modell válasza 1:1 (Markdown), vagy a felhasználó üzenete. */
  content: string;
  timestamp: number;
  error?: boolean;
  /** Igaz, amíg a válasz még streamelődik. */
  streaming?: boolean;
  /** A modell "gondolkodás" szövege (Ollama natív "thinking" mezője), ha van. */
  thinking?: string;
  /** Token statisztikák, csak a lezárt válasznál. */
  stats?: OllamaStats;
  /** A modell által lefuttatott webes keresőkifejezések. */
  searches?: string[];
  /** Ha a kontextusméret automatikusan lejjebb lett állítva memória-hiba miatt. */
  contextFallback?: { from: number; to: number };
  /** Válaszidő és (ha volt gondolkodás) gondolkodási idő. Csak a lezárt válasznál. */
  timings?: MessageTimings;
  /** F6: a lefuttatott eszközhívások (a ToolCallCard mutatja). */
  toolCalls?: ToolCallRecord[];
  /** F8: a behúzott források, amikre a válasz hivatkozik. */
  sources?: SourceRef[];
  /** F7: a router döntése, ha futott (a válasz alatt megjeleníthető). */
  routerDecision?: RouterDecision;
  /** F9: a válaszhoz betöltött skillek neve. */
  loadedSkills?: string[];
  /** F11: ha több válaszból választottunk, hányból. */
  selfConsistency?: { runs: number; chosen: number; reason: string | null };
}

export interface AiRequest {
  conversationId: string;
  language: 'hu' | 'en';
  message: string;
  /** A beszélgetés eddigi üzenetei, az ÚJ (jelen) üzenet NÉLKÜL. */
  history: ChatMessage[];
  /** F5: a compaction összefoglalója, ha volt. A prompt elejére kerül. */
  summary?: string;
}

/** Egy streamelt darab a provider felől a store felé. */
export interface AiResponseDelta {
  content?: string;
  thinking?: string;
  /** Ha a modell webes keresést indított ezzel a kifejezéssel. */
  searchQuery?: string;
  /** F6: éppen milyen eszközt hívott meg. */
  toolCall?: { name: string; args: Record<string, unknown> };
  /** F7: a router döntése (a válasz legelején érkezik). */
  routerDecision?: RouterDecision;
  /** F9: betöltött skill neve. */
  skillLoaded?: string;
}

/**
 * A modell válasza. Az app „buta cső": kizárólag a `message`-t jeleníti meg
 * 1:1, Markdownként.
 */
export interface AiResponse {
  message: string;
  thinking?: string;
  stats?: OllamaStats;
  searches?: string[];
  contextFallback?: { from: number; to: number };
  toolCalls?: ToolCallRecord[];
  sources?: SourceRef[];
  routerDecision?: RouterDecision;
  /** F11: ha tobb valaszbol valasztottunk */
  selfConsistency?: { runs: number; chosen: number; reason: string | null };
}
