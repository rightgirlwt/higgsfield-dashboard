export interface IgAccount {
  id: string;
  username: string;
  name: string;
  picture: string;
  followers: number | null;
  follows: number | null;
  mediaCount: number | null;
  tokenLast4: string;
  tokenExpiresAt: string | null;
  lastSyncedAt: string | null;
  lastError: string;
  connectedAt: string | null;
}

export type PostMetrics = Record<string, number>;

export interface IgPost {
  id: string;
  mediaId: string;
  permalink: string;
  caption: string;
  type: 'Reel' | 'Carousel' | 'Photo' | 'Video';
  thumb: string;
  postedAt: string | null;
  metrics: PostMetrics;
  engagement: number | null;
}

export interface IgPostDetail extends IgPost {
  snapshots: { takenAt: string; metrics: PostMetrics }[];
}

export interface Overview {
  account: IgAccount;
  days: { day: string; followers: number | null; reach: number | null }[];
  followerChange: number | null;
  followerSince: string | null;
  last30: { posts: number; averageReach: number | null; averageEngagement: number | null; totalSaves: number; totalShares: number };
  best: IgPost | null;
}

export interface SyncResult {
  account: IgAccount;
  posts: number;
  withoutInsights: string[];
}

/** What each number is called on the page. Instagram's own names are shown nowhere. */
export const METRIC_LABELS: Record<string, string> = {
  reach: 'Reach',
  views: 'Views',
  likes: 'Likes',
  comments: 'Comments',
  saved: 'Saves',
  shares: 'Shares',
  reposts: 'Reposts',
  total_interactions: 'Interactions',
  follows: 'Follows from it',
  profile_visits: 'Profile visits',
  ig_reels_avg_watch_time: 'Average watch time',
  ig_reels_video_view_total_time: 'Total watch time',
};

/** Watch times come in milliseconds. */
export function watchTime(ms: number): string {
  const s = ms / 1000;
  if (s < 90) return `${s.toFixed(1)} s`;
  const m = s / 60;
  return m < 90 ? `${m.toFixed(1)} min` : `${(m / 60).toFixed(1)} h`;
}

// ---- Facebook Pages ---------------------------------------------------------------------------------------------

export interface FbPage {
  id: string;
  pageId: string;
  name: string;
  picture: string;
  followers: number | null;
  tokenLast4: string;
  lastSyncedAt: string | null;
  lastError: string;
  connectedAt: string | null;
}

export interface FbPost {
  id: string;
  postId: string;
  permalink: string;
  message: string;
  type: string;
  thumb: string;
  postedAt: string | null;
  metrics: PostMetrics;
  engagement: number | null;
}

export interface FbOverview {
  page: FbPage;
  days: { day: string; followers: number | null; views: number | null; reach: number | null; engagements: number | null; new_follows: number | null }[];
  followerChange: number | null;
  followerSince: string | null;
  last30: { posts: number; views: number | null; engagements: number | null; newFollows: number | null; averageReach: number | null; averageEngagement: number | null };
  best: FbPost | null;
}

// ---- Ads ----------------------------------------------------------------------------------------------------------

export interface AdAccount {
  id: string;
  accountId: string;
  name: string;
  currency: string;
  tokenLast4: string;
  lastSyncedAt: string | null;
  lastError: string;
  connectedAt: string | null;
}

export interface AdOverview {
  account: AdAccount;
  days: number;
  totals: { spend: number; impressions: number; clicks: number; ctr: number | null; cpc: number | null; results: number | null; costPerResult: number | null; campaigns: number };
  daily: { day: string; spend: number; clicks: number; impressions: number }[];
  campaigns: { campaignId: string; name: string; spend: number; impressions: number; clicks: number; ctr: number | null; cpc: number | null; resultLabel: string | null; results: number | null; costPerResult: number | null }[];
}

// ---- All channels ---------------------------------------------------------------------------------------------------

export interface Summary {
  instagram: { id: string; name: string; picture: string; followers: number | null; followerChange: number | null; posts: number; averageReach: number | null; averageEngagement: number | null; lastSyncedAt: string | null; lastError: string }[];
  facebook: { id: string; name: string; picture: string; followers: number | null; followerChange: number | null; posts: number; views: number | null; engagements: number | null; averageReach: number | null; averageEngagement: number | null; lastSyncedAt: string | null; lastError: string }[];
  ads: { id: string; name: string; currency: string; spend: number; results: number | null; costPerResult: number | null; clicks: number; ctr: number | null; campaigns: number; lastSyncedAt: string | null; lastError: string }[];
  topPosts: { channel: 'Instagram' | 'Facebook'; account: string; title: string; type: string; thumb: string; postedAt: string | null; permalink: string; reach: number | null; engagement: number | null }[];
}