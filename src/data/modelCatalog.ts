// Curated catalog of popular open models from the Ollama library, shipped with
// the app (no network lookup). APPROXIMATE: sizes are the download size of the
// default Ollama tag (Q4_K_M unless a comment says otherwise) and context is the
// maximum the model supports, as listed in the Ollama library in 2025. Ollama
// may retag or requantize models later, so treat the numbers as a guide.

export type ModelKind = 'chat' | 'reasoning' | 'embedding';

export interface CatalogModel {
  tag: string;
  family: string;
  /** total parameters, e.g. "8B" or "567M" */
  params: string;
  /** active parameters per token for MoE models, e.g. "3B" */
  activeParams?: string;
  diskGB: number;
  /** maximum context, thousands of tokens */
  contextK: number;
  license: string;
  kind: ModelKind;
  strengths: string;
  languagesNote?: string;
}

const QWEN = 'Supports 119 languages, including Hungarian.';
const LLAMA = 'Officially 8 languages (English, German, French, Italian, Portuguese, Hindi, Spanish, Thai).';
const GEMMA = 'Over 140 languages.';

export const MODEL_CATALOG: CatalogModel[] = [
  // --- Qwen3: hybrid thinking (can answer with or without a reasoning phase) ---
  { tag: 'qwen3:1.7b', family: 'qwen3', params: '1.7B', diskGB: 1.4, contextK: 40, license: 'Apache 2.0', kind: 'reasoning', strengths: 'Tiny hybrid-thinking model for quick answers on weak hardware.', languagesNote: QWEN },
  { tag: 'qwen3:4b', family: 'qwen3', params: '4B', diskGB: 2.5, contextK: 256, license: 'Apache 2.0', kind: 'reasoning', strengths: 'Small but capable all-rounder with a very long context.', languagesNote: QWEN },
  { tag: 'qwen3:8b', family: 'qwen3', params: '8B', diskGB: 5.2, contextK: 40, license: 'Apache 2.0', kind: 'reasoning', strengths: 'Balanced everyday assistant with good tool use and reasoning.', languagesNote: QWEN },
  { tag: 'qwen3:14b', family: 'qwen3', params: '14B', diskGB: 9.3, contextK: 40, license: 'Apache 2.0', kind: 'reasoning', strengths: 'Stronger reasoning and writing than the 8B, needs more memory.', languagesNote: QWEN },
  { tag: 'qwen3:30b-a3b', family: 'qwen3', params: '30B', activeParams: '3B', diskGB: 19, contextK: 256, license: 'Apache 2.0', kind: 'reasoning', strengths: 'Mixture-of-experts: large-model quality at small-model speed.', languagesNote: QWEN },

  // --- Llama ---
  { tag: 'llama3.2:1b', family: 'llama3.2', params: '1B', diskGB: 1.3, contextK: 128, license: 'Llama 3.2 Community', kind: 'chat', strengths: 'Very small and fast, good for summaries and simple chat.', languagesNote: LLAMA },
  { tag: 'llama3.2:3b', family: 'llama3.2', params: '3B', diskGB: 2.0, contextK: 128, license: 'Llama 3.2 Community', kind: 'chat', strengths: 'Small general assistant with solid instruction following.', languagesNote: LLAMA },
  { tag: 'llama3.1:8b', family: 'llama3.1', params: '8B', diskGB: 4.9, contextK: 128, license: 'Llama 3.1 Community', kind: 'chat', strengths: 'Widely used 8B chat model with tool calling.', languagesNote: LLAMA },

  // --- Gemma 3 (4B and up also read images) ---
  { tag: 'gemma3:1b', family: 'gemma3', params: '1B', diskGB: 0.8, contextK: 32, license: 'Gemma Terms of Use', kind: 'chat', strengths: 'Smallest Gemma, text only, fine for light tasks.', languagesNote: GEMMA },
  { tag: 'gemma3:4b', family: 'gemma3', params: '4B', diskGB: 3.3, contextK: 128, license: 'Gemma Terms of Use', kind: 'chat', strengths: 'Compact multimodal model that also understands images.', languagesNote: GEMMA },
  { tag: 'gemma3:12b', family: 'gemma3', params: '12B', diskGB: 8.1, contextK: 128, license: 'Gemma Terms of Use', kind: 'chat', strengths: 'Strong multilingual writing and image understanding.', languagesNote: GEMMA },

  // --- Phi ---
  { tag: 'phi4-mini', family: 'phi4', params: '3.8B', diskGB: 2.5, contextK: 128, license: 'MIT', kind: 'chat', strengths: 'Small model that is good at math, logic and function calling.' },
  { tag: 'phi4', family: 'phi4', params: '14B', diskGB: 9.1, contextK: 16, license: 'MIT', kind: 'chat', strengths: 'Strong reasoning for its size, short context.' },

  // --- Mistral ---
  { tag: 'mistral-small3.2', family: 'mistral', params: '24B', diskGB: 15, contextK: 128, license: 'Apache 2.0', kind: 'chat', strengths: 'High-quality instruction following and tool use, also reads images.', languagesNote: 'Dozens of languages, best in European ones.' },

  // --- DeepSeek-R1 distills: always reason before answering ---
  { tag: 'deepseek-r1:7b', family: 'deepseek-r1', params: '7B', diskGB: 4.7, contextK: 128, license: 'MIT', kind: 'reasoning', strengths: 'Step-by-step reasoning for math and logic puzzles.' },
  { tag: 'deepseek-r1:8b', family: 'deepseek-r1', params: '8B', diskGB: 5.2, contextK: 128, license: 'MIT', kind: 'reasoning', strengths: 'Newer R1 distill on Qwen3 8B with better reasoning.' },
  { tag: 'deepseek-r1:14b', family: 'deepseek-r1', params: '14B', diskGB: 9.0, contextK: 128, license: 'MIT', kind: 'reasoning', strengths: 'Deeper reasoning, slower and needs more memory.' },

  // --- IBM Granite ---
  { tag: 'granite3.3:2b', family: 'granite3.3', params: '2B', diskGB: 1.5, contextK: 128, license: 'Apache 2.0', kind: 'chat', strengths: 'Small business-oriented model with long context.', languagesNote: '12 languages.' },
  { tag: 'granite3.3:8b', family: 'granite3.3', params: '8B', diskGB: 4.9, contextK: 128, license: 'Apache 2.0', kind: 'chat', strengths: 'Reliable instruction following, RAG and summarization.', languagesNote: '12 languages.' },

  // --- others ---
  { tag: 'qwen2.5-coder:7b', family: 'qwen2.5-coder', params: '7B', diskGB: 4.7, contextK: 32, license: 'Apache 2.0', kind: 'chat', strengths: 'Code generation, code reasoning and fixing.' },
  // MXFP4 weights, not Q4_K_M
  { tag: 'gpt-oss:20b', family: 'gpt-oss', params: '21B', activeParams: '3.6B', diskGB: 14, contextK: 128, license: 'Apache 2.0', kind: 'reasoning', strengths: 'OpenAI open-weight MoE with adjustable reasoning effort.' },

  // --- embedding models (F16 weights): for search and memory, not for chat ---
  { tag: 'bge-m3', family: 'bge-m3', params: '567M', diskGB: 1.2, contextK: 8, license: 'MIT', kind: 'embedding', strengths: 'Multilingual embeddings; Vellum uses it for semantic search.', languagesNote: '100+ languages, including Hungarian.' },
  { tag: 'nomic-embed-text', family: 'nomic-bert', params: '137M', diskGB: 0.3, contextK: 2, license: 'Apache 2.0', kind: 'embedding', strengths: 'Small, fast English embedding model.' }
];

/** "8B" -> 8, "567M" -> 0.567; anything else -> NaN. */
export function parseParamsB(value: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*([BM])$/i.exec(value.trim());
  if (!match) return NaN;
  const n = Number(match[1]);
  return match[2].toUpperCase() === 'M' ? n / 1000 : n;
}

/** Ollama stores an untagged name as ":latest". */
export function normalizeTag(tag: string): string {
  return tag.includes(':') ? tag : `${tag}:latest`;
}

export function findCatalogModel(tag: string): CatalogModel | undefined {
  const wanted = normalizeTag(tag.trim().toLowerCase());
  return MODEL_CATALOG.find((model) => normalizeTag(model.tag) === wanted);
}
