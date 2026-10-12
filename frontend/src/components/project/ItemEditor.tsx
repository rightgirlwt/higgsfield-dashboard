import { Check, Film, ImageIcon, Trash2, Wand2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useCan } from '../../auth/context';
import { api, errorMessage } from '../../lib/api';
import { usd } from '../../lib/format';
import type { BoardItem, MediaInput, MediaRole, ProjectAsset, ProjectTypeDef, StudioCatalog, StudioMode, StudioModel } from '../../lib/types';
import { useToast } from '../../state/Toast';
import { defaultsFor, LibraryPicker, MediaSlot, SettingControl, type Settings } from '../StudioControls';
import { Badge, Button, cx, Field, Input, Modal, Select, Tabs, Textarea } from '../ui';

type MediaState = Partial<Record<MediaRole, string[]>>;

/** The mode that fits the media (and a planned start frame) best, like the server's own pick. */
function bestMode(model: StudioModel, media: MediaState, hasStartFrame: boolean): StudioMode {
  const have = (r: MediaRole) => (media[r]?.length ?? 0) > 0 || (r === 'start' && hasStartFrame);
  let best = model.modes[0];
  let score = -1;
  for (const m of model.modes) {
    if (m.media.some((i) => i.required && !have(i.role))) continue;
    const s = m.media.filter((i) => have(i.role)).length;
    if (s > score) (best = m), (score = s);
  }
  return best;
}

