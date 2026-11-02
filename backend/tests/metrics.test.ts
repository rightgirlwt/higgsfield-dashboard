import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { config } from '../src/config';
import { setDb } from '../src/ctx';
import { createDb, type Db } from '../src/db';
import { migrate } from '../src/db/migrations';
import { seedDemo } from '../src/db/seed';
import { engagementRate, metricsFrom } from '../src/services/metrics';

const GOOD = 'IGAAtestTOKENgood0123456789abcdef';
const DAY = 86_400_000;
const ago = (d: number) => new Date(Date.now() - d * DAY).toISOString();

/** A stand-in for graph.instagram.com. Every request is written down so the tests can see exactly what was asked. */
const fake = {
  token: GOOD,
  followers: 1200,
  requests: [] as { path: string; metric?: string }[],
  reelReach: 5000,
  expired: false,
  media: [
    { id: 'm1', caption: 'Reel one', media_type: 'VIDEO', media_product_type: 'REELS', permalink: 'https://www.instagram.com/reel/m1/', timestamp: ago(3), like_count: 120, comments_count: 14, thumbnail_url: 'https://cdn.example/m1.jpg' },
    { id: 'm2', caption: 'A photo', media_type: 'IMAGE', media_product_type: 'FEED', permalink: 'https://www.instagram.com/p/m2/', timestamp: ago(6), like_count: 40, comments_count: 2, media_url: 'https://cdn.example/m2.jpg' },
    { id: 'm3', caption: 'Old carousel', media_type: 'CAROUSEL_ALBUM', media_product_type: 'FEED', permalink: 'https://www.instagram.com/p/m3/', timestamp: ago(80), like_count: 10, comments_count: 0, media_url: 'https://cdn.example/m3.jpg' },
  ],
};
const insightsOf = (id: string, metric: string[]) => {
  const reel = id === 'm1';
  const all: Record<string, number> = reel
    ? { reach: fake.reelReach, views: 9000, likes: 120, comments: 14, saved: 60, shares: 30, reposts: 2, total_interactions: 226, ig_reels_avg_watch_time: 4100, ig_reels_video_view_total_time: 900000 }
    : id === 'm2'
      ? { reach: 800, views: 1000, likes: 40, comments: 2, saved: 5, shares: 1, reposts: 0, total_interactions: 48, follows: 3, profile_visits: 9 }
      : { reach: 300, views: 400, likes: 10, comments: 0, saved: 1, shares: 0, reposts: 0, total_interactions: 11, follows: 0, profile_visits: 1 };
  // this account is refused two metrics, the way a real one can be: the reels watch time and a feed post's "reposts"
  const refused = (m: string) => (reel && m === 'ig_reels_avg_watch_time') || (!reel && m === 'reposts');
  if (metric.some(refused)) return { error: { message: `(#100) The ${metric.find(refused)} metric is not supported for this media`, code: 100 } };
  return { data: metric.map((m) => ({ name: m, period: 'lifetime', values: [{ value: all[m] }] })) };
};

