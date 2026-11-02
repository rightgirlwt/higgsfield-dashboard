import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { config } from '../src/config';
import { setDb } from '../src/ctx';
import { createDb, type Db } from '../src/db';
import { migrate } from '../src/db/migrations';
import { seedDemo } from '../src/db/seed';
import { fbEngagement } from '../src/services/facebook';
import { resultOf } from '../src/services/ads';

const TOKEN = 'EAABtestMETAtoken0123456789abcdefgh';
const PAGE_TOKEN = 'EAABpageSPECIFICtoken0123456789abcd';
const DAY = 86_400_000;
const ago = (d: number) => new Date(Date.now() - d * DAY);
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const PAGE = '100000000000001';

/** A stand-in for graph.facebook.com that knows one Page and one ad account. */
const fake = {
  noFollowersField: false,
  requests: [] as { path: string; token: string; metric?: string; fields?: string }[],
  pages: [{ id: PAGE, name: 'Right Girl Media', followers_count: 900, picture: { data: { url: 'https://cdn.example/page.jpg' } } }],
};
const posts = [
  { id: `${PAGE}_p1`, message: 'Three mistakes that cost you the case\nmore', created_time: ago(2).toISOString(), permalink_url: 'https://www.facebook.com/p1', full_picture: 'https://cdn.example/p1.jpg', status_type: 'added_video', reactions: { summary: { total_count: 100 } }, comments: { summary: { total_count: 10 } }, shares: { count: 5 } },
  { id: `${PAGE}_p2`, message: 'Team photo', created_time: ago(9).toISOString(), permalink_url: 'https://www.facebook.com/p2', status_type: 'added_photos', reactions: { summary: { total_count: 20 } }, comments: { summary: { total_count: 2 } } },
  { id: `${PAGE}_p3`, message: 'Old one', created_time: ago(70).toISOString(), permalink_url: 'https://www.facebook.com/p3', status_type: 'mobile_status_update', reactions: { summary: { total_count: 4 } }, comments: { summary: { total_count: 0 } }, shares: { count: 1 } },
];
const postInsight: Record<string, Record<string, number>> = {
  [`${PAGE}_p1`]: { post_media_view: 5000, post_total_media_view_unique: 3000, post_clicks: 40 },
  [`${PAGE}_p2`]: { post_media_view: 1200, post_total_media_view_unique: 800, post_clicks: 9 },
  [`${PAGE}_p3`]: { post_media_view: 300, post_total_media_view_unique: 200, post_clicks: 1 },
};
const adRows = [
  { campaign_id: 'c1', campaign_name: 'Free case review', date_start: ymd(ago(1)), spend: '10.00', impressions: '1000', reach: '900', clicks: '50', actions: [{ action_type: 'lead', value: '2' }, { action_type: 'link_click', value: '50' }] },
  { campaign_id: 'c1', campaign_name: 'Free case review', date_start: ymd(ago(3)), spend: '20.00', impressions: '2000', reach: '1800', clicks: '80', actions: [{ action_type: 'lead', value: '3' }] },
  { campaign_id: 'c1', campaign_name: 'Free case review', date_start: ymd(ago(10)), spend: '30.00', impressions: '3000', reach: '2500', clicks: '100', actions: [{ action_type: 'lead', value: '4' }] },
  { campaign_id: 'c2', campaign_name: 'Brand awareness', date_start: ymd(ago(1)), spend: '5.00', impressions: '5000', reach: '4000', clicks: '20', actions: [{ action_type: 'link_click', value: '20' }] },
  { campaign_id: 'c2', campaign_name: 'Brand awareness', date_start: ymd(ago(40)), spend: '8.00', impressions: '4000', reach: '3000', clicks: '30', actions: [{ action_type: 'link_click', value: '30' }] },
];

