import { config } from '../config';
import { getDb } from '../ctx';
import { decryptSecret, encryptSecret, last4 } from '../lib/crypto';
import { badRequest, HttpError, notFound } from '../lib/errors';
import { logger } from '../logger';
import { inWorkspace, type Workspace } from './workspaces';

/**
 * Metrics: real numbers for Instagram accounts that are connected with their own access token ("Instagram API with Instagram Login").
 * Reading is free. Each sync stores a snapshot of every post's numbers, so growth over time can be drawn.
 * The token is kept encrypted and is never sent to the page.
 */

const REEL_METRICS = ['reach', 'views', 'likes', 'comments', 'saved', 'shares', 'reposts', 'total_interactions', 'ig_reels_avg_watch_time', 'ig_reels_video_view_total_time'];
const FEED_METRICS = ['reach', 'views', 'likes', 'comments', 'saved', 'shares', 'reposts', 'total_interactions', 'follows', 'profile_visits'];
const DEFAULT_POSTS = 40;
const MAX_POSTS = 100;

// ---- talking to Instagram -------------------------------------------------------------------------------------

export class GraphError extends Error {
  constructor(message: string, readonly code: number, readonly status: number) {
    super(message);
  }
}

/** Metrics a post's insights can return, as numbers. Anything else in the answer is ignored. */
export type PostMetrics = Record<string, number>;

/**
 * Where an account is read from. An "instagram" token goes to graph.instagram.com and the account is "me".
 * A "facebook" token (the Unified login kind that Meta gives newer apps) goes to graph.facebook.com and needs the account's own id.
 */
export interface Conn {
  api: 'instagram' | 'facebook';
  token: string;
  id: string;
}
const baseOf = (api: Conn['api']) => (api === 'facebook' ? config.facebookGraphBase : config.instagramGraphBase);
const connOf = (a: { api: Conn['api']; ig_user_id: string }, token: string): Conn => ({ api: a.api, token, id: a.api === 'facebook' ? a.ig_user_id : 'me' });

export async function graph<T = Record<string, unknown>>(c: Pick<Conn, 'api' | 'token'>, pathname: string, params: Record<string, string | number> = {}): Promise<T> {
  const token = c.token;
  const url = new URL(baseOf(c.api).replace(/\/$/, '') + pathname);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  url.searchParams.set('access_token', token);
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  } catch (e) {
    throw new HttpError(502, `Could not reach Instagram: ${(e as Error).message.replace(token, '***')}`, 'instagram_unreachable');
  }
  const body = (await res.json().catch(() => ({}))) as { error?: { message?: string; code?: number } } & T;
  if (!res.ok || body.error) {
    const e = body.error ?? {};
    // The token must never end up in a message, a log or the page.
    throw new GraphError(String(e.message ?? `HTTP ${res.status}`).split(token).join('***'), Number(e.code ?? 0), res.status);
  }
  return body;
}

/** Expired or revoked token (190), or the account lost the permission. */
export const tokenProblem = (e: unknown) => e instanceof GraphError && (e.code === 190 || e.code === 102 || e.status === 401);
/** Instagram asked the app to slow down. */
export const rateLimited = (e: unknown) => e instanceof GraphError && [4, 17, 32, 613, 80002].includes(e.code);

interface Profile {
  user_id?: string;
  id?: string;
  username?: string;
  name?: string;
  followers_count?: number;
  follows_count?: number;
  media_count?: number;
  profile_picture_url?: string;
}

interface MediaItem {
  id: string;
  caption?: string;
  media_type?: string;
  media_product_type?: string;
  permalink?: string;
  timestamp?: string;
  like_count?: number;
  comments_count?: number;
  thumbnail_url?: string;
  media_url?: string;
}

async function mediaList(c: Conn, limit: number): Promise<MediaItem[]> {
  const out: MediaItem[] = [];
  let after = '';
  while (out.length < limit) {
    const page = await graph<{ data?: MediaItem[]; paging?: { cursors?: { after?: string }; next?: string } }>(c, `/${c.id}/media`, {
      fields: 'id,caption,media_type,media_product_type,permalink,timestamp,like_count,comments_count,thumbnail_url,media_url',
      limit: Math.min(25, limit - out.length),
      ...(after ? { after } : {}),
    });
    out.push(...(page.data ?? []));
    after = page.paging?.next ? (page.paging.cursors?.after ?? '') : '';
    if (!after || !page.data?.length) break;
  }
  return out.slice(0, limit);
}

