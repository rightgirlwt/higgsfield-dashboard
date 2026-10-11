import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';
import { badRequest } from '../lib/errors';
import { calcCostUsd, estimateTokens, getModel } from '../lib/pricing';
import { getSecret } from './secrets';

export interface PromptParams {
  model: string;
  system?: string;
  user: string;
  temperature?: number | null;
  maxTokens: number;
}

export interface PromptResult {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
  stopReason: string | null;
  simulated: boolean;
}

/** Non-streaming requests are capped to stay well inside SDK HTTP timeouts. */
const MAX_NON_STREAMING_TOKENS = 16000;

export async function runPrompt(orgId: string, p: PromptParams): Promise<PromptResult> {
  const model = getModel(p.model);
  if (!model) throw badRequest(`Unknown model "${p.model}"`);
  const maxTokens = Math.min(p.maxTokens, MAX_NON_STREAMING_TOKENS, model.maxOutputTokens);

  const apiKey = await getSecret(orgId, 'anthropic');
  if (!apiKey) return simulate(p, maxTokens);

  const client = new Anthropic({ apiKey, maxRetries: 2 });
  const started = Date.now();
  const res = await client.messages.create({
    model: model.id,
    max_tokens: maxTokens,
    ...(p.system?.trim() ? { system: p.system } : {}),
    // Current-generation models reject non-default sampling params, so only send it where supported.
    ...(model.supportsTemperature && typeof p.temperature === 'number' ? { temperature: Math.min(1, Math.max(0, p.temperature)) } : {}),
    messages: [{ role: 'user', content: p.user }],
  });
  const latencyMs = Date.now() - started;
  if (res.stop_reason === 'refusal') {
    throw new Error('The model declined this request (stop_reason: refusal).');
  }
  const text = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  return {
    text,
    model: model.id,
    inputTokens: res.usage.input_tokens,
    outputTokens: res.usage.output_tokens,
    costUsd: calcCostUsd(model.id, res.usage.input_tokens, res.usage.output_tokens),
    latencyMs,
    stopReason: res.stop_reason,
    simulated: false,
  };
}

async function simulate(p: PromptParams, maxTokens: number): Promise<PromptResult> {
  const delay = config.isTest ? 0 : 350 + Math.floor(Math.random() * 500);
  if (delay) await new Promise((r) => setTimeout(r, delay));
  const excerpt = p.user.replace(/\s+/g, ' ').slice(0, 160);
  const text =
    `[SIMULATED RESPONSE — no Anthropic API key is configured. Add one in Settings → API keys to get real output.]\n\n` +
    `Received a ${p.user.length}-character prompt${p.system ? ' with a system prompt' : ''} for ${p.model}.\n` +
    `Prompt excerpt: "${excerpt}${p.user.length > 160 ? '…' : ''}"`;
  const inputTokens = estimateTokens((p.system ?? '') + p.user);
  const outputTokens = Math.min(maxTokens, estimateTokens(text));
  return {
    text,
    model: p.model,
    inputTokens,
    outputTokens,
    costUsd: calcCostUsd(p.model, inputTokens, outputTokens),
    latencyMs: delay,
    stopReason: 'end_turn',
    simulated: true,
  };
}
