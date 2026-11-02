import { BarChart3, ExternalLink, Plug, RefreshCw, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useCan } from '../auth/context';
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, Field, Input, Modal, PageHeader, Select, Skeleton } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { num, timeAgo } from '../lib/format';
import { useApi, useDocumentTitle } from '../lib/hooks';
import { METRIC_LABELS, watchTime, type IgAccount, type IgPost, type IgPostDetail, type Overview, type SyncResult } from '../lib/metrics';
import { cssColor } from '../lib/theme';
import { useToast } from '../state/Toast';

const tooltipStyle = { background: cssColor('slate-900'), border: `1px solid ${cssColor('slate-700')}`, borderRadius: 12, color: cssColor('slate-100') } as const;
const AXIS = cssColor('slate-400');
const SORTS: [string, string][] = [['recent', 'Newest'], ['reach', 'Reach'], ['views', 'Views'], ['engagement', 'Engagement'], ['saved', 'Saves'], ['shares', 'Shares'], ['comments', 'Comments'], ['likes', 'Likes']];
const dayLabel = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const n = (v: number | null | undefined) => (v == null ? '–' : num(v));

export default function Metrics() {
  useDocumentTitle('Metrics');
  const isAdmin = useCan('admin');
  const accounts = useApi<IgAccount[]>('/metrics/accounts');
  const [picked, setPicked] = useState('');
  const list = accounts.data ?? [];
  const account = list.find((a) => a.id === picked) ?? list[0] ?? null;

  return (
    <div>
      <PageHeader eyebrow="How it is landing" title="Metrics" />
      {accounts.error ? (
        <ErrorState message={accounts.error} onRetry={accounts.reload} />
      ) : !accounts.data ? (
        <Skeleton className="h-40" />
      ) : (
        <>
          {list.length > 1 && (
            <div className="mb-4 flex flex-wrap gap-2" role="tablist" aria-label="Instagram accounts">
              {list.map((a) => (
                <button key={a.id} role="tab" aria-selected={a.id === account?.id} onClick={() => setPicked(a.id)} className={`rounded-full border px-3 py-1.5 text-sm ${a.id === account?.id ? 'border-cyan-500/60 bg-cyan-500/10 text-cyan-200' : 'border-slate-700 text-slate-400 hover:border-slate-500'}`}>
                  @{a.username}
                </button>
              ))}
            </div>
          )}
          {account ? <AccountView key={account.id} account={account} isAdmin={isAdmin} reload={accounts.reload} onGone={() => (setPicked(''), accounts.reload())} /> : <EmptyState title="No Instagram account connected" hint={isAdmin ? 'Connect one below to see its reach, saves and shares.' : 'An admin needs to connect an Instagram account first.'} />}
          {isAdmin && <ConnectCard first={list.length === 0} onDone={(a) => (setPicked(a.id), accounts.reload())} />}
        </>
      )}
    </div>
  );
}

