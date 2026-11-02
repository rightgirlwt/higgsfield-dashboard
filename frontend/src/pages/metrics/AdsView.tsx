import { RefreshCw, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useCan } from '../../auth/context';
import { Button, Card, CardHeader, EmptyState, ErrorState, Field, Select, Skeleton } from '../../components/ui';
import { api, errorMessage } from '../../lib/api';
import { timeAgo } from '../../lib/format';
import { useApi } from '../../lib/hooks';
import type { AdAccount, AdOverview } from '../../lib/metrics';
import { cssColor } from '../../lib/theme';
import { useToast } from '../../state/Toast';
import { AccountTabs, AXIS, ConnectBox, dayLabel, money, n, pct, Stat, tooltipStyle } from './shared';

const AD_STEPS = (
  <>
    <li>In <strong>Meta for Developers</strong>, open your app, go to <strong>Use cases, Customize</strong>, and make sure <strong>ads_read</strong> is added under <strong>Permissions and features</strong>. Nothing here ever changes a campaign.</li>
    <li>The ad account must belong to your business, or be shared with it. For a client&apos;s ad account, they share it with your business in Meta Business Settings (Accounts, Ad accounts, Add partner).</li>
    <li>Generate a token the same way as for Instagram, and paste it here.</li>
    <li>If it says it could not find an ad account on its own, also paste the ad account ID (Meta Business Settings, Accounts, Ad accounts), the number that may be shown as act_ followed by digits.</li>
  </>
);