export function ItemEditor({
  projectId, item, items, assets, catalog, type, groups, onClose, onSaved, onGenerate,
}: {
  projectId: string;
  item: BoardItem | null;
  items: BoardItem[];
  assets: ProjectAsset[];
  catalog: StudioCatalog | null;
  type: ProjectTypeDef;
  groups: string[];
  onClose: () => void;
  onSaved: () => void;
  onGenerate: (item: BoardItem) => void;
}) {
  const toast = useToast();
  const canWrite = useCan('user');
  const [tab, setTab] = useState<'details' | 'takes'>('details');
  const [group, setGroup] = useState('');
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [notes, setNotes] = useState('');
  const [modelId, setModelId] = useState('');
  const [modeId, setModeId] = useState('');
  const [settings, setSettings] = useState<Settings>({});
  const [media, setMedia] = useState<MediaState>({});
  const [startFrom, setStartFrom] = useState('');
  const [count, setCount] = useState(1);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [pick, setPick] = useState<MediaInput | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load the card into the form whenever a different one is opened.
  useEffect(() => {
    if (!item) return;
    setTab(item.status === 'review' && item.takeCount > 0 ? 'takes' : 'details');
    setGroup(item.group);
    setTitle(item.title);
    setPrompt(item.prompt);
    setNotes(item.notes);
    setModelId(item.modelId);
    setModeId(item.mode);
    setSettings(item.settings);
    setMedia(item.media);
    setStartFrom(String(item.meta?.startFromItemId ?? ''));
    setCount(Number(item.meta?.count ?? 1) || 1);
    setError(null);
    setShowAdvanced(false);
  }, [item?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const model = catalog?.models.find((m) => m.id === modelId);
  const mode = model ? (model.modes.find((m) => m.id === modeId) ?? bestMode(model, media, !!startFrom)) : undefined;
  const nativeBatch = !!mode && 'batch_size' in mode.params;
  const hasCharacter = !!mode && 'custom_reference_id' in mode.params;
  const characters = assets.filter((a) => a.kind === 'character' && a.characterId);
  const frameSources = items.filter((i) => i.id !== item?.id && catalog?.models.find((m) => m.id === i.modelId)?.surface === 'image');

  const params = mode ? Object.entries(mode.params).filter(([, s]) => s.type !== 'character') : [];
  const basic = params.filter(([, s]) => !s.advanced);
  const advanced = params.filter(([, s]) => s.advanced);

  const chooseModel = (id: string) => {
    const m = catalog?.models.find((x) => x.id === id);
    setModelId(id);
    if (!m) return setModeId('');
    const md = bestMode(m, media, !!startFrom);
    setModeId(md.id);
    setSettings(defaultsFor(md));
    setMedia((cur) => Object.fromEntries(Object.entries(cur).filter(([r]) => md.media.some((i) => i.role === r))) as MediaState);
  };
  const chooseMode = (md: StudioMode) => {
    setModeId(md.id);
    setSettings((cur) => {
      const d = defaultsFor(md);
      for (const k of Object.keys(d)) if (k in cur && md.params[k] && mode?.params[k]?.type === md.params[k].type) d[k] = cur[k];
      if ('custom_reference_id' in md.params && cur.custom_reference_id) d.custom_reference_id = cur.custom_reference_id;
      return d;
    });
    setMedia((cur) => Object.fromEntries(Object.entries(cur).filter(([r]) => md.media.some((i) => i.role === r))) as MediaState);
  };

  const body = () => {
    const cleanMedia = Object.fromEntries(Object.entries(media).filter(([r, u]) => u && u.length && mode?.media.some((i) => i.role === r)));
    const meta: Record<string, unknown> = { ...(item?.meta ?? {}) };
    if (startFrom) meta.startFromItemId = startFrom;
    else delete meta.startFromItemId;
    if (count > 1 && !nativeBatch) meta.count = count;
    else delete meta.count;
    const cleanSettings = Object.fromEntries(Object.entries(settings).filter(([k, v]) => v !== undefined && v !== '' && mode && k in mode.params));
    return { group: group.trim(), title: title.trim(), prompt, notes, modelId, mode: modelId ? (mode?.id ?? '') : '', settings: modelId ? cleanSettings : {}, media: modelId ? cleanMedia : {}, meta };
  };

  const save = async (then?: 'generate') => {
    if (!item) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await api.put<BoardItem>(`/projects/${projectId}/items/${item.id}`, body());
      onSaved();
      if (then === 'generate') onGenerate({ ...item, ...saved, estimate: item.estimate, takes: item.takes });
      else onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!item || !window.confirm(`Delete "${item.title}"?`)) return;
    try {
      await api.del(`/projects/${projectId}/items/${item.id}`);
      onSaved();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const approve = async (takeId: string) => {
    if (!item) return;
    try {
      await api.put(`/projects/${projectId}/items/${item.id}`, { approvedAssetId: takeId });
      toast.success('Take approved');
      onSaved();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const reject = async () => {
    if (!item) return;
    try {
      await api.put(`/projects/${projectId}/items/${item.id}`, { status: 'rejected' });
      onSaved();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const est = item?.estimate;
  const generating = item?.status === 'generating';
  const readOnly = !canWrite || generating;
  const takes = item?.takes ?? [];
  const label = useMemo(() => type.itemLabel, [type]);

  const closePick = useCallback(() => setPick(null), []);
  // Escape in the library picker must not also close the editor underneath. (Modal re-focuses when onClose changes, so keep this stable.)
  const close = useCallback(() => {
    if (!pick) onClose();
  }, [pick, onClose]);

  return (
    <>
    <Modal open={item !== null} onClose={close} title={item ? `${label}: ${item.title}` : ''} wide>
      {item && (
        <div className="space-y-4">
          <Tabs label="Card sections" value={tab} onChange={setTab} tabs={[{ id: 'details', label: 'Details' }, { id: 'takes', label: `Takes${item.takeCount ? ` (${item.takeCount})` : ''}` }]} />

          {tab === 'details' && (
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={type.groupLabel} htmlFor="ie-group">
                  <Input id="ie-group" list="ie-groups" value={group} onChange={(e) => setGroup(e.target.value)} disabled={readOnly} placeholder={type.id === 'micro_drama' ? 'Ep 1 · Scene 1' : 'Concept A'} />
                  <datalist id="ie-groups">{groups.map((g) => <option key={g} value={g} />)}</datalist>
                </Field>
                <Field label="Title" htmlFor="ie-title"><Input id="ie-title" value={title} maxLength={160} onChange={(e) => setTitle(e.target.value)} disabled={readOnly} /></Field>
              </div>

              <div className="grid gap-4 md:grid-cols-[minmax(0,20rem)_1fr]">
                <Field label="Model" htmlFor="ie-model" hint={model?.description}>
                  <Select id="ie-model" value={modelId} onChange={(e) => chooseModel(e.target.value)} disabled={readOnly || !catalog}>
                    <option value="">Not chosen yet</option>
                    {(['image', 'video'] as const).map((surface) => (
                      <optgroup key={surface} label={surface === 'image' ? 'Images' : 'Video'}>
                        {catalog?.models.filter((m) => m.surface === surface).map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                      </optgroup>
                    ))}
                  </Select>
                </Field>
                {model && model.modes.length > 1 && (
                  <div>
                    <div className="mb-1.5 text-xs font-medium uppercase tracking-wider text-slate-400">Mode</div>
                    <div role="tablist" aria-label="Mode" className="flex flex-wrap gap-1 rounded-xl border border-slate-800 bg-slate-950/60 p-1">
                      {model.modes.map((md) => (
                        <button key={md.id} role="tab" aria-selected={md.id === mode?.id} disabled={readOnly} onClick={() => chooseMode(md)} className={cx('rounded-lg px-3 py-1.5 text-sm transition', md.id === mode?.id ? 'bg-slate-900 text-slate-100 shadow-sm' : 'text-slate-400 hover:text-slate-100')}>{md.label}</button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <Field label={mode?.promptRequired === false ? 'Prompt (optional)' : 'Prompt'} htmlFor="ie-prompt" hint="Describe the whole picture: subject, action, setting, camera, light, mood. Each generation starts from scratch.">
                <Textarea id="ie-prompt" rows={5} maxLength={5000} value={prompt} onChange={(e) => setPrompt(e.target.value)} disabled={readOnly} className="font-sans" />
              </Field>
              <Field label={type.id === 'micro_drama' ? 'Dialogue and notes' : 'Hook, script and notes'} htmlFor="ie-notes" hint="For you and the team. Not sent to the model.">
                <Textarea id="ie-notes" rows={2} maxLength={4000} value={notes} onChange={(e) => setNotes(e.target.value)} disabled={readOnly} className="font-sans" />
              </Field>

              {model && mode && (
                <>
                  {model.surface === 'video' && mode.media.some((i) => i.role === 'start') && frameSources.length > 0 && (
                    <Field label="Start frame from another card" htmlFor="ie-from" hint="Animates that card’s approved image (or its newest one). Generate and approve it first.">
                      <Select id="ie-from" value={startFrom} onChange={(e) => setStartFrom(e.target.value)} disabled={readOnly}>
                        <option value="">None (use an image below, or text only)</option>
                        {frameSources.map((i) => <option key={i.id} value={i.id}>{i.group ? `${i.group} · ` : ''}{i.title}</option>)}
                      </Select>
                    </Field>
                  )}
                  {mode.media.length > 0 && (
                    <section aria-label="Inputs" className="grid gap-4 md:grid-cols-2">
                      {mode.media.map((input) => (
                        <MediaSlot key={input.role + input.param} input={input} urls={media[input.role] ?? []} onChange={(u) => setMedia((m) => ({ ...m, [input.role]: u }))} onPick={() => setPick(input)} disabled={readOnly} connected={!!catalog?.connected} />
                      ))}
                    </section>
                  )}
                  {hasCharacter && (
                    <Field label="Character (Soul ID)" htmlFor="ie-char" hint={characters.length === 0 ? 'Add a character with a Soul ID in the Assets tab to use it here.' : undefined}>
                      <Select id="ie-char" value={settings.custom_reference_id ?? ''} onChange={(e) => setSettings((s) => ({ ...s, custom_reference_id: e.target.value || undefined }))} disabled={readOnly}>
                        <option value="">No character</option>
                        {characters.map((c) => <option key={c.id} value={c.characterId}>{c.name}</option>)}
                        {settings.custom_reference_id && !characters.some((c) => c.characterId === settings.custom_reference_id) && <option value={settings.custom_reference_id}>Custom character</option>}
                      </Select>
                    </Field>
                  )}
                  {(basic.length > 0 || !nativeBatch) && (
                    <section aria-label="Settings" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                      {basic.map(([key, spec]) => <SettingControl key={key} id={`ie-${key}`} spec={spec} value={settings[key]} onChange={(v) => setSettings((s) => ({ ...s, [key]: v }))} disabled={readOnly} />)}
                      {!nativeBatch && (
                        <Field label="Takes per generation" htmlFor="ie-count" hint="More takes = more cost; pick your favourite.">
                          <Select id="ie-count" value={count} onChange={(e) => setCount(Number(e.target.value))} disabled={readOnly}>{[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}</Select>
                        </Field>
                      )}
                    </section>
                  )}
                  {advanced.length > 0 && (
                    <div>
                      <Button size="sm" variant="ghost" aria-expanded={showAdvanced} onClick={() => setShowAdvanced((a) => !a)}>{showAdvanced ? 'Hide' : 'Show'} advanced settings</Button>
                      {showAdvanced && (
                        <section aria-label="Advanced settings" className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                          {advanced.map(([key, spec]) => <SettingControl key={key} id={`ie-${key}`} spec={spec} value={settings[key]} onChange={(v) => setSettings((s) => ({ ...s, [key]: v }))} disabled={readOnly} />)}
                        </section>
                      )}
                    </div>
                  )}
                </>
              )}

              <p className="text-sm text-slate-400" aria-live="polite">
                {est?.ok ? (
                  est.costUsd === null ? 'No price known for this model yet.' : <>Saved version costs about <strong className="text-slate-200">{usd(est.costUsd)}</strong> ({est.outputs} output{est.outputs > 1 ? 's' : ''}{est.seconds > 1 ? ` × ${est.seconds}s` : ''}{est.precision === 'from' ? ', low end of range' : ''}). Save to refresh this after changes.</>
                ) : est ? <span className="text-amber-300">Can’t price yet: {est.reason}</span> : null}
              </p>
              {item.lastError && <p role="alert" className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-300">Last attempt: {item.lastError}</p>}
              {generating && <p className="text-sm text-cyan-700">This card is generating right now, so it can’t be edited until it finishes.</p>}
              {error && <p role="alert" className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-300">{error}</p>}

              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-800 pt-4">
                <Button variant="ghost" className="text-rose-600" disabled={readOnly} onClick={() => void remove()}><Trash2 className="h-4 w-4" aria-hidden /> Delete</Button>
                <div className="flex gap-2">
                  <Button variant="ghost" onClick={onClose}>Close</Button>
                  <Button disabled={readOnly || !title.trim()} loading={busy} onClick={() => void save()}>Save</Button>
                  <Button variant="primary" disabled={readOnly || !title.trim() || !modelId} loading={busy} onClick={() => void save('generate')}><Wand2 className="h-4 w-4" aria-hidden /> Save and review cost</Button>
                </div>
              </div>
            </div>
          )}

          {tab === 'takes' && (
            <div className="space-y-4">
              {takes.length === 0 ? (
                <p className="rounded-xl border border-dashed border-slate-800 p-8 text-center text-sm text-slate-400">Nothing generated for this card yet. Use “Save and review cost” on the Details tab.</p>
              ) : (
                <>
                  <p className="text-sm text-slate-400">Pick the take you want to keep. The approved take is what gets exported and what other cards can start from.</p>
                  <ul className="grid gap-4 sm:grid-cols-2">
                    {takes.map((t) => {
                      const chosen = item.approvedAssetId === t.id;
                      const playable = /^https?:\/\//i.test(t.url);
                      return (
                        <li key={t.id} className={cx('overflow-hidden rounded-2xl border bg-slate-950/50', chosen ? 'border-emerald-500 ring-2 ring-emerald-500/30' : 'border-slate-800')}>
                          <div className="bg-black">
                            {t.type === 'video' && playable ? <video src={t.url} poster={t.thumbUrl} controls preload="metadata" className="max-h-80 w-full object-contain" /> : <img src={t.thumbUrl} alt={t.title} className="max-h-80 w-full object-contain" />}
                          </div>
                          <div className="flex items-center justify-between gap-2 p-2.5">
                            <Badge tone={t.type === 'video' ? 'violet' : 'cyan'}>{t.type === 'video' ? <Film className="h-3 w-3" aria-hidden /> : <ImageIcon className="h-3 w-3" aria-hidden />}{t.type}</Badge>
                            {chosen ? <Badge tone="emerald"><Check className="h-3 w-3" aria-hidden /> Approved</Badge> : <Button size="sm" variant="primary" disabled={!canWrite} onClick={() => void approve(t.id)}>Approve this take</Button>}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                  {canWrite && item.status !== 'rejected' && <div className="flex justify-end"><Button variant="ghost" className="text-rose-600" onClick={() => void reject()}>None of these: reject and try again</Button></div>}
                </>
              )}
            </div>
          )}
        </div>
      )}
    </Modal>
    <LibraryPicker input={pick} onClose={closePick} onPick={(inp, urls) => { setMedia((m) => ({ ...m, [inp.role]: [...(m[inp.role] ?? []), ...urls].slice(0, inp.max) })); setPick(null); }} />
    </>
  );
}
