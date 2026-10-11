import { config } from '../config';
import { getDb } from '../ctx';
import { placeholderImage } from '../lib/placeholder';
import { getHfConfig, getStatus, simStatus, simSubmit, submit, TERMINAL, type HfConfig } from './higgsfield';
import type { Work } from './jobs';
import { getSetting, putSetting } from './settings';
import { getStudioModel, resolveMedia, resolveSettings, type MediaRole } from './studioCatalog';
import { recordUsage } from './usage';

export type Prices = Record<string, number | null>;

/** Per-output prices (USD) are entered by an admin; the platform API does not report cost. */
export async function getPrices(orgId: string): Promise<Prices> {
  const s = await getSetting<{ prices: Prices }>(orgId, 'studio_prices', { prices: {} });
  return s.prices ?? {};
}
export const setPrices = (orgId: string, prices: Prices) => putSetting(orgId, 'studio_prices', { prices });

export interface GenerateParams {
  modelId: string;
  prompt: string;
  settings?: Record<string, unknown>;
  media?: Partial<Record<MediaRole, string[]>>;
  /** Number of separate requests for models without native batching (1-4). */
  count?: number;
  workflowId?: string | null;
}

export interface GeneratedAsset {
  id: string;
  url: string;
  thumbUrl: string;
  type: 'photo' | 'video';
}

