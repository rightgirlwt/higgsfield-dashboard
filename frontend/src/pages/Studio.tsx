import { AlertTriangle, Film, ImageIcon, Library, Loader2, Music, Plus, RefreshCw, Sparkles, Upload, Users, Wand2, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useCan } from '../auth/context';
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, Modal, PageHeader, Select, Skeleton, Textarea } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { timeAgo, usd } from '../lib/format';
import { useApi, useDocumentTitle } from '../lib/hooks';
import type { Character, MediaInput, MediaItem, MediaRole, ParamSpec, Run, StudioCatalog, StudioMode, StudioModel } from '../lib/types';
import { useRealtime } from '../state/Realtime';
import { useToast } from '../state/Toast';
import { Lightbox } from './Media';

type Settings = Record<string, any>;
type MediaState = Partial<Record<MediaRole, string[]>>;

const ACCEPT: Record<MediaRole, string> = {
  start: 'image/jpeg,image/png,image/webp,image/gif',
  end: 'image/jpeg,image/png,image/webp,image/gif',
  reference: 'image/jpeg,image/png,image/webp,image/gif',
  video: 'video/mp4',
  audio: 'audio/wav',
};
const kindOf = (role: MediaRole): 'image' | 'video' | 'audio' => (role === 'video' ? 'video' : role === 'audio' ? 'audio' : 'image');

function defaultsFor(mode: StudioMode): Settings {
  const out: Settings = {};
  for (const [k, s] of Object.entries(mode.params)) if ('default' in s) out[k] = s.default;
  return out;
}

