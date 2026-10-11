import { AlertTriangle, Film, ImageIcon, Library, Loader2, Plus, Sparkles, Wand2, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useCan } from '../auth/context';
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, Modal, PageHeader, Select, Skeleton, Textarea } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { timeAgo, usd } from '../lib/format';
import { useApi, useDocumentTitle } from '../lib/hooks';
import type { MediaItem, MediaRole, Run, SettingSpec, StudioCatalog, StudioModel } from '../lib/types';
import { useRealtime } from '../state/Realtime';
import { useToast } from '../state/Toast';
import { Lightbox } from './Media';

const ROLE_LABEL: Record<MediaRole, string> = {
  start: 'Start frame',
  end: 'End frame',
  reference: 'Reference images',
  video: 'Reference video',
  audio: 'Audio',
};
const ROLE_ORDER: MediaRole[] = ['start', 'end', 'reference', 'video', 'audio'];

function defaultsFor(m: StudioModel): Record<string, any> {
  return Object.fromEntries(Object.entries(m.settings).map(([k, s]) => [k, s.default]));
}

export default function Studio() {
  useDocumentTitle('Studio');
  const toast = useToast();
  const canWrite = useCan('user');
  const isAdmin = useCan('admin');
  const { runTick, jobs, logs } = useRealtime();

  const catalog = useApi<StudioCatalog>('/studio/models');
  const [modelId, setModelId] = useState('');
  const [prompt, setPrompt] = useState('');
  const [settings, setSettings] = useState<Record<string, any>>({});
  const [media, setMedia] = useState<Partial<Record<MediaRole, string[]>>>({});
  const [count, setCount] = useState(1);
  const [busy, setBusy] = useState(false);
  const [pickRole, setPickRole] = useState<MediaRole | null>(null);
  const [limit, setLimit] = useState(24);
  const [viewer, setViewer] = useState<number | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  const gallery = useApi<{ items: MediaItem[]; total: number; nextCursor: string | null }>(`/media?source=studio&limit=${limit}`);
  const activeRuns = useApi<Run[]>('/runs?kind=generation&limit=20');

  const model = catalog.data?.models.find((m) => m.id === modelId);

  // Pick the first model once the catalog loads.
  useEffect(() => {
    const first = catalog.data?.models[0];
    if (first && !modelId) {
      setModelId(first.id);
      setSettings(defaultsFor(first));
    }
  }, [catalog.data, modelId]);

  // Refresh gallery + in-progress list whenever any run changes state.
  const reloadGallery = gallery.reload;
  const reloadRuns = activeRuns.reload;
  useEffect(() => {
    if (runTick > 0) {
      reloadGallery();
      reloadRuns();
    }
  }, [runTick, reloadGallery, reloadRuns]);

  const chooseModel = (id: string) => {
    const m = catalog.data?.models.find((x) => x.id === id);
    if (!m) return;
    setModelId(id);
    setSettings(defaultsFor(m));
    // Drop media the new model can't take.
    setMedia((cur) => Object.fromEntries(Object.entries(cur).filter(([r]) => (m.roles[r as MediaRole] ?? 0) > 0)));
    if (m.nativeBatch) setCount(1);
  };

  const outputs = model ? (model.nativeBatch ? Number(settings.batchSize ?? 1) : count) : 1;
  const estimate = model?.priceUsd != null ? model.priceUsd * outputs : null;

  const generate = async () => {
    if (!model) return;
    setBusy(true);
    try {
      await api.post('/studio/generate', { modelId: model.id, prompt, settings, media, count: model.nativeBatch ? 1 : count });
      toast.success(`${model.label}: generation started`);
      activeRuns.reload();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const reuse = (m: MediaItem) => {
    const md = m.metadata ?? {};
    const target = catalog.data?.models.find((x) => x.id === md.model);
    if (!target) return toast.info('That model is no longer in the catalog');
    setModelId(target.id);
    setSettings({ ...defaultsFor(target), ...(md.settings ?? {}) });
    setPrompt(String(md.prompt ?? m.title));
    setMedia({});
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // Runs to show in the "in progress" strip: working ones, plus failures from the last 10 minutes.
  const inProgress = useMemo(() => {
    const merged = new Map<string, Run>();
    for (const r of activeRuns.data ?? []) merged.set(r.id, r);
    for (const r of Object.values(jobs)) if (r.kind === 'generation') merged.set(r.id, { ...merged.get(r.id), ...r });
    const now = Date.now();
    return [...merged.values()]
      .filter((r) => !dismissed.has(r.id))
      .filter((r) => r.status === 'queued' || r.status === 'running' || (r.status === 'failed' && r.finishedAt && now - new Date(r.finishedAt).getTime() < 10 * 60_000))
      .sort((a, b) => b.queuedAt.localeCompare(a.queuedAt));
  }, [activeRuns.data, jobs, dismissed]);

  const latestLine = (runId: string) => logs.find((l) => l.runId === runId)?.message;

  const setSetting = (k: string, v: unknown) => setSettings((s) => ({ ...s, [k]: v }));
  const addUrl = (role: MediaRole, url: string) => {
    const u = url.trim();
    if (!u) return;
    setMedia((m) => ({ ...m, [role]: [...(m[role] ?? []), u] }));
  };
  const removeUrl = (role: MediaRole, i: number) => setMedia((m) => ({ ...m, [role]: (m[role] ?? []).filter((_, idx) => idx !== i) }));

  if (catalog.error) return <ErrorState message={catalog.error} onRetry={catalog.reload} />;

  return (
    <div>
      <PageHeader
        eyebrow="Create"
        title="Studio"
        actions={
          catalog.data && (
            <Badge tone={catalog.data.connected ? 'emerald' : 'amber'}>{catalog.data.connected ? 'Connected to Higgsfield' : 'Simulated — not connected'}</Badge>
          )
        }
      />

      {catalog.data && !catalog.data.connected && (
        <div role="note" className="mb-5 flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-100">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <p>
            Higgsfield isn’t connected, so generations return <strong>placeholder results</strong> (nothing is billed). To connect: save your key under <Link className="underline" to="/settings">Settings → API keys</Link>
            {!catalog.data.baseUrlSet && <> and your API address under <Link className="underline" to="/settings">Settings → Higgsfield</Link></>}.
            {!isAdmin && ' (Ask an admin if you can’t see those tabs.)'}
          </p>
        </div>
      )}

      <Card className="p-5">
        {!catalog.data || !model ? (
          <Skeleton className="h-64" />
        ) : (
          <div className="space-y-5">
            <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_16rem]">
              <Field label="Prompt" htmlFor="s-prompt">
                <Textarea id="s-prompt" rows={4} maxLength={5000} placeholder="Describe the image or video you want…" value={prompt} onChange={(e) => setPrompt(e.target.value)} disabled={!canWrite} className="font-sans" />
              </Field>
              <Field label="Model" htmlFor="s-model" hint={model.description}>
                <Select id="s-model" value={modelId} onChange={(e) => chooseModel(e.target.value)}>
                  {(['image', 'video'] as const).map((surface) => (
                    <optgroup key={surface} label={surface === 'image' ? 'Images' : 'Video'}>
                      {catalog.data!.models.filter((m) => m.surface === surface).map((m) => (
                        <option key={m.id} value={m.id}>{m.label}</option>
                      ))}
                    </optgroup>
                  ))}
                </Select>
              </Field>
            </div>

            {(Object.keys(model.settings).length > 0 || !model.nativeBatch) && (
              <section aria-label="Settings" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {Object.entries(model.settings).map(([key, spec]) => (
                  <SettingControl key={key} id={`set-${key}`} spec={spec} value={settings[key]} onChange={(v) => setSetting(key, v)} disabled={!canWrite} />
                ))}
                {!model.nativeBatch && (
                  <Field label="How many" htmlFor="s-count">
                    <Select id="s-count" value={count} onChange={(e) => setCount(Number(e.target.value))}>
                      {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}
                    </Select>
                  </Field>
                )}
              </section>
            )}

            {ROLE_ORDER.some((r) => (model.roles[r] ?? 0) > 0) && (
              <section aria-label="Media inputs" className="grid gap-4 md:grid-cols-2">
                {ROLE_ORDER.filter((r) => (model.roles[r] ?? 0) > 0).map((role) => (
                  <MediaSlot key={role} role={role} limit={model.roles[role]!} urls={media[role] ?? []} onAdd={(u) => addUrl(role, u)} onRemove={(i) => removeUrl(role, i)} onPick={() => setPickRole(role)} disabled={!canWrite} />
                ))}
              </section>
            )}

            {model.note && <p className="text-xs text-slate-500">Note: {model.note}</p>}

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-800 pt-4">
              <p className="text-sm text-slate-400" aria-live="polite">
                {outputs} {model.surface === 'image' ? 'image' : 'video'}{outputs > 1 ? 's' : ''} ·{' '}
                {estimate !== null ? <>about <strong className="text-slate-200">{usd(estimate)}</strong> (your set price)</> : <>no price set — spend won’t be tracked{isAdmin && <> · <Link className="underline" to="/settings">set a price</Link></>}</>}
              </p>
              <Button variant="primary" loading={busy} disabled={!canWrite || !prompt.trim()} onClick={generate}>
                <Wand2 className="h-4 w-4" aria-hidden /> Generate
              </Button>
            </div>
            {!canWrite && <p className="text-xs text-amber-300">Viewers can browse the gallery but not generate.</p>}
          </div>
        )}
      </Card>

      {inProgress.length > 0 && (
        <section aria-label="In progress" className="mt-6 space-y-2">
          <h2 className="text-sm font-semibold text-slate-300">In progress</h2>
          {inProgress.map((r) => (
            <div key={r.id} className={`flex items-center justify-between gap-3 rounded-xl border p-3 text-sm ${r.status === 'failed' ? 'border-rose-500/30 bg-rose-500/5' : 'border-slate-800 bg-slate-900/70'}`}>
              <div className="min-w-0">
                <div className="flex items-center gap-2 font-medium">
                  {r.status === 'failed' ? <AlertTriangle className="h-4 w-4 text-rose-300" aria-hidden /> : <Loader2 className="h-4 w-4 animate-spin text-cyan-300" aria-hidden />}
                  <span className="truncate">{r.refName}</span>
                </div>
                <p className={`mt-0.5 truncate text-xs ${r.status === 'failed' ? 'text-rose-200' : 'text-slate-500'}`}>
                  {r.status === 'failed' ? r.error : (latestLine(r.id) ?? (r.status === 'queued' ? 'Queued…' : 'Starting…'))}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Badge tone={r.status === 'failed' ? 'rose' : r.status === 'running' ? 'cyan' : 'amber'}>{r.status}</Badge>
                {r.status === 'failed' && (
                  <Button size="sm" variant="ghost" aria-label="Dismiss" onClick={() => setDismissed((d) => new Set(d).add(r.id))}><X className="h-3.5 w-3.5" aria-hidden /></Button>
                )}
              </div>
            </div>
          ))}
        </section>
      )}

      <section aria-label="Gallery" className="mt-8">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Your generations{gallery.data ? ` (${gallery.data.total})` : ''}</h2>
          <Link to="/media" className="text-sm text-cyan-300 underline">Full media timeline</Link>
        </div>
        {gallery.error ? (
          <ErrorState message={gallery.error} onRetry={gallery.reload} />
        ) : !gallery.data ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="aspect-video" />)}</div>
        ) : gallery.data.items.length === 0 ? (
          <EmptyState title="Nothing generated yet" hint="Write a prompt above and press Generate. Results appear here and in your media timeline." />
        ) : (
          <>
            <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {gallery.data.items.map((m, i) => (
                <li key={m.id} className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/80">
                  <button onClick={() => setViewer(i)} className="group block w-full text-left" aria-label={`Open ${m.type}: ${m.title}`}>
                    <div className="relative aspect-video bg-slate-950">
                      <img src={m.thumbUrl} alt="" loading="lazy" className="h-full w-full object-cover transition group-hover:scale-[1.02]" />
                      <span className="absolute left-2 top-2"><Badge tone={m.type === 'video' ? 'violet' : 'cyan'}>{m.type === 'video' ? <Film className="h-3 w-3" aria-hidden /> : <ImageIcon className="h-3 w-3" aria-hidden />}{m.type}</Badge></span>
                      {m.metadata?.simulated && <span className="absolute right-2 top-2"><Badge tone="amber">simulated</Badge></span>}
                    </div>
                    <div className="p-3">
                      <div className="line-clamp-2 text-sm">{m.title}</div>
                      <div className="mt-1 text-xs text-slate-500">{m.metadata?.modelLabel ?? 'Studio'} · {timeAgo(m.createdAt)}</div>
                    </div>
                  </button>
                  {canWrite && (
                    <div className="border-t border-slate-800 px-2 py-1.5">
                      <Button size="sm" variant="ghost" onClick={() => reuse(m)}><Sparkles className="h-3.5 w-3.5" aria-hidden /> Use this prompt</Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
            {gallery.data.nextCursor && limit < 60 && (
              <div className="mt-5 text-center"><Button onClick={() => setLimit((l) => Math.min(60, l + 24))}><Plus className="h-4 w-4" aria-hidden /> Show more</Button></div>
            )}
          </>
        )}
      </section>

      {viewer !== null && gallery.data?.items[viewer] && (
        <Lightbox items={gallery.data.items} index={viewer} onIndex={setViewer} onClose={() => setViewer(null)} canDelete={canWrite} onDelete={async (m) => {
          if (!window.confirm(`Delete "${m.title}"?`)) return;
          try {
            await api.del(`/media/${m.id}`);
            setViewer(null);
            gallery.reload();
          } catch (e) {
            toast.error(errorMessage(e));
          }
        }} />
      )}

      <LibraryPicker role={pickRole} onClose={() => setPickRole(null)} onPick={(role, url) => { addUrl(role, url); setPickRole(null); }} />
    </div>
  );
}

function SettingControl({ id, spec, value, onChange, disabled }: { id: string; spec: SettingSpec; value: any; onChange: (v: any) => void; disabled: boolean }) {
  if (spec.type === 'enum') {
    return (
      <Field label={spec.label} htmlFor={id}>
        <Select id={id} value={value ?? spec.default} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
          {spec.values.map((v) => <option key={v} value={v}>{v}</option>)}
        </Select>
      </Field>
    );
  }
  if (spec.type === 'range') {
    return (
      <Field label={`${spec.label}: ${value ?? spec.default}`} htmlFor={id}>
        <input id={id} type="range" min={spec.min} max={spec.max} step={spec.step ?? 1} value={value ?? spec.default} onChange={(e) => onChange(Number(e.target.value))} disabled={disabled} className="w-full accent-cyan-500" />
      </Field>
    );
  }
  return (
    <div className="flex items-end pb-2">
      <label className="flex items-center gap-2 text-sm text-slate-200">
        <input type="checkbox" className="h-4 w-4 accent-cyan-500" checked={!!(value ?? spec.default)} onChange={(e) => onChange(e.target.checked)} disabled={disabled} />
        {spec.label}
      </label>
    </div>
  );
}

function MediaSlot({ role, limit, urls, onAdd, onRemove, onPick, disabled }: { role: MediaRole; limit: number; urls: string[]; onAdd: (u: string) => void; onRemove: (i: number) => void; onPick: () => void; disabled: boolean }) {
  const [draft, setDraft] = useState('');
  const full = urls.length >= limit;
  const submit = () => {
    onAdd(draft);
    setDraft('');
  };
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-3">
      <div className="mb-2 flex items-center justify-between text-xs uppercase tracking-wider text-slate-400">
        <span>{ROLE_LABEL[role]} <span className="text-slate-600">(max {limit})</span></span>
        {role !== 'audio' && role !== 'video' && (
          <Button size="sm" variant="ghost" disabled={disabled || full} onClick={onPick}><Library className="h-3.5 w-3.5" aria-hidden /> From library</Button>
        )}
      </div>
      {urls.length > 0 && (
        <ul className="mb-2 space-y-1">
          {urls.map((u, i) => (
            <li key={`${u}-${i}`} className="flex items-center justify-between gap-2 rounded-lg bg-slate-900 px-2 py-1 text-xs">
              <span className="truncate text-slate-300">{u}</span>
              <button aria-label={`Remove ${ROLE_LABEL[role]} ${i + 1}`} onClick={() => onRemove(i)} className="text-slate-500 hover:text-rose-300"><X className="h-3.5 w-3.5" aria-hidden /></button>
            </li>
          ))}
        </ul>
      )}
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <Input aria-label={`${ROLE_LABEL[role]} URL`} type="url" placeholder="Paste a public https:// URL" value={draft} onChange={(e) => setDraft(e.target.value)} disabled={disabled || full} />
        <Button type="submit" disabled={disabled || full || !draft.trim()}>Add</Button>
      </form>
    </div>
  );
}

/** Choose an existing library image as a start/end/reference input (only public http(s) URLs qualify). */
function LibraryPicker({ role, onClose, onPick }: { role: MediaRole | null; onClose: () => void; onPick: (role: MediaRole, url: string) => void }) {
  const items = useApi<{ items: MediaItem[] }>(role ? '/media?type=photo&limit=60' : null);
  const usable = items.data?.items.filter((i) => /^https?:\/\//i.test(i.url)) ?? [];
  return (
    <Modal open={role !== null} onClose={onClose} title={role ? `Pick: ${ROLE_LABEL[role]}` : ''} wide>
      {items.error ? <ErrorState message={items.error} onRetry={items.reload} /> : !items.data ? <Skeleton className="h-40" /> : usable.length === 0 ? (
        <EmptyState title="No usable images yet" hint="Only images with a public web address can be used as inputs. Add one on the Media page (From URL or Upload), or paste a URL instead." />
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {usable.map((i) => (
            <li key={i.id}>
              <button onClick={() => role && onPick(role, i.url)} className="w-full overflow-hidden rounded-xl border border-slate-800 text-left hover:border-cyan-500">
                <img src={i.thumbUrl} alt="" className="aspect-video w-full object-cover" />
                <span className="block truncate p-2 text-xs">{i.title}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
