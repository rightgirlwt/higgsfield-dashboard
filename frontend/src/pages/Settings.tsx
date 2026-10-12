import { CheckCircle2, Download, KeyRound, Lock, Trash2, UserPlus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useAuth, useCan } from '../auth/context';
import { Badge, Button, Card, CardHeader, ErrorState, Field, Input, PageHeader, Select, Skeleton, Tabs } from '../components/ui';
import { PriceCheckCard } from '../components/PriceCheckCard';
import { api, errorMessage } from '../lib/api';
import { price, timeAgo } from '../lib/format';
import { useApi, useDocumentTitle } from '../lib/hooks';
import type { Role, SecretStatus, SettingsData, StudioCatalog, TeamUser } from '../lib/types';
import { useToast } from '../state/Toast';

type Tab = 'models' | 'keys' | 'higgsfield' | 'storage' | 'team' | 'billing' | 'data';

export default function SettingsPage() {
  useDocumentTitle('Settings');
  const [tab, setTab] = useState<Tab>('keys');
  const isAdmin = useCan('admin');
  const settings = useApi<SettingsData>('/settings');

  return (
    <div>
      <PageHeader eyebrow="Configuration" title="Settings & integrations" />
      <div className="mb-6">
        <Tabs
          label="Settings sections"
          value={tab}
          onChange={setTab}
          tabs={[
            { id: 'keys', label: 'API keys' },
            { id: 'higgsfield', label: 'Higgsfield' },
            { id: 'models', label: 'Claude models' },
            { id: 'storage', label: 'Storage' },
            { id: 'team', label: 'Team' },
            { id: 'billing', label: 'Billing & alerts' },
            { id: 'data', label: 'Data export' },
          ]}
        />
      </div>
      {!isAdmin && tab !== 'data' && tab !== 'team' && (
        <p role="note" className="mb-4 flex items-center gap-2 rounded-xl border border-slate-800 bg-slate-900/60 p-3 text-sm text-slate-300"><Lock className="h-4 w-4" aria-hidden /> Only admins can view or change this section.</p>
      )}
      {settings.error ? (
        <ErrorState message={settings.error} onRetry={settings.reload} />
      ) : !settings.data ? (
        <Skeleton className="h-64" />
      ) : (
        <>
          {tab === 'keys' && isAdmin && <Keys />}
          {tab === 'higgsfield' && isAdmin && <HiggsfieldTab s={settings.data} onSaved={settings.reload} />}
          {tab === 'models' && isAdmin && <Models s={settings.data} onSaved={settings.reload} />}
          {tab === 'storage' && isAdmin && <Storage s={settings.data} onSaved={settings.reload} />}
          {tab === 'team' && <Team />}
          {tab === 'billing' && isAdmin && <Billing s={settings.data} onSaved={settings.reload} />}
          {tab === 'data' && <DataExport />}
        </>
      )}
    </div>
  );
}

const SECRET_META: Record<SecretStatus['name'], { label: string; hint: string; group: 'ai' | 'storage' }> = {
  anthropic: { label: 'Anthropic (Claude) API key', hint: 'Used for prompt runs and workflow LLM nodes. Without it the app returns clearly-labelled simulated responses.', group: 'ai' },
  higgsfield: { label: 'Higgsfield API key', hint: 'Paste the whole key in the form id:secret. Studio needs this plus the API address on the Higgsfield tab.', group: 'ai' },
  s3_access_key_id: { label: 'S3 access key ID', hint: 'For direct media uploads to your bucket.', group: 'storage' },
  s3_secret_access_key: { label: 'S3 secret access key', hint: 'Stored encrypted; never shown again.', group: 'storage' },
};

