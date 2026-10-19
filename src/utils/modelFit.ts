// "Will it run?" estimate for a model on this machine. A rule of thumb, not a
// measurement: weights + KV cache + a fixed overhead against usable VRAM and RAM.

export interface ModelSize {
  /** download size of the default tag, GB */
  diskGB: number;
  /** total parameters, billions; unknown -> guessed from the size */
  paramsB?: number;
  /** active parameters per token for MoE models, billions */
  activeParamsB?: number;
}

export interface Hardware {
  /** total VRAM, GB (0 = no usable GPU) */
  vramGB: number;
  /** total system RAM, GB */
  ramGB: number;
}

export type Fit = 'gpu' | 'gpu+ram' | 'no';

export type FitReason = 'fitsVram' | 'spillsToRam' | 'ramOnly' | 'tooBig';

export interface FitResult {
  fit: Fit;
  reason: FitReason;
  /** weights + KV cache + overhead, GB (one decimal) */
  estimatedGB: number;
  kvCacheGB: number;
  usableVramGB: number;
  usableRamGB: number;
  /** few active parameters: runs much faster than its size suggests */
  moe: boolean;
}

/** KV cache: about 0.06 GB per 1k tokens for an 8B model, linear in parameters. */
const KV_GB_PER_1K_TOKENS_PER_8B = 0.06;
const WEIGHT_FACTOR = 1.1;
const OVERHEAD_GB = 0.5;
const VRAM_USABLE = 0.9;
/** left for Windows and the other apps */
const RAM_RESERVED_GB = 6;
const MOE_ACTIVE_RATIO = 0.3;
/** Q4_K_M weights take about 0.6 GB per billion parameters */
const GB_PER_BILLION_PARAMS = 0.6;

const round1 = (n: number) => Math.round(n * 10) / 10;

export function estimateFit(model: ModelSize, contextTokens: number, hw: Hardware): FitResult {
  const paramsB =
    model.paramsB !== undefined && Number.isFinite(model.paramsB) && model.paramsB > 0
      ? model.paramsB
      : model.diskGB / GB_PER_BILLION_PARAMS;
  const kvCacheGB = KV_GB_PER_1K_TOKENS_PER_8B * (contextTokens / 1024) * (paramsB / 8);
  const need = model.diskGB * WEIGHT_FACTOR + kvCacheGB + OVERHEAD_GB;
  const usableVramGB = Math.max(0, hw.vramGB * VRAM_USABLE);
  const usableRamGB = Math.max(0, hw.ramGB - RAM_RESERVED_GB);
  const moe =
    model.activeParamsB !== undefined &&
    model.activeParamsB <= paramsB * MOE_ACTIVE_RATIO;

  let fit: Fit;
  let reason: FitReason;
  if (usableVramGB > 0 && need <= usableVramGB) {
    fit = 'gpu';
    reason = 'fitsVram';
  } else if (need <= usableVramGB + usableRamGB) {
    fit = 'gpu+ram';
    reason = usableVramGB > 0 ? 'spillsToRam' : 'ramOnly';
  } else {
    fit = 'no';
    reason = 'tooBig';
  }

  return {
    fit,
    reason,
    estimatedGB: round1(need),
    kvCacheGB: round1(kvCacheGB),
    usableVramGB: round1(usableVramGB),
    usableRamGB: round1(usableRamGB),
    moe
  };
}
