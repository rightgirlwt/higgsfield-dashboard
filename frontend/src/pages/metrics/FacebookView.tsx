import { ExternalLink, RefreshCw, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useCan } from '../../auth/context';
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, Field, Select, Skeleton } from '../../components/ui';
import { api, errorMessage } from '../../lib/api';
import { num, timeAgo } from '../../lib/format';
import { useApi } from '../../lib/hooks';
import type { FbOverview, FbPage, FbPost } from '../../lib/metrics';
import { cssColor } from '../../lib/theme';
import { useToast } from '../../state/Toast';
import { AccountTabs, AXIS, ConnectBox, dayLabel, n, pct, Stat, tooltipStyle } from './shared';

const SORTS: [string, string][] = [['recent', 'Newest'], ['reach', 'Reach'], ['views', 'Views'], ['engagement', 'Engagement'], ['clicks', 'Clicks'], ['shares', 'Shares'], ['comments', 'Comments'], ['likes', 'Reactions']];

const FB_STEPS = (
  <>
    <li>In <strong>Meta for Developers</strong>, open your app, go to <strong>Use cases, Customize</strong>, and add these under <strong>Permissions and features</strong>: <strong>pages_show_list</strong>, <strong>pages_read_engagement</strong> and <strong>read_insights</strong>.</li>
    <li>The Page must be one you manage, and the person generating the token needs permission to see its insights (an Admin or an Analyst on the Page).</li>
    <li>Generate a token the same way as for Instagram (the same token can work for both if it was made with these permissions), and paste it here.</li>
    <li>If it says it could not find a Page on its own, also paste the Page ID (Meta Business Settings, Accounts, Pages). Pages need 100 or more likes before Facebook shares Page insights.</li>
  </>
);

export default function FacebookView() {
  const toast = useToast();
  const isAdmin = useCan('admin');
  const pages = useApi<FbPage[]>('/metrics/facebook/pages');
  const [picked, setPicked] = useState('');
  const list = pages.data ?? [];
  const page = list.find((p) => p.id === picked) ?? list[0] ?? null;
  return (
    <div>
      {pages.error ? (
        <ErrorState message={pages.error} onRetry={pages.reload} />
      ) : !pages.data ? (
        <Skeleton className="h-40" />
      ) : (
        <>
          <AccountTabs label="Facebook Pages" items={list.map((p) => ({ id: p.id, name: p.name }))} current={page?.id} onPick={setPicked} />
          {page ? <PageView key={page.id} page={page} isAdmin={isAdmin} reload={pages.reload} onGone={() => (setPicked(''), pages.reload())} /> : <EmptyState title="No Facebook Page connected" hint={isAdmin ? 'Connect one below to see its views, reach and engagement.' : 'An admin needs to connect a Facebook Page first.'} />}
          {isAdmin && (
            <ConnectBox
              title={list.length === 0 ? 'Connect a Facebook Page' : 'Connect another Page'}
              intro="Uses the same kind of access token as Instagram. Reading is free. The token is kept encrypted here and is never shown again."
              idLabel="Page ID"
              idPlaceholder="optional"
              steps={FB_STEPS}
              connect={async (token, id) => {
                const r = await api.post<{ pages: { page: FbPage; posts: number; error?: string }[] }>('/metrics/facebook/pages', { token, ...(id ? { pageId: id } : {}) });
                const ok = r.pages.filter((p) => !p.error);
                if (ok.length) toast.success(`Connected ${ok.map((p) => p.page.name).join(', ')}, ${ok.reduce((s, p) => s + p.posts, 0)} posts read.`);
                for (const p of r.pages.filter((x) => x.error)) toast.error(`${p.page.name}: ${p.error}`);
                setPicked(r.pages[0].page.id);
                pages.reload();
              }}
            />
          )}
        </>
      )}
    </div>
  );
}

