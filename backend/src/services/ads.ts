import { getDb } from '../ctx';
import { decryptSecret, encryptSecret, last4 } from '../lib/crypto';
import { badRequest, HttpError, notFound } from '../lib/errors';
import { graph, GraphError, iso, rateLimited, tokenProblem } from './metrics';
import { inWorkspace, type Workspace } from './workspaces';

/**
 * Metrics for Meta ad accounts: what was spent and what it got, by campaign and by day. Read only (the token cannot change a campaign
 * through anything here). The last 90 days are kept as a row a day per campaign.
 */

const WINDOW_DAYS = 90;
const tokenShape = /^[A-Za-z0-9_\-.]{20,600}$/;
const idShape = /^(act_)?\d{5,25}$/;

/** What counts as a "result", most meaningful first. A campaign's result is the first of these it actually got. */
const RESULT_TYPES: [string, string][] = [
  ['lead', 'Leads'],
  ['onsite_conversion.lead_grouped', 'Leads'],
  ['offsite_conversion.fb_pixel_lead', 'Leads'],
  ['onsite_conversion.messaging_conversation_started_7d', 'Conversations'],
  ['offsite_conversion.fb_pixel_purchase', 'Purchases'],
  ['purchase', 'Purchases'],
  ['link_click', 'Link clicks'],
];

interface AdRow {
  id: string;
  org_id: string;
  workspace_id: string | null;
  account_id: string;
  name: string;
  currency: string;
  token_cipher: string;
  token_last4: string;
  last_synced_at: string | Date | null;
  last_error: string;
  created_at: string | Date;
}

const presentAccount = (a: AdRow) => ({
  id: a.id,
  accountId: a.account_id,
  name: a.name,
  currency: a.currency,
  tokenLast4: a.token_last4,
  lastSyncedAt: iso(a.last_synced_at),
  lastError: a.last_error,
  connectedAt: iso(a.created_at),
});

async function loadAccount(orgId: string, id: string): Promise<AdRow> {
  const { rows } = await getDb().query<AdRow>('SELECT * FROM ad_accounts WHERE id=$1 AND org_id=$2', [id, orgId]);
  if (!rows[0]) throw notFound('Ad account not found');
  return rows[0];
}

export async function listAdAccounts(orgId: string, ws: Workspace) {
  const params: unknown[] = [orgId];
  const { rows } = await getDb().query<AdRow>(`SELECT a.* FROM ad_accounts a WHERE a.org_id=$1 AND ${inWorkspace(ws, 'a', params)} ORDER BY a.created_at`, params);
  return rows.map(presentAccount);
}

const user = (token: string) => ({ api: 'facebook' as const, token });
const actId = (v: string) => (v.startsWith('act_') ? v : `act_${v}`);

interface AccountNode {
  id?: string;
  account_id?: string;
  name?: string;
  currency?: string;
}

