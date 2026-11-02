import { adOverview, listAdAccounts } from './ads';
import { listFbPosts, listPages, pageOverview } from './facebook';
import { listAccounts, listPosts, overview } from './metrics';
import type { Workspace } from './workspaces';

interface TopPost {
  channel: 'Instagram' | 'Facebook';
  account: string;
  title: string;
  type: string;
  thumb: string;
  postedAt: string | null;
  permalink: string;
  reach: number | null;
  engagement: number | null;
}

/**
 * Everything in one place: each connected Instagram account, Facebook Page and ad account with its headline numbers, and the best
 * recent posts across Instagram and Facebook together. It only reads what has already been stored (nothing is fetched here).
 */
export async function allChannels(orgId: string, ws: Workspace) {
  const [igAccounts, pages, ads] = await Promise.all([listAccounts(orgId, ws), listPages(orgId, ws), listAdAccounts(orgId, ws)]);
  const cutoff = Date.now() - 30 * 86_400_000;
  const recent = (iso: string | null) => !!iso && Date.parse(iso) >= cutoff;

  const instagram = await Promise.all(
    igAccounts.map(async (a) => {
      const [o, posts] = await Promise.all([overview(orgId, a.id), listPosts(orgId, a.id, { sort: 'reach' })]);
      return {
        summary: { id: a.id, name: `@${a.username}`, picture: a.picture, followers: a.followers, followerChange: o.followerChange, posts: o.last30.posts, averageReach: o.last30.averageReach, averageEngagement: o.last30.averageEngagement, lastSyncedAt: a.lastSyncedAt, lastError: a.lastError },
        top: posts.filter((p) => recent(p.postedAt)).slice(0, 5).map((p) => ({ channel: 'Instagram' as const, account: `@${a.username}`, title: p.caption.split('\n')[0], type: p.type, thumb: p.thumb, postedAt: p.postedAt, permalink: p.permalink, reach: p.metrics.reach ?? null, engagement: p.engagement })),
      };
    }),
  );
  const facebook = await Promise.all(
    pages.map(async (p) => {
      const [o, posts] = await Promise.all([pageOverview(orgId, p.id), listFbPosts(orgId, p.id, { sort: 'reach' })]);
      return {
        summary: { id: p.id, name: p.name, picture: p.picture, followers: p.followers, followerChange: o.followerChange, posts: o.last30.posts, views: o.last30.views, engagements: o.last30.engagements, averageReach: o.last30.averageReach, averageEngagement: o.last30.averageEngagement, lastSyncedAt: p.lastSyncedAt, lastError: p.lastError },
        top: posts.filter((x) => recent(x.postedAt)).slice(0, 5).map((x) => ({ channel: 'Facebook' as const, account: p.name, title: x.message.split('\n')[0], type: x.type, thumb: x.thumb, postedAt: x.postedAt, permalink: x.permalink, reach: x.metrics.reach ?? null, engagement: x.engagement })),
      };
    }),
  );
  const adSummaries = await Promise.all(
    ads.map(async (a) => {
      const o = await adOverview(orgId, a.id, 30);
      return { id: a.id, name: a.name, currency: a.currency, spend: o.totals.spend, results: o.totals.results, costPerResult: o.totals.costPerResult, clicks: o.totals.clicks, ctr: o.totals.ctr, campaigns: o.totals.campaigns, lastSyncedAt: a.lastSyncedAt, lastError: a.lastError };
    }),
  );
  const topPosts = ([...instagram.flatMap((x) => x.top), ...facebook.flatMap((x) => x.top)] as TopPost[]).sort((a, b) => (b.reach ?? -1) - (a.reach ?? -1)).slice(0, 8);
  return { instagram: instagram.map((x) => x.summary), facebook: facebook.map((x) => x.summary), ads: adSummaries, topPosts };
}
