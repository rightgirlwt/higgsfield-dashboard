import { ChevronLeft, ChevronRight, Download, ExternalLink, Film, ImageIcon, Plus, Search, Trash2, Upload, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useCan } from '../auth/context';
import { Badge, Button, Card, EmptyState, ErrorState, Field, IconButton, Input, Modal, PageHeader, Select, Skeleton, Spinner } from '../components/ui';
import { api, errorMessage, qs } from '../lib/api';
import { dateTime, dayLabel } from '../lib/format';
import { useApi, useDebounced, useDocumentTitle, useInView } from '../lib/hooks';
import type { MediaItem, WorkflowListItem } from '../lib/types';
import { useToast } from '../state/Toast';

interface Page {
  items: MediaItem[];
  total: number;
  nextCursor: string | null;
}

export default function Media() {
  useDocumentTitle('Media');
  const toast = useToast();
  const canWrite = useCan('user');
  const [params, setParams] = useSearchParams();
  const [type, setType] = useState('');
  const [tag, setTag] = useState('');
  const [workflowId, setWorkflowId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [q, setQ] = useState(params.get('q') ?? '');
  const dq = useDebounced(q);
  const tags = useApi<{ tag: string; n: number }[]>('/media/tags');
  const workflows = useApi<WorkflowListItem[]>('/workflows');

  const [items, setItems] = useState<MediaItem[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<number | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const gen = useRef(0);

  const filterQs = useMemo(() => ({ type, tag, workflowId, from, to, q: dq }), [type, tag, workflowId, from, to, dq]);

  const load = useCallback(
    async (reset: boolean, cur: string | null) => {
      const my = ++gen.current;
      setLoading(true);
      setError(null);
      try {
        const p = await api.get<Page>(`/media${qs({ ...filterQs, limit: 24, cursor: reset ? undefined : cur })}`);
        if (my !== gen.current) return; // a newer request superseded this one
        setItems((prev) => (reset ? p.items : [...prev, ...p.items]));
        setTotal(p.total);
        setCursor(p.nextCursor);
      } catch (e) {
        if (my === gen.current) setError(errorMessage(e));
      } finally {
        if (my === gen.current) setLoading(false);
      }
    },
    [filterQs],
  );

  useEffect(() => {
    void load(true, null);
  }, [load]);

  const sentinel = useInView(() => !loading && cursor && void load(false, cursor), !!cursor && !error);

  const groups = useMemo(() => {
    const out: { label: string; items: { item: MediaItem; index: number }[] }[] = [];
    items.forEach((item, index) => {
      const label = dayLabel(item.createdAt);
      const last = out[out.length - 1];
      if (last?.label === label) last.items.push({ item, index });
      else out.push({ label, items: [{ item, index }] });
    });
    return out;
  }, [items]);

  const clear = () => {
    setType(''); setTag(''); setWorkflowId(''); setFrom(''); setTo(''); setQ('');
    if (params.get('q')) setParams({});
  };
  const filtered = !!(type || tag || workflowId || from || to || dq);

  const exportFile = async (format: 'csv' | 'json') => {
    try {
      await api.download(`/media/export${qs({ ...filterQs, format })}`, `media-export.${format}`);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const remove = async (m: MediaItem) => {
    if (!window.confirm(`Delete "${m.title}"?`)) return;
    try {
      await api.del(`/media/${m.id}`);
      toast.success('Deleted');
      setLightbox(null);
      void load(true, null);
      tags.reload();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <div>
      <PageHeader
        eyebrow="Archive"
        title="Media timeline"
        actions={
          <>
            <Button onClick={() => exportFile('csv')}><Download className="h-4 w-4" aria-hidden /> CSV</Button>
            <Button onClick={() => exportFile('json')}><Download className="h-4 w-4" aria-hidden /> JSON</Button>
            {canWrite && <Button variant="primary" onClick={() => setAddOpen(true)}><Plus className="h-4 w-4" aria-hidden /> Add media</Button>}
          </>
        }
      />

      <Card className="mb-6 p-4">
        <form role="search" aria-label="Filter media" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7" onSubmit={(e) => e.preventDefault()}>
          <div className="relative lg:col-span-2">
            <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-500" aria-hidden />
            <Input aria-label="Search titles" className="pl-9" placeholder="Search titles…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <Select aria-label="Media type" value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">Photos & videos</option>
            <option value="photo">Photos</option>
            <option value="video">Videos</option>
          </Select>
          <Select aria-label="Tag" value={tag} onChange={(e) => setTag(e.target.value)}>
            <option value="">All tags</option>
            {tags.data?.map((t) => <option key={t.tag} value={t.tag}>{t.tag} ({t.n})</option>)}
          </Select>
          <Select aria-label="Workflow" value={workflowId} onChange={(e) => setWorkflowId(e.target.value)}>
            <option value="">Any workflow</option>
            {workflows.data?.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </Select>
          <div className="flex items-center gap-2 sm:col-span-2">
            <Input type="date" aria-label="From date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
            <span className="text-slate-500" aria-hidden>–</span>
            <Input type="date" aria-label="To date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
          </div>
        </form>
        <div className="mt-3 flex items-center justify-between text-sm text-slate-400" aria-live="polite">
          <span>{total === null ? 'Loading…' : `${total.toLocaleString()} asset${total === 1 ? '' : 's'}${filtered ? ' match your filters' : ''}`}</span>
          {filtered && <Button size="sm" variant="ghost" onClick={clear}>Clear filters</Button>}
        </div>
      </Card>

      {error ? (
        <ErrorState message={error} onRetry={() => load(true, null)} />
      ) : items.length === 0 && loading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="aspect-video" />)}</div>
      ) : items.length === 0 ? (
        <EmptyState title={filtered ? 'Nothing matches those filters' : 'No media yet'} hint={filtered ? 'Try widening the date range or clearing a filter.' : 'Assets saved by workflows or added manually appear here.'} action={filtered ? <Button onClick={clear}>Clear filters</Button> : undefined} />
      ) : (
        <div className="space-y-8">
          {groups.map((g) => (
            <section key={g.label} aria-label={g.label}>
              <h2 className="mb-3 text-sm font-semibold text-slate-300">{g.label}</h2>
              <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {g.items.map(({ item, index }) => (
                  <li key={item.id}>
                    <button onClick={() => setLightbox(index)} className="group block w-full overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/80 text-left transition hover:border-slate-600" aria-label={`Open ${item.type} ${item.title}`}>
                      <div className="relative aspect-video bg-slate-950">
                        <img src={item.thumbUrl} alt="" loading="lazy" className="h-full w-full object-cover transition group-hover:scale-[1.02]" />
                        <span className="absolute left-2 top-2"><Badge tone={item.type === 'video' ? 'violet' : 'cyan'}>{item.type === 'video' ? <Film className="h-3 w-3" aria-hidden /> : <ImageIcon className="h-3 w-3" aria-hidden />}{item.type}</Badge></span>
                      </div>
                      <div className="space-y-1.5 p-3">
                        <div className="truncate text-sm font-medium">{item.title}</div>
                        <div className="text-xs text-slate-500">{dateTime(item.createdAt)}{item.workflowName && <> · {item.workflowName}</>}</div>
                        <div className="flex flex-wrap gap-1">{item.tags.slice(0, 3).map((t) => <Badge key={t}>{t}</Badge>)}</div>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          <div ref={sentinel} className="flex min-h-12 items-center justify-center">
            {loading && <Spinner label="Loading more" />}
            {!loading && cursor && <Button onClick={() => load(false, cursor)}>Load more</Button>}
            {!loading && !cursor && <p className="text-sm text-slate-600">End of timeline</p>}
          </div>
        </div>
      )}

      {lightbox !== null && items[lightbox] && (
        <Lightbox items={items} index={lightbox} onIndex={setLightbox} onClose={() => setLightbox(null)} canDelete={canWrite} onDelete={remove} />
      )}
      <AddMedia open={addOpen} onClose={() => setAddOpen(false)} onAdded={() => (void load(true, null), tags.reload())} />
    </div>
  );
}

function Lightbox({ items, index, onIndex, onClose, canDelete, onDelete }: { items: MediaItem[]; index: number; onIndex: (i: number) => void; onClose: () => void; canDelete: boolean; onDelete: (m: MediaItem) => void }) {
  const m = items[index];
  const ref = useRef<HTMLDivElement>(null);
  const prev = useCallback(() => onIndex(Math.max(0, index - 1)), [index, onIndex]);
  const next = useCallback(() => onIndex(Math.min(items.length - 1, index + 1)), [index, items.length, onIndex]);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    return () => opener?.focus?.();
  }, []);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft') prev();
      else if (e.key === 'ArrowRight') next();
    };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [onClose, prev, next]);

  const isPlaceholder = m.metadata?.placeholder;
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-slate-950/95 p-3 md:p-6" role="dialog" aria-modal="true" aria-label={`${m.type}: ${m.title}`} ref={ref} tabIndex={-1}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-lg font-semibold">{m.title}</h2>
          <p className="text-xs text-slate-400">{dateTime(m.createdAt)} · {index + 1} of {items.length}</p>
        </div>
        <div className="flex gap-2">
          {!m.url.startsWith('data:') && <a href={m.url} target="_blank" rel="noopener noreferrer" aria-label="Open original in new tab" className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-slate-700 bg-slate-900 hover:bg-slate-800"><ExternalLink className="h-4 w-4" aria-hidden /></a>}
          {canDelete && <IconButton label="Delete" onClick={() => onDelete(m)}><Trash2 className="h-4 w-4 text-rose-300" aria-hidden /></IconButton>}
          <IconButton label="Close viewer" onClick={onClose}><X className="h-4 w-4" aria-hidden /></IconButton>
        </div>
      </div>
      <div className="relative flex min-h-0 flex-1 items-center justify-center">
        <IconButton label="Previous" className="absolute left-0 z-10 disabled:opacity-30" disabled={index === 0} onClick={prev}><ChevronLeft className="h-5 w-5" aria-hidden /></IconButton>
        {m.type === 'video' ? (
          // Browsers can't autoplay with sound; user controls playback.
          <video key={m.id} src={m.url} poster={m.thumbUrl} controls playsInline className="max-h-full max-w-full rounded-xl bg-black" />
        ) : (
          <img key={m.id} src={m.url} alt={m.title} className="max-h-full max-w-full rounded-xl object-contain" />
        )}
        <IconButton label="Next" className="absolute right-0 z-10 disabled:opacity-30" disabled={index === items.length - 1} onClick={next}><ChevronRight className="h-5 w-5" aria-hidden /></IconButton>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
        {m.workflowName && m.workflowId && <Link to={`/workflows/${m.workflowId}`} className="text-cyan-300 underline">{m.workflowName}</Link>}
        {m.tags.map((t) => <Badge key={t}>{t}</Badge>)}
        {isPlaceholder && <Badge tone="amber">placeholder — no source URL</Badge>}
        {m.metadata?.demo && <Badge tone="amber">demo data</Badge>}
        {m.metadata?.width && <span className="text-slate-400">{m.metadata.width}×{m.metadata.height}</span>}
        {m.metadata?.durationSec && <span className="text-slate-400">{m.metadata.durationSec}s</span>}
      </div>
    </div>
  );
}

function AddMedia({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded: () => void }) {
  const toast = useToast();
  const [mode, setMode] = useState<'url' | 'upload'>('url');
  const [type, setType] = useState<'photo' | 'video'>('photo');
  const [title, setTitle] = useState('');
  const [url, setUrl] = useState('');
  const [tags, setTags] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      let finalUrl = url.trim();
      let kind = type;
      if (mode === 'upload') {
        if (!file) throw new Error('Choose a file');
        kind = file.type.startsWith('video/') ? 'video' : 'photo';
        const t = await api.post<{ uploadUrl: string; publicUrl: string; headers: Record<string, string> }>('/media/upload-url', { filename: file.name, contentType: file.type });
        const put = await fetch(t.uploadUrl, { method: 'PUT', headers: t.headers, body: file });
        if (!put.ok) throw new Error(`Upload to storage failed (${put.status}). Check bucket CORS and permissions.`);
        finalUrl = t.publicUrl;
      }
      await api.post('/media', { type: kind, title: title.trim() || file?.name || 'Untitled', url: finalUrl, tags: tags.split(',').map((x) => x.trim()).filter(Boolean) });
      toast.success('Media added');
      setTitle(''); setUrl(''); setTags(''); setFile(null);
      onAdded();
      onClose();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Add media">
      <div className="mb-4 flex gap-2">
        <Button size="sm" variant={mode === 'url' ? 'primary' : 'secondary'} onClick={() => setMode('url')}>From URL</Button>
        <Button size="sm" variant={mode === 'upload' ? 'primary' : 'secondary'} onClick={() => setMode('upload')}><Upload className="h-3.5 w-3.5" aria-hidden /> Upload to storage</Button>
      </div>
      <div className="space-y-3">
        <Field label="Title" htmlFor="m-title"><Input id="m-title" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} /></Field>
        {mode === 'url' ? (
          <>
            <Field label="Type" htmlFor="m-type">
              <Select id="m-type" value={type} onChange={(e) => setType(e.target.value as 'photo' | 'video')}><option value="photo">Photo</option><option value="video">Video</option></Select>
            </Field>
            <Field label="URL" htmlFor="m-url"><Input id="m-url" type="url" placeholder="https://…" value={url} onChange={(e) => setUrl(e.target.value)} /></Field>
          </>
        ) : (
          <Field label="File" htmlFor="m-file" hint="Requires S3-compatible storage configured in Settings → Storage. Images (png, jpg, webp, gif, avif) and video (mp4, webm, mov).">
            <Input id="m-file" type="file" accept="image/*,video/mp4,video/webm,video/quicktime" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </Field>
        )}
        <Field label="Tags" htmlFor="m-tags" hint="Comma separated"><Input id="m-tags" value={tags} onChange={(e) => setTags(e.target.value)} /></Field>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" loading={busy} disabled={mode === 'url' ? !url.trim() : !file} onClick={submit}>Add</Button>
      </div>
    </Modal>
  );
}
