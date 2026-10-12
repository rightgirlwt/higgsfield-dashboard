import { badRequest } from '../lib/errors';
import { estimate, getHfConfig, HiggsfieldError } from './higgsfield';
import { getSetting, putSetting } from './settings';
import { billedSeconds, buildRequest, LIST_PRICES, outputsPerRequest, PRICES_AS_OF, resolveSettings, STUDIO_MODELS, unitPrice, type MediaRole } from './studioCatalog';

export interface PriceRow {
  modelId: string;
  model: string;
  modeId: string;
  mode: string;
  /** What the dashboard's snapshot says one request at the default settings costs. */
  snapshotUsd: number | null;
  /** What Higgsfield says. */
  liveUsd: number | null;
  diffPct: number | null;
  status: 'match' | 'changed' | 'info' | 'error';
  /** Variable-priced models: Higgsfield's own written pricing, shown as is. */
  description?: string;
  note?: string;
}

export interface PriceCheck {
  checkedAt: string;
  snapshotDate: string;
  rows: PriceRow[];
  counts: { match: number; changed: number; info: number; error: number };
}

// Higgsfield doesn't fetch the file when estimating, so a stand-in address is enough to satisfy a required input.
const PLACEHOLDER: Record<MediaRole, string> = {
  start: 'https://example.com/placeholder.png',
  end: 'https://example.com/placeholder.png',
  reference: 'https://example.com/placeholder.png',
  video: 'https://example.com/placeholder.mp4',
  audio: 'https://example.com/placeholder.wav',
};

/** Price of one request at a mode's default settings, using the snapshot (the same maths the cost dialogs use). */
function snapshotPrice(model: (typeof STUDIO_MODELS)[number], mode: (typeof STUDIO_MODELS)[number]['modes'][number], settings: Record<string, any>): number | null {
  const unit = unitPrice(mode, settings, null);
  return unit ? unit.amount * billedSeconds(model, mode, settings) * outputsPerRequest(settings) : null;
}

/**
 * Asks Higgsfield for the real price of every model and mode (at default settings) and compares it with the dashboard's snapshot.
 * Nothing is generated or charged; estimates are free lookups.
 */
export async function checkPrices(orgId: string): Promise<PriceCheck> {
  const cfg = await getHfConfig(orgId);
  if (!cfg) throw badRequest('Connect Higgsfield first (Settings → API keys and Settings → Higgsfield).');

  const jobs = STUDIO_MODELS.flatMap((model) => model.modes.map((mode) => ({ model, mode })));
  const rows: PriceRow[] = new Array(jobs.length);
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const i = next++;
      const { model, mode } = jobs[i];
      const base = { modelId: model.id, model: model.label, modeId: mode.id, mode: mode.label };
      try {
        const settings = resolveSettings(mode, {});
        const media = Object.fromEntries(mode.media.filter((m) => m.required).map((m) => [m.role, [PLACEHOLDER[m.role]]])) as Partial<Record<MediaRole, string[]>>;
        const { path, body } = buildRequest(mode, { prompt: 'price check', settings, media });
        const est = await estimate(cfg, path, body);
        if (est.kind === 'description') {
          rows[i] = { ...base, snapshotUsd: snapshotPrice(model, mode, settings), liveUsd: null, diffPct: null, status: 'info', description: est.text };
          continue;
        }
        const live = est.usd;
        const snap = snapshotPrice(model, mode, settings);
        const diffPct = snap && snap > 0 ? ((live - snap) / snap) * 100 : null;
        // A fraction of a percent, or under a tenth of a cent, is rounding rather than a price change.
        const same = snap !== null && (Math.abs(live - snap) < 0.0005 || Math.abs(diffPct ?? 100) < 1);
        rows[i] = { ...base, snapshotUsd: snap, liveUsd: live, diffPct: diffPct === null ? null : Math.round(diffPct * 10) / 10, status: same ? 'match' : 'changed' };
      } catch (e) {
        rows[i] = { ...base, snapshotUsd: null, liveUsd: null, diffPct: null, status: 'error', note: e instanceof HiggsfieldError || e instanceof Error ? e.message.slice(0, 160) : 'Failed' };
      }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));

  const counts = { match: 0, changed: 0, info: 0, error: 0 };
  for (const r of rows) counts[r.status]++;
  const result: PriceCheck = { checkedAt: new Date().toISOString(), snapshotDate: PRICES_AS_OF, rows, counts };
  await putSetting(orgId, 'price_check', result);
  return result;
}

export const lastPriceCheck = (orgId: string) => getSetting<PriceCheck | null>(orgId, 'price_check', null);

/** Latest promo end date in the snapshot (ISO date), if any. */
export function promoEndDate(): string | null {
  const dates = Object.values(LIST_PRICES).map((p) => p.promoEnds).filter((d): d is string => !!d);
  return dates.length ? dates.sort().at(-1)! : null;
}