interface InsightRow {
  name: string;
  values?: { value?: number; end_time?: string }[];
  total_value?: { value?: number };
}

export function metricsFrom(rows: InsightRow[] | undefined): PostMetrics {
  const out: PostMetrics = {};
  for (const r of rows ?? []) {
    const v = r.values?.[0]?.value ?? r.total_value?.value;
    if (typeof v === 'number' && Number.isFinite(v)) out[r.name] = v;
  }
  return out;
}

/**
 * One post's insights. All the metrics in one call; if Instagram refuses one of them for this account or post type (the list
 * changes between versions), ask one at a time and remember the refused ones so later posts do not ask again.
 */
async function insightsFor(c: Conn, mediaId: string, wanted: string[], refused: Set<string>): Promise<PostMetrics> {
  const ask = wanted.filter((m) => !refused.has(m));
  if (ask.length === 0) return {};
  try {
    return metricsFrom((await graph<{ data?: InsightRow[] }>(c, `/${mediaId}/insights`, { metric: ask.join(',') })).data);
  } catch (e) {
    if (tokenProblem(e) || rateLimited(e) || !(e instanceof GraphError)) throw e;
  }
  const out: PostMetrics = {};
  for (const m of ask) {
    try {
      Object.assign(out, metricsFrom((await graph<{ data?: InsightRow[] }>(c, `/${mediaId}/insights`, { metric: m })).data));
    } catch (e) {
      if (tokenProblem(e) || rateLimited(e)) throw e;
      refused.add(m);
    }
  }
  return out;
}

// ---- accounts -------------------------------------------------------------------------------------------------

interface AccountRow {
  id: string;
  org_id: string;
  workspace_id: string | null;
  ig_user_id: string;
  api: Conn['api'];
  username: string;
  name: string;
  picture: string;
  followers: number | null;
  follows: number | null;
  media_count: number | null;
  token_cipher: string;
  token_last4: string;
  token_expires_at: string | Date | null;
  last_synced_at: string | Date | null;
  last_error: string;
  created_at: string | Date;
}

export const iso = (d: string | Date | null) => (d ? new Date(d).toISOString() : null);

const presentAccount = (a: AccountRow) => ({
  id: a.id,
  username: a.username,
  name: a.name,
  picture: a.picture,
  followers: a.followers,
  follows: a.follows,
  mediaCount: a.media_count,
  tokenLast4: a.token_last4,
  tokenExpiresAt: iso(a.token_expires_at),
  lastSyncedAt: iso(a.last_synced_at),
  lastError: a.last_error,
  connectedAt: iso(a.created_at),
});

async function loadAccount(orgId: string, id: string): Promise<AccountRow> {
  const { rows } = await getDb().query<AccountRow>('SELECT * FROM ig_accounts WHERE id=$1 AND org_id=$2', [id, orgId]);
  if (!rows[0]) throw notFound('Instagram account not found');
  return rows[0];
}

export async function listAccounts(orgId: string, ws: Workspace) {
  const params: unknown[] = [orgId];
  const { rows } = await getDb().query<AccountRow>(`SELECT a.* FROM ig_accounts a WHERE a.org_id=$1 AND ${inWorkspace(ws, 'a', params)} ORDER BY a.created_at`, params);
  return rows.map(presentAccount);
}

const tokenShape = /^[A-Za-z0-9_\-.]{20,600}$/;
const idShape = /^\d{5,25}$/;

/** Asks Instagram for a fresh 60 days on an Instagram-login token. It refuses tokens under a day old; that is fine, the old one still works. */
async function refreshToken(a: Pick<AccountRow, 'id' | 'token_expires_at'>, token: string): Promise<{ token: string; expiresAt: Date | null }> {
  try {
    const r = await graph<{ access_token?: string; expires_in?: number }>({ api: 'instagram', token }, '/refresh_access_token', { grant_type: 'ig_refresh_token' });
    const expiresAt = typeof r.expires_in === 'number' ? new Date(Date.now() + r.expires_in * 1000) : null;
    return { token: r.access_token || token, expiresAt };
  } catch (e) {
    logger.info('instagram: token not refreshed', { account: a.id, reason: (e as Error).message.slice(0, 120) });
    return { token, expiresAt: a.token_expires_at ? new Date(a.token_expires_at) : null };
  }
}

