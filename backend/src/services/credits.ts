import { getDb } from '../ctx';
import { createAlert } from './alerts';
import { getSetting, putSetting } from './settings';

/**
 * Neither Anthropic nor Higgsfield offers an API to read a remaining balance with an ordinary key (Anthropic's usage API needs a
 * separate admin key and reports usage only; Higgsfield shows usage in its Console). So the person enters the balance they see in
 * each console, and the dashboard subtracts the spend it records afterwards. It only knows about spend made through this dashboard.
 */
export const CREDIT_PROVIDERS = ['claude', 'higgsfield'] as const;
export type CreditProvider = (typeof CREDIT_PROVIDERS)[number];

interface Stored {
  balanceUsd: number;
  asOf: string;
}
type Store = Partial<Record<CreditProvider, Stored>>;

export interface CreditStatus {
  provider: CreditProvider;
  /** False until a balance has been entered. */
  set: boolean;
  startingUsd: number | null;
  asOf: string | null;
  /** Tracked spend since the balance was entered. */
  usedSinceUsd: number;
  /** Everything tracked, ever (real spend only; demo data excluded). */
  lifetimeUsedUsd: number;
  remainingUsd: number | null;
  low: boolean;
}

/** "Low" is under 15% of the balance you entered, or under $2. */
const isLow = (starting: number, remaining: number) => remaining <= Math.max(2, starting * 0.15);

export async function creditStatus(orgId: string): Promise<CreditStatus[]> {
  const store = await getSetting<Store>(orgId, 'credits', {});
  const { rows } = await getDb().query<{ provider: CreditProvider; lifetime: number; since: number }>(
    `SELECT provider, COALESCE(SUM(cost_usd),0)::float8 AS lifetime,
            COALESCE(SUM(cost_usd) FILTER (WHERE ts >= COALESCE(($2::jsonb->>provider)::timestamptz, 'infinity'::timestamptz)),0)::float8 AS since
     FROM usage_events WHERE org_id=$1 AND NOT simulated GROUP BY provider`,
    [orgId, JSON.stringify(Object.fromEntries(CREDIT_PROVIDERS.map((p) => [p, store[p]?.asOf ?? null])))],
  );
  const by = new Map(rows.map((r) => [r.provider, r]));
  return CREDIT_PROVIDERS.map((provider) => {
    const s = store[provider];
    const r = by.get(provider);
    const used = r?.since ?? 0;
    const remaining = s ? s.balanceUsd - used : null;
    return {
      provider, set: !!s, startingUsd: s?.balanceUsd ?? null, asOf: s?.asOf ?? null, usedSinceUsd: used, lifetimeUsedUsd: r?.lifetime ?? 0,
      remainingUsd: remaining, low: s && remaining !== null ? isLow(s.balanceUsd, remaining) : false,
    };
  });
}

export async function setBalance(orgId: string, provider: CreditProvider, balanceUsd: number): Promise<void> {
  const store = await getSetting<Store>(orgId, 'credits', {});
  await putSetting(orgId, 'credits', { ...store, [provider]: { balanceUsd, asOf: new Date().toISOString() } });
}

export async function clearBalance(orgId: string, provider: CreditProvider): Promise<void> {
  const store = await getSetting<Store>(orgId, 'credits', {});
  const { [provider]: _gone, ...rest } = store;
  await putSetting(orgId, 'credits', rest);
}

const LABEL: Record<CreditProvider, string> = { claude: 'Anthropic (Claude)', higgsfield: 'Higgsfield' };

/** After spend is recorded: warn once per entered balance when the estimate says credit is running low. */
export async function checkCreditsLow(orgId: string, provider: CreditProvider): Promise<void> {
  const s = (await creditStatus(orgId)).find((c) => c.provider === provider);
  if (!s?.set || !s.low || s.remainingUsd === null || !s.asOf) return;
  await createAlert(orgId, {
    kind: 'credits_low',
    severity: s.remainingUsd <= 0 ? 'critical' : 'warning',
    message: `${LABEL[provider]} credit looks low: about $${Math.max(0, s.remainingUsd).toFixed(2)} left of the $${s.startingUsd!.toFixed(2)} you entered. Check the real balance in the ${provider === 'claude' ? 'Anthropic' : 'Higgsfield'} console.`,
    period: `credits:${provider}:${s.asOf}`,
  });
}