export default function Studio() {
  useDocumentTitle('Studio');
  const toast = useToast();
  const canWrite = useCan('user');
  const isAdmin = useCan('admin');
  const { runTick, jobs, logs } = useRealtime();

  const catalog = useApi<StudioCatalog>('/studio/models');
  const [modelId, setModelId] = useState('');
  const [modeId, setModeId] = useState('');
  const [prompt, setPrompt] = useState('');
  const [settings, setSettings] = useState<Settings>({});
  const [media, setMedia] = useState<MediaState>({});
  const [count, setCount] = useState(1);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pick, setPick] = useState<MediaInput | null>(null);
  const [charOpen, setCharOpen] = useState(false);
  const [limit, setLimit] = useState(24);
  const [viewer, setViewer] = useState<number | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  const model = catalog.data?.models.find((m) => m.id === modelId);
  const mode = model?.modes.find((m) => m.id === modeId) ?? model?.modes[0];
  const hasCharacter = !!mode && 'custom_reference_id' in mode.params;

  const gallery = useApi<{ items: MediaItem[]; total: number; nextCursor: string | null }>(`/media?source=studio&limit=${limit}`);
  const activeRuns = useApi<Run[]>('/runs?kind=generation&limit=20');
  const chars = useApi<{ connected: boolean; characters: Character[] }>(hasCharacter ? '/studio/characters' : null);

  // Choose a starting model once the catalog loads.
  useEffect(() => {
    const first = catalog.data?.models[0];
    if (first && !modelId) selectModel(first, undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalog.data]);

  const reloadGallery = gallery.reload;
  const reloadRuns = activeRuns.reload;
  useEffect(() => {
    if (runTick > 0) {
      reloadGallery();
      reloadRuns();
    }
  }, [runTick, reloadGallery, reloadRuns]);

  function selectModel(m: StudioModel, preferMode: string | undefined, keepMedia?: MediaState) {
    const md = m.modes.find((x) => x.id === preferMode) ?? m.modes[0];
    setModelId(m.id);
    setModeId(md.id);
    setSettings(defaultsFor(md));
    setMedia(keepMedia ? pruneMedia(keepMedia, md) : {});
    setCount(1);
  }
  function selectMode(md: StudioMode) {
    setModeId(md.id);
    // Keep values for settings both modes share; everything else resets to that mode's defaults.
    setSettings((cur) => {
      const d = defaultsFor(md);
      for (const k of Object.keys(d)) if (k in cur && md.params[k] && mode?.params[k]?.type === md.params[k].type) d[k] = cur[k];
      return d;
    });
    setMedia((cur) => pruneMedia(cur, md));
  }
  const pruneMedia = (cur: MediaState, md: StudioMode): MediaState => Object.fromEntries(Object.entries(cur).filter(([r]) => md.media.some((i) => i.role === r))) as MediaState;

  const setSetting = (k: string, v: unknown) => setSettings((s) => ({ ...s, [k]: v }));
  const setRole = (role: MediaRole, urls: string[]) => setMedia((m) => ({ ...m, [role]: urls }));

  // ---- readiness + cost -----------------------------------------------------------------------
  const missing = useMemo(() => {
    if (!mode) return 'Loading…';
    if (mode.promptRequired !== false && !prompt.trim()) return 'Write a prompt';
    const m = mode.media.find((i) => i.required && !(media[i.role]?.length));
    return m ? `${m.label} is required` : null;
  }, [mode, prompt, media]);

  const nativeBatch = !!mode && 'batch_size' in mode.params;
  const outputs = nativeBatch ? Number(settings.batch_size ?? 1) : count;
  const lp = mode?.price ?? null;
  const seconds = model?.priceUnit !== 'second' ? 1 : typeof settings.duration === 'number' ? settings.duration : (lp?.assumedSeconds ?? 1);
  // Admin-set price wins; otherwise Higgsfield's list price (exact for the chosen resolution when published, else the low end of its range).
  const unit = model?.priceUsd != null ? model.priceUsd : lp ? (lp.byResolution?.[settings.resolution] ?? lp.min) : null;
  const exact = model?.priceUsd != null || !lp || lp.byResolution?.[settings.resolution] !== undefined || lp.min === lp.max;
  const estimate = unit !== null ? unit * seconds * outputs : null;
  const estimateMax = !exact && lp ? lp.max * seconds * outputs : null;
  const promo = model?.priceUsd == null && lp?.promoEnds ? lp.promoEnds : null;

  const generate = async () => {
    if (!model || !mode) return;
    setBusy(true);
    try {
      const clean = Object.fromEntries(Object.entries(settings).filter(([, v]) => v !== '' && v !== undefined && v !== null));
      await api.post('/studio/generate', { modelId: model.id, mode: mode.id, prompt, settings: clean, media, count: nativeBatch ? 1 : count });
      toast.success(`${model.label}: generation started`);
      activeRuns.reload();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  // ---- gallery actions ------------------------------------------------------------------------
  const reuse = (m: MediaItem) => {
    const md = m.metadata ?? {};
    const target = catalog.data?.models.find((x) => x.id === md.model);
    if (!target) return toast.info('That model is no longer in the catalog');
    selectModel(target, md.mode);
    setSettings((cur) => ({ ...cur, ...(md.settings ?? {}) }));
    setPrompt(String(md.prompt ?? m.title));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  /** Turn a generated/library image into the start frame of a video (the "animate it" workflow). */
  const animate = (url: string) => {
    const models = catalog.data?.models ?? [];
    const hasStart = (x: StudioModel) => x.surface === 'video' && x.modes.some((md) => md.media.some((i) => i.role === 'start'));
    const target = model && hasStart(model) ? model : (models.find((x) => x.id === 'kling-3-std') ?? models.find(hasStart));
    const md = target?.modes.find((x) => x.media.some((i) => i.role === 'start'));
    if (!target || !md) return toast.info('No video model with a start frame is available');
    selectModel(target, md.id, { start: [url] });
    window.scrollTo({ top: 0, behavior: 'smooth' });
    toast.success(`Start frame set on ${target.label}. Add a prompt and generate.`);
  };

  const addAsReference = (url: string) => {
    const slot = mode?.media.find((i) => i.role === 'reference') ?? mode?.media.find((i) => i.role === 'start');
    if (!slot) return toast.info(`${mode?.label ?? 'This mode'} has no image input. Pick a mode that accepts references.`);
    setMedia((m) => ({ ...m, [slot.role]: [...(m[slot.role] ?? []), url].slice(-slot.max) }));
    window.scrollTo({ top: 0, behavior: 'smooth' });
    toast.success(`Added to “${slot.label}”`);
  };

  // ---- in-progress strip ----------------------------------------------------------------------
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

  if (catalog.error) return <ErrorState message={catalog.error} onRetry={catalog.reload} />;

  const visibleParams = mode ? Object.entries(mode.params).filter(([, s]) => s.type !== 'character') : [];
  const basic = visibleParams.filter(([, s]) => !s.advanced);
  const advanced = visibleParams.filter(([, s]) => s.advanced);

  return (
    <div>
      <PageHeader eyebrow="Create" title="Studio" actions={catalog.data && <Badge tone={catalog.data.connected ? 'emerald' : 'amber'}>{catalog.data.connected ? 'Connected to Higgsfield' : 'Simulated — not connected'}</Badge>} />

      {catalog.data && !catalog.data.connected && (
        <div role="note" className="mb-5 flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-100">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <p>
            Higgsfield isn’t connected, so generations return <strong>placeholder results</strong> (nothing is billed), and file uploads and characters are unavailable. Save your key under <Link className="underline" to="/settings">Settings → API keys</Link>
            {!catalog.data.baseUrlSet && <> and the API address under <Link className="underline" to="/settings">Settings → Higgsfield</Link></>}.
            {!isAdmin && ' (Ask an admin if you can’t see those tabs.)'}
          </p>
        </div>
      )}

      <Card className="p-5">
        {!catalog.data || !model || !mode ? (
          <Skeleton className="h-72" />
        ) : (
          <div className="space-y-5">
            {/* model + mode */}
            <div className="grid gap-4 md:grid-cols-[minmax(0,22rem)_1fr]">
              <Field label="Model" htmlFor="s-model" hint={model.description}>
                <Select id="s-model" value={model.id} onChange={(e) => { const m = catalog.data!.models.find((x) => x.id === e.target.value); if (m) selectModel(m, undefined, media); }}>
                  {(['image', 'video'] as const).map((surface) => (
                    <optgroup key={surface} label={surface === 'image' ? 'Images' : 'Video'}>
                      {catalog.data!.models.filter((m) => m.surface === surface).map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                    </optgroup>
                  ))}
                </Select>
              </Field>
              {model.modes.length > 1 && (
                <div>
                  <div className="mb-1.5 text-xs font-medium uppercase tracking-wider text-slate-400">Mode</div>
                  <div role="tablist" aria-label="Mode" className="flex flex-wrap gap-1 rounded-xl border border-slate-800 bg-slate-950/60 p-1">
                    {model.modes.map((md) => (
                      <button key={md.id} role="tab" aria-selected={md.id === mode.id} onClick={() => selectMode(md)} className={`rounded-lg px-3 py-1.5 text-sm transition ${md.id === mode.id ? 'bg-slate-900 text-slate-100 shadow-sm' : 'text-slate-400 hover:text-slate-100'}`}>{md.label}</button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* media inputs */}
            {mode.media.length > 0 && (
              <section aria-label="Inputs" className="grid gap-4 md:grid-cols-2">
                {mode.media.map((input) => (
                  <MediaSlot key={input.role + input.param} input={input} urls={media[input.role] ?? []} onChange={(u) => setRole(input.role, u)} onPick={() => setPick(input)} disabled={!canWrite} connected={catalog.data!.connected} />
                ))}
              </section>
            )}

            {/* character */}
            {hasCharacter && (
              <section aria-label="Character" className="rounded-xl border border-slate-800 bg-slate-950/50 p-4">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <h3 className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-slate-400"><Users className="h-4 w-4" aria-hidden /> Character (Soul ID)</h3>
                  <div className="flex gap-2">
                    <Button size="sm" variant="ghost" onClick={() => chars.reload()} aria-label="Refresh characters"><RefreshCw className="h-3.5 w-3.5" aria-hidden /></Button>
                    <Button size="sm" disabled={!canWrite || !catalog.data.connected} onClick={() => setCharOpen(true)}><Plus className="h-3.5 w-3.5" aria-hidden /> New character</Button>
                  </div>
                </div>
                {!catalog.data.connected ? (
                  <p className="text-sm text-slate-500">Connect Higgsfield to use characters.</p>
                ) : chars.error ? (
                  <p className="text-sm text-rose-300">{chars.error}</p>
                ) : (
                  <div className="grid gap-4 sm:grid-cols-[minmax(0,20rem)_1fr]">
                    <Select aria-label="Character" value={settings.custom_reference_id ?? ''} onChange={(e) => setSetting('custom_reference_id', e.target.value || undefined)} disabled={!canWrite}>
                      <option value="">No character</option>
                      {chars.data?.characters.map((c) => <option key={c.id} value={c.id} disabled={c.status !== 'completed'}>{c.name}{c.status !== 'completed' ? ` (${c.status})` : ''}</option>)}
                    </Select>
                    {settings.custom_reference_id && mode.params.custom_reference_strength && (
                      <SettingControl id="set-char-strength" spec={mode.params.custom_reference_strength} value={settings.custom_reference_strength} onChange={(v) => setSetting('custom_reference_strength', v)} disabled={!canWrite} />
                    )}
                  </div>
                )}
                {chars.data && chars.data.characters.length === 0 && catalog.data.connected && (
                  <p className="mt-2 text-xs text-slate-500">No characters yet. Create one from photos of a person to keep their look consistent across images.</p>
                )}
              </section>
            )}

            {/* prompt */}
            <Field label={mode.promptRequired === false ? 'Prompt (optional)' : 'Prompt'} htmlFor="s-prompt">
              <Textarea id="s-prompt" rows={4} maxLength={5000} placeholder="Describe the image or video you want…" value={prompt} onChange={(e) => setPrompt(e.target.value)} disabled={!canWrite} className="font-sans" />
            </Field>

            {/* settings */}
            {(basic.length > 0 || !nativeBatch) && (
              <section aria-label="Settings" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {basic.map(([key, spec]) => <SettingControl key={key} id={`set-${key}`} spec={spec} value={settings[key]} onChange={(v) => setSetting(key, v)} disabled={!canWrite} />)}
                {!nativeBatch && (
                  <Field label="How many" htmlFor="s-count">
                    <Select id="s-count" value={count} onChange={(e) => setCount(Number(e.target.value))}>{[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}</Select>
                  </Field>
                )}
              </section>
            )}
            {advanced.length > 0 && (
              <div>
                <Button size="sm" variant="ghost" aria-expanded={showAdvanced} onClick={() => setShowAdvanced((a) => !a)}>{showAdvanced ? 'Hide' : 'Show'} advanced settings</Button>
                {showAdvanced && (
                  <section aria-label="Advanced settings" className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                    {advanced.map(([key, spec]) => <SettingControl key={key} id={`set-${key}`} spec={spec} value={settings[key]} onChange={(v) => setSetting(key, v)} disabled={!canWrite} />)}
                  </section>
                )}
              </div>
            )}
            {model.note && <p className="text-xs text-slate-500">Note: {model.note}</p>}

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-800 pt-4">
              <p className="text-sm text-slate-400" aria-live="polite">
                {outputs} {model.surface === 'image' ? 'image' : 'video'}{outputs > 1 ? 's' : ''}{model.priceUnit === 'second' && seconds > 1 ? ` × ${seconds}s` : ''} ·{' '}
                {estimate !== null ? (
                  <>
                    {exact ? 'about' : 'from'} <strong className="text-slate-200">{usd(estimate)}</strong>
                    {estimateMax !== null && <> (up to {usd(estimateMax)})</>}{' '}
                    <span className="text-slate-500">{model.priceUsd != null ? '(your set price)' : '(Higgsfield list price)'}</span>
                    {model.priceUnit === 'second' && !('duration' in (mode?.params ?? {})) && <span className="text-slate-500"> · billed by input video length, assumed {seconds}s</span>}
                    {promo && <span className="text-slate-500"> · promo rate until {promo}</span>}
                  </>
                ) : (
                  <>no price known — spend won’t be tracked{isAdmin && <> · <Link className="underline" to="/settings">set a price</Link></>}</>
                )}
              </p>
              <div className="flex items-center gap-3">
                {missing && <span className="text-xs text-amber-300">{missing}</span>}
                <Button variant="primary" loading={busy} disabled={!canWrite || !!missing} onClick={generate}><Wand2 className="h-4 w-4" aria-hidden /> Generate</Button>
              </div>
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
                <p className={`mt-0.5 truncate text-xs ${r.status === 'failed' ? 'text-rose-200' : 'text-slate-500'}`}>{r.status === 'failed' ? r.error : (latestLine(r.id) ?? (r.status === 'queued' ? 'Queued…' : 'Starting…'))}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Badge tone={r.status === 'failed' ? 'rose' : r.status === 'running' ? 'cyan' : 'amber'}>{r.status}</Badge>
                {r.status === 'failed' && <Button size="sm" variant="ghost" aria-label="Dismiss" onClick={() => setDismissed((d) => new Set(d).add(r.id))}><X className="h-3.5 w-3.5" aria-hidden /></Button>}
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
                      <div className="mt-1 text-xs text-slate-500">{m.metadata?.modelLabel ?? 'Studio'}{m.metadata?.modeLabel ? ` · ${m.metadata.modeLabel}` : ''} · {timeAgo(m.createdAt)}</div>
                    </div>
                  </button>
                  {canWrite && (
                    <div className="flex flex-wrap gap-1 border-t border-slate-800 px-2 py-1.5">
                      <Button size="sm" variant="ghost" onClick={() => reuse(m)}><Sparkles className="h-3.5 w-3.5" aria-hidden /> Prompt</Button>
                      {m.type === 'photo' && /^https?:\/\//i.test(m.url) && (
                        <>
                          <Button size="sm" variant="ghost" onClick={() => animate(m.url)}><Film className="h-3.5 w-3.5" aria-hidden /> Animate</Button>
                          <Button size="sm" variant="ghost" onClick={() => addAsReference(m.url)}><Plus className="h-3.5 w-3.5" aria-hidden /> Input</Button>
                        </>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
            {gallery.data.nextCursor && limit < 60 && <div className="mt-5 text-center"><Button onClick={() => setLimit((l) => Math.min(60, l + 24))}><Plus className="h-4 w-4" aria-hidden /> Show more</Button></div>}
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

      <LibraryPicker input={pick} onClose={() => setPick(null)} onPick={(inp, urls) => { setMedia((m) => ({ ...m, [inp.role]: [...(m[inp.role] ?? []), ...urls].slice(0, inp.max) })); setPick(null); }} />
      <CharacterModal open={charOpen} onClose={() => setCharOpen(false)} price={catalog.data?.soulIdPriceUsd ?? 2.5} onCreated={() => { chars.reload(); setCharOpen(false); }} />
    </div>
  );
}

// ---- settings controls ---------------------------------------------------------------------------------
function SettingControl({ id, spec, value, onChange, disabled }: { id: string; spec: ParamSpec; value: any; onChange: (v: any) => void; disabled: boolean }) {
  switch (spec.type) {
    case 'enum':
      return (
        <Field label={spec.label} htmlFor={id}>
          <Select id={id} value={value ?? spec.default} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
            {spec.values.map((v) => <option key={v} value={v}>{v === '' ? 'None' : v}</option>)}
          </Select>
        </Field>
      );
    case 'int':
    case 'number':
      return (
        <Field label={`${spec.label}: ${value ?? spec.default}`} htmlFor={id}>
          <input id={id} type="range" min={spec.min} max={spec.max} step={spec.type === 'number' ? spec.step : 1} value={value ?? spec.default} onChange={(e) => onChange(Number(e.target.value))} disabled={disabled} className="w-full accent-cyan-500" />
        </Field>
      );
    case 'boolean':
      return (
        <div className="flex items-end pb-2">
          <label className="flex items-center gap-2 text-sm text-slate-200">
            <input type="checkbox" className="h-4 w-4 accent-cyan-500" checked={!!(value ?? spec.default)} onChange={(e) => onChange(e.target.checked)} disabled={disabled} />
            {spec.label}
          </label>
        </div>
      );
    case 'text':
      return (
        <Field label={spec.label} htmlFor={id}>
          <Input id={id} value={value ?? ''} maxLength={spec.maxLength} onChange={(e) => onChange(e.target.value)} disabled={disabled} />
        </Field>
      );
    case 'seed':
      return (
        <Field label={spec.label} htmlFor={id}>
          <Input id={id} type="number" min={spec.min} max={spec.max} placeholder="Random" value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? undefined : Math.floor(Number(e.target.value)))} disabled={disabled} />
        </Field>
      );
    default:
      return null;
  }
}

// ---- media input slot ----------------------------------------------------------------------------------
function Thumb({ url, role }: { url: string; role: MediaRole }) {
  const kind = kindOf(role);
  if (kind === 'image') return <img src={url} alt="" className="h-14 w-14 rounded-lg object-cover" />;
  if (kind === 'video') return <video src={url} muted preload="metadata" className="h-14 w-20 rounded-lg bg-black object-cover" />;
  return <span className="grid h-14 w-14 place-items-center rounded-lg bg-slate-800 text-slate-300"><Music className="h-5 w-5" aria-hidden /></span>;
}

function MediaSlot({ input, urls, onChange, onPick, disabled, connected }: { input: MediaInput; urls: string[]; onChange: (u: string[]) => void; onPick: () => void; disabled: boolean; connected: boolean }) {
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState('');
  const [uploading, setUploading] = useState(false);
  const room = input.max - urls.length;
  const kind = kindOf(input.role);

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading(true);
    const added: string[] = [];
    try {
      for (const f of [...files].slice(0, room)) {
        const r = await api.upload<{ url: string }>(`/studio/uploads?filename=${encodeURIComponent(f.name)}`, f);
        added.push(r.url);
      }
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      if (added.length) onChange([...urls, ...added]);
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs font-medium uppercase tracking-wider text-slate-400">
          {input.label} {input.required ? <span className="text-amber-300">· required</span> : null}
          {input.max > 1 && <span className="text-slate-600"> · up to {input.max}</span>}
        </div>
        <div className="flex gap-1">
          <input ref={fileRef} type="file" hidden accept={ACCEPT[input.role]} multiple={input.max > 1} onChange={(e) => void upload(e.target.files)} />
          <Button size="sm" variant="ghost" loading={uploading} disabled={disabled || room <= 0 || !connected} title={connected ? undefined : 'Connect Higgsfield to upload files'} onClick={() => fileRef.current?.click()}><Upload className="h-3.5 w-3.5" aria-hidden /> Upload</Button>
          {kind !== 'audio' && <Button size="sm" variant="ghost" disabled={disabled || room <= 0} onClick={onPick}><Library className="h-3.5 w-3.5" aria-hidden /> Library</Button>}
        </div>
      </div>
      {urls.length > 0 && (
        <ul className="mb-2 flex flex-wrap gap-2">
          {urls.map((u, i) => (
            <li key={`${u}-${i}`} className="relative">
              <Thumb url={u} role={input.role} />
              <button aria-label={`Remove ${input.label} ${i + 1}`} onClick={() => onChange(urls.filter((_, k) => k !== i))} className="absolute -right-1.5 -top-1.5 rounded-full bg-slate-900 p-0.5 text-slate-400 shadow hover:text-rose-300"><X className="h-3.5 w-3.5" aria-hidden /></button>
            </li>
          ))}
        </ul>
      )}
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (draft.trim()) { onChange([...urls, draft.trim()]); setDraft(''); } }}>
        <Input aria-label={`${input.label}: paste a public URL`} type="url" placeholder="…or paste a public https:// link" value={draft} onChange={(e) => setDraft(e.target.value)} disabled={disabled || room <= 0} />
        <Button type="submit" disabled={disabled || room <= 0 || !draft.trim()}>Add</Button>
      </form>
      {input.hint && <p className="mt-1.5 text-xs text-slate-500">{input.hint}</p>}
    </div>
  );
}

/** Pick from your library: generated results and uploaded references (only public web addresses can be sent to the platform). */
function LibraryPicker({ input, onClose, onPick }: { input: MediaInput | null; onClose: () => void; onPick: (input: MediaInput, urls: string[]) => void }) {
  const type = input ? (kindOf(input.role) === 'video' ? 'video' : 'photo') : null;
  const items = useApi<{ items: MediaItem[] }>(type ? `/media?type=${type}&limit=60` : null);
  const [chosen, setChosen] = useState<string[]>([]);
  useEffect(() => setChosen([]), [input]);
  const usable = items.data?.items.filter((i) => /^https?:\/\//i.test(i.url)) ?? [];
  const room = input ? input.max : 1;
  const toggle = (u: string) => setChosen((c) => (c.includes(u) ? c.filter((x) => x !== u) : room === 1 ? [u] : [...c, u].slice(0, room)));
  return (
    <Modal open={input !== null} onClose={onClose} title={input ? `Pick: ${input.label}` : ''} wide>
      {items.error ? <ErrorState message={items.error} onRetry={items.reload} /> : !items.data ? <Skeleton className="h-40" /> : usable.length === 0 ? (
        <EmptyState title="Nothing usable yet" hint="Only items with a public web address can be used as inputs. Upload a file here, or generate something first." />
      ) : (
        <>
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
            {usable.map((i) => (
              <li key={i.id}>
                <button onClick={() => toggle(i.url)} aria-pressed={chosen.includes(i.url)} className={`w-full overflow-hidden rounded-xl border text-left ${chosen.includes(i.url) ? 'border-cyan-400 ring-2 ring-cyan-400/40' : 'border-slate-800 hover:border-slate-600'}`}>
                  <img src={i.thumbUrl} alt="" className="aspect-video w-full object-cover" />
                  <span className="block truncate p-2 text-xs">{i.title}</span>
                </button>
              </li>
            ))}
          </ul>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button variant="primary" disabled={chosen.length === 0} onClick={() => input && onPick(input, chosen)}>Use {chosen.length || ''} selected</Button>
          </div>
        </>
      )}
    </Modal>
  );
}

/** Train a Soul ID character from photos. Billed by Higgsfield, so the cost must be confirmed explicitly. */
function CharacterModal({ open, onClose, onCreated, price }: { open: boolean; onClose: () => void; onCreated: () => void; price: number }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [urls, setUrls] = useState<string[]>([]);
  const [confirm, setConfirm] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading(true);
    const added: string[] = [];
    try {
      for (const f of [...files].slice(0, 30 - urls.length)) added.push((await api.upload<{ url: string }>(`/studio/uploads?filename=${encodeURIComponent(f.name)}`, f)).url);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setUrls((u) => [...u, ...added]);
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const create = async () => {
    setBusy(true);
    try {
      await api.post('/studio/characters', { name, imageUrls: urls, confirmedCost: true });
      toast.success('Character training started. It can take several minutes; it becomes selectable once it shows as completed.');
      setName(''); setUrls([]); setConfirm(false);
      onCreated();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="New character (Soul ID)" wide>
      <div className="space-y-4">
        <p className="text-sm text-slate-400">Upload clear photos of one person (different angles and lighting; more is better, roughly 8–20). Higgsfield trains a character you can reuse in Soul 2 so they look the same across images.</p>
        <Field label="Name" htmlFor="c-name"><Input id="c-name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="e.g. Mia" /></Field>
        <div>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-medium uppercase tracking-wider text-slate-400">Photos ({urls.length})</span>
            <input ref={fileRef} type="file" hidden multiple accept={ACCEPT.start} onChange={(e) => void upload(e.target.files)} />
            <Button size="sm" loading={uploading} onClick={() => fileRef.current?.click()}><Upload className="h-3.5 w-3.5" aria-hidden /> Add photos</Button>
          </div>
          {urls.length > 0 && (
            <ul className="flex flex-wrap gap-2">
              {urls.map((u, i) => (
                <li key={u} className="relative"><img src={u} alt="" className="h-16 w-16 rounded-lg object-cover" /><button aria-label={`Remove photo ${i + 1}`} onClick={() => setUrls((x) => x.filter((_, k) => k !== i))} className="absolute -right-1.5 -top-1.5 rounded-full bg-slate-900 p-0.5 text-slate-400 hover:text-rose-300"><X className="h-3.5 w-3.5" aria-hidden /></button></li>
              ))}
            </ul>
          )}
        </div>
        <label className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-100">
          <input type="checkbox" className="mt-1 h-4 w-4 accent-amber-400" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />
          <span>I understand Higgsfield charges about <strong>{usd(price)}</strong> to train a character, taken from my Higgsfield balance. Only upload photos of people who have agreed to it.</span>
        </label>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!name.trim() || urls.length === 0 || !confirm} onClick={create}>Train character</Button>
        </div>
      </div>
    </Modal>
  );
}