function AccountView({ account, isAdmin, reload, onGone }: { account: IgAccount; isAdmin: boolean; reload: () => void; onGone: () => void }) {
  const toast = useToast();
  const [version, setVersion] = useState(0);
  const overview = useApi<Overview>(`/metrics/accounts/${account.id}/overview?v=${version}`);
  const [sort, setSort] = useState('recent');
  const [type, setType] = useState('');
  const posts = useApi<IgPost[]>(`/metrics/accounts/${account.id}/posts?sort=${sort}${type ? `&type=${type}` : ''}&v=${version}`);
  const [syncing, setSyncing] = useState(false);
  const [open, setOpen] = useState<IgPost | null>(null);
  const [confirm, setConfirm] = useState(false);

  async function sync() {
    setSyncing(true);
    try {
      const r = await api.post<SyncResult>(`/metrics/accounts/${account.id}/sync`, {});
      toast.success(`${r.posts} posts read.${r.withoutInsights.length ? ' Instagram does not share some numbers for this account.' : ''}`);
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
      await api.del(`/metrics/accounts/${account.id}`);
      toast.success('Disconnected. Everything read from it was removed.');
      onGone();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  const o = overview.data;
  const chart = useMemo(() => (o?.days ?? []).map((d) => ({ day: dayLabel(d.day), Followers: d.followers, Reach: d.reach })), [o]);
  // Followers are only known from the day the account was connected, so a line needs a second day
  const followerDays = (o?.days ?? []).filter((d) => d.followers !== null).length;
  const expires = account.tokenExpiresAt ? Math.ceil((Date.parse(account.tokenExpiresAt) - Date.now()) / 86_400_000) : null;

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-3">
          {account.picture ? <img src={account.picture} alt="" referrerPolicy="no-referrer" className="h-12 w-12 rounded-full object-cover" /> : <div className="h-12 w-12 rounded-full bg-slate-800" />}
          <div className="min-w-0 grow">
            <h2 className="truncate text-lg font-semibold">@{account.username}</h2>
            <p className="text-xs text-slate-500">
              {account.lastSyncedAt ? `Updated ${timeAgo(account.lastSyncedAt)}` : 'Not read yet'}
              {expires !== null && ` · connection renews itself, ${expires} days left`}
            </p>
          </div>
          <Button variant="primary" onClick={() => void sync()} loading={syncing}><RefreshCw className="h-4 w-4" aria-hidden /> Refresh from Instagram</Button>
          {isAdmin && (confirm ? (
            <>
              <Button variant="danger" onClick={() => void remove()}>Yes, disconnect</Button>
              <Button variant="ghost" onClick={() => setConfirm(false)}>Keep it</Button>
            </>
          ) : (
            <Button variant="ghost" onClick={() => setConfirm(true)} aria-label={`Disconnect @${account.username}`}><Trash2 className="h-4 w-4" aria-hidden /></Button>
          ))}
        </div>
        {account.lastError && <p className="mt-3 rounded-lg border border-rose-500/30 bg-rose-500/5 p-2 text-sm text-rose-300" role="alert">{account.lastError}</p>}
      </Card>

      {!o ? (
        <Skeleton className="h-40" />
      ) : (
        <>
          <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Headline numbers">
            <Stat label="Followers" value={n(account.followers)} sub={o.followerChange === null ? 'Change shows after a second day of reading' : `${o.followerChange >= 0 ? '+' : ''}${num(o.followerChange)} since ${dayLabel(o.followerSince!)}`} />
            <Stat label="Average reach, last 30 days" value={n(o.last30.averageReach)} sub={`${o.last30.posts} post${o.last30.posts === 1 ? '' : 's'}`} />
            <Stat label="Average engagement" value={o.last30.averageEngagement === null ? '–' : `${o.last30.averageEngagement}%`} sub="Likes, comments, saves and shares, of people reached" />
            <Stat label="Saves and shares, last 30 days" value={`${num(o.last30.totalSaves)} · ${num(o.last30.totalShares)}`} sub="Saves, then shares" />
          </section>

          <Card className="p-4">
            <CardHeader eyebrow="Over time" title={followerDays >= 2 ? 'Followers and reach' : 'Reach per day'} />
            {chart.length < 2 ? (
              <p className="mt-3 text-sm text-slate-500">The lines draw once there are two or more days of numbers. Refresh again tomorrow.</p>
            ) : (
              <div className="mt-3 h-64" role="img" aria-label="Followers and reach by day">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chart} margin={{ top: 4, right: 8, left: -8, bottom: 0 }}>
                    <CartesianGrid stroke={cssColor('slate-800')} vertical={false} />
                    <XAxis dataKey="day" tick={{ fill: AXIS, fontSize: 11 }} minTickGap={32} axisLine={false} tickLine={false} />
                    {followerDays >= 2 && <YAxis yAxisId="f" domain={['auto', 'auto']} allowDecimals={false} tick={{ fill: AXIS, fontSize: 11 }} axisLine={false} tickLine={false} width={52} />}
                    <YAxis yAxisId="r" orientation="right" allowDecimals={false} tick={{ fill: AXIS, fontSize: 11 }} axisLine={false} tickLine={false} width={44} />
                    <Tooltip contentStyle={tooltipStyle} />
                    {followerDays >= 2 && <Line yAxisId="f" type="monotone" dataKey="Followers" stroke={cssColor('cyan-500')} strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />}
                    <Line yAxisId="r" type="monotone" dataKey="Reach" stroke={cssColor('violet-500')} strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />
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
          <div className="flex gap-2">
            <Field label="Sort by"><Select value={sort} onChange={(e) => setSort(e.target.value)}>{SORTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
            <Field label="Show"><Select value={type} onChange={(e) => setType(e.target.value)}><option value="">All</option>{['Reel', 'Carousel', 'Photo', 'Video'].map((t) => <option key={t} value={t}>{t}s</option>)}</Select></Field>
          </div>
        </div>
        {posts.error ? <ErrorState message={posts.error} onRetry={posts.reload} /> : !posts.data ? <Skeleton className="mt-3 h-40" /> : posts.data.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">{account.lastSyncedAt ? 'No posts to show.' : 'Press "Refresh from Instagram" to read the posts.'}</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[44rem] text-left text-sm">
              <thead className="text-xs uppercase tracking-wider text-slate-500">
                <tr><th className="py-2 pr-3 font-medium">Post</th><th className="px-2 font-medium">Reach</th><th className="px-2 font-medium">Views</th><th className="px-2 font-medium">Likes</th><th className="px-2 font-medium">Comments</th><th className="px-2 font-medium">Saves</th><th className="px-2 font-medium">Shares</th><th className="px-2 font-medium">Engaged</th></tr>
              </thead>
              <tbody>
                {posts.data.map((p) => (
                  <tr key={p.id} className="cursor-pointer border-t border-slate-800 hover:bg-slate-900/40" onClick={() => setOpen(p)}>
                    <td className="py-2 pr-3">
                      <button className="flex items-center gap-3 text-left" onClick={(e) => (e.stopPropagation(), setOpen(p))} aria-label={`Open ${p.caption.slice(0, 40) || 'post'}`}>
                        {p.thumb ? <img src={p.thumb} alt="" referrerPolicy="no-referrer" className="h-12 w-9 shrink-0 rounded object-cover" /> : <div className="h-12 w-9 shrink-0 rounded bg-slate-800" />}
                        <span className="min-w-0">
                          <span className="block max-w-[18rem] truncate">{p.caption.split('\n')[0] || 'No caption'}</span>
                          <span className="text-xs text-slate-500"><Badge tone={p.type === 'Reel' ? 'violet' : 'slate'}>{p.type}</Badge> {p.postedAt ? new Date(p.postedAt).toLocaleDateString() : ''}</span>
                        </span>
                      </button>
                    </td>
                    <td className="px-2 tabular-nums">{n(p.metrics.reach)}</td>
                    <td className="px-2 tabular-nums">{n(p.metrics.views)}</td>
                    <td className="px-2 tabular-nums">{n(p.metrics.likes)}</td>
                    <td className="px-2 tabular-nums">{n(p.metrics.comments)}</td>
                    <td className="px-2 tabular-nums">{n(p.metrics.saved)}</td>
                    <td className="px-2 tabular-nums">{n(p.metrics.shares)}</td>
                    <td className="px-2 tabular-nums">{p.engagement === null ? '–' : `${p.engagement}%`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <PostModal post={open} onClose={() => setOpen(null)} />
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <Card className="p-4">
      <div className="text-xs uppercase tracking-wider text-slate-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      <div className="mt-1 text-xs text-slate-500">{sub}</div>
    </Card>
  );
}

function PostModal({ post, onClose }: { post: IgPost | null; onClose: () => void }) {
  const detail = useApi<IgPostDetail>(post ? `/metrics/posts/${post.id}` : null);
  const [line, setLine] = useState('reach');
  useEffect(() => setLine('reach'), [post?.id]);
  const d = detail.data;
  const m = post?.metrics ?? {};
  const shown = Object.keys(METRIC_LABELS).filter((k) => typeof m[k] === 'number');
  const series = (d?.snapshots ?? []).map((s) => ({ at: new Date(s.takenAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }), value: s.metrics[line] ?? null }));
  return (
    <Modal open={!!post} onClose={onClose} title={post?.caption.split('\n')[0].slice(0, 80) || 'Post'} wide>
      {post && (
        <div className="grid gap-4 md:grid-cols-[minmax(0,12rem)_minmax(0,1fr)]">
          <div>
            {post.thumb ? <img src={post.thumb} alt="" referrerPolicy="no-referrer" className="w-full rounded-xl object-cover" /> : <div className="aspect-[9/16] rounded-xl bg-slate-900" />}
            {post.permalink && <a href={post.permalink} target="_blank" rel="noreferrer noopener" className="mt-2 inline-flex items-center gap-1 text-xs text-cyan-300 hover:underline"><ExternalLink className="h-3 w-3" aria-hidden /> Open on Instagram</a>}
          </div>
          <div className="min-w-0">
            <p className="text-xs text-slate-500">{post.type}{post.postedAt ? ` · posted ${new Date(post.postedAt).toLocaleDateString()}` : ''}</p>
            <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
              {shown.map((k) => (
                <div key={k}>
                  <dt className="text-xs uppercase tracking-wider text-slate-500">{METRIC_LABELS[k]}</dt>
                  <dd className="mt-0.5 text-lg font-semibold tabular-nums">{k.startsWith('ig_reels') ? watchTime(m[k]) : num(m[k])}</dd>
                </div>
              ))}
              {post.engagement !== null && <div><dt className="text-xs uppercase tracking-wider text-slate-500">Engaged</dt><dd className="mt-0.5 text-lg font-semibold">{post.engagement}%</dd></div>}
            </dl>
            <div className="mt-4 flex items-center justify-between gap-2">
              <h3 className="text-sm font-medium">Growth since first read</h3>
              <Select value={line} onChange={(e) => setLine(e.target.value)} aria-label="Number to chart">{shown.filter((k) => !k.startsWith('ig_reels')).map((k) => <option key={k} value={k}>{METRIC_LABELS[k]}</option>)}</Select>
            </div>
            {detail.loading ? <Skeleton className="mt-2 h-40" /> : series.length < 2 ? (
              <p className="mt-2 text-sm text-slate-500">One reading so far. Each time you refresh and the numbers have moved, a point is added.</p>
            ) : (
              <div className="mt-2 h-48" role="img" aria-label={`${METRIC_LABELS[line]} over time`}>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={series} margin={{ top: 4, right: 8, left: -8, bottom: 0 }}>
                    <CartesianGrid stroke={cssColor('slate-800')} vertical={false} />
                    <XAxis dataKey="at" tick={{ fill: AXIS, fontSize: 11 }} minTickGap={24} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fill: AXIS, fontSize: 11 }} allowDecimals={false} axisLine={false} tickLine={false} width={48} />
                    <Tooltip contentStyle={tooltipStyle} />
                    <Line type="monotone" dataKey="value" name={METRIC_LABELS[line]} stroke={cssColor('cyan-500')} strokeWidth={2} connectNulls isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

function ConnectCard({ first, onDone }: { first: boolean; onDone: (a: IgAccount) => void }) {
  const toast = useToast();
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  async function connect() {
    setBusy(true);
    try {
      const r = await api.post<SyncResult>('/metrics/accounts', { token });
      toast.success(`Connected @${r.account.username}, ${r.posts} posts read.`);
      setToken('');
      onDone(r.account);
    } catch (e) {
      toast.error(errorMessage(e));
    }
    setBusy(false);
  }
  return (
    <Card className="mt-4 p-4">
      <CardHeader eyebrow="Admin" title={first ? 'Connect an Instagram account' : 'Connect another account'} />
      <p className="mt-2 text-sm text-slate-400">
        Each account needs its own Instagram access token, made in Meta for Developers. Reading is free. The token is kept encrypted here and is never shown again, and the connection renews itself before it runs out.
      </p>
      <details className="mt-3 text-sm">
        <summary className="cursor-pointer text-slate-300 hover:text-white">How to get the token</summary>
        <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-slate-400">
          <li>The Instagram account must be a <strong>Business or Creator</strong> account (Instagram, Settings, Account type).</li>
          <li>In <strong>Meta for Developers</strong> (developers.facebook.com), open your app, or create one of type Business, and add the product <strong>Instagram</strong>, then <strong>API setup with Instagram login</strong>.</li>
          <li>Under <strong>Generate access tokens</strong>, add the Instagram account and sign in as it. Allow the permissions it asks for, including insights.</li>
          <li>For an account that is not yours (a client), add it first under <strong>App roles, Roles</strong> as an <strong>Instagram Tester</strong>, and have them accept in Instagram (Settings, Website permissions, Tester invites). Until the app passes Meta's app review, only accounts added this way can connect.</li>
          <li>Copy the token Meta shows and paste it below.</li>
        </ol>
      </details>
      <form className="mt-3 flex flex-wrap items-end gap-2" onSubmit={(e) => (e.preventDefault(), token.trim() && !busy && void connect())}>
        <div className="min-w-60 flex-1">
          <Field label="Instagram access token">
            <Input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder="IGAA…" />
          </Field>
        </div>
        <Button type="submit" variant="primary" loading={busy} disabled={!token.trim()}><Plug className="h-4 w-4" aria-hidden /> Connect and read</Button>
      </form>
      <p className="mt-2 flex items-center gap-1 text-xs text-slate-500"><BarChart3 className="h-3 w-3" aria-hidden /> Posts, reach, saves, shares and watch time for the newest 40 posts.</p>
    </Card>
  );
}