export async function connectAdAccounts(orgId: string, ws: Workspace, rawToken: string, adAccountId?: string) {
  const token = rawToken.trim();
  const given = adAccountId?.trim() || undefined;
  if (!tokenShape.test(token)) throw badRequest('That does not look like an access token. Paste only the token itself, with no spaces or quotes.');
  if (given && !idShape.test(given)) throw badRequest('The ad account ID is a number, sometimes written act_ followed by the number. Paste only that.');
  let nodes: AccountNode[];
  try {
    if (given) nodes = [await graph<AccountNode>(user(token), `/${actId(given)}`, { fields: 'id,account_id,name,currency' })];
    else {
      const r = await graph<{ data?: AccountNode[] }>(user(token), '/me/adaccounts', { fields: 'id,account_id,name,currency', limit: 100 });
      nodes = r.data ?? [];
      if (nodes.length === 0) throw badRequest('That token works, but it could not find an ad account on its own. Paste the ad account ID too (Meta Business Settings, Accounts, Ad accounts).');
    }
  } catch (e) {
    if (e instanceof GraphError) throw badRequest(`Meta did not accept that: ${e.message}`);
    throw e;
  }
  const results = [];
  for (const n of nodes) {
    const id = n.id ?? (n.account_id ? actId(n.account_id) : '');
    if (!id) throw badRequest('Meta did not return an ad account for that ID. Check the number.');
    const { rows } = await getDb().query<AdRow>(
      `INSERT INTO ad_accounts (org_id, workspace_id, account_id, name, currency, token_cipher, token_last4)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (org_id, account_id) DO UPDATE SET workspace_id=EXCLUDED.workspace_id, name=EXCLUDED.name, currency=EXCLUDED.currency,
         token_cipher=EXCLUDED.token_cipher, token_last4=EXCLUDED.token_last4, last_error=''
       RETURNING *`,
      [orgId, ws.id, id, n.name ?? id, n.currency ?? 'USD', encryptSecret(token), last4(token)],
    );
    try {
      results.push(await syncAdAccount(orgId, rows[0].id));
    } catch (e) {
      results.push({ account: presentAccount(await loadAccount(orgId, rows[0].id)), days: 0, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { accounts: results };
}

export async function removeAdAccount(orgId: string, id: string) {
  const { rowCount } = await getDb().query('DELETE FROM ad_accounts WHERE id=$1 AND org_id=$2', [id, orgId]);
  if (rowCount === 0) throw notFound('Ad account not found');
}

interface InsightRow {
  campaign_id?: string;
  campaign_name?: string;
  date_start?: string;
  spend?: string;
  impressions?: string;
  reach?: string;
  clicks?: string;
  actions?: { action_type?: string; value?: string }[];
}

const toNum = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
};
const ymd = (d: Date) => d.toISOString().slice(0, 10);

/** Reads 90 days of spend and results, a row per campaign per day. Free. */
export async function syncAdAccount(orgId: string, id: string) {
  const db = getDb();
  const a = await loadAccount(orgId, id);
  const token = decryptSecret(a.token_cipher);
  const fail = async (e: unknown): Promise<never> => {
    const msg = tokenProblem(e) ? 'Meta no longer accepts this token. Connect the ad account again with a new token.' : e instanceof Error ? e.message : String(e);
    await db.query('UPDATE ad_accounts SET last_error=$3 WHERE id=$1 AND org_id=$2', [id, orgId, msg]);
    if (e instanceof HttpError) throw e;
    throw badRequest(rateLimited(e) ? 'Meta asked us to slow down. Try again in a few minutes.' : msg);
  };
  try {
    const node = await graph<AccountNode>(user(token), `/${a.account_id}`, { fields: 'name,currency' });
    await db.query('UPDATE ad_accounts SET name=COALESCE($3,name), currency=COALESCE($4,currency) WHERE id=$1 AND org_id=$2', [id, orgId, node.name ?? null, node.currency ?? null]);
    const until = new Date();
    const since = new Date(Date.now() - (WINDOW_DAYS - 1) * 86_400_000);
    let after = '';
    let days = 0;
    for (let page = 0; page < 40; page++) {
      const r = await graph<{ data?: InsightRow[]; paging?: { cursors?: { after?: string }; next?: string } }>(user(token), `/${a.account_id}/insights`, {
        level: 'campaign', time_increment: 1, time_range: JSON.stringify({ since: ymd(since), until: ymd(until) }),
        fields: 'campaign_id,campaign_name,spend,impressions,reach,clicks,actions', limit: 500, ...(after ? { after } : {}),
      });
      for (const row of r.data ?? []) {
        if (!row.campaign_id || !row.date_start) continue;
        const actions: Record<string, number> = {};
        for (const x of row.actions ?? []) if (x.action_type) actions[x.action_type] = toNum(x.value);
        await db.query(
          `INSERT INTO ad_days (ad_account_id, campaign_id, campaign_name, day, spend, impressions, reach, clicks, actions)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
           ON CONFLICT (ad_account_id, campaign_id, day) DO UPDATE SET campaign_name=EXCLUDED.campaign_name, spend=EXCLUDED.spend, impressions=EXCLUDED.impressions,
             reach=EXCLUDED.reach, clicks=EXCLUDED.clicks, actions=EXCLUDED.actions`,
          [id, row.campaign_id, (row.campaign_name ?? '').slice(0, 200), row.date_start, toNum(row.spend), Math.round(toNum(row.impressions)), Math.round(toNum(row.reach)), Math.round(toNum(row.clicks)), JSON.stringify(actions)],
        );
        days++;
      }
      after = r.paging?.next ? (r.paging.cursors?.after ?? '') : '';
      if (!after || !r.data?.length) break;
    }
    await db.query(`UPDATE ad_accounts SET last_synced_at=now(), last_error='' WHERE id=$1 AND org_id=$2`, [id, orgId]);
    return { account: presentAccount(await loadAccount(orgId, id)), days };
  } catch (e) {
    return fail(e);
  }
}

// ---- reading what was stored ----------------------------------------------------------------------------------

interface DayRow {
  campaign_id: string;
  campaign_name: string;
  day: string;
  spend: number;
  impressions: number;
  clicks: number;
  actions: Record<string, number>;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The result a set of days is best described by: the first kind in the list that happened at all, and how many. */
export function resultOf(rows: Pick<DayRow, 'actions'>[]): { label: string; count: number } | null {
  for (const [type, label] of RESULT_TYPES) {
    const count = rows.reduce((s, r) => s + (r.actions?.[type] ?? 0), 0);
    if (count > 0) return { label, count };
  }
  return null;
}

/** Spend and results for the last 7, 30 or 90 days, by campaign and by day. */
export async function adOverview(orgId: string, id: string, days: number) {
  const a = await loadAccount(orgId, id);
  const window = [7, 30, 90].includes(days) ? days : 30;
  const { rows } = await getDb().query<DayRow>(
    `SELECT campaign_id, campaign_name, day::text AS day, spend, impressions, clicks, actions FROM ad_days WHERE ad_account_id=$1 AND day >= CURRENT_DATE - $2::int + 1 ORDER BY day`, [id, window]);
  const byCampaign = new Map<string, DayRow[]>();
  for (const r of rows) byCampaign.set(r.campaign_id, [...(byCampaign.get(r.campaign_id) ?? []), r]);
  const campaigns = [...byCampaign.entries()].map(([campaignId, list]) => {
    const spend = list.reduce((s, r) => s + r.spend, 0);
    const impressions = list.reduce((s, r) => s + r.impressions, 0);
    const clicks = list.reduce((s, r) => s + r.clicks, 0);
    const res = resultOf(list);
    return {
      campaignId,
      name: list[list.length - 1].campaign_name || campaignId,
      spend: round2(spend),
      impressions,
      clicks,
      ctr: impressions ? round2((clicks / impressions) * 100) : null,
      cpc: clicks ? round2(spend / clicks) : null,
      resultLabel: res?.label ?? null,
      results: res?.count ?? null,
      costPerResult: res ? round2(spend / res.count) : null,
    };
  }).sort((x, y) => y.spend - x.spend);
  const perDay = new Map<string, { spend: number; clicks: number; impressions: number }>();
  for (const r of rows) {
    const d = perDay.get(r.day) ?? { spend: 0, clicks: 0, impressions: 0 };
    d.spend += r.spend; d.clicks += r.clicks; d.impressions += r.impressions;
    perDay.set(r.day, d);
  }
  const spend = campaigns.reduce((s, c) => s + c.spend, 0);
  const impressions = campaigns.reduce((s, c) => s + c.impressions, 0);
  const clicks = campaigns.reduce((s, c) => s + c.clicks, 0);
  const withResults = campaigns.filter((c) => c.results);
  const results = withResults.reduce((s, c) => s + (c.results ?? 0), 0);
  const spendWithResults = withResults.reduce((s, c) => s + c.spend, 0);
  return {
    account: presentAccount(a),
    days: window,
    totals: {
      spend: round2(spend),
      impressions,
      clicks,
      ctr: impressions ? round2((clicks / impressions) * 100) : null,
      cpc: clicks ? round2(spend / clicks) : null,
      results: results || null,
      // blended over only the campaigns that got a result, so one with no tracked result does not distort it
      costPerResult: results ? round2(spendWithResults / results) : null,
      campaigns: campaigns.length,
    },
    daily: [...perDay.entries()].map(([day, d]) => ({ day, spend: round2(d.spend), clicks: d.clicks, impressions: d.impressions })),
    campaigns,
  };
}
