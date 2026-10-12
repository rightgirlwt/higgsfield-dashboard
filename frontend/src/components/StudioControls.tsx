import { Library, Music, Upload, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button, EmptyState, ErrorState, Field, Input, Modal, Select, Skeleton } from './ui';
import { api, errorMessage } from '../lib/api';
import { useApi } from '../lib/hooks';
import type { MediaInput, MediaItem, MediaRole, ParamSpec, StudioMode } from '../lib/types';
import { useToast } from '../state/Toast';

export type Settings = Record<string, any>;

/** Shared by the Studio page and the project board: setting controls, media input slots and the library picker. */
export const ACCEPT: Record<MediaRole, string> = {
  start: 'image/jpeg,image/png,image/webp,image/gif',
  end: 'image/jpeg,image/png,image/webp,image/gif',
  reference: 'image/jpeg,image/png,image/webp,image/gif',
  video: 'video/mp4',
  audio: 'audio/wav',
};
export const kindOf = (role: MediaRole): 'image' | 'video' | 'audio' => (role === 'video' ? 'video' : role === 'audio' ? 'audio' : 'image');

export function defaultsFor(mode: StudioMode): Settings {
  const out: Settings = {};
  for (const [k, s] of Object.entries(mode.params)) if ('default' in s) out[k] = s.default;
  return out;
}

// ---- settings controls ---------------------------------------------------------------------------------
export function SettingControl({ id, spec, value, onChange, disabled }: { id: string; spec: ParamSpec; value: any; onChange: (v: any) => void; disabled: boolean }) {
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

export function MediaSlot({ input, urls, onChange, onPick, disabled, connected }: { input: MediaInput; urls: string[]; onChange: (u: string[]) => void; onPick: () => void; disabled: boolean; connected: boolean }) {
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
export function LibraryPicker({ input, onClose, onPick }: { input: MediaInput | null; onClose: () => void; onPick: (input: MediaInput, urls: string[]) => void }) {
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