let graphServer: http.Server;
beforeAll(async () => {
  graphServer = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    const send = (code: number, body: unknown) => (res.writeHead(code, { 'content-type': 'application/json' }), res.end(JSON.stringify(body)));
    const sent = u.searchParams.get('access_token') ?? '';
    const fields = u.searchParams.get('fields') ?? '';
    fake.requests.push({ path: u.pathname, token: sent, metric: u.searchParams.get('metric') ?? undefined, fields });
    const bad = () => send(400, { error: { message: `Invalid OAuth access token ${sent}`, code: 190 } });
    if (sent !== TOKEN && sent !== PAGE_TOKEN) return bad();
    // Meta removes Page fields from time to time; this one has no followers_count, the way it had no fan_count
    if (fake.noFollowersField && fields.includes('followers_count') && (u.pathname === '/me/accounts' || u.pathname === `/${PAGE}`)) return send(400, { error: { message: '(#100) Tried accessing nonexisting field (followers_count) on node type (Page)', code: 100 } });
    // an Instagram account's id: it has a name, but no Page edges
    if (u.pathname === '/17841400000000077') return fields === 'access_token' ? send(200, {}) : send(200, { id: '17841400000000077', name: 'Reginald Greene, Esq.' });
    if (u.pathname === '/17841400000000077/published_posts') return send(400, { error: { message: '(#100) Tried accessing nonexisting field (published_posts) on node type (Instagram User)', code: 100 } });
    if (u.pathname === '/me/accounts') return send(200, { data: fake.pages });
    if (u.pathname === '/me/adaccounts') return send(200, { data: [{ id: 'act_555', account_id: '555', name: 'GLG Ads', currency: 'USD' }] });
    if (u.pathname === '/act_555') return send(200, { id: 'act_555', name: 'GLG Ads', currency: 'USD' });
    if (u.pathname === '/act_555/insights') {
      // two pages, so paging is exercised
      const after = u.searchParams.get('after');
      return after ? send(200, { data: adRows.slice(3), paging: {} }) : send(200, { data: adRows.slice(0, 3), paging: { cursors: { after: 'n2' }, next: 'https://graph.facebook.com/next' } });
    }
    if (u.pathname === `/${PAGE}`) {
      if (fields === 'access_token') return send(200, { access_token: PAGE_TOKEN });
      return send(200, fake.pages[0]);
    }
    if (u.pathname === `/${PAGE}/published_posts`) return send(sent === PAGE_TOKEN ? 200 : 403, sent === PAGE_TOKEN ? { data: posts } : { error: { message: 'Needs a Page token', code: 200 } });
    if (u.pathname === `/${PAGE}/insights`) {
      const day = (n: number, v: number) => ({ value: v, end_time: new Date(Date.now() - n * DAY + 12 * 3_600_000).toISOString() });
      const metrics = (u.searchParams.get('metric') ?? '').split(',');
      const series: Record<string, number[]> = { page_media_view: [100, 200], page_total_media_view_unique: [60, 90], page_post_engagements: [10, 20], page_daily_follows_unique: [1, 3] };
      return send(200, { data: metrics.map((name) => ({ name, period: 'day', values: [day(2, series[name][0]), day(1, series[name][1])] })) });
    }
    const m = /^\/(\d+_p\d)\/insights$/.exec(u.pathname);
    if (m) {
      const wanted = (u.searchParams.get('metric') ?? '').split(',');
      // this Page is refused post_clicks on its oldest post, the way a real one can be
      if (m[1].endsWith('p3') && wanted.includes('post_clicks')) return send(400, { error: { message: '(#100) The value must be a valid insights metric', code: 100 } });
      return send(200, { data: wanted.map((name) => ({ name, period: 'lifetime', values: [{ value: postInsight[m[1]][name] }] })) });
    }
    return send(404, { error: { message: 'Unknown path', code: 803 } });
  });
  await new Promise<void>((r) => graphServer.listen(0, r));
  config.facebookGraphBase = `http://127.0.0.1:${(graphServer.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((r) => graphServer.close(r));
});

describe('Facebook and ads, in small pieces', () => {
  it('works a post\'s engagement from reactions, comments and shares over the people reached', () => {
    expect(fbEngagement({ reach: 1000, likes: 50, comments: 10, shares: 10 })).toBe(7);
    expect(fbEngagement({ likes: 5 })).toBeNull();
  });

  it('picks the result a campaign is best described by, leads before link clicks', () => {
    expect(resultOf([{ actions: { lead: 2, link_click: 50 } }, { actions: { lead: 1 } }])).toEqual({ label: 'Leads', count: 3 });
    expect(resultOf([{ actions: { link_click: 20 } }])).toEqual({ label: 'Link clicks', count: 20 });
    expect(resultOf([{ actions: {} }])).toBeNull();
  });
});

describe('Facebook Pages, ads and the all-channels view, against a fake Meta', () => {
  let db: Db;
  let server: http.Server;
  let base = '';
  let admin = '';
  let member = '';
  let pageId = '';
  let adId = '';
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

  it('connects a Page: finds it, reads its posts with the Page token, and never sends the token back', async () => {
    expect((await call(member, 'POST', '/metrics/facebook/pages', { token: TOKEN })).status).toBe(403);
    fake.requests.length = 0;
    const res = await call(admin, 'POST', '/metrics/facebook/pages', { token: TOKEN });
    expect(res.status).toBe(201);
    const text = await res.text();
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(PAGE_TOKEN);
    const j = JSON.parse(text) as { pages: { page: { id: string; name: string; followers: number }; posts: number; withoutInsights: string[] }[] };
    expect(j.pages).toHaveLength(1);
    pageId = j.pages[0].page.id;
    expect(j.pages[0].page).toMatchObject({ name: 'Right Girl Media', followers: 900 });
    expect(j.pages[0].posts).toBe(3);
    expect(j.pages[0].withoutInsights).toEqual(['clicks']); // refused on one post, asked one by one, remembered
    // the posts were read with the Page's own token, not the one pasted in
    expect(fake.requests.find((q) => q.path === `/${PAGE}/published_posts`)?.token).toBe(PAGE_TOKEN);
    expect((await db.query<{ token_cipher: string }>('SELECT token_cipher FROM fb_pages')).rows[0].token_cipher).not.toContain(TOKEN);
  });

  it('keeps each post under the names Instagram uses, so the two can be compared', async () => {
    const list = await json<{ message: string; type: string; thumb: string; metrics: Record<string, number>; engagement: number | null }[]>(await call(member, 'GET', `/metrics/facebook/pages/${pageId}/posts`));
    expect(list.map((p) => p.message.split('\n')[0])).toEqual(['Three mistakes that cost you the case', 'Team photo', 'Old one']);
    expect(list[0]).toMatchObject({ type: 'Video', engagement: 3.83, metrics: { views: 5000, reach: 3000, clicks: 40, likes: 100, comments: 10, shares: 5 } });
    expect(list[1].type).toBe('Photo');
    expect(list[1].metrics.shares).toBe(0); // a post nobody shared has no shares field
    expect(list[2].metrics.clicks).toBeUndefined();
    const byReach = await json<{ message: string }[]>(await call(member, 'GET', `/metrics/facebook/pages/${pageId}/posts?sort=reach`));
    expect(byReach[0].message).toMatch(/^Three mistakes/);
    expect((await call(member, 'GET', `/metrics/facebook/pages/${pageId}/posts?sort=nope`)).status).toBe(400);
  });

  it('shows the Page\'s own views, reach and follows by day, and 30-day totals', async () => {
    const o = await json<{ days: { views: number | null; followers: number | null }[]; last30: { posts: number; views: number; engagements: number; newFollows: number; averageReach: number; averageEngagement: number }; best: { message: string } | null; page: { followers: number } }>(
      await call(member, 'GET', `/metrics/facebook/pages/${pageId}/overview`));
    expect(o.page.followers).toBe(900);
    expect(o.last30).toMatchObject({ posts: 2, views: 300, engagements: 30, newFollows: 4, averageReach: 1900 }); // the 70-day-old post is outside
    expect(o.best?.message).toMatch(/^Three mistakes/);
    expect(o.days.some((d) => d.followers === 900)).toBe(true);
  });

  it('asks for the Page ID when the token cannot list Pages, and refuses a bad one', async () => {
    fake.pages = [];
    const none = await call(admin, 'POST', '/metrics/facebook/pages', { token: TOKEN });
    expect(none.status).toBe(400);
    expect((await json<{ error: { message: string } }>(none)).error.message).toMatch(/Paste the Page ID too/);
    expect((await call(admin, 'POST', '/metrics/facebook/pages', { token: TOKEN, pageId: 'my page' })).status).toBe(400);
    fake.pages = [{ id: PAGE, name: 'Right Girl Media', followers_count: 900, picture: { data: { url: 'https://cdn.example/page.jpg' } } }];
    expect((await call(admin, 'POST', '/metrics/facebook/pages', { token: TOKEN, pageId: PAGE })).status).toBe(201);
    expect((await json<unknown[]>(await call(member, 'GET', '/metrics/facebook/pages')))).toHaveLength(1); // the same Page, not a second one
  });

  it('connects an ad account and reads 90 days of spend by campaign and day', async () => {
    expect((await call(member, 'POST', '/metrics/ads/accounts', { token: TOKEN })).status).toBe(403);
    const res = await call(admin, 'POST', '/metrics/ads/accounts', { token: TOKEN });
    expect(res.status).toBe(201);
    const text = await res.text();
    expect(text).not.toContain(TOKEN);
    const j = JSON.parse(text) as { accounts: { account: { id: string; name: string; currency: string }; days: number }[] };
    adId = j.accounts[0].account.id;
    expect(j.accounts[0]).toMatchObject({ days: 5, account: { name: 'GLG Ads', currency: 'USD' } }); // both pages were read
    expect((await call(admin, 'POST', '/metrics/ads/accounts', { token: TOKEN, adAccountId: 'abc' })).status).toBe(400);
  });

  it('works out spend, results and cost per result for 7, 30 and 90 days', async () => {
    type Ov = { days: number; totals: { spend: number; impressions: number; clicks: number; results: number; costPerResult: number; ctr: number; campaigns: number }; campaigns: { name: string; spend: number; resultLabel: string; results: number; costPerResult: number }[]; daily: { day: string; spend: number }[] };
    const d30 = await json<Ov>(await call(member, 'GET', `/metrics/ads/accounts/${adId}/overview?days=30`));
    expect(d30.totals).toMatchObject({ spend: 65, impressions: 11000, clicks: 250, results: 29, campaigns: 2 });
    expect(d30.totals.costPerResult).toBe(2.24); // 65 / 29
    expect(d30.campaigns[0]).toMatchObject({ name: 'Free case review', spend: 60, resultLabel: 'Leads', results: 9, costPerResult: 6.67 });
    expect(d30.campaigns[1]).toMatchObject({ name: 'Brand awareness', resultLabel: 'Link clicks', results: 20, costPerResult: 0.25 });
    expect(d30.daily).toHaveLength(3); // distinct days with spend (both campaigns spent on one of them)
    expect(d30.daily.find((d) => d.spend === 15)).toBeTruthy(); // 10 + 5 on that day
    const d7 = await json<Ov>(await call(member, 'GET', `/metrics/ads/accounts/${adId}/overview?days=7`));
    expect(d7.totals.spend).toBe(35);
    expect(d7.campaigns[0]).toMatchObject({ spend: 30, results: 5, costPerResult: 6 });
    const d90 = await json<Ov>(await call(member, 'GET', `/metrics/ads/accounts/${adId}/overview?days=90`));
    expect(d90.totals.spend).toBe(73);
    expect(d90.campaigns.find((c) => c.name === 'Brand awareness')).toMatchObject({ spend: 13, results: 50 });
  });

  it('shows everything on one page: each account and the best recent posts across channels', async () => {
    const s = await json<{
      instagram: unknown[];
      facebook: { name: string; followers: number; views: number; posts: number }[];
      ads: { name: string; spend: number; results: number; costPerResult: number }[];
      topPosts: { channel: string; account: string; title: string; reach: number; engagement: number }[];
    }>(await call(member, 'GET', '/metrics/summary'));
    expect(s.instagram).toEqual([]); // none connected here, the page says so
    expect(s.facebook[0]).toMatchObject({ name: 'Right Girl Media', followers: 900, views: 300, posts: 2 });
    expect(s.ads[0]).toMatchObject({ name: 'GLG Ads', spend: 65, results: 29 });
    expect(s.topPosts.map((p) => p.channel)).toEqual(['Facebook', 'Facebook']);
    expect(s.topPosts[0]).toMatchObject({ account: 'Right Girl Media', reach: 3000, engagement: 3.83 });
  });

  it('refuses an Instagram account\'s ID pasted as a Page ID, saying what it is, and saves nothing', async () => {
    const before = (await db.query('SELECT 1 FROM fb_pages')).rows.length;
    const r = await call(admin, 'POST', '/metrics/facebook/pages', { token: TOKEN, pageId: '17841400000000077' });
    expect(r.status).toBe(400);
    const msg = (await json<{ error: { message: string } }>(r)).error.message;
    expect(msg).toMatch(/"Reginald Greene, Esq\." is not a Facebook Page/);
    expect(msg).toMatch(/Instagram account/);
    expect((await db.query('SELECT 1 FROM fb_pages')).rows).toHaveLength(before);
  });

  it('still connects and reads a Page when Meta refuses one of the profile fields, instead of failing', async () => {
    fake.noFollowersField = true;
    fake.requests.length = 0;
    const found = await call(admin, 'POST', '/metrics/facebook/pages', { token: TOKEN });
    expect(found.status).toBe(201);
    const j = await json<{ pages: { page: { name: string; followers: number | null }; posts: number; error?: string }[] }>(found);
    expect(j.pages[0]).toMatchObject({ posts: 3 });
    expect(j.pages[0].error).toBeUndefined();
    expect(j.pages[0].page.name).toBe('Right Girl Media');
    expect(fake.requests.some((q) => q.fields === 'id,name,picture{url}')).toBe(true); // the second try, with fewer fields
    // an unrelated failure is not retried as if it were a field problem
    fake.requests.length = 0;
    const bad = await call(admin, 'POST', '/metrics/facebook/pages', { token: 'EAABwrongPAGEtoken0123456789abcdefg' });
    expect(bad.status).toBe(400);
    expect(fake.requests.filter((q) => q.path === '/me/accounts')).toHaveLength(1);
    fake.noFollowersField = false;
  });

  it('refreshes on the Team\'s request, says so when a token stops working, and disconnects cleanly', async () => {
    expect((await call(member, 'POST', `/metrics/facebook/pages/${pageId}/sync`, {})).status).toBe(200);
    expect((await call(member, 'POST', `/metrics/ads/accounts/${adId}/sync`, {})).status).toBe(200);
    // a token that has stopped working
    const saved = (await db.query<{ token_cipher: string }>('SELECT token_cipher FROM ad_accounts')).rows[0].token_cipher;
    const { encryptSecret } = await import('../src/lib/crypto');
    await db.query('UPDATE ad_accounts SET token_cipher=$1', [encryptSecret('EAABexpiredTOKEN0123456789abcdefghij')]);
    const dead = await call(member, 'POST', `/metrics/ads/accounts/${adId}/sync`, {});
    expect(dead.status).toBe(400);
    expect((await json<{ error: { message: string } }>(dead)).error.message).toMatch(/no longer accepts this token/);
    expect((await json<{ lastError: string }[]>(await call(member, 'GET', '/metrics/ads/accounts')))[0].lastError).toMatch(/Connect the ad account again/);
    await db.query('UPDATE ad_accounts SET token_cipher=$1', [saved]);
    expect((await call(member, 'DELETE', `/metrics/ads/accounts/${adId}`)).status).toBe(403);
    expect((await call(admin, 'DELETE', `/metrics/ads/accounts/${adId}`)).status).toBe(204);
    expect((await call(admin, 'DELETE', `/metrics/facebook/pages/${pageId}`)).status).toBe(204);
    expect((await db.query('SELECT 1 FROM ad_days')).rows).toHaveLength(0);
    expect((await db.query('SELECT 1 FROM fb_posts')).rows).toHaveLength(0);
    expect((await db.query('SELECT 1 FROM fb_page_days')).rows).toHaveLength(0);
  });
});
