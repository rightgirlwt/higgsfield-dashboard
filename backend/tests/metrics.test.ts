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
const FB = 'EAABtestFACEBOOKtoken0123456789abcdef';
const DAY = 86_400_000;
const ago = (d: number) => new Date(Date.now() - d * DAY).toISOString();

/** A stand-in for graph.instagram.com. Every request is written down so the tests can see exactly what was asked. */
const fake = {
  token: GOOD,
  pages: ['17841400000000011', '17841400000000012'],
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
    const sent = u.searchParams.get('access_token');
    if (sent === FB && !fake.expired) {
      // the Facebook side (Meta's Unified login): the account is named by its own id, never "me"
      if (u.pathname === '/me/accounts') return send(200, { data: fake.pages.map((id) => ({ id: `page${id}`, instagram_business_account: { id } })) });
      const acct = /^\/(\d{10,})(\/media|\/insights)?$/.exec(u.pathname);
      if (acct && acct[2] === '/media') return send(200, { data: fake.media });
      if (acct && acct[2] === '/insights') return send(200, { data: [{ name: 'reach', period: 'day', values: [{ value: 650, end_time: new Date(Date.now() - DAY + 12 * 3_600_000).toISOString() }] }] });
      if (acct) return acct[1].endsWith('9') ? send(400, { error: { message: 'Unsupported get request. Object does not exist', code: 100 } }) : send(200, { id: acct[1], username: `acct${acct[1].slice(-2)}`, name: 'Right Girl Media', followers_count: 500, follows_count: 10, media_count: 3, profile_picture_url: 'https://cdn.example/p.jpg' });
      const m2 = /^\/(m\d)\/insights$/.exec(u.pathname);
      if (m2) return send(200, insightsOf(m2[1], (u.searchParams.get('metric') ?? '').split(',')));
      return send(404, { error: { message: 'Unknown path', code: 803 } });
    }
    if (u.pathname === '/me/accounts' || /^\/\d{10,}/.test(u.pathname)) return send(400, { error: { message: `Invalid OAuth access token ${sent}`, type: 'OAuthException', code: 190 } });
    if (fake.expired || sent !== fake.token) return send(400, { error: { message: `Invalid OAuth access token ${sent}`, type: 'OAuthException', code: 190 } });
    if (u.pathname === '/me') return send(200, { user_id: '17841400000000001', username: 'rightgirlmedia', name: 'Right Girl Media', followers_count: fake.followers, follows_count: 300, media_count: 3, profile_picture_url: 'https://cdn.example/p.jpg' });
    if (u.pathname === '/refresh_access_token') return send(200, { access_token: fake.token, token_type: 'bearer', expires_in: 5_184_000 });
    if (u.pathname === '/me/media') {
      const after = u.searchParams.get('after');
      const limit = Number(u.searchParams.get('limit') ?? 25);
      // two pages, so paging is exercised
      const page = after ? fake.media.slice(2) : fake.media.slice(0, Math.min(2, limit));
      return send(200, { data: page, paging: after || fake.media.length <= 2 ? {} : { cursors: { after: 'c2' }, next: 'https://graph.instagram.com/next-page-url-with-token' } });
    }
    const split = (a: number, b: number) => ({ data: [{ name: u.searchParams.get('metric'), total_value: { value: a + b, breakdowns: [{ dimension_keys: ['follow_type'], results: [{ dimension_values: ['FOLLOWER'], value: a }, { dimension_values: ['NON_FOLLOWER'], value: b }] }] } }] });
    // the split is offered for the account as a whole, on reach under "follow_type"; the other names are refused, the way Instagram does
    if (u.pathname === '/me/insights' && u.searchParams.get('breakdown')) return u.searchParams.get('breakdown') === 'follow_type' && u.searchParams.get('metric') === 'reach' ? send(200, split(300, 700)) : send(400, { error: { message: '(#100) unsupported breakdown', code: 100 } });
    const cm = /^\/(m\d)\/comments$/.exec(u.pathname);
    if (cm) return send(200, { data: cm[1] === 'm1' ? [{ id: 'c1', text: 'who is the guy?', username: 'viewer_one', timestamp: ago(1), like_count: 4 }, { id: 'c2', text: 'ep 4?', username: 'viewer_two', timestamp: ago(2), like_count: 1 }] : [] });
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
  config.facebookGraphBase = config.instagramGraphBase;
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
    const all = JSON.parse(text) as { accounts: { account: { id: string; username: string; followers: number; tokenExpiresAt: string; tokenLast4: string }; posts: number; withoutInsights: string[] }[] };
    expect(all.accounts).toHaveLength(1);
    const j = all.accounts[0];
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

  it('says how much of the account\'s audience does not follow it, trying the views and reach names until one is offered', async () => {
    const o = await json<{ reachSplit: { of: string; followers: number; nonFollowers: number; days: number } | null }>(await call(member, 'GET', `/metrics/accounts/${accountId}/overview`));
    expect(o.reachSplit).toEqual({ of: 'reach', followers: 300, nonFollowers: 700, days: 28 }); // views was refused, reach was not
  });

  it('keeps what viewers wrote under the newest posts', async () => {
    const posts = await json<{ id: string }[]>(await call(member, 'GET', `/metrics/accounts/${accountId}/posts`));
    const d = await json<{ comments: { text: string; username: string; likes: number }[] }>(await call(member, 'GET', `/metrics/posts/${posts[0].id}`));
    expect(d.comments.map((c) => c.text).sort()).toEqual(['ep 4?', 'who is the guy?']);
    expect(d.comments.find((c) => c.username === 'viewer_one')?.likes).toBe(4);
    // syncing again does not double them
    await call(member, 'POST', `/metrics/accounts/${accountId}/sync`, {});
    expect((await db.query('SELECT 1 FROM ig_comments')).rows).toHaveLength(2);
  });

  it('marks each post on the follower chart', async () => {
    const o = await json<{ markers: { day: string; type: string; title: string; episode: number | null }[] }>(await call(member, 'GET', `/metrics/accounts/${accountId}/overview`));
    expect(o.markers.map((m) => m.title).sort()).toEqual(['A photo', 'Old carousel', 'Reel one']); // the carousel is 80 days old, inside the 90 days drawn
    expect(o.markers.every((m) => /^\d{4}-\d{2}-\d{2}$/.test(m.day))).toBe(true);
  });

  it('ties a post to an episode and shows what the episode cost to make next to what it earned', async () => {
    const org = (await db.query<{ id: string }>('SELECT id FROM organizations LIMIT 1')).rows[0].id;
    const pr = await json<{ id: string }>(await call(admin, 'POST', '/projects', { name: "Nya's Story", type: 'micro_drama' }));
    const shot = async (group: string, usd: number[]) => {
      const it = (await db.query<{ id: string }>(`INSERT INTO project_items (org_id, project_id, kind, group_name, position, title) VALUES ($1,$2,'shot',$3,0,'shot') RETURNING id`, [org, pr.id, group])).rows[0].id;
      for (const c of usd) await db.query(`INSERT INTO job_runs (org_id, kind, ref_name, status, input, cost_usd) VALUES ($1,'generation','shot','completed',$2::jsonb,$3)`, [org, JSON.stringify({ projectId: pr.id, itemId: it }), c]);
    };
    await shot('Ep 3 · Scene 1', [1.5, 2.25]);
    await shot('Ep 3 · Scene 2', [4]);
    await shot('Ep 4 · Scene 1', [9]);
    const posts = await json<{ id: string }[]>(await call(member, 'GET', `/metrics/accounts/${accountId}/posts`));
    const set = await call(member, 'PUT', `/metrics/posts/${posts[0].id}/episode`, { link: { projectId: pr.id, episode: 3 } });
    expect(set.status).toBe(200);
    expect((await json<{ link: unknown }>(set)).link).toEqual({ projectId: pr.id, projectName: "Nya's Story", episode: 3, spendUsd: 7.75 });
    const listed = await json<{ link: { episode: number; spendUsd: number } | null }[]>(await call(member, 'GET', `/metrics/accounts/${accountId}/posts`));
    expect(listed[0].link).toMatchObject({ episode: 3, spendUsd: 7.75 });
    expect(listed[1].link).toBeNull();
    // the link survives a refresh, and shows on the chart's marker
    await call(member, 'POST', `/metrics/accounts/${accountId}/sync`, {});
    const o = await json<{ markers: { title: string; episode: number | null }[] }>(await call(member, 'GET', `/metrics/accounts/${accountId}/overview`));
    expect(o.markers.find((m) => m.title === 'Reel one')?.episode).toBe(3);
    // bad links are refused, and a link can be cleared
    expect((await call(member, 'PUT', `/metrics/posts/${posts[0].id}/episode`, { link: { projectId: '00000000-0000-4000-8000-000000000000', episode: 3 } })).status).toBe(404);
    expect((await call(member, 'PUT', `/metrics/posts/${posts[0].id}/episode`, { link: { projectId: pr.id, episode: 0 } })).status).toBe(400);
    expect((await call(member, 'PUT', `/metrics/posts/00000000-0000-4000-8000-000000000000/episode`, { link: null })).status).toBe(404);
    const cleared = await call(member, 'PUT', `/metrics/posts/${posts[0].id}/episode`, { link: null });
    expect((await json<{ link: unknown }>(cleared)).link).toBeNull();
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

  describe('a Facebook-side token (Meta\'s Unified login)', () => {
    type Conn = { accounts: { account: { id: string; username: string; tokenExpiresAt: string | null }; posts: number; error?: string }[] };

    it('finds every Instagram account the token reaches, reads each through the facebook side, and never tries to refresh', async () => {
      fake.requests.length = 0;
      const res = await call(admin, 'POST', '/metrics/accounts', { token: FB });
      expect(res.status).toBe(201);
      const text = await res.text();
      expect(text).not.toContain(FB);
      const j = JSON.parse(text) as Conn;
      expect(j.accounts.map((a) => a.account.username).sort()).toEqual(['acct11', 'acct12']);
      expect(j.accounts.every((a) => a.posts === 3 && a.account.tokenExpiresAt === null)).toBe(true); // system tokens do not expire
      const paths = fake.requests.map((q) => q.path);
      expect(paths).toContain('/me/accounts');
      expect(paths).toContain('/17841400000000011/media'); // named by its own id
      expect(paths).not.toContain('/me/media');
      expect(paths).not.toContain('/refresh_access_token');
      expect((await db.query<{ api: string }>('SELECT DISTINCT api FROM ig_accounts')).rows).toEqual([{ api: 'facebook' }]);
      const list = await json<{ id: string; username: string }[]>(await call(member, 'GET', '/metrics/accounts'));
      expect(list).toHaveLength(2);
      // refreshing one later uses the same route and its numbers come through
      const again = await call(member, 'POST', `/metrics/accounts/${list[0].id}/sync`, {});
      expect(again.status).toBe(200);
      const posts = await json<{ metrics: Record<string, number> }[]>(await call(member, 'GET', `/metrics/accounts/${list[0].id}/posts?sort=reach`));
      expect(posts[0].metrics.reach).toBe(6500);
    });

    it('takes the account ID when the token cannot list accounts on its own', async () => {
      fake.pages = [];
      const none = await call(admin, 'POST', '/metrics/accounts', { token: FB });
      expect(none.status).toBe(400);
      expect((await json<{ error: { message: string } }>(none)).error.message).toMatch(/Paste the Instagram account ID too/);
      const one = await call(admin, 'POST', '/metrics/accounts', { token: FB, igUserId: '17841400000000013' });
      expect(one.status).toBe(201);
      expect((await json<Conn>(one)).accounts.map((a) => a.account.username)).toEqual(['acct13']);
      // a wrong ID is said plainly, and a bad shape is refused before anything is asked
      const wrong = await call(admin, 'POST', '/metrics/accounts', { token: FB, igUserId: '17841400000000019' });
      expect(wrong.status).toBe(400);
      expect((await call(admin, 'POST', '/metrics/accounts', { token: FB, igUserId: 'rightgirl_media' })).status).toBe(400);
    });

    it('says the token was refused when neither side accepts it, without repeating it', async () => {
      const r = await call(admin, 'POST', '/metrics/accounts', { token: 'EAABwrongFACEBOOKtoken0123456789abc' });
      expect(r.status).toBe(400);
      const msg = (await json<{ error: { message: string } }>(r)).error.message;
      expect(msg).toMatch(/did not accept that token/);
      expect(msg).not.toContain('EAABwrong');
    });
  });
});
