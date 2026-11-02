import { ExternalLink, RefreshCw } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useCan } from '../../auth/context';
import { Badge, Button, Card, CardHeader, ErrorState, Skeleton } from '../../components/ui';
import { api, errorMessage } from '../../lib/api';
import { num, timeAgo } from '../../lib/format';
import { useApi } from '../../lib/hooks';
import type { Summary } from '../../lib/metrics';
import { useToast } from '../../state/Toast';
import { money, n, pct } from './shared';

export type ViewId = 'all' | 'instagram' | 'facebook' | 'ads';

/** Every connected account on one page: the headline numbers for each, and the best recent posts across Instagram and Facebook. */
export default function AllView({ onOpen }: { onOpen: (v: ViewId) => void }) {
  const toast = useToast();
  const isAdmin = useCan('admin');
  const s = useApi<Summary>('/metrics/summary');
  const [busy, setBusy] = useState(false);
  const d = s.data;
  const total = d ? d.instagram.length + d.facebook.length + d.ads.length : 0;

  /** Reads every connected account in turn. One failing must not stop the others. */
  async function refreshAll() {
    if (!d) return;
    setBusy(true);
    const jobs = [
      ...d.instagram.map((a) => ({ name: a.name, path: `/metrics/accounts/${a.id}/sync` })),
      ...d.facebook.map((p) => ({ name: p.name, path: `/metrics/facebook/pages/${p.id}/sync` })),
      ...d.ads.map((a) => ({ name: a.name, path: `/metrics/ads/accounts/${a.id}/sync` })),
    ];
    let ok = 0;
    for (const j of jobs) {
      try {
        await api.post(j.path, {});
        ok++;
      } catch (e) {
        toast.error(`${j.name}: ${errorMessage(e)}`);
      }
    }
    if (ok) toast.success(`${ok} of ${jobs.length} refreshed.`);
    s.reload();
    setBusy(false);
  }

  if (s.error) return <ErrorState message={s.error} onRetry={s.reload} />;
  if (!d) return <Skeleton className="h-60" />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-slate-400">{total === 0 ? 'Nothing is connected for this workspace yet.' : `${total} account${total === 1 ? '' : 's'} connected for this workspace.`}</p>
        {total > 0 && <Button variant="primary" onClick={() => void refreshAll()} loading={busy}><RefreshCw className="h-4 w-4" aria-hidden /> Refresh everything</Button>}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Channel title="Instagram" empty="No Instagram account connected" canConnect={isAdmin} onOpen={() => onOpen('instagram')} count={d.instagram.length}>
          {d.instagram.map((a) => (
            <Row key={a.id} name={a.name} picture={a.picture} stamp={a.lastSyncedAt} error={a.lastError} lines={[
              ['Followers', `${n(a.followers)}${a.followerChange ? ` (${a.followerChange > 0 ? '+' : ''}${num(a.followerChange)})` : ''}`],
              ['Average reach, 30 days', n(a.averageReach)],
              ['Engagement', pct(a.averageEngagement)],
            ]} />
          ))}
        </Channel>
        <Channel title="Facebook" empty="No Facebook Page connected" canConnect={isAdmin} onOpen={() => onOpen('facebook')} count={d.facebook.length}>
          {d.facebook.map((p) => (
            <Row key={p.id} name={p.name} picture={p.picture} stamp={p.lastSyncedAt} error={p.lastError} lines={[
              ['Followers', `${n(p.followers)}${p.followerChange ? ` (${p.followerChange > 0 ? '+' : ''}${num(p.followerChange)})` : ''}`],
              ['Views, 30 days', n(p.views)],
              ['Engagements, 30 days', n(p.engagements)],
            ]} />
          ))}
        </Channel>
        <Channel title="Ads" empty="No ad account connected" canConnect={isAdmin} onOpen={() => onOpen('ads')} count={d.ads.length}>
          {d.ads.map((a) => (
            <Row key={a.id} name={a.name} picture="" stamp={a.lastSyncedAt} error={a.lastError} lines={[
              ['Spend, 30 days', money(a.spend, a.currency)],
              ['Results', a.results === null ? '–' : n(a.results)],
              ['Cost per result', money(a.costPerResult, a.currency)],
            ]} />
          ))}
        </Channel>
      </div>

      <Card className="p-4">
        <CardHeader eyebrow="Last 30 days" title="Best posts across Instagram and Facebook" />
        {d.topPosts.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">Posts from the last 30 days show here once an Instagram account or Facebook Page has been read.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[36rem] text-left text-sm">
              <thead className="text-xs uppercase tracking-wider text-slate-500">
                <tr><th className="py-2 pr-3 font-medium">Post</th><th className="px-2 font-medium">Where</th><th className="px-2 font-medium">Reach</th><th className="px-2 font-medium">Engaged</th></tr>
              </thead>
              <tbody>
                {d.topPosts.map((p, i) => (
                  <tr key={`${p.permalink}-${i}`} className="border-t border-slate-800">
                    <td className="py-2 pr-3">
                      <div className="flex items-center gap-3">
                        {p.thumb ? <img src={p.thumb} alt="" referrerPolicy="no-referrer" className="h-12 w-10 shrink-0 rounded object-cover" /> : <div className="h-12 w-10 shrink-0 rounded bg-slate-800" />}
                        <div className="min-w-0">
                          <div className="max-w-[20rem] truncate">{p.title || 'No text'}</div>
                          <div className="text-xs text-slate-500">{p.type} {p.postedAt ? new Date(p.postedAt).toLocaleDateString() : ''}
                            {p.permalink && <a href={p.permalink} target="_blank" rel="noreferrer noopener" className="ml-2 inline-flex items-center text-cyan-300 hover:underline" aria-label={`Open on ${p.channel}`}><ExternalLink className="h-3 w-3" aria-hidden /></a>}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-2"><Badge tone={p.channel === 'Instagram' ? 'violet' : 'cyan'}>{p.channel}</Badge> <span className="text-xs text-slate-500">{p.account}</span></td>
                    <td className="px-2 tabular-nums">{n(p.reach)}</td>
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

function Channel({ title, empty, count, canConnect, onOpen, children }: { title: string; empty: string; count: number; canConnect: boolean; onOpen: () => void; children: ReactNode }) {
  return (
    <Card className="p-4">
      <CardHeader eyebrow={count ? `${count} connected` : 'Not connected'} title={title} action={<Button size="sm" onClick={onOpen}>{count ? 'Open' : canConnect ? 'Connect' : 'Open'}</Button>} />
      {count === 0 ? <p className="mt-3 text-sm text-slate-500">{empty}.</p> : <div className="mt-3 space-y-4">{children}</div>}
    </Card>
  );
}

function Row({ name, picture, stamp, error, lines }: { name: string; picture: string; stamp: string | null; error: string; lines: [string, string][] }) {
  return (
    <div>
      <div className="flex items-center gap-2">
        {picture ? <img src={picture} alt="" referrerPolicy="no-referrer" className="h-7 w-7 rounded-full object-cover" /> : null}
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{name}</div>
          <div className="text-xs text-slate-500">{stamp ? `Updated ${timeAgo(stamp)}` : 'Not read yet'}</div>
        </div>
      </div>
      <dl className="mt-2 grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-sm">
        {lines.map(([k, v]) => (
          <div key={k} className="contents"><dt className="text-slate-500">{k}</dt><dd className="text-right font-medium tabular-nums">{v}</dd></div>
        ))}
      </dl>
      {error && <p className="mt-2 rounded-lg border border-rose-500/30 bg-rose-500/5 p-2 text-xs text-rose-300" role="alert">{error}</p>}
    </div>
  );
}