function Keys() {
  const toast = useToast();
  const secrets = useApi<SecretStatus[]>('/settings/secrets');
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const save = async (name: string) => {
    setBusy(name);
    try {
      await api.put(`/settings/secrets/${name}`, { value: values[name] });
      setValues((v) => ({ ...v, [name]: '' }));
      toast.success('Key saved (encrypted)');
      secrets.reload();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const remove = async (name: string) => {
    if (!window.confirm('Remove this key?')) return;
    setBusy(name);
    try {
      await api.del(`/settings/secrets/${name}`);
      secrets.reload();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const test = async () => {
    setBusy('test');
    try {
      const r = await api.post<{ ok: boolean; message?: string }>('/settings/secrets/anthropic/test');
      (r.ok ? toast.success : toast.error)(r.ok ? 'Anthropic key is valid' : (r.message ?? 'Key check failed'));
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  if (secrets.error) return <ErrorState message={secrets.error} onRetry={secrets.reload} />;
  if (!secrets.data) return <Skeleton className="h-64" />;
  return (
    <Card className="p-5">
      <CardHeader eyebrow="Integrations" title="API keys" />
      <p className="mb-5 flex gap-2 text-sm text-slate-400"><Lock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> Keys are encrypted at rest (AES-256-GCM) and never sent back to the browser — only the last 4 characters are shown.</p>
      <ul className="space-y-5">
        {secrets.data.map((s) => {
          const m = SECRET_META[s.name];
          return (
            <li key={s.name} className="rounded-xl border border-slate-800 bg-slate-950/50 p-4">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <span className="flex items-center gap-2 font-medium"><KeyRound className="h-4 w-4 text-cyan-300" aria-hidden /> {m.label}</span>
                {s.configured ? (
                  <Badge tone="emerald"><CheckCircle2 className="h-3 w-3" aria-hidden /> {s.source === 'environment' ? 'from server env' : 'configured'} · …{s.last4}</Badge>
                ) : (
                  <Badge tone="amber">not set</Badge>
                )}
              </div>
              <p className="mb-3 text-xs text-slate-500">{m.hint}{s.updatedAt && ` Updated ${timeAgo(s.updatedAt)}.`}</p>
              {s.format && (
                <p className={`mb-3 text-xs ${s.formatOk ? 'text-emerald-300' : 'text-amber-300'}`}>
                  Saved key shape: {s.format}{s.formatOk ? '' : ' — this will be rejected by Higgsfield; paste it again as ID:SECRET'}
                </p>
              )}
              <div className="flex flex-wrap items-end gap-2">
                <div className="min-w-0 flex-1">
                  <Field label={s.configured ? 'Replace key' : 'Key'} htmlFor={`k-${s.name}`}>
                    <Input id={`k-${s.name}`} type="password" autoComplete="off" spellCheck={false} placeholder="Paste key" value={values[s.name] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [s.name]: e.target.value }))} />
                  </Field>
                </div>
                <Button variant="primary" loading={busy === s.name} disabled={(values[s.name] ?? '').trim().length < 8} onClick={() => save(s.name)}>Save</Button>
                {s.name === 'anthropic' && s.configured && <Button loading={busy === 'test'} onClick={test}>Test key</Button>}
                {s.source === 'stored' && <Button variant="ghost" aria-label={`Remove ${m.label}`} onClick={() => remove(s.name)}><Trash2 className="h-4 w-4 text-rose-300" aria-hidden /></Button>}
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function HiggsfieldTab({ s, onSaved }: { s: SettingsData; onSaved: () => void }) {
  const toast = useToast();
  const catalog = useApi<StudioCatalog>('/studio/models');
  const secrets = useApi<SecretStatus[]>('/settings/secrets');
  const [baseUrl, setBaseUrl] = useState(s.higgsfield.baseUrl);
  const [prices, setPrices] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries(s.higgsfield.prices).map(([k, v]) => [k, v === null ? '' : String(v)])));
  const [busy, setBusy] = useState<string | null>(null);
  const keySet = secrets.data?.find((x) => x.name === 'higgsfield')?.configured ?? false;

  const saveUrl = async () => {
    setBusy('url');
    try {
      const r = await api.put<{ baseUrl: string }>('/settings/higgsfield', { baseUrl });
      setBaseUrl(r.baseUrl);
      toast.success(r.baseUrl ? 'API address saved' : 'API address cleared');
      onSaved();
      catalog.reload();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const savePrices = async () => {
    setBusy('prices');
    try {
      const body = Object.fromEntries(Object.entries(prices).map(([k, v]) => [k, v.trim() === '' ? null : Number(v)]));
      if (Object.values(body).some((v) => v !== null && (!Number.isFinite(v) || v < 0))) throw new Error('Prices must be numbers of 0 or more');
      await api.put('/settings/studio-prices', { prices: body });
      toast.success('Prices saved');
      onSaved();
      catalog.reload();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="grid gap-6 xl:grid-cols-2">
      <Card className="h-fit p-5">
        <CardHeader eyebrow="Studio" title="Connection" />
        <div className="mb-4 flex flex-wrap gap-2">
          <Badge tone={keySet ? 'emerald' : 'amber'}>API key {keySet ? 'saved' : 'missing'}</Badge>
          <Badge tone={baseUrl ? 'emerald' : 'amber'}>API address {baseUrl ? 'set' : 'missing'}</Badge>
          <Badge tone={catalog.data?.connected ? 'emerald' : 'amber'}>{catalog.data?.connected ? 'Studio is live' : 'Studio is simulated'}</Badge>
        </div>
        <Field label="Higgsfield API address" htmlFor="hf-base" hint={s.higgsfield.baseUrlFromEnv ? 'Currently coming from the server’s HIGGSFIELD_API_BASE setting; saving a value here overrides it.' : 'Paste the address exactly as Higgsfield gives it, starting with https://. No trailing slash needed.'}>
          <Input id="hf-base" type="url" placeholder="https://…" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
        </Field>
        <div className="mt-3 flex gap-2">
          <Button variant="primary" loading={busy === 'url'} onClick={saveUrl}>Save address</Button>
        </div>
        <p className="mt-4 text-xs text-slate-500">The key (format <code>id:secret</code>) is saved on the <strong>API keys</strong> tab. Both are required before Studio talks to Higgsfield; until then it produces placeholder results and nothing is billed.</p>
      </Card>

      <Card className="p-5">
        <CardHeader eyebrow="Spend tracking" title="Prices (USD)" />
        <p className="mb-4 text-sm text-slate-400">
          Cost dialogs and spend tracking ask <strong>Higgsfield for its own price</strong> for your exact settings, so you don’t need to enter anything. The figures below are a saved snapshot ({catalog.data?.pricesAsOf ?? '…'}) used only when Higgsfield can’t give a single number (some models are priced by length or tokens). Fill in a box only to <strong>override</strong> a model with your own flat price (per image, or per second of video). Higgsfield’s billing page is the final word on what you were charged.
        </p>
        {!catalog.data ? <Skeleton className="h-40" /> : (
          <ul className="space-y-2">
            {catalog.data.models.map((m) => {
              const ps = m.modes.map((x) => x.price).filter((x): x is NonNullable<typeof x> => !!x);
              const lo = ps.length ? Math.min(...ps.map((x) => x.min)) : null;
              const hi = ps.length ? Math.max(...ps.map((x) => x.max)) : null;
              const fmt = (n: number) => `$${n < 0.01 ? n.toFixed(4) : n.toFixed(n < 1 ? 3 : 2)}`;
              return (
                <li key={m.id} className="flex items-center justify-between gap-3">
                  <label htmlFor={`price-${m.id}`} className="min-w-0 text-sm">
                    {m.label}
                    <span className="block text-xs text-slate-500">
                      {lo !== null && hi !== null ? `Higgsfield: ${lo === hi ? fmt(lo) : `${fmt(lo)}–${fmt(hi)}`} ${m.priceUnit === 'second' ? 'per second' : 'per image'}` : 'No list price known'}
                    </span>
                  </label>
                  <div className="flex shrink-0 items-center gap-1">
                    <span className="text-slate-500">$</span>
                    <Input id={`price-${m.id}`} className="w-24" type="number" min={0} step="0.001" placeholder={lo !== null ? String(lo) : '—'} value={prices[m.id] ?? ''} onChange={(e) => setPrices((p) => ({ ...p, [m.id]: e.target.value }))} />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <Button className="mt-4" variant="primary" loading={busy === 'prices'} onClick={savePrices}>Save overrides</Button>
      </Card>

      <PriceCheckCard last={s.higgsfield.priceCheck} promoEnds={s.higgsfield.promoEnds} onChecked={onSaved} />
    </div>
  );
}

function Models({ s, onSaved }: { s: SettingsData; onSaved: () => void }) {
  const toast = useToast();
  const [model, setModel] = useState(s.defaults.model);
  const [maxTokens, setMax] = useState(s.defaults.maxTokens);
  const [temp, setTemp] = useState<number | null>(s.defaults.temperature);
  const [busy, setBusy] = useState(false);
  const info = s.models.find((m) => m.id === model);

  const save = async () => {
    setBusy(true);
    try {
      await api.put('/settings/defaults', { model, maxTokens, temperature: info?.supportsTemperature ? temp : null });
      toast.success('Defaults saved');
      onSaved();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card className="p-5">
        <CardHeader eyebrow="Defaults" title="Model configuration" />
        <div className="space-y-4">
          <Field label="Default model" htmlFor="d-model" hint="Used by workflow LLM nodes that don't pick a model.">
            <Select id="d-model" value={model} onChange={(e) => setModel(e.target.value)}>
              {s.models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </Select>
          </Field>
          <Field label="Default max tokens" htmlFor="d-max"><Input id="d-max" type="number" min={1} max={128000} value={maxTokens} onChange={(e) => setMax(Math.max(1, Number(e.target.value) || 1))} /></Field>
          <Field label="Default temperature" htmlFor="d-temp" hint={info?.supportsTemperature ? 'Claude accepts 0–1.' : `${info?.label} does not accept temperature; it is never sent.`}>
            <Input id="d-temp" type="number" min={0} max={1} step={0.05} disabled={!info?.supportsTemperature} value={temp ?? ''} placeholder="Model default" onChange={(e) => setTemp(e.target.value === '' ? null : Math.min(1, Math.max(0, Number(e.target.value))))} />
          </Field>
          <Button variant="primary" loading={busy} onClick={save}>Save defaults</Button>
        </div>
      </Card>
      <Card className="p-5">
        <CardHeader eyebrow="Reference" title="Available models & prices" />
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Models with price per million tokens</caption>
            <thead className="text-xs uppercase tracking-wider text-slate-500"><tr><th scope="col" className="pb-2">Model</th><th scope="col" className="pb-2 text-right">Input / 1M</th><th scope="col" className="pb-2 text-right">Output / 1M</th></tr></thead>
            <tbody className="divide-y divide-slate-800/70">
              {s.models.map((m) => (
                <tr key={m.id}><td className="py-2"><div>{m.label}</div><div className="text-xs text-slate-500">{m.id}</div></td><td className="py-2 text-right tabular-nums">{price(m.inputPerMTok)}</td><td className="py-2 text-right tabular-nums">{price(m.outputPerMTok)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-slate-500">Costs in the app are estimates from reported token usage × these prices. Prices live in <code>backend/src/lib/pricing.ts</code>; verify against Anthropic’s published pricing.</p>
      </Card>
    </div>
  );
}

function Storage({ s, onSaved }: { s: SettingsData; onSaved: () => void }) {
  const toast = useToast();
  const [v, setV] = useState(s.storage);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof typeof v>(k: K, x: (typeof v)[K]) => setV((p) => ({ ...p, [k]: x }));
  const save = async () => {
    setBusy(true);
    try {
      await api.put('/settings/storage', v);
      toast.success('Storage settings saved');
      onSaved();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="max-w-2xl p-5">
      <CardHeader eyebrow="Media storage" title="S3-compatible storage" />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Bucket" htmlFor="s-bucket"><Input id="s-bucket" value={v.bucket} onChange={(e) => set('bucket', e.target.value)} /></Field>
        <Field label="Region" htmlFor="s-region"><Input id="s-region" value={v.region} onChange={(e) => set('region', e.target.value)} /></Field>
        <Field label="Endpoint (optional)" htmlFor="s-ep" hint="For R2, MinIO, B2, etc. Leave empty for AWS S3."><Input id="s-ep" type="url" placeholder="https://…" value={v.endpoint} onChange={(e) => set('endpoint', e.target.value)} /></Field>
        <Field label="Public base URL (optional)" htmlFor="s-pub" hint="CDN or public bucket URL used for playback."><Input id="s-pub" type="url" value={v.publicBaseUrl} onChange={(e) => set('publicBaseUrl', e.target.value)} /></Field>
      </div>
      <label className="mt-4 flex items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4 accent-cyan-500" checked={v.forcePathStyle} onChange={(e) => set('forcePathStyle', e.target.checked)} /> Force path-style addressing (MinIO)</label>
      <p className="mt-3 text-xs text-slate-500">Access keys are set under API keys. The bucket needs a CORS rule allowing PUT from this app’s origin for browser uploads.</p>
      <Button className="mt-4" variant="primary" loading={busy} onClick={save}>Save storage settings</Button>
    </Card>
  );
}

function Team() {
  const toast = useToast();
  const { me } = useAuth();
  const isAdmin = useCan('admin');
  const team = useApi<TeamUser[]>('/team');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('user');
  const [busy, setBusy] = useState(false);

  const invite = async () => {
    setBusy(true);
    try {
      await api.post('/team/invite', { email, name: name || undefined, role });
      toast.success('Member added. They get access when they sign in with that email.');
      setEmail(''); setName('');
      team.reload();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const changeRole = async (u: TeamUser, r: Role) => {
    try {
      await api.patch(`/team/${u.id}`, { role: r });
      team.reload();
    } catch (e) {
      toast.error(errorMessage(e));
      team.reload();
    }
  };
  const remove = async (u: TeamUser) => {
    if (!window.confirm(`Remove ${u.name}?`)) return;
    try {
      await api.del(`/team/${u.id}`);
      team.reload();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <div className="grid gap-6 xl:grid-cols-[1.6fr_1fr]">
      <Card className="p-5">
        <CardHeader eyebrow="Access control" title="Team members" />
        {team.error ? <ErrorState message={team.error} onRetry={team.reload} /> : !team.data ? <Skeleton className="h-40" /> : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Team members and roles</caption>
              <thead className="text-xs uppercase tracking-wider text-slate-500"><tr><th scope="col" className="pb-2">Member</th><th scope="col" className="pb-2">Role</th><th scope="col" className="pb-2 text-right">Actions</th></tr></thead>
              <tbody className="divide-y divide-slate-800/70">
                {team.data.map((u) => (
                  <tr key={u.id}>
                    <td className="py-3 pr-3"><div className="font-medium">{u.name}{u.id === me.id && <span className="ml-2 text-xs text-slate-500">(you)</span>}</div><div className="text-xs text-slate-500">{u.email}{!u.linked && ' · invited'}</div></td>
                    <td className="py-3 pr-3">
                      {isAdmin ? (
                        <Select aria-label={`Role for ${u.name}`} className="w-28" value={u.role} onChange={(e) => changeRole(u, e.target.value as Role)}>
                          <option value="admin">Admin</option><option value="user">User</option><option value="viewer">Viewer</option>
                        </Select>
                      ) : <Badge tone={u.role === 'admin' ? 'violet' : u.role === 'user' ? 'cyan' : 'slate'}>{u.role}</Badge>}
                    </td>
                    <td className="py-3 text-right">{isAdmin && u.id !== me.id && <Button size="sm" variant="ghost" aria-label={`Remove ${u.name}`} onClick={() => remove(u)}><Trash2 className="h-4 w-4 text-rose-300" aria-hidden /></Button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <dl className="mt-5 grid gap-2 text-xs text-slate-500 sm:grid-cols-3">
          <div><dt className="font-semibold text-slate-300">Admin</dt><dd>Everything, incl. keys, team, billing</dd></div>
          <div><dt className="font-semibold text-slate-300">User</dt><dd>Create/run prompts & workflows</dd></div>
          <div><dt className="font-semibold text-slate-300">Viewer</dt><dd>Read-only</dd></div>
        </dl>
      </Card>
      {isAdmin && (
        <Card className="h-fit p-5">
          <CardHeader eyebrow="Invite" title="Add a member" />
          <div className="space-y-3">
            <Field label="Email" htmlFor="t-email"><Input id="t-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
            <Field label="Name (optional)" htmlFor="t-name"><Input id="t-name" value={name} onChange={(e) => setName(e.target.value)} /></Field>
            <Field label="Role" htmlFor="t-role"><Select id="t-role" value={role} onChange={(e) => setRole(e.target.value as Role)}><option value="admin">Admin</option><option value="user">User</option><option value="viewer">Viewer</option></Select></Field>
            <Button variant="primary" loading={busy} disabled={!email.includes('@')} onClick={invite}><UserPlus className="h-4 w-4" aria-hidden /> Add member</Button>
          </div>
        </Card>
      )}
    </div>
  );
}

function Billing({ s, onSaved }: { s: SettingsData; onSaved: () => void }) {
  const toast = useToast();
  const [budget, setBudget] = useState(s.billing.monthlyBudgetUsd);
  const [threshold, setThreshold] = useState(s.billing.alertThresholdPct);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setBudget(s.billing.monthlyBudgetUsd);
    setThreshold(s.billing.alertThresholdPct);
  }, [s.billing]);
  const save = async () => {
    setBusy(true);
    try {
      await api.put('/settings/billing', { monthlyBudgetUsd: budget, alertThresholdPct: threshold });
      toast.success('Budget saved');
      onSaved();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="max-w-xl p-5">
      <CardHeader eyebrow="Cost controls" title="Budget & alerts" />
      <div className="space-y-4">
        <Field label="Monthly budget (USD)" htmlFor="b-budget" hint="0 disables budget alerts. Compares against estimated spend this calendar month (UTC).">
          <Input id="b-budget" type="number" min={0} step={10} value={budget} onChange={(e) => setBudget(Math.max(0, Number(e.target.value) || 0))} />
        </Field>
        <Field label="Alert threshold (%)" htmlFor="b-thr" hint="You get a warning at this percentage and a critical alert at 100%. Each fires once per month.">
          <Input id="b-thr" type="number" min={1} max={100} value={threshold} onChange={(e) => setThreshold(Math.min(100, Math.max(1, Number(e.target.value) || 1)))} />
        </Field>
        <Button variant="primary" loading={busy} onClick={save}>Save budget</Button>
      </div>
      <p className="mt-4 text-xs text-slate-500">Alerts appear in the bell menu and Monitoring page. Email/Slack delivery is not built in yet.</p>
    </Card>
  );
}

function DataExport() {
  const toast = useToast();
  const [range, setRange] = useState('30d');
  const [busy, setBusy] = useState<string | null>(null);
  const get = async (path: string, file: string) => {
    setBusy(file);
    try {
      await api.download(path, file);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <Card className="max-w-xl p-5">
      <CardHeader eyebrow="Reports" title="Export your data" />
      <Field label="Date range" htmlFor="x-range">
        <Select id="x-range" value={range} onChange={(e) => setRange(e.target.value)}><option value="7d">Last 7 days</option><option value="30d">Last 30 days</option><option value="90d">Last 90 days</option></Select>
      </Field>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button loading={busy === 'usage.csv'} onClick={() => get(`/export/usage.csv?range=${range}`, 'usage.csv')}><Download className="h-4 w-4" aria-hidden /> Usage CSV</Button>
        <Button loading={busy === 'runs.csv'} onClick={() => get(`/export/runs.csv?range=${range}`, 'runs.csv')}><Download className="h-4 w-4" aria-hidden /> Runs CSV</Button>
        <Button loading={busy === 'report.pdf'} onClick={() => get(`/export/report.pdf?range=${range}`, 'report.pdf')}><Download className="h-4 w-4" aria-hidden /> PDF report</Button>
      </div>
      <p className="mt-3 text-xs text-slate-500">Media metadata export lives on the Media page.</p>
    </Card>
  );
}
