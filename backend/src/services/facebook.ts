import { getDb } from '../ctx';
import { decryptSecret, encryptSecret, last4 } from '../lib/crypto';
import { badRequest, HttpError, notFound } from '../lib/errors';
import { logger } from '../logger';
import { graph, GraphError, iso, pool, rateLimited, tokenProblem, type PostMetrics } from './metrics';
import { inWorkspace, type Workspace } from './workspaces';

/**
 * Metrics for Facebook Pages, read with the same kind of token as Instagram (Meta's Unified login). Reading is free.
 * Post numbers use the names Instagram uses (reach, views, likes, comments, shares) so the two can sit side by side.
 * Meta retired the old "impressions" metrics, so views and unique viewers come from page_media_view and page_total_media_view_unique.
 */

/** Meta's current post metrics, and the names the page shows them under. */
const POST_METRICS: Record<string, string> = { post_media_view: 'views', post_total_media_view_unique: 'reach', post_clicks: 'clicks' };
const PAGE_DAY_METRICS = ['page_media_view', 'page_total_media_view_unique', 'page_post_engagements', 'page_daily_follows_unique'];
const DEFAULT_POSTS = 25;
const MAX_POSTS = 100;
const tokenShape = /^[A-Za-z0-9_\-.]{20,600}$/;
const idShape = /^\d{5,25}$/;

interface PageRow {
  id: string;
  org_id: string;
  workspace_id: string | null;
  page_id: string;
  name: string;
  picture: string;
  followers: number | null;
  token_cipher: string;
  token_last4: string;
  last_synced_at: string | Date | null;
  last_error: string;
  created_at: string | Date;
}

const presentPage = (p: PageRow) => ({
  id: p.id,
  pageId: p.page_id,
  name: p.name,
  picture: p.picture,
  followers: p.followers,
  tokenLast4: p.token_last4,
  lastSyncedAt: iso(p.last_synced_at),
  lastError: p.last_error,
  connectedAt: iso(p.created_at),
});

async function loadPage(orgId: string, id: string): Promise<PageRow> {
  const { rows } = await getDb().query<PageRow>('SELECT * FROM fb_pages WHERE id=$1 AND org_id=$2', [id, orgId]);
  if (!rows[0]) throw notFound('Facebook Page not found');
  return rows[0];
}

export async function listPages(orgId: string, ws: Workspace) {
  const params: unknown[] = [orgId];
  const { rows } = await getDb().query<PageRow>(`SELECT p.* FROM fb_pages p WHERE p.org_id=$1 AND ${inWorkspace(ws, 'p', params)} ORDER BY p.created_at`, params);
  return rows.map(presentPage);
}

interface PageNode {
  id?: string;
  name?: string;
  followers_count?: number;
  access_token?: string;
  picture?: { data?: { url?: string } };
}
/** Meta keeps changing which Page fields exist, so a read that is refused for a field is retried with fewer. */
const PAGE_FIELD_SETS = ['id,name,followers_count,picture{url}', 'id,name,picture{url}', 'id,name'];

async function readPage(token: string, path: string, listed = false): Promise<PageNode & { data?: PageNode[] }> {
  let last: unknown;
  for (const fields of PAGE_FIELD_SETS) {
    try {
      return await graph<PageNode & { data?: PageNode[] }>(user(token), path, { fields, ...(listed ? { limit: 100 } : {}) });
    } catch (e) {
      last = e;
      // only a refused field is worth another try with fewer; a bad token or a missing Page is not
      if (!(e instanceof GraphError) || e.code !== 100 || !/field/i.test(e.message)) throw e;
    }
  }
  throw last;
}

const user = (token: string) => ({ api: 'facebook' as const, token });

/** Page-level numbers need a Page token. Ask for one with the connecting token; if there is none, the connecting token is used as it is. */
async function pageTokenFor(token: string, pageId: string): Promise<string> {
  try {
    return (await graph<PageNode>(user(token), `/${pageId}`, { fields: 'access_token' })).access_token || token;
  } catch {
    return token;
  }
}