function PageView({ page, isAdmin, reload, onGone }: { page: FbPage; isAdmin: boolean; reload: () => void; onGone: () => void }) {
  const toast = useToast();
  const [version, setVersion] = useState(0);
  const overview = useApi<FbOverview>(`/metrics/facebook/pages/${page.id}/overview?v=${version}`);
  const [sort, setSort] = useState('recent');
  const posts = useApi<FbPost[]>(`/metrics/facebook/pages/${page.id}/posts?sort=${sort}&v=${version}`);
  const [syncing, setSyncing] = useState(false);
  const [confirm, setConfirm] = useState(false);

  async function sync() {
    setSyncing(true);
    try {
      const r = await api.post<{ posts: number; withoutInsights: string[] }>(`/metrics/facebook/pages/${page.id}/sync`, {});
      toast.success(`${r.posts} posts read.${r.withoutInsights.length ? ' Facebook does not share some numbers for this Page.' : ''}`);
      setVersion((v) => v + 1);
      reload();
    } catch (e) {
      toast.error(errorMessage(e));
      reload();
    }
    setSyncing(false);
  }
  async function remove() {
    try {
      await api.del(`/metrics/facebook/pages/${page.id}`);
      toast.success('Disconnected. Everything read from it was removed.');
      onGone();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  const o = overview.data;
  const chart = useMemo(() => (o?.days ?? []).filter((d) => d.views !== null || d.engagements !== null).map((d) => ({ day: dayLabel(d.day), Views: d.views, Engagements: d.engagements })), [o]);

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-3">
          {page.picture ? <img src={page.picture} alt="" referrerPolicy="no-referrer" className="h-12 w-12 rounded-full object-cover" /> : <div className="h-12 w-12 rounded-full bg-slate-800" />}
          <div className="min-w-0 grow">
            <h2 className="truncate text-lg font-semibold">{page.name}</h2>
            <p className="text-xs text-slate-500">{page.lastSyncedAt ? `Updated ${timeAgo(page.lastSyncedAt)}` : 'Not read yet'}</p>
          </div>
          <Button variant="primary" onClick={() => void sync()} loading={syncing}><RefreshCw className="h-4 w-4" aria-hidden /> Refresh from Facebook</Button>
          {isAdmin && (confirm ? (
            <>
              <Button variant="danger" onClick={() => void remove()}>Yes, disconnect</Button>
              <Button variant="ghost" onClick={() => setConfirm(false)}>Keep it</Button>
            </>
          ) : (
            <Button variant="ghost" onClick={() => setConfirm(true)} aria-label={`Disconnect ${page.name}`}><Trash2 className="h-4 w-4" aria-hidden /></Button>
          ))}
        </div>
        {page.lastError && <p className="mt-3 rounded-lg border border-rose-500/30 bg-rose-500/5 p-2 text-sm text-rose-300" role="alert">{page.lastError}</p>}
      </Card>

      {!o ? (
        <Skeleton className="h-40" />
      ) : (
        <>
          <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Headline numbers">
            <Stat label="Followers" value={n(page.followers)} sub={o.followerChange === null ? 'Change shows after a second day of reading' : `${o.followerChange >= 0 ? '+' : ''}${num(o.followerChange)} since ${dayLabel(o.followerSince!)}`} />
            <Stat label="Views, last 30 days" value={n(o.last30.views)} sub={o.last30.newFollows === null ? 'Facebook did not share Page totals' : `${num(o.last30.newFollows)} new follows`} />
            <Stat label="Engagements, last 30 days" value={n(o.last30.engagements)} sub="Reactions, comments, shares and more" />
            <Stat label="Average post reach" value={n(o.last30.averageReach)} sub={`${o.last30.posts} post${o.last30.posts === 1 ? '' : 's'}${o.last30.averageEngagement !== null ? ` · ${pct(o.last30.averageEngagement)} engaged` : ''}`} />
          </section>
          <Card className="p-4">
            <CardHeader eyebrow="Over time" title="Views and engagements by day" />
            {chart.length < 2 ? (
              <p className="mt-3 text-sm text-slate-500">Facebook gave no daily numbers for this Page (Pages under 100 likes get none), or there is only one day so far.</p>
            ) : (
              <div className="mt-3 h-64" role="img" aria-label="Page views and engagements by day">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chart} margin={{ top: 4, right: 8, left: -8, bottom: 0 }}>
                    <CartesianGrid stroke={cssColor('slate-800')} vertical={false} />
                    <XAxis dataKey="day" tick={{ fill: AXIS, fontSize: 11 }} minTickGap={32} axisLine={false} tickLine={false} />
                    <YAxis yAxisId="v" allowDecimals={false} tick={{ fill: AXIS, fontSize: 11 }} axisLine={false} tickLine={false} width={52} />
                    <YAxis yAxisId="e" orientation="right" allowDecimals={false} tick={{ fill: AXIS, fontSize: 11 }} axisLine={false} tickLine={false} width={44} />
                    <Tooltip contentStyle={tooltipStyle} />
                    <Line yAxisId="v" type="monotone" dataKey="Views" stroke={cssColor('cyan-500')} strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />
                    <Line yAxisId="e" type="monotone" dataKey="Engagements" stroke={cssColor('violet-500')} strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </Card>
        </>
      )}

      <Card className="p-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <CardHeader eyebrow="Every post" title="How each one did" />
          <Field label="Sort by"><Select value={sort} onChange={(e) => setSort(e.target.value)}>{SORTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
        </div>
        {posts.error ? <ErrorState message={posts.error} onRetry={posts.reload} /> : !posts.data ? <Skeleton className="mt-3 h-40" /> : posts.data.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">{page.lastSyncedAt ? 'No posts to show.' : 'Press "Refresh from Facebook" to read the posts.'}</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[44rem] text-left text-sm">
              <thead className="text-xs uppercase tracking-wider text-slate-500">
                <tr><th className="py-2 pr-3 font-medium">Post</th><th className="px-2 font-medium">Reach</th><th className="px-2 font-medium">Views</th><th className="px-2 font-medium">Reactions</th><th className="px-2 font-medium">Comments</th><th className="px-2 font-medium">Shares</th><th className="px-2 font-medium">Clicks</th><th className="px-2 font-medium">Engaged</th></tr>
              </thead>
              <tbody>
                {posts.data.map((p) => (
                  <tr key={p.id} className="border-t border-slate-800">
                    <td className="py-2 pr-3">
                      <div className="flex items-center gap-3">
                        {p.thumb ? <img src={p.thumb} alt="" referrerPolicy="no-referrer" className="h-12 w-12 shrink-0 rounded object-cover" /> : <div className="h-12 w-12 shrink-0 rounded bg-slate-800" />}
                        <div className="min-w-0">
                          <div className="max-w-[18rem] truncate">{p.message.split('\n')[0] || 'No text'}</div>
                          <div className="text-xs text-slate-500"><Badge tone={p.type === 'Video' ? 'violet' : 'slate'}>{p.type}</Badge> {p.postedAt ? new Date(p.postedAt).toLocaleDateString() : ''}
                            {p.permalink && <a href={p.permalink} target="_blank" rel="noreferrer noopener" className="ml-2 inline-flex items-center gap-0.5 text-cyan-300 hover:underline" aria-label="Open on Facebook"><ExternalLink className="h-3 w-3" aria-hidden /></a>}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-2 tabular-nums">{n(p.metrics.reach)}</td>
                    <td className="px-2 tabular-nums">{n(p.metrics.views)}</td>
                    <td className="px-2 tabular-nums">{n(p.metrics.likes)}</td>
                    <td className="px-2 tabular-nums">{n(p.metrics.comments)}</td>
                    <td className="px-2 tabular-nums">{n(p.metrics.shares)}</td>
                    <td className="px-2 tabular-nums">{n(p.metrics.clicks)}</td>
                    <td className="px-2 tabular-nums">{pct(p.engagement)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
