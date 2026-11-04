import { ExternalLink, RefreshCw, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useCan } from '../../auth/context';
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, Field, Input, Modal, Select, Skeleton } from '../../components/ui';
import type { Project } from '../../lib/types';
import { api, errorMessage } from '../../lib/api';
import { num, timeAgo } from '../../lib/format';
import { useApi } from '../../lib/hooks';
import { METRIC_LABELS, watchTime, type IgAccount, type IgPost, type IgPostDetail, type Overview, type SyncResult } from '../../lib/metrics';
import { cssColor } from '../../lib/theme';
import { useToast } from '../../state/Toast';
import { AXIS, ConnectBox, dayLabel, n, SORTS, Stat, tooltipStyle } from './shared';

const IG_STEPS = (
  <>
    <li>The Instagram account must be a <strong>Business or Creator</strong> account (Instagram, Settings, Account type).</li>
    <li>In <strong>Meta for Developers</strong> (developers.facebook.com), open your app, go to <strong>Use cases, Customize</strong>, and under <strong>Permissions and features</strong> make sure <strong>instagram_manage_insights</strong> and <strong>instagram_basic</strong> are added.</li>
    <li>Add the account under <strong>App roles, Roles</strong> as an <strong>Instagram Tester</strong> and have them accept in Instagram (Settings, Apps and websites, Tester invites).</li>
    <li>Under <strong>Generate access tokens</strong>, add the account, sign in as it and generate a token. Paste it here.</li>
    <li>If it says it could not find the account on its own, also paste the account&apos;s Instagram ID (Meta Business Settings, Accounts, Instagram accounts).</li>
  </>
);