let graphServer: http.Server;
beforeAll(async () => {
  graphServer = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    const send = (code: number, body: unknown) => (res.writeHead(code, { 'content-type': 'application/json' }), res.end(JSON.stringify(body)));
    fake.requests.push({ path: u.pathname, metric: u.searchParams.get('metric') ?? undefined });
    if (fake.expired || u.searchParams.get('access_token') !== fake.token) return send(400, { error: { message: `Invalid OAuth access token ${u.searchParams.get('access_token')}`, type: 'OAuthException', code: 190 } });
    if (u.pathname === '/me') return send(200, { user_id: '17841400000000001', username: 'rightgirlmedia', name: 'Right Girl Media', followers_count: fake.followers, follows_count: 300, media_count: 3, profile_picture_url: 'https://cdn.example/p.jpg' });
    if (u.pathname === '/refresh_access_token') return send(200, { access_token: fake.token, token_type: 'bearer', expires_in: 5_184_000 });
    if (u.pathname === '/me/media') {
      const after = u.searchParams.get('after');
      const limit = Number(u.searchParams.get('limit') ?? 25);
      // two pages, so paging is exercised
      const page = after ? fake.media.slice(2) : fake.media.slice(0, Math.min(2, limit));
      return send(200, { data: page, paging: after || fake.media.length <= 2 ? {} : { cursors: { after: 'c2' }, next: 'https://graph.instagram.com/next-page-url-with-token' } });
    }
    if (u.pathname === '/me/insights') {
      const end = (d: number) => new Date(Date.now() - d * DAY + 12 * 3_600_000).toISOString();
      return send(200, { data: [{ name: 'reach', period: 'day', values: [{ value: 700, end_time: end(2) }, { value: 900, end_time: end(1) }] }] });
    }
    const m = /^\/(m\d)\/insights$/.exec(u.pathname);
    if (m) return send(200, insightsOf(m[1], (u.searchParams.get('metric') ?? '').split(',')));
    return send(404, { error: { message: 'Unknown path', code: 803 } });
  });
  await new Promise<void>((r) => graphServer.listen(0, r));
  config.instagramGraphBase = `http://127.0.0.1:${(graphServer.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((r) => graphServer.close(r));
});

describe('Metrics, in small pieces', () => {
  it('reads each insight whether Instagram gives it as a value or a total, and ignores anything else', () => {
    expect(metricsFrom([{ name: 'reach', values: [{ value: 5 }] }, { name: 'follows', total_value: { value: 2 } }, { name: 'odd', values: [] }, { name: 'text', values: [{ value: 'x' as unknown as number }] }])).toEqual({ reach: 5, follows: 2 });
    expect(metricsFrom(undefined)).toEqual({});
  });

  it('works engagement out as likes, comments, saves and shares over the people reached', () => {
    expect(engagementRate({ reach: 1000, likes: 50, comments: 10, saved: 30, shares: 10 })).toBe(10);
    expect(engagementRate({ likes: 5 })).toBeNull(); // no reach known, so no rate
    expect(engagementRate({ reach: 0, likes: 5 })).toBeNull();
  });
});

describe('Metrics end to end, against a fake Instagram', () => {
  let db: Db;
  let server: http.Server;
  let base = '';
  let admin = '';
  let member = '';
  let accountId = '';
  const call = (token: string, method: string, url: string, body?: unknown) =>
    fetch(base + '/api' + url, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = async <T>(r: Response) => (await r.json()) as T;

  beforeAll(async () => {
    db = await createDb({ memory: true });
    setDb(db);
    await migrate(db);
    await seedDemo(db);
    server = http.createServer(createApp());
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const users = await json<{ role: string; token: string }[]>(await fetch(base + '/api/dev/users'));
    admin = users.find((u) => u.role === 'admin')!.token;
    member = users.find((u) => u.role === 'user')!.token;
  });
  afterAll(async () => {
    await new Promise((r) => server.close(r));
    await db.close();
  });

  it('refuses a bad token without echoing it, and only the admin can connect', async () => {
    const bad = await call(admin, 'POST', '/metrics/accounts', { token: 'IGAAwrongTOKEN0123456789abcdefgh' });
    expect(bad.status).toBe(400);
    const msg = (await json<{ error: { message: string } }>(bad)).error.message;
    expect(msg).toMatch(/did not accept that token/);
    expect(msg).not.toContain('IGAAwrongTOKEN');
    expect((await call(admin, 'POST', '/metrics/accounts', { token: 'has spaces in it and is long enough' })).status).toBe(400);
    expect((await call(member, 'POST', '/metrics/accounts', { token: GOOD })).status).toBe(403);
  });

  it('connects an account: checks the token, keeps it encrypted, reads the posts and their numbers', async () => {
    const res = await call(admin, 'POST', '/metrics/accounts', { token: GOOD });
    expect(res.status).toBe(201);
    const text = await res.text();
    expect(text).not.toContain(GOOD); // the token never goes back to the page
    const j = JSON.parse(text) as { account: { id: string; username: string; followers: number; tokenExpiresAt: string; tokenLast4: string }; posts: number; withoutInsights: string[] };
    accountId = j.account.id;
    expect(j.account).toMatchObject({ username: 'rightgirlmedia', followers: 1200, tokenLast4: GOOD.slice(-4) });
    expect(j.account.tokenExpiresAt).toBeTruthy(); // the refresh told us when it runs out
    expect(j.posts).toBe(3); // both pages were read
    // the reel's watch time and the photo's reposts were refused: asked for one by one, and remembered
    expect(j.withoutInsights).toEqual(['ig_reels_avg_watch_time', 'reposts']);
    const stored = (await db.query<{ token_cipher: string }>('SELECT token_cipher FROM ig_accounts WHERE id=$1', [accountId])).rows[0].token_cipher;
    expect(stored).not.toContain(GOOD);
  });

  it('keeps what each post earned, falling back to the listing counts, and works the rate out', async () => {
    const posts = await json<{ id: string; type: string; caption: string; thumb: string; metrics: Record<string, number>; engagement: number | null }[]>(await call(member, 'GET', `/metrics/accounts/${accountId}/posts`));
    expect(posts.map((p) => p.caption)).toEqual(['Reel one', 'A photo', 'Old carousel']);
    const reel = posts[0];
    expect(reel).toMatchObject({ type: 'Reel', thumb: 'https://cdn.example/m1.jpg' });
    expect(reel.metrics).toMatchObject({ reach: 5000, views: 9000, saved: 60, shares: 30, ig_reels_video_view_total_time: 900000 });
    expect(reel.metrics.ig_reels_avg_watch_time).toBeUndefined();
    expect(reel.engagement).toBe(4.48); // (120 + 14 + 60 + 30) / 5000
    expect(posts[1]).toMatchObject({ type: 'Photo', thumb: 'https://cdn.example/m2.jpg' });
    expect(posts[1].metrics.reposts).toBeUndefined();
    expect(posts[2].type).toBe('Carousel');
  });

  it('sorts and filters', async () => {
    const byReach = await json<{ caption: string }[]>(await call(member, 'GET', `/metrics/accounts/${accountId}/posts?sort=reach`));
    expect(byReach.map((p) => p.caption)).toEqual(['Reel one', 'A photo', 'Old carousel']);
    const byRate = await json<{ caption: string }[]>(await call(member, 'GET', `/metrics/accounts/${accountId}/posts?sort=engagement`));
    expect(byRate[0].caption).toBe('A photo'); // 6% of the people it reached, against the reel's 4.48%
    const reels = await json<unknown[]>(await call(member, 'GET', `/metrics/accounts/${accountId}/posts?type=Reel`));
    expect(reels).toHaveLength(1);
    expect((await call(member, 'GET', `/metrics/accounts/${accountId}/posts?sort=drop-table`)).status).toBe(400);
  });

  it('syncing again stores a new snapshot only for posts whose numbers moved, so growth can be drawn', async () => {
    fake.reelReach = 6500;
    fake.followers = 1260;
    const r = await call(member, 'POST', `/metrics/accounts/${accountId}/sync`, {}); // the Team can refresh
    expect(r.status).toBe(200);
    const posts = await json<{ id: string; caption: string }[]>(await call(member, 'GET', `/metrics/accounts/${accountId}/posts`));
    const reel = await json<{ snapshots: { metrics: { reach: number } }[] }>(await call(member, 'GET', `/metrics/posts/${posts[0].id}`));
    expect(reel.snapshots.map((s) => s.metrics.reach)).toEqual([5000, 6500]);
    const photo = await json<{ snapshots: unknown[] }>(await call(member, 'GET', `/metrics/posts/${posts[1].id}`));
    expect(photo.snapshots).toHaveLength(1); // nothing changed, nothing stored
  });

  it('shows the headline numbers: followers and reach by day, the last 30 days, the best post', async () => {
    const o = await json<{
      days: { day: string; followers: number | null; reach: number | null }[];
      last30: { posts: number; averageReach: number; averageEngagement: number; totalSaves: number; totalShares: number };
      best: { caption: string } | null;
      account: { followers: number };
    }>(await call(member, 'GET', `/metrics/accounts/${accountId}/overview`));
    expect(o.account.followers).toBe(1260);
    expect(o.days.some((d) => d.reach === 900)).toBe(true);
    expect(o.days[o.days.length - 1].followers).toBe(1260); // today's row was updated by the second sync
    expect(o.last30.posts).toBe(2); // the carousel is 80 days old
    expect(o.last30.averageReach).toBe(3650); // (6500 + 800) / 2
    expect(o.last30.totalSaves).toBe(65);
    expect(o.best?.caption).toBe('Reel one');
  });

  it('asks each insight for a post once it knows which ones are refused', async () => {
    fake.requests.length = 0;
    await call(member, 'POST', `/metrics/accounts/${accountId}/sync`, {});
    const asked = fake.requests.filter((q) => q.path === '/m1/insights').map((q) => q.metric ?? '');
    expect(asked.length).toBeGreaterThan(0);
    // a fresh sync does not know the refusals yet (they are per sync), so it asks together first and then one by one, which is the cost of not guessing
    expect(asked[0]).toContain('ig_reels_avg_watch_time');
  });

  it('says so when the token has expired, and remembers it', async () => {
    fake.expired = true;
    const r = await call(member, 'POST', `/metrics/accounts/${accountId}/sync`, {});
    expect(r.status).toBe(400);
    expect((await json<{ error: { message: string } }>(r)).error.message).toMatch(/no longer accepts this token/);
    const list = await json<{ lastError: string }[]>(await call(member, 'GET', '/metrics/accounts'));
    expect(list[0].lastError).toMatch(/Connect the account again/);
    fake.expired = false;
    expect((await call(member, 'POST', `/metrics/accounts/${accountId}/sync`, {})).status).toBe(200);
    expect(((await json<{ lastError: string }[]>(await call(member, 'GET', '/metrics/accounts')))[0]).lastError).toBe('');
  });

  it('disconnects an account and everything read from it, admin only', async () => {
    expect((await call(member, 'DELETE', `/metrics/accounts/${accountId}`)).status).toBe(403);
    expect((await call(admin, 'DELETE', `/metrics/accounts/${accountId}`)).status).toBe(204);
    expect((await db.query('SELECT 1 FROM ig_posts')).rows).toHaveLength(0);
    expect((await db.query('SELECT 1 FROM ig_snapshots')).rows).toHaveLength(0);
    expect((await call(member, 'GET', `/metrics/accounts/${accountId}/overview`)).status).toBe(404);
  });
});
