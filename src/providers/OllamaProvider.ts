import type { AiProvider } from './AiProvider';
import type { AiRequest, AiResponse, AiResponseDelta } from '../types/chat';
import type { RouterDecision } from '../types/bridge';
import { generateId } from '../utils/formatting';
import { buildPrompt, formatWebSources } from '../promptBuilder';

const DEFAULT_HOST = 'http://localhost:11434';
const DEFAULT_MODEL = 'qwen3:30b-a3b-q4_K_M';
const DEFAULT_CONTEXT_SIZE = 32768;

/**
 * Az Ollama provider.
 *
 * MI VALTOZOTT AZ EGYESITESKOR:
 *   - a promptot mar nem itt allitjuk ossze kezzel, hanem a promptBuilder
 *     15 retegu, KV-cache barat sorrendjevel (src/promptBuilder.ts)
 *   - a memoria nem szo szerinti utasitaskent megy, hanem tipus szerint:
 *     a tenyek ADATKERETBEN, a stilus-utasitasok az uzenet ELE
 *   - futas elott lefut a router (F7), ami eldonti: kell-e kereses, milyen
 *     eszkozok, mennyi gondolkodas, melyik skill
 *
 * AMI VALTOZATLAN: a hibabuborekok nem mennek a modellnek (azt a store szuri),
 * es a vegleges szoveget a valasz adja, nem a delta-akkumulacio.
 */
export class OllamaProvider implements AiProvider {
  readonly id = 'ollama';
  readonly statusLabel = 'Helyi modell (Ollama)';

  private host = DEFAULT_HOST;
  private model = DEFAULT_MODEL;
  private webSearchEnabled = true;
  private darkPersona = false;
  private contextSize = DEFAULT_CONTEXT_SIZE;
  private idleTimeoutSec: number | undefined;
  private routerEnabled = true;
  private skillsEnabled = true;
  private maxSkillsPerTurn = 2;

  configure(opts: {
    host: string;
    model: string;
    webSearchEnabled?: boolean;
    darkPersona?: boolean;
    contextSize?: number;
    idleTimeoutSec?: number;
    routerEnabled?: boolean;
    skillsEnabled?: boolean;
    maxSkillsPerTurn?: number;
  }): void {
    if (opts.host) this.host = opts.host;
    if (opts.model) this.model = opts.model;
    if (opts.webSearchEnabled !== undefined) this.webSearchEnabled = opts.webSearchEnabled;
    if (opts.darkPersona !== undefined) this.darkPersona = opts.darkPersona;
    if (opts.contextSize !== undefined) this.contextSize = opts.contextSize;
    if (opts.idleTimeoutSec !== undefined) this.idleTimeoutSec = opts.idleTimeoutSec;
    if (opts.routerEnabled !== undefined) this.routerEnabled = opts.routerEnabled;
    if (opts.skillsEnabled !== undefined) this.skillsEnabled = opts.skillsEnabled;
    if (opts.maxSkillsPerTurn !== undefined) this.maxSkillsPerTurn = opts.maxSkillsPerTurn;
  }

  async sendMessage(
    request: AiRequest,
    onDelta?: (delta: AiResponseDelta) => void
  ): Promise<AiResponse> {
    const bridge = window.companion;
    if (!bridge) {
      throw new Error('Ollama is only reachable from inside the Electron app.');
    }

    // --- 1. memoria blokkok (a main processbol, minden keresnel frissen) ---
    const memory = await bridge.memory.buildPrompt().catch(() => ({
      dataFrame: '',
      instructions: '',
      droppedCount: 0,
      estimatedTokens: 0
    }));

    // --- 2. router: eldonti, milyen utat jarjon be a keres ---
    let decision: RouterDecision | undefined;
    if (this.routerEnabled) {
      const routed = await bridge.router
        .route({
          currentMessage: request.message,
          recentHistory: request.history.slice(-3).map((m) => ({
            role: m.role,
            content: m.content
          })),
          conversationId: request.conversationId
        })
        .catch(() => null);
      decision = routed?.decision;
      if (decision) onDelta?.({ routerDecision: decision });
    }

    // --- 3. skillek betoltese, ha a router kert ---
    const loadedSkills: { name: string; body: string }[] = [];
    if (this.skillsEnabled && decision?.skills?.length) {
      for (const name of decision.skills.slice(0, this.maxSkillsPerTurn)) {
        const skill = await bridge.skills.load(name).catch(() => null);
        if (skill?.ok && skill.content) {
          loadedSkills.push({ name, body: skill.content });
          onDelta?.({ skillLoaded: name });
        }
      }
    }

    // --- 4. katalogusok (olcsok: nev + leiras, nem a teljes torzsek) ---
    const [skillCatalog, toolCatalog] = await Promise.all([
      this.skillsEnabled ? bridge.skills.catalog().catch(() => '') : Promise.resolve(''),
      bridge.tools.catalog().catch(() => '')
    ]);

    // --- 5. a 15 retegu prompt osszeallitasa ---
    const prompt = buildPrompt({
      currentMessage: request.message,
      history: request.history.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content
      })),
      memory: {
        dataFrame: memory.dataFrame,
        instructions: memory.instructions
      },
      routerDecision: decision,
      skillCatalog,
      loadedSkills,
      toolCatalog,
      summary: request.summary,
      settings: {
        language: request.language,
        darkMode: this.darkPersona,
        // a get_datetime eszkoz atveszi a datumot, ezert a promptba nem kell
        hasDateTool: true
      }
    });

    // --- 6. kuldes ---
    const result = await bridge.ollamaChatStream(
      {
        streamId: generateId('stream'),
        host: this.host,
        model: this.model,
        messages: prompt.messages.map((m) => ({
          role: m.role,
          content: m.content
        })),
        webSearchEnabled: this.webSearchEnabled,
        contextSize: this.contextSize,
        idleTimeoutSec: this.idleTimeoutSec,
        decision,
        conversationId: request.conversationId
      },
      (chunk) => {
        if (
          !chunk.contentDelta &&
          !chunk.thinkingDelta &&
          !chunk.searchQuery &&
          !chunk.toolCall
        ) {
          return;
        }
        onDelta?.({
          content: chunk.contentDelta,
          thinking: chunk.thinkingDelta,
          searchQuery: chunk.searchQuery,
          toolCall: chunk.toolCall
        });
      }
    );

    if (!result.ok) {
      throw new Error(result.message);
    }

    return {
      message: result.message,
      thinking: result.thinking,
      stats: result.stats,
      searches: result.searches,
      contextFallback: result.contextFallback,
      toolCalls: result.toolCalls,
      sources: result.sources,
      routerDecision: decision,
      selfConsistency: result.selfConsistency
    };
  }
}

// a formatWebSources-t a store hasznalja a forraslista megjelenitesehez
export { formatWebSources };