export default function InstagramView() {
  const toast = useToast();
  const isAdmin = useCan('admin');
  const accounts = useApi<IgAccount[]>('/metrics/accounts');
  const [picked, setPicked] = useState('');
  const list = accounts.data ?? [];
  const account = list.find((a) => a.id === picked) ?? list[0] ?? null;

  return (
    <div>
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
          {isAdmin && (
            <ConnectBox
              title={list.length === 0 ? 'Connect an Instagram account' : 'Connect another account'}
              intro="Each account needs its own access token, made in Meta for Developers. Reading is free. The token is kept encrypted here and is never shown again."
              idLabel="Instagram account ID"
              idPlaceholder="optional"
              steps={IG_STEPS}
              connect={async (token, id) => {
                // one token can reach several accounts (Meta's Unified login), so the answer is a list
                const r = await api.post<{ accounts: (SyncResult & { error?: string })[] }>('/metrics/accounts', { token, ...(id ? { igUserId: id } : {}) });
                const ok = r.accounts.filter((a) => !a.error);
                if (ok.length) toast.success(`Connected ${ok.map((a) => `@${a.account.username}`).join(', ')}, ${ok.reduce((s, a) => s + a.posts, 0)} posts read.`);
                for (const a of r.accounts.filter((x) => x.error)) toast.error(`@${a.account.username}: ${a.error}`);
                setPicked(r.accounts[0].account.id);
                accounts.reload();
              }}
            />
          )}
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
  // a line for each day something was posted (one per day, even when there were two posts), only on days the chart has
  const marks = useMemo(() => {
    const drawn = new Set((o?.days ?? []).map((d) => d.day));
    const byDay = new Map<string, string>();
    for (const m of o?.markers ?? []) {
      if (!drawn.has(m.day)) continue;
      const text = m.episode !== null ? `Ep ${m.episode}` : '';
      byDay.set(m.day, [byDay.get(m.day), text].filter(Boolean).join(' '));
    }
    return [...byDay].map(([day, text]) => ({ day, label: dayLabel(day), text }));
  }, [o]);
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
            <Stat label="Saves and shares, last 30 days" value={`${num(o.last30.totalSaves)} · ${num(o.last30.totalShares)}`} sub="Saves, then shares and sends" />
            {o.reachSplit && o.reachSplit.followers + o.reachSplit.nonFollowers > 0 && (
              <Stat label={`${o.reachSplit.of === 'views' ? 'Views' : 'Reach'} from non-followers`} value={`${Math.round((o.reachSplit.nonFollowers / (o.reachSplit.followers + o.reachSplit.nonFollowers)) * 100)}%`} sub={`${num(o.reachSplit.nonFollowers)} of ${num(o.reachSplit.followers + o.reachSplit.nonFollowers)}, last ${o.reachSplit.days} days, whole account`} />
            )}
          </section>

          <Card className="p-4">
            <CardHeader eyebrow="Over time" title={followerDays >= 2 ? 'Followers and reach' : 'Reach per day'} />
            {chart.length < 2 ? (
              <p className="mt-3 text-sm text-slate-500">The lines draw once there are two or more days of numbers. Refresh again tomorrow.</p>
            ) : (
              <>
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
                    {marks.map((m) => <ReferenceLine key={m.day} yAxisId="r" x={m.label} stroke={cssColor('amber-500')} strokeDasharray="3 3" strokeOpacity={0.8} label={{ value: m.text, position: 'insideTopRight', fill: AXIS, fontSize: 10 }} />)}
                  </LineChart>
                </ResponsiveContainer>
              </div>
              {marks.length > 0 && <p className="mt-2 text-xs text-slate-500">Dashed lines are days you posted{marks.some((m) => m.text) ? ' (labelled with the episode, when a post is tied to one)' : ''}.</p>}
              </>
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
            <table className="w-full min-w-[50rem] text-left text-sm">
              <thead className="text-xs uppercase tracking-wider text-slate-500">
                <tr><th className="py-2 pr-3 font-medium">Post</th><th className="px-2 font-medium">Reach</th><th className="px-2 font-medium">Views</th><th className="px-2 font-medium">Likes</th><th className="px-2 font-medium">Comments</th><th className="px-2 font-medium">Saves</th><th className="px-2 font-medium">Shares and sends</th><th className="px-2 font-medium" title="Instagram only reports follows for photos and carousels, not Reels">Follows</th><th className="px-2 font-medium">Engaged</th></tr>
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
                    <td className="px-2 tabular-nums">{n(p.metrics.follows)}</td>
                    <td className="px-2 tabular-nums">{p.engagement === null ? '–' : `${p.engagement}%`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <PostModal post={open} onClose={() => setOpen(null)} onChanged={() => setVersion((v) => v + 1)} />
    </div>
  );
}


/** Which episode of a project this post is, and what that episode cost to make next to what the post earned. */
function EpisodeLink({ post, onChanged }: { post: IgPostDetail; onChanged: () => void }) {
  const toast = useToast();
  const projects = useApi<Project[]>('/projects');
  const dramas = (projects.data ?? []).filter((p) => p.type === 'micro_drama');
  const [projectId, setProjectId] = useState(post.link?.projectId ?? '');
  const [episode, setEpisode] = useState(post.link ? String(post.link.episode) : '');
  const [busy, setBusy] = useState(false);
  const chosen = projectId || dramas[0]?.id || '';
  async function save(clear: boolean) {
    setBusy(true);
    try {
      await api.put(`/metrics/posts/${post.id}/episode`, { link: clear ? null : { projectId: chosen, episode: Number(episode) } });
      if (clear) setEpisode('');
      toast.success(clear ? 'Unlinked.' : 'Linked.');
      onChanged();
    } catch (e) {
      toast.error(errorMessage(e));
    }
    setBusy(false);
  }
  const m = post.metrics;
  const spend = post.link?.spendUsd ?? 0;
  const usd = (v: number) => `$${v.toFixed(v >= 100 ? 0 : 2)}`;
  return (
    <div className="mt-4 rounded-xl border border-slate-800 p-3">
      <h3 className="text-sm font-medium">Which episode is this?</h3>
      {dramas.length === 0 ? (
        <p className="mt-1 text-xs text-slate-500">{projects.loading ? 'Loading projects…' : 'No micro drama project in this workspace yet.'}</p>
      ) : (
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <Field label="Project"><Select value={chosen} onChange={(e) => setProjectId(e.target.value)}>{dramas.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>
          <Field label="Episode"><Input type="number" min={1} max={9999} value={episode} onChange={(e) => setEpisode(e.target.value)} className="w-24" /></Field>
          <Button onClick={() => void save(false)} loading={busy} disabled={!chosen || !Number.isInteger(Number(episode)) || Number(episode) < 1}>Save</Button>
          {post.link && <Button variant="ghost" onClick={() => void save(true)} disabled={busy}>Unlink</Button>}
        </div>
      )}
      {post.link && (
        <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div><dt className="text-xs uppercase tracking-wider text-slate-500">Cost to make</dt><dd className="mt-0.5 text-lg font-semibold tabular-nums">{spend > 0 ? usd(spend) : '–'}</dd></div>
          <div><dt className="text-xs uppercase tracking-wider text-slate-500">Per 1,000 views</dt><dd className="mt-0.5 text-lg font-semibold tabular-nums">{spend > 0 && m.views ? usd((spend / m.views) * 1000) : '–'}</dd></div>
          <div><dt className="text-xs uppercase tracking-wider text-slate-500">Per follow</dt><dd className="mt-0.5 text-lg font-semibold tabular-nums">{spend > 0 && m.follows ? usd(spend / m.follows) : '–'}</dd></div>
          <div><dt className="text-xs uppercase tracking-wider text-slate-500">Follows</dt><dd className="mt-0.5 text-lg font-semibold tabular-nums">{n(m.follows)}</dd></div>
        </dl>
      )}
      {post.link && spend === 0 && <p className="mt-2 text-xs text-slate-500">No generation cost is recorded for {post.link.projectName} episode {post.link.episode}.</p>}
    </div>
  );
}

function PostModal({ post, onClose, onChanged }: { post: IgPost | null; onClose: () => void; onChanged: () => void }) {
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
            {d && <EpisodeLink key={`${d.id}-${d.link?.projectId ?? ''}-${d.link?.episode ?? ''}`} post={d} onChanged={() => (detail.reload(), onChanged())} />}
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
            {d && (
              <div className="mt-4">
                <h3 className="text-sm font-medium">What viewers say</h3>
                {d.comments.length === 0 ? (
                  <p className="mt-1 text-sm text-slate-500">No comments read yet. Comments are read under the 15 newest posts each time you refresh.</p>
                ) : (
                  <ul className="mt-2 max-h-64 space-y-2 overflow-y-auto pr-1">
                    {d.comments.map((c) => (
                      <li key={c.id} className="rounded-lg bg-slate-900/60 px-3 py-2 text-sm">
                        <span className="text-xs text-slate-500">{c.username ? `@${c.username}` : 'Someone'}{c.postedAt ? ` · ${new Date(c.postedAt).toLocaleDateString()}` : ''}{c.likes > 0 ? ` · ${c.likes} like${c.likes === 1 ? '' : 's'}` : ''}</span>
                        <p className="mt-0.5 whitespace-pre-wrap break-words">{c.text}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