export interface GenerateResult {
  assets: GeneratedAsset[];
  failures: string[];
  costUsd: number;
  simulated: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SAFE_RESULT_URL = /^https?:\/\/\S+$/i;

const FAILURE_TEXT: Record<string, string> = {
  nsfw: 'Blocked by Higgsfield content moderation',
  canceled: 'The generation was cancelled',
  failed: 'The generation failed',
};

interface Pending {
  id: string;
  misses: number;
  lastStatus: string;
}

type Log = Parameters<Work>[0]['log'];

/**
 * Submits one or more requests, polls until each reaches a terminal status (or the deadline),
 * stores finished media in the timeline and records spend. Throws only when NOTHING was produced.
 */
export async function runStudioGeneration(orgId: string, ctx: { runId: string; log: Log }, p: GenerateParams): Promise<GenerateResult> {
  const { runId, log } = ctx;
  const model = getStudioModel(p.modelId);
  if (!model) throw new Error(`Unknown Studio model "${p.modelId}"`);
  const settings = resolveSettings(model, p.settings);
  const media = resolveMedia(model, p.media);
  const { path, body } = model.build({ prompt: p.prompt, settings, media });
  const nativeBatch = 'batchSize' in model.settings;
  const n = nativeBatch ? 1 : Math.min(4, Math.max(1, Math.floor(p.count ?? 1)));

  const cfg: HfConfig | null = await getHfConfig(orgId);
  const simulated = cfg === null;
  if (simulated) await log('warn', 'Higgsfield API key / base URL not configured — producing SIMULATED placeholder results');

  const failures: string[] = [];
  const pending: Pending[] = [];
  const submitted = await Promise.allSettled(
    Array.from({ length: n }, () => (cfg ? submit(cfg, path, body) : Promise.resolve(simSubmit(model.surface, p.prompt)))),
  );
  for (const s of submitted) {
    if (s.status === 'fulfilled') pending.push({ id: s.value.requestId, misses: 0, lastStatus: s.value.status });
    else {
      const msg = s.reason instanceof Error ? s.reason.message : String(s.reason);
      failures.push(msg);
      await log('error', `Submit failed: ${msg}`);
    }
  }
  if (pending.length === 0) throw new Error(failures[0] ?? 'Nothing was submitted');
  await log('info', `Submitted ${pending.length} request${pending.length > 1 ? 's' : ''} to ${model.label}${nativeBatch ? ` (batch of ${settings.batchSize})` : ''}`);

  const price = (await getPrices(orgId))[model.id] ?? null;
  const assets: GeneratedAsset[] = [];
  const title = p.prompt.replace(/\s+/g, ' ').slice(0, 120);
  const deadline = Date.now() + config.studioDeadlineMs;
  let live = [...pending];

  const finish = async (r: Pending, urls: { url: string; type: 'photo' | 'video' }[]) => {
    if (urls.length === 0) {
      failures.push('The platform reported completion but returned no media');
      await log('error', `Request ${r.id.slice(0, 8)} finished without output`);
      return;
    }
    for (const u of urls) {
      if (!SAFE_RESULT_URL.test(u.url) && !(simulated && u.url.startsWith('data:image/'))) {
        failures.push('The platform returned an unsupported media URL');
        continue;
      }
      const thumb = u.type === 'photo' ? u.url : placeholderImage(title, 'video', r.id);
      const { rows } = await getDb().query<{ id: string }>(
        `INSERT INTO media_assets (org_id, type, title, url, thumb_url, tags, metadata, workflow_id, run_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9) RETURNING id`,
        [orgId, u.type, title, u.url, thumb, ['studio', model.id], JSON.stringify({ source: 'studio', prompt: p.prompt, model: model.id, modelLabel: model.label, settings, requestId: r.id, simulated }), p.workflowId ?? null, runId],
      );
      assets.push({ id: rows[0].id, url: u.url, thumbUrl: thumb, type: u.type });
    }
    await log('info', `Request ${r.id.slice(0, 8)} completed`);
  };

  while (live.length) {
    await sleep(config.studioPollMs);
    const stillLive: Pending[] = [];
    await Promise.all(
      live.map(async (r) => {
        try {
          const s = cfg ? await getStatus(cfg, r.id) : simStatus(r.id);
          r.misses = 0;
          if (s.status !== r.lastStatus) {
            r.lastStatus = s.status;
            if (!TERMINAL.has(s.status)) await log('info', `Request ${r.id.slice(0, 8)}: ${s.status}`);
          }
          if (s.error && !TERMINAL.has(s.status)) throw new Error(s.error);
          if (!TERMINAL.has(s.status)) return void stillLive.push(r);
          if (s.status === 'completed') {
            await finish(r, [...s.images.map((url) => ({ url, type: 'photo' as const })), ...(s.video ? [{ url: s.video, type: 'video' as const }] : [])]);
          } else {
            const msg = `${FAILURE_TEXT[s.status] ?? 'The generation did not complete'}${s.error ? `: ${s.error}` : ''}`;
            failures.push(msg);
            await log('error', `Request ${r.id.slice(0, 8)}: ${msg}`);
          }
        } catch (err) {
          r.misses++;
          const msg = err instanceof Error ? err.message : String(err);
          if (r.misses >= 3) {
            failures.push(`Lost contact with Higgsfield: ${msg}`);
            await log('error', `Request ${r.id.slice(0, 8)}: lost contact (${msg})`);
          } else {
            await log('warn', `Status check failed (${r.misses}/3): ${msg}`);
            stillLive.push(r);
          }
        }
      }),
    );
    live = stillLive;
    if (live.length && Date.now() > deadline) {
      for (const r of live) {
        failures.push('Timed out waiting for the platform');
        await log('error', `Request ${r.id.slice(0, 8)} timed out`);
      }
      live = [];
    }
  }

  if (assets.length === 0) throw new Error(failures.join('; ') || 'No media was produced');

  const costUsd = (price ?? 0) * assets.length;
  if (price === null) await log('info', `No price set for ${model.label}, so this run is recorded at $0. Set one in Settings → Higgsfield.`);
  await recordUsage({ orgId, runId, provider: 'higgsfield', model: model.id, workflowId: p.workflowId ?? null, units: assets.length, costUsd, simulated });
  if (failures.length) await log('warn', `${failures.length} of ${pending.length} request(s) did not produce media`);
  return { assets, failures, costUsd, simulated };
}

/** Queue work for a stand-alone Studio generation (the Studio page). */
export function studioWork(orgId: string, p: GenerateParams): Work {
  return async (ctx) => {
    const r = await runStudioGeneration(orgId, ctx, p);
    return { output: { assets: r.assets, failures: r.failures }, model: p.modelId, inputTokens: 0, outputTokens: 0, costUsd: r.costUsd, simulated: r.simulated };
  };
}