export default function AdsView() {
  const toast = useToast();
  const isAdmin = useCan('admin');
  const accounts = useApi<AdAccount[]>('/metrics/ads/accounts');
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
          <AccountTabs label="Ad accounts" items={list.map((a) => ({ id: a.id, name: a.name }))} current={account?.id} onPick={setPicked} />
          {account ? <AdAccountView key={account.id} account={account} isAdmin={isAdmin} reload={accounts.reload} onGone={() => (setPicked(''), accounts.reload())} /> : <EmptyState title="No ad account connected" hint={isAdmin ? 'Connect one below to see what was spent and what it got.' : 'An admin needs to connect an ad account first.'} />}
          {isAdmin && (
            <ConnectBox
              title={list.length === 0 ? 'Connect an ad account' : 'Connect another ad account'}
              intro="Read only: it can see spend and results, never change a campaign. The token is kept encrypted here and is never shown again."
              idLabel="Ad account ID"
              idPlaceholder="optional"
              steps={AD_STEPS}
              connect={async (token, id) => {
                const r = await api.post<{ accounts: { account: AdAccount; days: number; error?: string }[] }>('/metrics/ads/accounts', { token, ...(id ? { adAccountId: id } : {}) });
                const ok = r.accounts.filter((a) => !a.error);
                if (ok.length) toast.success(`Connected ${ok.map((a) => a.account.name).join(', ')}.`);
                for (const a of r.accounts.filter((x) => x.error)) toast.error(`${a.account.name}: ${a.error}`);
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

function AdAccountView({ account, isAdmin, reload, onGone }: { account: AdAccount; isAdmin: boolean; reload: () => void; onGone: () => void }) {
  const toast = useToast();
  const [days, setDays] = useState(30);
  const [version, setVersion] = useState(0);
  const overview = useApi<AdOverview>(`/metrics/ads/accounts/${account.id}/overview?days=${days}&v=${version}`);
  const [syncing, setSyncing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const cur = account.currency || 'USD';

  async function sync() {
    setSyncing(true);
    try {
      await api.post(`/metrics/ads/accounts/${account.id}/sync`, {});
      toast.success('Spend and results refreshed.');
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
      await api.del(`/metrics/ads/accounts/${account.id}`);
      toast.success('Disconnected. Everything read from it was removed.');
      onGone();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  const o = overview.data;
  const chart = useMemo(() => (o?.daily ?? []).map((d) => ({ day: dayLabel(d.day), Spend: d.spend })), [o]);

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-0 grow">
            <h2 className="truncate text-lg font-semibold">{account.name}</h2>
            <p className="text-xs text-slate-500">{account.accountId} · {cur}{account.lastSyncedAt ? ` · updated ${timeAgo(account.lastSyncedAt)}` : ' · not read yet'}</p>
          </div>
          <Field label="Show"><Select value={days} onChange={(e) => setDays(Number(e.target.value))}>{[7, 30, 90].map((d) => <option key={d} value={d}>Last {d} days</option>)}</Select></Field>
          <Button variant="primary" onClick={() => void sync()} loading={syncing}><RefreshCw className="h-4 w-4" aria-hidden /> Refresh from Meta</Button>
          {isAdmin && (confirm ? (
            <>
              <Button variant="danger" onClick={() => void remove()}>Yes, disconnect</Button>
              <Button variant="ghost" onClick={() => setConfirm(false)}>Keep it</Button>
            </>
          ) : (
            <Button variant="ghost" onClick={() => setConfirm(true)} aria-label={`Disconnect ${account.name}`}><Trash2 className="h-4 w-4" aria-hidden /></Button>
          ))}
        </div>
        {account.lastError && <p className="mt-3 rounded-lg border border-rose-500/30 bg-rose-500/5 p-2 text-sm text-rose-300" role="alert">{account.lastError}</p>}
      </Card>

      {!o ? (
        <Skeleton className="h-40" />
      ) : o.campaigns.length === 0 ? (
        <EmptyState title="No spend in this window" hint={account.lastSyncedAt ? 'Nothing was spent in these days, or Meta shared no campaign data.' : 'Press "Refresh from Meta" to read the account.'} />
      ) : (
        <>
          <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Headline numbers">
            <Stat label="Spend" value={money(o.totals.spend, cur)} sub={`${o.totals.campaigns} campaign${o.totals.campaigns === 1 ? '' : 's'}, last ${o.days} days`} />
            <Stat label="Results" value={n(o.totals.results)} sub="Leads where there are leads, otherwise conversations, purchases or link clicks" />
            <Stat label="Cost per result" value={money(o.totals.costPerResult, cur)} sub="Over the campaigns that got a result" />
            <Stat label="Clicks" value={n(o.totals.clicks)} sub={`${pct(o.totals.ctr)} of impressions · ${money(o.totals.cpc, cur)} a click`} />
          </section>
          <Card className="p-4">
            <CardHeader eyebrow="Over time" title="Spend by day" />
            <div className="mt-3 h-56" role="img" aria-label="Spend by day">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chart} margin={{ top: 4, right: 8, left: -8, bottom: 0 }}>
                  <CartesianGrid stroke={cssColor('slate-800')} vertical={false} />
                  <XAxis dataKey="day" tick={{ fill: AXIS, fontSize: 11 }} minTickGap={24} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fill: AXIS, fontSize: 11 }} axisLine={false} tickLine={false} width={52} />
                  <Tooltip contentStyle={tooltipStyle} cursor={{ fill: cssColor('slate-800') }} />
                  <Bar dataKey="Spend" fill={cssColor('cyan-500')} radius={[4, 4, 0, 0]} isAnimationActive={false} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Card>
          <Card className="p-4">
            <CardHeader eyebrow="By campaign" title="What each campaign got" />
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[40rem] text-left text-sm">
                <thead className="text-xs uppercase tracking-wider text-slate-500">
                  <tr><th className="py-2 pr-3 font-medium">Campaign</th><th className="px-2 font-medium">Spend</th><th className="px-2 font-medium">Impressions</th><th className="px-2 font-medium">Clicks</th><th className="px-2 font-medium">CTR</th><th className="px-2 font-medium">Results</th><th className="px-2 font-medium">Cost per result</th></tr>
                </thead>
                <tbody>
                  {o.campaigns.map((c) => (
                    <tr key={c.campaignId} className="border-t border-slate-800">
                      <td className="max-w-[16rem] truncate py-2 pr-3" title={c.name}>{c.name}</td>
                      <td className="px-2 tabular-nums">{money(c.spend, cur)}</td>
                      <td className="px-2 tabular-nums">{n(c.impressions)}</td>
                      <td className="px-2 tabular-nums">{n(c.clicks)}</td>
                      <td className="px-2 tabular-nums">{pct(c.ctr)}</td>
                      <td className="px-2 tabular-nums">{c.results === null ? '–' : `${n(c.results)} ${c.resultLabel?.toLowerCase()}`}</td>
                      <td className="px-2 tabular-nums">{money(c.costPerResult, cur)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
