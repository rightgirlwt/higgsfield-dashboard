import { Image as ImageIcon, Library, Plus, Trash2, Upload, Users } from 'lucide-react';
import { useRef, useState } from 'react';
import { useCan } from '../../auth/context';
import { api, errorMessage } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import type { Character, MediaInput, ProjectAsset } from '../../lib/types';
import { useToast } from '../../state/Toast';
import { LibraryPicker } from '../StudioControls';
import { Badge, Button, Card, EmptyState, Field, Input, Modal, Select, Textarea } from '../ui';

const KINDS: { id: ProjectAsset['kind']; label: string }[] = [
  { id: 'character', label: 'Character' },
  { id: 'product', label: 'Product' },
  { id: 'logo', label: 'Logo' },
  { id: 'location', label: 'Location' },
  { id: 'style', label: 'Style reference' },
  { id: 'reference', label: 'Other reference' },
];
const IMAGE_INPUT: MediaInput = { param: 'image', role: 'reference', label: 'Image', max: 1, array: false };

/** Characters, products, logos and locations shared by every card in the project. Characters can carry a trained Soul ID. */
export function AssetsPanel({ projectId, assets, connected, onChanged }: { projectId: string; assets: ProjectAsset[]; connected: boolean; onChanged: () => void }) {
  const canWrite = useCan('user');
  const toast = useToast();
  const [editing, setEditing] = useState<ProjectAsset | 'new' | null>(null);

  const remove = async (a: ProjectAsset) => {
    if (!window.confirm(`Remove "${a.name}" from this project?`)) return;
    try {
      await api.del(`/projects/${projectId}/assets/${a.id}`);
      onChanged();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-slate-400">Keep the people, products and places that must look the same everywhere. The Director knows about these, and cards can use a character’s Soul ID.</p>
        {canWrite && <Button variant="primary" onClick={() => setEditing('new')}><Plus className="h-4 w-4" aria-hidden /> Add asset</Button>}
      </div>
      {assets.length === 0 ? (
        <EmptyState title="No assets yet" hint="Add your lead character, the product, a logo. Or ask the Director to list who and what you’ll need." />
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {assets.map((a) => (
            <li key={a.id}>
              <Card className="flex gap-3 p-3">
                <div className="grid h-20 w-20 shrink-0 place-items-center overflow-hidden rounded-xl bg-slate-950">
                  {a.url ? <img src={a.url} alt="" className="h-full w-full object-cover" /> : a.kind === 'character' ? <Users className="h-6 w-6 text-slate-600" aria-hidden /> : <ImageIcon className="h-6 w-6 text-slate-600" aria-hidden />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5"><span className="truncate font-medium">{a.name}</span><Badge>{KINDS.find((k) => k.id === a.kind)?.label ?? a.kind}</Badge></div>
                  {a.characterId && <div className="mt-0.5"><Badge tone="emerald">Soul ID linked</Badge></div>}
                  {!a.url && <p className="mt-0.5 text-[11px] text-amber-600">No image yet</p>}
                  {a.notes && <p className="mt-1 line-clamp-2 text-xs text-slate-500">{a.notes}</p>}
                  {canWrite && (
                    <div className="mt-1.5 flex gap-1">
                      <Button size="sm" variant="ghost" onClick={() => setEditing(a)}>Edit</Button>
                      <Button size="sm" variant="ghost" className="text-rose-600" aria-label={`Remove ${a.name}`} onClick={() => void remove(a)}><Trash2 className="h-3.5 w-3.5" aria-hidden /></Button>
                    </div>
                  )}
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
      <AssetModal projectId={projectId} asset={editing} connected={connected} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); onChanged(); }} />
    </div>
  );
}

function AssetModal({ projectId, asset, connected, onClose, onSaved }: { projectId: string; asset: ProjectAsset | 'new' | null; connected: boolean; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const existing = asset && asset !== 'new' ? asset : null;
  const [kind, setKind] = useState<ProjectAsset['kind']>('character');
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [notes, setNotes] = useState('');
  const [characterId, setCharacterId] = useState('');
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);

  const key = asset === null ? null : existing?.id ?? 'new';
  if (key !== loadedFor) {
    setLoadedFor(key);
    setKind(existing?.kind ?? 'character');
    setName(existing?.name ?? '');
    setUrl(existing?.url ?? '');
    setNotes(existing?.notes ?? '');
    setCharacterId(existing?.characterId ?? '');
    setError(null);
  }

  const chars = useApi<{ connected: boolean; characters: Character[] }>(asset !== null && kind === 'character' && connected ? '/studio/characters' : null);

  const upload = async (f: File | undefined) => {
    if (!f) return;
    setUploading(true);
    try {
      setUrl((await api.upload<{ url: string }>(`/studio/uploads?filename=${encodeURIComponent(f.name)}`, f)).url);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = { kind, name: name.trim(), url: url.trim(), notes, characterId: kind === 'character' ? characterId : '' };
      if (existing) await api.put(`/projects/${projectId}/assets/${existing.id}`, body);
      else await api.post(`/projects/${projectId}/assets`, body);
      toast.success('Saved');
      onSaved();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Modal open={asset !== null} onClose={onClose} title={existing ? 'Edit asset' : 'Add asset'}>
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Type" htmlFor="as-kind"><Select id="as-kind" value={kind} onChange={(e) => setKind(e.target.value as ProjectAsset['kind'])}>{KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}</Select></Field>
            <Field label="Name" htmlFor="as-name"><Input id="as-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder={kind === 'character' ? 'Mia' : 'Product name'} /></Field>
          </div>
          <Field label="Notes" htmlFor="as-notes" hint="Look, wardrobe, personality, what must stay consistent.">
            <Textarea id="as-notes" rows={3} value={notes} maxLength={1000} onChange={(e) => setNotes(e.target.value)} className="font-sans" />
          </Field>
          <div>
            <div className="mb-1.5 text-xs font-medium uppercase tracking-wider text-slate-400">Image</div>
            <div className="flex items-start gap-3">
              <div className="grid h-20 w-20 shrink-0 place-items-center overflow-hidden rounded-xl bg-slate-950">{url ? <img src={url} alt="" className="h-full w-full object-cover" /> : <ImageIcon className="h-6 w-6 text-slate-600" aria-hidden />}</div>
              <div className="min-w-0 flex-1 space-y-2">
                <Input aria-label="Image URL" type="url" placeholder="Paste a public https:// link" value={url} onChange={(e) => setUrl(e.target.value)} />
                <div className="flex gap-2">
                  <input ref={fileRef} type="file" hidden accept="image/jpeg,image/png,image/webp,image/gif" onChange={(e) => void upload(e.target.files?.[0])} />
                  <Button size="sm" loading={uploading} disabled={!connected} title={connected ? undefined : 'Connect Higgsfield to upload files'} onClick={() => fileRef.current?.click()}><Upload className="h-3.5 w-3.5" aria-hidden /> Upload</Button>
                  <Button size="sm" onClick={() => setPicking(true)}><Library className="h-3.5 w-3.5" aria-hidden /> Library</Button>
                </div>
              </div>
            </div>
          </div>
          {kind === 'character' && (
            <Field label="Soul ID (optional)" htmlFor="as-soul" hint="A trained Higgsfield character keeps the same face across images. Train one in Studio.">
              <Select id="as-soul" value={characterId} onChange={(e) => setCharacterId(e.target.value)} disabled={!connected}>
                <option value="">None</option>
                {chars.data?.characters.map((c) => <option key={c.id} value={c.id} disabled={c.status !== 'completed'}>{c.name}{c.status !== 'completed' ? ` (${c.status})` : ''}</option>)}
                {characterId && !chars.data?.characters.some((c) => c.id === characterId) && <option value={characterId}>Linked character</option>}
              </Select>
            </Field>
          )}
          {error && <p role="alert" className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-300">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button variant="primary" loading={busy} disabled={!name.trim()} onClick={() => void save()}>Save</Button>
          </div>
        </div>
      </Modal>
      <LibraryPicker input={picking ? IMAGE_INPUT : null} onClose={() => setPicking(false)} onPick={(_i, urls) => { if (urls[0]) setUrl(urls[0]); setPicking(false); }} />
    </>
  );
}
