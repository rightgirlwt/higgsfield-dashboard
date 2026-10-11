/**
 * Model registry + cost calculation.
 *
 * Prices are USD per 1M tokens, taken from Anthropic's published rates at the time of writing
 * (2026-10). Verify against https://platform.claude.com/docs/en/about-claude/pricing and update here
 * when rates change. Costs shown in the app are ESTIMATES derived from reported token usage.
 */
export interface ModelInfo {
  id: string;
  label: string;
  inputPerMTok: number;
  outputPerMTok: number;
  /** Current-generation models reject non-default sampling params (temperature etc.). */
  supportsTemperature: boolean;
  maxOutputTokens: number;
  tier: 'frontier' | 'balanced' | 'fast';
}

export const MODELS: ModelInfo[] = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', inputPerMTok: 4, outputPerMTok: 20, supportsTemperature: false, maxOutputTokens: 128000, tier: 'frontier' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', inputPerMTok: 2, outputPerMTok: 10, supportsTemperature: false, maxOutputTokens: 128000, tier: 'balanced' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', inputPerMTok: 0.1, outputPerMTok: 0.5, supportsTemperature: false, maxOutputTokens: 128000, tier: 'fast' },
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1', inputPerMTok: 10, outputPerMTok: 50, supportsTemperature: false, maxOutputTokens: 128000, tier: 'frontier' },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', inputPerMTok: 3, outputPerMTok: 15, supportsTemperature: true, maxOutputTokens: 64000, tier: 'balanced' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', inputPerMTok: 1, outputPerMTok: 5, supportsTemperature: true, maxOutputTokens: 64000, tier: 'fast' },
];

export const DEFAULT_MODEL = 'claude-sonnet-5-5';

export function getModel(id: string): ModelInfo | undefined {
  return MODELS.find((m) => m.id === id);
}

export function calcCostUsd(modelId: string, inputTokens: number, outputTokens: number): number {
  const m = getModel(modelId);
  if (!m) return 0;
  const cost = (inputTokens / 1_000_000) * m.inputPerMTok + (outputTokens / 1_000_000) * m.outputPerMTok;
  return Math.round(cost * 1e8) / 1e8;
}

/** Rough token estimate (~4 chars/token) used for simulated runs and pre-run estimates. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}