export async function connectPages(orgId: string, ws: Workspace, rawToken: string, pageId?: string) {
  const token = rawToken.trim();
  const given = pageId?.trim() || undefined;
  if (!tokenShape.test(token)) throw badRequest('That does not look like an access token. Paste only the token itself, with no spaces or quotes.');
  if (given && !idShape.test(given)) throw badRequest('The Facebook Page ID is a number. Paste only the number.');
  let nodes: PageNode[];
  try {
    if (given) nodes = [await readPage(token, `/${given}`)];
    else {
      const r = await readPage(token, '/me/accounts', true);
      nodes = r.data ?? [];
      if (nodes.length === 0) throw badRequest('That token works, but it could not find a Facebook Page on its own. Paste the Page ID too (Meta Business Settings, Accounts, Pages).');
    }
  } catch (e) {
    if (e instanceof GraphError) throw badRequest(`Facebook did not accept that: ${e.message}`);
    throw e;
  }
  const results = [];
  for (const n of nodes) {
    if (!n.id || !n.name) throw badRequest('Facebook did not return a Page for that ID. Check the number.');
    // An Instagram account or a person answers to an ID too, but has no Page posts. Say so now, before anything is saved.
    try {
      await graph(user(await pageTokenFor(token, n.id)), `/${n.id}/published_posts`, { limit: 1, fields: 'id' });
    } catch (e) {
      if (e instanceof GraphError && e.code === 100 && /nonexisting field/i.test(e.message)) {
        throw badRequest(`"${n.name}" is not a Facebook Page. That ID looks like an Instagram account or a personal profile. Use the Page's own ID (Meta Business Settings, Accounts, Pages), or leave the ID empty to find your Pages automatically.`);
      }
      // anything else (a permission, a rate limit) is dealt with when the Page is read
    }
    const { rows } = await getDb().query<PageRow>(
      `INSERT INTO fb_pages (org_id, workspace_id, page_id, name, picture, followers, token_cipher, token_last4)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (org_id, page_id) DO UPDATE SET workspace_id=EXCLUDED.workspace_id, name=EXCLUDED.name, picture=EXCLUDED.picture, followers=EXCLUDED.followers,
         token_cipher=EXCLUDED.token_cipher, token_last4=EXCLUDED.token_last4, last_error=''
       RETURNING *`,
      [orgId, ws.id, n.id, n.name, n.picture?.data?.url ?? '', n.followers_count ?? null, encryptSecret(token), last4(token)],
    );
    try {
      results.push(await syncPage(orgId, rows[0].id));
    } catch (e) {
      results.push({ page: presentPage(await loadPage(orgId, rows[0].id)), posts: 0, withoutInsights: [] as string[], error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { pages: results };
}

export async function removePage(orgId: string, id: string) {
  const { rowCount } = await getDb().query('DELETE FROM fb_pages WHERE id=$1 AND org_id=$2', [id, orgId]);
  if (rowCount === 0) throw notFound('Facebook Page not found');
}

interface FbPost {
  id: string;
  message?: string;
  created_time?: string;
  permalink_url?: string;
  full_picture?: string;
  status_type?: string;
  reactions?: { summary?: { total_count?: number } };
  comments?: { summary?: { total_count?: number } };
  shares?: { count?: number };
}

const POST_FIELDS = 'id,message,created_time,permalink_url,full_picture,status_type,reactions.limit(0).summary(true),comments.limit(0).summary(true),shares';

const kindOf = (status: string | undefined) => (/video/i.test(status ?? '') ? 'Video' : /photo/i.test(status ?? '') ? 'Photo' : /shared/i.test(status ?? '') ? 'Shared' : 'Post');

interface InsightRow {
  name: string;
  values?: { value?: number | Record<string, number>; end_time?: string }[];
}

const numberOf = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** All of a post's metrics in one call; if one is refused (Meta keeps changing the list), ask one at a time and remember the refusals. */
async function postInsights(token: string, postId: string, refused: Set<string>): Promise<PostMetrics> {
  const ask = Object.keys(POST_METRICS).filter((m) => !refused.has(m));
  const out: PostMetrics = {};
  const read = (rows: InsightRow[] | undefined) => {
    for (const r of rows ?? []) {
      const v = numberOf(r.values?.[0]?.value);
      if (v !== null && POST_METRICS[r.name]) out[POST_METRICS[r.name]] = v;
    }
  };
  if (ask.length === 0) return out;
  try {
    read((await graph<{ data?: InsightRow[] }>(user(token), `/${postId}/insights`, { metric: ask.join(',') })).data);
    return out;
  } catch (e) {
    if (tokenProblem(e) || rateLimited(e) || !(e instanceof GraphError)) throw e;
  }
  for (const m of ask) {
    try {
      read((await graph<{ data?: InsightRow[] }>(user(token), `/${postId}/insights`, { metric: m })).data);
    } catch (e) {
      if (tokenProblem(e) || rateLimited(e)) throw e;
      refused.add(m);
    }
  }
  return out;
}

/** Reads the Page, its newest posts with their numbers, and 28 days of the Page's own views, reach, engagement and follows. */
export async function syncPage(orgId: string, id: string, o: { posts?: number } = {}) {
  const db = getDb();
  const p = await loadPage(orgId, id);
  const connecting = decryptSecret(p.token_cipher);
  const fail = async (e: unknown): Promise<never> => {
    const msg = tokenProblem(e) ? 'Facebook no longer accepts this token. Connect the Page again with a new token.' : e instanceof Error ? e.message : String(e);
    await db.query('UPDATE fb_pages SET last_error=$3 WHERE id=$1 AND org_id=$2', [id, orgId, msg]);
    if (e instanceof HttpError) throw e;
    throw badRequest(rateLimited(e) ? 'Facebook asked us to slow down. Try again in a few minutes.' : msg);
  };
  try {
    const token = await pageTokenFor(connecting, p.page_id);
    const node = await readPage(token, `/${p.page_id}`);
    const followers = node.followers_count ?? null;
    await db.query('UPDATE fb_pages SET name=COALESCE($3,name), picture=$4, followers=$5 WHERE id=$1 AND org_id=$2', [id, orgId, node.name ?? null, node.picture?.data?.url ?? '', followers]);
    if (followers !== null) await db.query(`INSERT INTO fb_page_days (page_id, day, followers) VALUES ($1, CURRENT_DATE, $2) ON CONFLICT (page_id, day) DO UPDATE SET followers=EXCLUDED.followers`, [id, followers]);

    const want = Math.min(MAX_POSTS, Math.max(5, o.posts ?? DEFAULT_POSTS));
    const posts: FbPost[] = [];
    let after = '';
    while (posts.length < want) {
      const page = await graph<{ data?: FbPost[]; paging?: { cursors?: { after?: string }; next?: string } }>(user(token), `/${p.page_id}/published_posts`, {
        fields: POST_FIELDS, limit: Math.min(25, want - posts.length), ...(after ? { after } : {}),
      });
      posts.push(...(page.data ?? []));
      after = page.paging?.next ? (page.paging.cursors?.after ?? '') : '';
      if (!after || !page.data?.length) break;
    }
    const refused = new Set<string>();
    let updated = 0;
    await pool(posts.slice(0, want), 4, async (m) => {
      const insights = await postInsights(token, m.id, refused);
      const metrics: PostMetrics = {
        ...(numberOf(m.reactions?.summary?.total_count) !== null ? { likes: m.reactions!.summary!.total_count! } : {}),
        ...(numberOf(m.comments?.summary?.total_count) !== null ? { comments: m.comments!.summary!.total_count! } : {}),
        shares: m.shares?.count ?? 0,
        ...insights,
      };
      await db.query(
        `INSERT INTO fb_posts (page_id, post_id, permalink, message, kind, picture, posted_at, metrics, synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb, now())
         ON CONFLICT (page_id, post_id) DO UPDATE SET permalink=EXCLUDED.permalink, message=EXCLUDED.message, kind=EXCLUDED.kind, picture=EXCLUDED.picture, metrics=EXCLUDED.metrics, synced_at=now()`,
        [id, m.id, m.permalink_url ?? '', (m.message ?? '').slice(0, 2200), kindOf(m.status_type), m.full_picture ?? '', m.created_time ? new Date(m.created_time) : null, JSON.stringify(metrics)],
      );
      updated++;
    });

    // the Page's own numbers by day (best effort: Pages with under 100 likes get no insights)
    try {
      const now = Math.floor(Date.now() / 1000);
      const r = await graph<{ data?: InsightRow[] }>(user(token), `/${p.page_id}/insights`, { metric: PAGE_DAY_METRICS.join(','), period: 'day', since: now - 28 * 86_400, until: now });
      const col: Record<string, string> = { page_media_view: 'views', page_total_media_view_unique: 'reach', page_post_engagements: 'engagements', page_daily_follows_unique: 'new_follows' };
      for (const row of r.data ?? []) {
        const c = col[row.name];
        if (!c) continue;
        for (const v of row.values ?? []) {
          const n = numberOf(v.value);
          if (n === null || !v.end_time) continue;
          const day = new Date(new Date(v.end_time).getTime() - 12 * 3_600_000).toISOString().slice(0, 10);
          await db.query(`INSERT INTO fb_page_days (page_id, day, ${c}) VALUES ($1,$2,$3) ON CONFLICT (page_id, day) DO UPDATE SET ${c}=EXCLUDED.${c}`, [id, day, n]);
        }
      }
    } catch (e) {
      if (tokenProblem(e) || rateLimited(e)) throw e;
      logger.info('facebook: page insights not available', { page: id, reason: (e as Error).message.slice(0, 120) });
    }

    await db.query(`UPDATE fb_pages SET last_synced_at=now(), last_error='' WHERE id=$1 AND org_id=$2`, [id, orgId]);
    return { page: presentPage(await loadPage(orgId, id)), posts: updated, withoutInsights: [...refused].map((m) => POST_METRICS[m]).sort() };
  } catch (e) {
    return fail(e);
  }
}

// ---- reading what was stored ----------------------------------------------------------------------------------

interface PostRow {
  id: string;
  page_id: string;
  post_id: string;
  permalink: string;
  message: string;
  kind: string;
  picture: string;
  posted_at: string | Date | null;
  metrics: PostMetrics;
}

/** Reactions, comments and shares as a share of the people reached. Null until reach is known. */
export function fbEngagement(m: PostMetrics): number | null {
  if (!m.reach || m.reach <= 0) return null;
  return Math.round((((m.likes ?? 0) + (m.comments ?? 0) + (m.shares ?? 0)) / m.reach) * 10_000) / 100;
}

const presentPost = (p: PostRow) => ({
  id: p.id,
  postId: p.post_id,
  permalink: p.permalink,
  message: p.message,
  type: p.kind,
  thumb: p.picture,
  postedAt: iso(p.posted_at),
  metrics: p.metrics,
  engagement: fbEngagement(p.metrics),
});

const SORTS: Record<string, (p: ReturnType<typeof presentPost>) => number> = {
  recent: (p) => (p.postedAt ? Date.parse(p.postedAt) : 0),
  reach: (p) => p.metrics.reach ?? -1,
  views: (p) => p.metrics.views ?? -1,
  likes: (p) => p.metrics.likes ?? -1,
  comments: (p) => p.metrics.comments ?? -1,
  shares: (p) => p.metrics.shares ?? -1,
  clicks: (p) => p.metrics.clicks ?? -1,
  engagement: (p) => p.engagement ?? -1,
};
export const FB_SORT_KEYS = Object.keys(SORTS);

export async function listFbPosts(orgId: string, id: string, o: { sort?: string }) {
  await loadPage(orgId, id);
  const { rows } = await getDb().query<PostRow>('SELECT * FROM fb_posts WHERE page_id=$1 ORDER BY posted_at DESC NULLS LAST LIMIT 200', [id]);
  const by = SORTS[o.sort ?? 'recent'] ?? SORTS.recent;
  return rows.map(presentPost).sort((a, b) => by(b) - by(a));
}

const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);

export async function pageOverview(orgId: string, id: string) {
  const p = await loadPage(orgId, id);
  const days = await getDb().query<{ day: string; followers: number | null; views: number | null; reach: number | null; engagements: number | null; new_follows: number | null }>(
    `SELECT day::text AS day, followers, views, reach, engagements, new_follows FROM fb_page_days WHERE page_id=$1 AND day >= CURRENT_DATE - 90 ORDER BY day`, [id]);
  const posts = await listFbPosts(orgId, id, {});
  const cutoff = Date.now() - 30 * 86_400_000;
  const recent = posts.filter((x) => x.postedAt && Date.parse(x.postedAt) >= cutoff);
  const last30 = days.rows.filter((d) => Date.parse(`${d.day}T12:00:00`) >= cutoff);
  const sum = (k: 'views' | 'engagements' | 'new_follows') => last30.reduce((s, d) => s + (d[k] ?? 0), 0);
  const followed = days.rows.filter((d) => d.followers !== null);
  const best = [...posts].filter((x) => typeof x.metrics.reach === 'number').sort((a, b) => (b.metrics.reach ?? 0) - (a.metrics.reach ?? 0))[0] ?? null;
  return {
    page: presentPage(p),
    days: days.rows,
    followerChange: followed.length >= 2 ? (followed[followed.length - 1].followers ?? 0) - (followed[0].followers ?? 0) : null,
    followerSince: followed.length >= 2 ? followed[0].day : null,
    last30: {
      posts: recent.length,
      views: last30.some((d) => d.views !== null) ? sum('views') : null,
      engagements: last30.some((d) => d.engagements !== null) ? sum('engagements') : null,
      newFollows: last30.some((d) => d.new_follows !== null) ? sum('new_follows') : null,
      averageReach: avg(recent.filter((x) => typeof x.metrics.reach === 'number').map((x) => x.metrics.reach)),
      averageEngagement: avg(recent.map((x) => x.engagement).filter((x): x is number => x !== null)),
    },
    best,
  };
}