const PROFILE_FIELDS = 'username,name,followers_count,follows_count,media_count,profile_picture_url';
const profileOf = (c: Conn) => graph<Profile>(c, `/${c.id}`, { fields: c.api === 'instagram' ? `user_id,${PROFILE_FIELDS}` : `id,${PROFILE_FIELDS}` });

type Found = { api: Conn['api']; id: string; me: Profile };

/** An Instagram-login token knows whose it is. */
async function viaInstagram(token: string): Promise<Found[]> {
  const me = await profileOf({ api: 'instagram', token, id: 'me' });
  const id = me.user_id ?? me.id;
  if (!id || !me.username) throw badRequest('Instagram did not say whose token this is. Make sure it is for a professional (Business or Creator) account.');
  return [{ api: 'instagram', id, me }];
}

/**
 * A Facebook-side token (what Meta's Unified login gives newer apps) is asked which Instagram accounts it can reach, one per Page
 * they are connected to, unless the account's id is given. One such token can serve several accounts.
 */
async function viaFacebook(token: string, igUserId?: string): Promise<Found[]> {
  let ids: string[];
  if (igUserId) ids = [igUserId];
  else {
    const r = await graph<{ data?: { instagram_business_account?: { id?: string } }[] }>({ api: 'facebook', token }, '/me/accounts', { fields: 'instagram_business_account{id}', limit: 100 });
    ids = [...new Set((r.data ?? []).map((p) => p.instagram_business_account?.id).filter((x): x is string => !!x))];
    if (ids.length === 0) throw badRequest('That token works, but it could not find an Instagram account on its own. Paste the Instagram account ID too (Meta Business Settings, Accounts, Instagram accounts).');
  }
  const out: Found[] = [];
  for (const id of ids) {
    const me = await profileOf({ api: 'facebook', token, id });
    if (!me.username) throw badRequest(`Instagram did not return an account for ID ${id}. Check the number, and that the account is Business or Creator.`);
    out.push({ api: 'facebook', id: me.id ?? id, me });
  }
  return out;
}

/** Checks the token works, keeps it (encrypted) and reads each account it reaches for the first time. */
export async function connectAccount(orgId: string, ws: Workspace, rawToken: string, igUserId?: string) {
  const token = rawToken.trim();
  const given = igUserId?.trim() || undefined;
  if (!tokenShape.test(token)) throw badRequest('That does not look like an access token. Paste only the token itself, with no spaces or quotes.');
  if (given && !idShape.test(given)) throw badRequest('The Instagram account ID is a number of 15 to 17 digits. Paste only the number.');
  // Instagram-login tokens start with IG; try the matching side first so the other side's complaint is not what the person reads
  const attempts = (token.startsWith('IG') && !given ? [viaInstagram, viaFacebook] : [viaFacebook, viaInstagram]) as ((t: string, id?: string) => Promise<Found[]>)[];
  let found: Found[] | null = null;
  let firstError: unknown;
  for (const attempt of attempts) {
    try {
      found = await attempt(token, given);
      break;
    } catch (e) {
      firstError ??= e;
      if (!(e instanceof GraphError) && !(e instanceof HttpError && e.status < 500)) throw e;
    }
  }
  if (!found) {
    if (firstError instanceof GraphError) throw badRequest(`Instagram did not accept that token: ${firstError.message}`);
    throw firstError;
  }
  const results = [];
  for (const f of found) {
    const { rows } = await getDb().query<AccountRow>(
      `INSERT INTO ig_accounts (org_id, workspace_id, ig_user_id, api, username, name, picture, followers, follows, media_count, token_cipher, token_last4)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (org_id, ig_user_id) DO UPDATE SET workspace_id=EXCLUDED.workspace_id, api=EXCLUDED.api, username=EXCLUDED.username, name=EXCLUDED.name, picture=EXCLUDED.picture,
         followers=EXCLUDED.followers, follows=EXCLUDED.follows, media_count=EXCLUDED.media_count, token_cipher=EXCLUDED.token_cipher, token_last4=EXCLUDED.token_last4, last_error=''
       RETURNING *`,
      [orgId, ws.id, f.id, f.api, f.me.username, f.me.name ?? '', f.me.profile_picture_url ?? '', f.me.followers_count ?? null, f.me.follows_count ?? null, f.me.media_count ?? null, encryptSecret(token), last4(token)],
    );
    const acct = rows[0];
    if (f.api === 'instagram') {
      const fresh = await refreshToken(acct, token);
      await getDb().query('UPDATE ig_accounts SET token_cipher=$3, token_last4=$4, token_expires_at=$5 WHERE id=$1 AND org_id=$2', [acct.id, orgId, encryptSecret(fresh.token), last4(fresh.token), fresh.expiresAt]);
    }
    // one account failing to read must not hide the others that connected
    try {
      results.push(await syncAccount(orgId, acct.id));
    } catch (e) {
      results.push({ account: presentAccount(await loadAccount(orgId, acct.id)), posts: 0, withoutInsights: [] as string[], error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { accounts: results };
}

export async function removeAccount(orgId: string, id: string) {
  const { rowCount } = await getDb().query('DELETE FROM ig_accounts WHERE id=$1 AND org_id=$2', [id, orgId]);
  if (rowCount === 0) throw notFound('Instagram account not found');
}

// ---- syncing --------------------------------------------------------------------------------------------------

export async function pool<T>(items: T[], width: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, async () => { while (next < items.length) await work(items[next++]); }));
}

export const sameMetrics = (a: PostMetrics, b: PostMetrics) => {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
};

export const inDays = (d: number) => new Date(Date.now() + d * 86_400_000);

/** Reads the profile, the newest posts and each post's insights, and stores a snapshot where the numbers changed. */
export async function syncAccount(orgId: string, id: string, o: { posts?: number } = {}) {
  const db = getDb();
  let a = await loadAccount(orgId, id);
  let token = decryptSecret(a.token_cipher);
  const conn = (): Conn => connOf(a, token);
  const fail = async (e: unknown): Promise<never> => {
    const msg = tokenProblem(e) ? 'Instagram no longer accepts this token (it expired or was revoked). Connect the account again with a new token.' : e instanceof Error ? e.message : String(e);
    await db.query('UPDATE ig_accounts SET last_error=$3 WHERE id=$1 AND org_id=$2', [id, orgId, msg]);
    if (e instanceof HttpError) throw e;
    throw badRequest(rateLimited(e) ? 'Instagram asked us to slow down. Try again in a few minutes.' : msg);
  };
  try {
    // keep an Instagram-login token alive: refresh when its expiry is unknown or near (Facebook-side system tokens do not expire)
    if (a.api === 'instagram' && (!a.token_expires_at || new Date(a.token_expires_at).getTime() < inDays(14).getTime())) {
      const fresh = await refreshToken(a, token);
      token = fresh.token;
      await db.query('UPDATE ig_accounts SET token_cipher=$3, token_last4=$4, token_expires_at=$5 WHERE id=$1 AND org_id=$2', [id, orgId, encryptSecret(token), last4(token), fresh.expiresAt]);
    }
    const me = await profileOf(conn());
    await db.query('UPDATE ig_accounts SET username=COALESCE($3,username), name=$4, picture=$5, followers=$6, follows=$7, media_count=$8 WHERE id=$1 AND org_id=$2', [
      id, orgId, me.username ?? null, me.name ?? '', me.profile_picture_url ?? '', me.followers_count ?? null, me.follows_count ?? null, me.media_count ?? null,
    ]);
    if (typeof me.followers_count === 'number') {
      await db.query(`INSERT INTO ig_account_days (account_id, day, followers) VALUES ($1, CURRENT_DATE, $2) ON CONFLICT (account_id, day) DO UPDATE SET followers=EXCLUDED.followers`, [id, me.followers_count]);
    }

    const media = await mediaList(conn(), Math.min(MAX_POSTS, Math.max(5, o.posts ?? DEFAULT_POSTS)));
    const refused = { reel: new Set<string>(), feed: new Set<string>() };
    let updated = 0;
    await pool(media, 4, async (m) => {
      const reel = m.media_product_type === 'REELS';
      const insights = await insightsFor(conn(), m.id, reel ? REEL_METRICS : FEED_METRICS, reel ? refused.reel : refused.feed);
      // the listing's own counts are the fallback when insights are not available for a post
      const metrics: PostMetrics = { ...(typeof m.like_count === 'number' ? { likes: m.like_count } : {}), ...(typeof m.comments_count === 'number' ? { comments: m.comments_count } : {}), ...insights };
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO ig_posts (account_id, media_id, permalink, caption, media_type, product_type, thumb_url, posted_at, metrics, synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb, now())
         ON CONFLICT (account_id, media_id) DO UPDATE SET permalink=EXCLUDED.permalink, caption=EXCLUDED.caption, media_type=EXCLUDED.media_type, product_type=EXCLUDED.product_type,
           thumb_url=EXCLUDED.thumb_url, metrics=EXCLUDED.metrics, synced_at=now()
         RETURNING id`,
        [id, m.id, m.permalink ?? '', (m.caption ?? '').slice(0, 2200), m.media_type ?? '', m.media_product_type ?? '', m.thumbnail_url ?? (m.media_type === 'IMAGE' ? (m.media_url ?? '') : ''), m.timestamp ? new Date(m.timestamp) : null, JSON.stringify(metrics)],
      );
      const last = await db.query<{ metrics: PostMetrics }>('SELECT metrics FROM ig_snapshots WHERE post_id=$1 ORDER BY taken_at DESC LIMIT 1', [rows[0].id]);
      if (!last.rows[0] || !sameMetrics(last.rows[0].metrics, metrics)) {
        await db.query('INSERT INTO ig_snapshots (post_id, metrics) VALUES ($1,$2::jsonb)', [rows[0].id, JSON.stringify(metrics)]);
      }
      updated++;
    });

    // reach for the account, a day at a time (best effort: it needs the insights permission and enough followers)
    try {
      const since = Math.floor(Date.now() / 1000) - 28 * 86_400;
      const r = await graph<{ data?: InsightRow[] }>(conn(), `/${conn().id}/insights`, { metric: 'reach', period: 'day', since, until: Math.floor(Date.now() / 1000) });
      for (const v of r.data?.[0]?.values ?? []) {
        if (typeof v.value !== 'number' || !v.end_time) continue;
        // Instagram stamps a day by when it ends; the day itself is the one before
        const day = new Date(new Date(v.end_time).getTime() - 12 * 3_600_000).toISOString().slice(0, 10);
        await db.query(`INSERT INTO ig_account_days (account_id, day, reach) VALUES ($1,$2,$3) ON CONFLICT (account_id, day) DO UPDATE SET reach=EXCLUDED.reach`, [id, day, v.value]);
      }
    } catch (e) {
      if (tokenProblem(e) || rateLimited(e)) throw e;
      logger.info('instagram: account reach not available', { account: id, reason: (e as Error).message.slice(0, 120) });
    }

    await db.query(`UPDATE ig_accounts SET last_synced_at=now(), last_error='' WHERE id=$1 AND org_id=$2`, [id, orgId]);
    a = await loadAccount(orgId, id);
    return { account: presentAccount(a), posts: updated, withoutInsights: [...new Set([...refused.reel, ...refused.feed])].sort() };
  } catch (e) {
    return fail(e);
  }
}

// ---- reading what was stored ----------------------------------------------------------------------------------

interface PostRow {
  id: string;
  account_id: string;
  media_id: string;
  permalink: string;
  caption: string;
  media_type: string;
  product_type: string;
  thumb_url: string;
  posted_at: string | Date | null;
  metrics: PostMetrics;
}

/** Likes, comments, saves and shares as a share of the people reached. Null until reach is known. */
export function engagementRate(m: PostMetrics): number | null {
  const reach = m.reach;
  if (!reach || reach <= 0) return null;
  const sum = (m.likes ?? 0) + (m.comments ?? 0) + (m.saved ?? 0) + (m.shares ?? 0);
  return Math.round((sum / reach) * 10_000) / 100;
}

const presentPost = (p: PostRow) => ({
  id: p.id,
  mediaId: p.media_id,
  permalink: p.permalink,
  caption: p.caption,
  type: p.product_type === 'REELS' ? 'Reel' : p.media_type === 'CAROUSEL_ALBUM' ? 'Carousel' : p.media_type === 'VIDEO' ? 'Video' : 'Photo',
  thumb: p.thumb_url,
  postedAt: iso(p.posted_at),
  metrics: p.metrics,
  engagement: engagementRate(p.metrics),
});

const SORTS: Record<string, (p: ReturnType<typeof presentPost>) => number> = {
  recent: (p) => (p.postedAt ? Date.parse(p.postedAt) : 0),
  reach: (p) => p.metrics.reach ?? -1,
  views: (p) => p.metrics.views ?? -1,
  likes: (p) => p.metrics.likes ?? -1,
  comments: (p) => p.metrics.comments ?? -1,
  saved: (p) => p.metrics.saved ?? -1,
  shares: (p) => p.metrics.shares ?? -1,
  engagement: (p) => p.engagement ?? -1,
};
export const SORT_KEYS = Object.keys(SORTS);

export async function listPosts(orgId: string, id: string, o: { sort?: string; type?: string }) {
  await loadAccount(orgId, id);
  const { rows } = await getDb().query<PostRow>('SELECT * FROM ig_posts WHERE account_id=$1 ORDER BY posted_at DESC NULLS LAST LIMIT 200', [id]);
  let posts = rows.map(presentPost);
  if (o.type) posts = posts.filter((p) => p.type === o.type);
  const by = SORTS[o.sort ?? 'recent'] ?? SORTS.recent;
  return posts.sort((a, b) => by(b) - by(a));
}

export async function getPost(orgId: string, postId: string) {
  const { rows } = await getDb().query<PostRow & { org_id: string }>('SELECT p.*, a.org_id FROM ig_posts p JOIN ig_accounts a ON a.id=p.account_id WHERE p.id=$1', [postId]);
  if (!rows[0] || rows[0].org_id !== orgId) throw notFound('Post not found');
  const snaps = await getDb().query<{ taken_at: string | Date; metrics: PostMetrics }>('SELECT taken_at, metrics FROM ig_snapshots WHERE post_id=$1 ORDER BY taken_at', [postId]);
  return { ...presentPost(rows[0]), snapshots: snaps.rows.map((s) => ({ takenAt: iso(s.taken_at)!, metrics: s.metrics })) };
}

const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);

/** The headline numbers: followers over time, reach over time, and how recent posts are doing. */
export async function overview(orgId: string, id: string) {
  const a = await loadAccount(orgId, id);
  const days = await getDb().query<{ day: string; followers: number | null; reach: number | null }>(
    `SELECT day::text AS day, followers, reach FROM ig_account_days WHERE account_id=$1 AND day >= CURRENT_DATE - 90 ORDER BY day`, [id]);
  const posts = await listPosts(orgId, id, { sort: 'recent' });
  const cutoff = Date.now() - 30 * 86_400_000;
  const recent = posts.filter((p) => p.postedAt && Date.parse(p.postedAt) >= cutoff);
  const withReach = recent.filter((p) => typeof p.metrics.reach === 'number');
  const rates = recent.map((p) => p.engagement).filter((x): x is number => x !== null);
  const followed = days.rows.filter((d) => d.followers !== null);
  const best = [...posts].filter((p) => typeof p.metrics.reach === 'number').sort((x, y) => (y.metrics.reach ?? 0) - (x.metrics.reach ?? 0))[0] ?? null;
  return {
    account: presentAccount(a),
    days: days.rows,
    followerChange: followed.length >= 2 ? (followed[followed.length - 1].followers ?? 0) - (followed[0].followers ?? 0) : null,
    followerSince: followed.length >= 2 ? followed[0].day : null,
    last30: { posts: recent.length, averageReach: avg(withReach.map((p) => p.metrics.reach as number)), averageEngagement: avg(rates), totalSaves: recent.reduce((s, p) => s + (p.metrics.saved ?? 0), 0), totalShares: recent.reduce((s, p) => s + (p.metrics.shares ?? 0), 0) },
    best,
  };
}
