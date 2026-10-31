import { Calendar, Copy, Film, FolderOpen, Layers, Search, Sparkles, Trash2, Upload, Volume2, VolumeX } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCan } from '../auth/context';
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, Field, Input, Modal, PageHeader, ProgressBar, Select, Skeleton, Tabs } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { usd } from '../lib/format';
import { useApi, useDebounced, useDocumentTitle } from '../lib/hooks';
import { useToast } from '../state/Toast';

interface Clip {
  id: string;
  name: string;
  source: 'folder' | 'upload';
  sizeBytes: number;
  durationSec: number | null;
  width: number | null;
  height: number | null;
  shotAt: string;
  shotDate: string;
  hasSound: boolean;
  duplicateOf: string | null;
  folder: string;
  tags: string[];
  description: string;
  sorted: boolean;
  thumb: string;
}
interface Stats {
  clips: number;
  duplicates: number;
  unsorted: number;
  days: number;
  seconds: number;
  folders: { folder: string; n: number }[];
  folderNames: string[];
}
interface Day {
  day: string;
  clips: number;
  seconds: number;
  first: string;
  last: string;
  folders: string[];
  thumbs: string[];
}
interface Job {
  id: string;
  kind: 'scan' | 'sort';
  state: 'running' | 'done' | 'error';
  total: number;
  done: number;
  added: number;
  duplicates: number;
  failed: number;
  costUsd: number;
  note: string;
  error: string;
}
interface Reel {
  id: string;
  title: string;
  style: 'vlog' | 'topic';
  day: string | null;
  hook: string;
  caption: string;
  why: string;
  status: 'idea' | 'saved' | 'used';
  beats: { clipId: string; line: string; seconds: number; clip: Clip | null }[];
}
interface ReelQuote {
  approved: false;
  model: string;
  clips: number;
  days: number;
  estimateUsd: number;
  maxUsd: number;
  keyMissing: boolean;
}

type TabId = 'clips' | 'days' | 'reels';
const PAGE = 36;
const TYPES: Record<string, string> = { mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm' };

const mmss = (s: number | null) => (s === null ? '' : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`);
const dayText = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' });
const timeText = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const mb = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1e6))} MB`);

/** Follows a scan or sort until it finishes, then says so. */
function useJob(jobId: string | null, onFinish: (job: Job) => void) {
  const [job, setJob] = useState<Job | null>(null);
  const finish = useRef(onFinish);
  finish.current = onFinish;
  useEffect(() => {
    if (!jobId) return;
    let stop = false;
    const tick = async () => {
      try {
        const j = await api.get<Job>(`/vault/jobs/${jobId}`);
        if (stop) return;
        setJob(j);
        if (j.state !== 'running') return finish.current(j);
      } catch {
        if (stop) return;
        return finish.current({ id: jobId, kind: 'scan', state: 'error', total: 0, done: 0, added: 0, duplicates: 0, failed: 0, costUsd: 0, note: '', error: 'Lost track of this job (did the server restart?).' });
      }
      setTimeout(tick, 1000);
    };
    void tick();
    return () => {
      stop = true;
    };
  }, [jobId]);
  return jobId ? job : null;
}

export default function Vault() {
  useDocumentTitle('Content Vault');
  const toast = useToast();
  const canWrite = useCan('user');
  const isAdmin = useCan('admin');
  const stats = useApi<Stats>('/vault/stats');
  const days = useApi<Day[]>('/vault/days');
  const reels = useApi<Reel[]>('/vault/reels');
  const [tab, setTab] = useState<TabId>('clips');
  const [folder, setFolder] = useState('');
  const [view, setView] = useState<'' | 'unsorted' | 'duplicates'>('');
  const [day, setDay] = useState('');
  const [search, setSearch] = useState('');
  const q = useDebounced(search);
  const [version, setVersion] = useState(0);
  const [open, setOpen] = useState<Clip | null>(null);
  const [planDay, setPlanDay] = useState('');

  const refresh = useCallback(() => {
    stats.reload();
    days.reload();
    setVersion((v) => v + 1);
  }, [stats, days]);

  const query = useMemo(() => {
    const p = new URLSearchParams();
    if (folder) p.set('folder', folder);
    if (day) p.set('day', day);
    if (q.trim()) p.set('q', q.trim());
    if (view === 'unsorted') p.set('unsorted', '1');
    if (view === 'duplicates') p.set('duplicates', 'only');
    return p.toString();
  }, [folder, day, q, view]);

  const [items, setItems] = useState<Clip[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(
    async (offset: number) => {
      setLoading(true);
      setError(null);
      try {
        const r = await api.get<{ items: Clip[]; total: number }>(`/vault/clips?${query}&limit=${PAGE}&offset=${offset}`);
        setItems((cur) => (offset === 0 ? r.items : [...cur, ...r.items]));
        setTotal(r.total);
      } catch (e) {
        setError(errorMessage(e));
      }
      setLoading(false);
    },
    [query],
  );
  useEffect(() => void load(0), [load, version]);

  const folders = stats.data?.folders ?? [];
  const empty = stats.data && stats.data.clips === 0 && stats.data.duplicates === 0;

  return (
    <div>
      <PageHeader eyebrow="Footage, sorted" title="Content Vault" />
      <StatStrip stats={stats.data} />
      {canWrite && <AddFootage isAdmin={isAdmin} onDone={refresh} />}
      {canWrite && stats.data && stats.data.unsorted > 0 && <SortCard unsorted={stats.data.unsorted} onDone={refresh} />}

      <div className="mt-6">
        <Tabs<TabId>
          label="Vault views"
          value={tab}
          onChange={setTab}
          tabs={[
            { id: 'clips', label: 'Clips' },
            { id: 'days', label: 'By day' },
            { id: 'reels', label: `Reel ideas${reels.data?.length ? ` (${reels.data.length})` : ''}` },
          ]}
        />
      </div>

      {empty && (
        <div className="mt-6">
          <EmptyState title="No footage yet" hint={isAdmin ? 'Point the Vault at a folder of clips, or upload some. Reading them is free.' : 'Upload some clips. Reading them is free.'} />
        </div>
      )}

      {tab === 'clips' && !empty && (
        <section className="mt-4" aria-label="Clips">
          <div className="flex flex-wrap items-center gap-2">
            <Chip active={!folder && !view} onClick={() => (setFolder(''), setView(''))}>All {stats.data ? `Â· ${stats.data.clips}` : ''}</Chip>
            {folders.map((f) => (
              <Chip key={f.folder} active={folder === f.folder} onClick={() => (setFolder(f.folder), setView(''))}>
                {f.folder} Â· {f.n}
              </Chip>
            ))}
            {!!stats.data?.unsorted && (
              <Chip active={view === 'unsorted'} onClick={() => (setView('unsorted'), setFolder(''))}>
                Not sorted Â· {stats.data.unsorted}
              </Chip>
            )}
            {!!stats.data?.duplicates && (
              <Chip active={view === 'duplicates'} onClick={() => (setView('duplicates'), setFolder(''))}>
                Duplicates Â· {stats.data.duplicates}
              </Chip>
            )}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <div className="relative min-w-56 flex-1 sm:max-w-sm">
              <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-500" aria-hidden />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search names, tags, what happens" aria-label="Search clips" className="pl-9" />
            </div>
            {day && (
              <button onClick={() => setDay('')} className="inline-flex items-center gap-1 rounded-full bg-cyan-500/15 px-3 py-1 text-xs text-cyan-300 hover:bg-cyan-500/25">
                <Calendar className="h-3 w-3" aria-hidden /> {dayText(day)} âœ•
              </button>
            )}
            <span className="text-xs text-slate-500">{loading && items.length === 0 ? '' : `${total} clip${total === 1 ? '' : 's'}`}</span>
          </div>
          {error ? (
            <div className="mt-4">
              <ErrorState message={error} onRetry={() => void load(0)} />
            </div>
          ) : loading && items.length === 0 ? (
            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
              {Array.from({ length: 12 }, (_, i) => <Skeleton key={i} className="aspect-video" />)}
            </div>
          ) : items.length === 0 ? (
            <div className="mt-4">
              <EmptyState title="No clips match" hint="Try another folder or search." />
            </div>
          ) : (
            <>
              <ul className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
                {items.map((c) => (
                  <li key={c.id}>
                    <ClipTile clip={c} onOpen={() => setOpen(c)} />
                  </li>
                ))}
              </ul>
              {items.length < total && (
                <div className="mt-4 text-center">
                  <Button onClick={() => void load(items.length)} loading={loading}>Show more</Button>
                </div>
              )}
            </>
          )}
        </section>
      )}

      {tab === 'days' && !empty && (
        <DaysList
          days={days.data}
          error={days.error}
          onClips={(d) => (setDay(d), setFolder(''), setView(''), setTab('clips'))}
          onReels={(d) => (setPlanDay(d), setTab('reels'))}
        />
      )}

      {tab === 'reels' && !empty && <Reels reels={reels.data} days={days.data ?? []} canWrite={canWrite} planDay={planDay} setPlanDay={setPlanDay} unsorted={stats.data?.unsorted ?? 0} sorted={(stats.data?.clips ?? 0) - (stats.data?.unsorted ?? 0)} reload={reels.reload} onOpenClip={setOpen} />}

      <ClipModal
        clip={open}
        names={stats.data?.folderNames ?? []}
        canWrite={canWrite}
        onClose={() => setOpen(null)}
        onChanged={() => {
          setOpen(null);
          refresh();
          reels.reload();
        }}
        toast={toast}
      />
    </div>
  );
}

function StatStrip({ stats }: { stats: Stats | null }) {
  const cells = [
    { label: 'Clips found', value: stats ? stats.clips : null },
    { label: 'Folders created', value: stats ? stats.folders.length : null },
    { label: 'Days filmed', value: stats ? stats.days : null },
    { label: 'Duplicates caught', value: stats ? stats.duplicates : null },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" aria-label="Vault totals">
      {cells.map((c) => (
        <Card key={c.label} className="p-4">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">{c.label}</div>
          <div className="mt-1 text-3xl font-semibold tabular-nums">{c.value === null ? <Skeleton className="h-9 w-16" /> : c.value}</div>
        </Card>
      ))}
    </div>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} aria-pressed={active} className={`rounded-full border px-3 py-1 text-xs transition ${active ? 'border-cyan-400/60 bg-cyan-500/15 text-cyan-200' : 'border-slate-800 bg-slate-950/60 text-slate-400 hover:text-slate-100'}`}>
      {children}
    </button>
  );
}

function AddFootage({ isAdmin, onDone }: { isAdmin: boolean; onDone: () => void }) {
  const toast = useToast();
  const [folder, setFolder] = useState('');
  const [jobId, setJobId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [uploading, setUploading] = useState<{ at: number; of: number } | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const job = useJob(jobId, (j) => {
    setJobId(null);
    if (j.state === 'error') toast.error(j.error);
    else toast.success(`${j.added} new clip${j.added === 1 ? '' : 's'} added${j.duplicates ? `, ${j.duplicates} duplicate${j.duplicates === 1 ? '' : 's'} caught` : ''}${j.failed ? `, ${j.failed} could not be read` : ''}.`);
    onDone();
  });

  async function scan() {
    setStarting(true);
    try {
      const j = await api.post<Job>('/vault/scan', { folder });
      if (j.total === 0) toast.success(`Nothing new: ${j.note}`);
      else setJobId(j.id);
    } catch (e) {
      toast.error(errorMessage(e));
    }
    setStarting(false);
  }

  async function upload(files: File[]) {
    let added = 0;
    let dupes = 0;
    for (let i = 0; i < files.length; i++) {
      setUploading({ at: i + 1, of: files.length });
      const f = files[i];
      try {
        const type = f.type || TYPES[f.name.split('.').pop()?.toLowerCase() ?? ''] || '';
        const r = await api.upload<{ duplicate: boolean }>(`/vault/upload?filename=${encodeURIComponent(f.name)}&modified=${f.lastModified}`, f, type);
        if (r.duplicate) dupes++;
        else added++;
      } catch (e) {
        toast.error(`${f.name}: ${errorMessage(e)}`);
      }
    }
    setUploading(null);
    toast.success(`${added} clip${added === 1 ? '' : 's'} added${dupes ? `, ${dupes} duplicate${dupes === 1 ? '' : 's'} caught` : ''}.`);
    onDone();
  }

  const busy = !!jobId || !!uploading;
  return (
    <Card className="mt-4 p-4">
      <CardHeader eyebrow="Free" title="Add footage" />
      <div className="mt-3 grid gap-4 lg:grid-cols-2">
        {isAdmin && (
          <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => (e.preventDefault(), folder.trim() && !busy && void scan())}>
            <div className="min-w-60 flex-1">
              <Field label="A folder on this computer" hint="Reads every video inside it, and the folders inside that. Your files stay where they are.">
                <Input value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="C:\Users\you\Videos\Camera Roll" />
              </Field>
            </div>
            <Button type="submit" variant="primary" loading={starting} disabled={!folder.trim() || busy}>
              <FolderOpen className="h-4 w-4" aria-hidden /> Read folder
            </Button>
          </form>
        )}
        <div className="flex flex-wrap items-end gap-2">
          <input ref={picker} type="file" accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.m4v,.webm" multiple hidden onChange={(e) => (e.target.files?.length && void upload([...e.target.files]), (e.target.value = ''))} />
          <Button onClick={() => picker.current?.click()} disabled={busy}>
            <Upload className="h-4 w-4" aria-hidden /> Upload clips
          </Button>
          <span className="pb-2 text-xs text-slate-500">MP4, MOV or WebM, up to 500 MB each. Several at once is fine.</span>
        </div>
      </div>
      {job && (
        <div className="mt-4" aria-live="polite">
          <div className="mb-1 text-xs text-slate-400">
            Reading clips: {job.done} of {job.total} {job.note && <span className="text-slate-500">Â· {job.note}</span>}
          </div>
          <ProgressBar value={job.total ? (job.done / job.total) * 100 : 0} label="Reading clips" />
        </div>
      )}
      {uploading && (
        <div className="mt-4 text-xs text-slate-400" aria-live="polite">
          Uploading clip {uploading.at} of {uploading.of}â€¦
          <div className="mt-1">
            <ProgressBar value={((uploading.at - 1) / uploading.of) * 100} label="Uploading" />
          </div>
        </div>
      )}
    </Card>
  );
}

/**
 * The unsorted footage as a dense ball of small, white-bordered thumbnails tilted at every angle, packed in a sunflower spiral.
 * A ball needs a lot of tiles to read as a ball, so a small Vault repeats its thumbnails; the real count is in the heading.
 */
function ClipBall({ thumbs, total }: { thumbs: string[]; total: number }) {
  const tiles = 130;
  const size = 300;
  const radius = size / 2 - 20;
  const s = Math.sqrt((2.4 * Math.PI * radius * radius) / tiles);
  return (
    <div className="relative mx-auto shrink-0" style={{ width: size, height: size }} role="img" aria-label={`${total} clips waiting to be sorted`}>
      {Array.from({ length: tiles }, (_, i) => {
        const r = radius * Math.sqrt((i + 0.5) / tiles) + (((i * 53) % 7) - 3);
        const a = i * 2.39996;
        return (
          <img
            key={i}
            src={thumbs[i % thumbs.length]}
            alt=""
            className="absolute rounded-[3px] border-[1.5px] border-[#fdf8f3] object-cover shadow-[0_1px_3px_rgba(0,0,0,0.35)]"
            style={{ width: s, height: s * 0.85, left: size / 2 + r * Math.cos(a) - s / 2, top: size / 2 + r * Math.sin(a) - (s * 0.85) / 2, transform: `rotate(${(i * 137.5) % 360}deg)`, zIndex: (i * 7) % tiles }}
          />
        );
      })}
    </div>
  );
}

const FEATURED = ['Desk', 'Studio', 'Talking head', 'Close-ups'];

/** The folders clips land in: empty slots at first, filling with thumbnails as sorting runs. */
function FolderBoxes({ active }: { active: boolean }) {
  const [boxes, setBoxes] = useState<{ folder: string; n: number; thumbs: string[] }[]>(FEATURED.map((folder) => ({ folder, n: 0, thumbs: [] })));
  useEffect(() => {
    let stop = false;
    const pull = async () => {
      try {
        const s = await api.get<Stats>('/vault/stats');
        const names = [...FEATURED, ...s.folders.map((f) => f.folder).filter((f) => !FEATURED.includes(f))];
        const next = await Promise.all(
          names.map(async (folder) => {
            const n = s.folders.find((f) => f.folder === folder)?.n ?? 0;
            const thumbs = n ? (await api.get<{ items: Clip[] }>(`/vault/clips?folder=${encodeURIComponent(folder)}&limit=12`)).items.map((c) => c.thumb) : [];
            return { folder, n, thumbs };
          }),
        );
        if (!stop) setBoxes(next);
      } catch {
        /* the next tick tries again */
      }
    };
    void pull();
    if (!active) return () => void (stop = true);
    const t = setInterval(() => void pull(), 1500);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [active]);
  return (
    <div className="mt-5 grid gap-3 sm:grid-cols-2" aria-label="Folders">
      {boxes.map((b) => (
        <div key={b.folder} className="rounded-xl border border-slate-800 bg-slate-950/60 p-2.5">
          <div className="mb-2 flex items-center justify-between text-xs">
            <span className="inline-flex items-center gap-1.5 font-medium text-slate-200"><FolderOpen className="h-3.5 w-3.5 text-amber-400" aria-hidden />{b.folder}</span>
            <span className="tabular-nums text-slate-500">{b.n}</span>
          </div>
          <div className="grid grid-cols-6 gap-1">
            {Array.from({ length: 12 }, (_, i) => (b.thumbs[i] ? <img key={i} src={b.thumbs[i]} alt="" className="aspect-[4/3] w-full rounded-[3px] object-cover" /> : <div key={i} className="aspect-[4/3] rounded-[3px] bg-slate-900" />))}
          </div>
        </div>
      ))}
    </div>
  );
}

function SortCard({ unsorted, onDone }: { unsorted: number; onDone: () => void }) {
  const toast = useToast();
  const waiting = useApi<{ items: Clip[] }>(`/vault/clips?unsorted=1&limit=100&n=${unsorted}`);
  const thumbs = (waiting.data?.items ?? []).map((c) => c.thumb).filter(Boolean);
  const [busy, setBusy] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useJob(jobId, (j) => {
    setJobId(null);
    if (j.state === 'error') toast.error(j.error);
    else toast.success(`Sorted ${j.done - j.failed} clip${j.done - j.failed === 1 ? '' : 's'} for ${usd(j.costUsd)}${j.failed ? ` (${j.failed} could not be sorted)` : ''}.${j.note ? ' ' + j.note : ''}`);
    onDone();
  });

  /** One click: the server still works out the most this run can cost and stops there. */
  async function sort() {
    setBusy(true);
    try {
      const q = await api.post<{ keyMissing: boolean }>('/vault/sort', { approved: false });
      if (q.keyMissing) throw new Error('Add your Anthropic key in Settings first. Nothing has been spent.');
      setJobId((await api.post<Job>('/vault/sort', { approved: true })).id);
    } catch (e) {
      toast.error(errorMessage(e));
    }
    setBusy(false);
  }

  return (
    <Card className="mt-4 p-4">
      <div className="flex flex-wrap items-center gap-6">
        {thumbs.length > 0 && <ClipBall thumbs={thumbs} total={unsorted} />}
        <div className="min-w-60 flex-1">
          <CardHeader eyebrow="A few cents in all" title={`${unsorted} clip${unsorted === 1 ? '' : 's'} not sorted yet`} />
          <p className="mt-2 text-sm text-slate-400">Claude looks at three frames from each clip and files it in a folder (Talking head, Desk, Studio, Close-ups and so on), with tags and a one-line description. What it cost is shown when it finishes.</p>
          {!job && (
            <div className="mt-4">
              <Button variant="primary" onClick={() => void sort()} loading={busy}>
                <Sparkles className="h-4 w-4" aria-hidden /> Sort with Claude
              </Button>
            </div>
          )}
        </div>
      </div>
      <FolderBoxes active={!!job} />
      {job && (
        <div className="mt-4" aria-live="polite">
          <div className="mb-1 text-xs text-slate-400">
            Sorting: {job.done} of {job.total} · spent {usd(job.costUsd)}
          </div>
          <ProgressBar value={job.total ? (job.done / job.total) * 100 : 0} label="Sorting clips" />
        </div>
      )}
    </Card>
  );
}
function ClipTile({ clip, onOpen }: { clip: Clip; onOpen: () => void }) {
  return (
    <button onClick={onOpen} className="group block w-full overflow-hidden rounded-xl border border-slate-800 bg-slate-950/60 text-left transition hover:border-slate-600">
      <div className="relative aspect-video bg-slate-900">
        {clip.thumb ? <img src={clip.thumb} alt="" className="h-full w-full object-cover" loading="lazy" /> : <div className="grid h-full place-items-center text-xs text-slate-600">No preview</div>}
        <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] tabular-nums text-white">{mmss(clip.durationSec)}</span>
        <span className="absolute left-1 top-1">{clip.duplicateOf ? <Badge tone="amber">Duplicate</Badge> : clip.sorted ? <Badge tone="cyan">{clip.folder}</Badge> : <Badge>Not sorted</Badge>}</span>
      </div>
      <div className="p-2">
        <div className="truncate text-xs font-medium text-slate-200" title={clip.name}>{clip.name}</div>
        <div className="mt-0.5 line-clamp-2 min-h-8 text-[11px] leading-4 text-slate-500">{clip.description || `${dayText(clip.shotDate)}`}</div>
      </div>
    </button>
  );
}

function DaysList({ days, error, onClips, onReels }: { days: Day[] | null; error: string | null; onClips: (d: string) => void; onReels: (d: string) => void }) {
  if (error) return <div className="mt-4"><ErrorState message={error} /></div>;
  if (!days) return <div className="mt-4 space-y-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-24" />)}</div>;
  return (
    <section className="mt-4 space-y-3" aria-label="Days filmed">
      <p className="text-sm text-slate-400">Clips grouped by the day they were filmed. A day with a few clips makes a vlog-style reel.</p>
      {days.map((d) => (
        <Card key={d.day} className="flex flex-wrap items-center gap-4 p-3">
          <div className="flex w-44 shrink-0 gap-1">
            {d.thumbs.map((t, i) => (t ? <img key={i} src={t} alt="" className="h-12 w-[2.6rem] flex-1 rounded object-cover" /> : <div key={i} className="h-12 flex-1 rounded bg-slate-900" />))}
          </div>
          <div className="min-w-48 flex-1">
            <div className="font-medium">{dayText(d.day)}</div>
            <div className="mt-0.5 text-xs text-slate-500">
              {d.clips} clip{d.clips === 1 ? '' : 's'} Â· {mmss(d.seconds)} of footage Â· {timeText(d.first)}{d.clips > 1 ? ` to ${timeText(d.last)}` : ''}
            </div>
            <div className="mt-1.5 flex flex-wrap gap-1">{d.folders.map((f) => <Badge key={f} tone="slate">{f}</Badge>)}</div>
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => onClips(d.day)}>View clips</Button>
            <Button size="sm" onClick={() => onReels(d.day)} disabled={d.clips < 3} title={d.clips < 3 ? 'Needs at least 3 clips' : undefined}>
              <Layers className="h-3.5 w-3.5" aria-hidden /> Reel ideas
            </Button>
          </div>
        </Card>
      ))}
      {days.length === 0 && <EmptyState title="No days yet" hint="Add some footage first." />}
    </section>
  );
}

function Reels({ reels, days, canWrite, planDay, setPlanDay, unsorted, sorted, reload, onOpenClip }: { reels: Reel[] | null; days: Day[]; canWrite: boolean; planDay: string; setPlanDay: (d: string) => void; unsorted: number; sorted: number; reload: () => void; onOpenClip: (c: Clip) => void }) {
  const toast = useToast();
  const [count, setCount] = useState(5);
  const [sending, setSending] = useState<Reel | null>(null);
  const [quote, setQuote] = useState<ReelQuote | null>(null);
  const [busy, setBusy] = useState(false);

  async function ask() {
    setBusy(true);
    try {
      setQuote(await api.post<ReelQuote>('/vault/reels/suggest', { approved: false, count, ...(planDay ? { day: planDay } : {}) }));
    } catch (e) {
      toast.error(errorMessage(e));
    }
    setBusy(false);
  }
  async function approve() {
    setBusy(true);
    try {
      const r = await api.post<{ costUsd: number; reels: Reel[] }>('/vault/reels/suggest', { approved: true, count, ...(planDay ? { day: planDay } : {}) });
      setQuote(null);
      toast.success(`${r.reels.length} reel idea${r.reels.length === 1 ? '' : 's'} added for ${usd(r.costUsd)}.`);
      reload();
    } catch (e) {
      toast.error(errorMessage(e));
    }
    setBusy(false);
  }
  async function status(r: Reel, s: Reel['status']) {
    try {
      await api.patch(`/vault/reels/${r.id}`, { status: s });
      reload();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }
  async function remove(r: Reel) {
    try {
      await api.del(`/vault/reels/${r.id}`);
      reload();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  return (
    <section className="mt-4 space-y-4" aria-label="Reel ideas">
      {canWrite && (
        <Card className="p-4">
          <CardHeader eyebrow="Costs a little" title="Plan reels from your footage" />
          <p className="mt-2 text-sm text-slate-400">Claude reads what each sorted clip shows and when it was filmed. Vlog reels use clips from one day in the order they happened; topic reels pull clips from any day around one idea. Every beat names a real clip.</p>
          {sorted < 3 ? (
            <p className="mt-3 text-sm text-amber-200">Sort at least 3 clips first{unsorted ? ` (${unsorted} are waiting above)` : ''}.</p>
          ) : (
            <div className="mt-3 flex flex-wrap items-end gap-3">
              <Field label="From">
                <Select value={planDay} onChange={(e) => (setPlanDay(e.target.value), setQuote(null))}>
                  <option value="">All my footage</option>
                  {days.filter((d) => d.clips >= 3).map((d) => <option key={d.day} value={d.day}>{dayText(d.day)} ({d.clips} clips)</option>)}
                </Select>
              </Field>
              <Field label="How many">
                <Select value={count} onChange={(e) => (setCount(Number(e.target.value)), setQuote(null))}>
                  {[1, 3, 5, 8].map((n) => <option key={n} value={n}>{n}</option>)}
                </Select>
              </Field>
              <Button onClick={() => void ask()} loading={busy && !quote}>See the price</Button>
            </div>
          )}
          {quote && (
            <div className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-sm" role="status">
              <p>
                Planning up to {count} reel{count === 1 ? '' : 's'} from {quote.clips} clip{quote.clips === 1 ? '' : 's'} across {quote.days} day{quote.days === 1 ? '' : 's'} with Claude Sonnet 5.5 will cost about <strong>{usd(quote.estimateUsd)}</strong>, and never more than <strong>{usd(quote.maxUsd)}</strong>.
              </p>
              {quote.keyMissing && <p className="mt-2 text-amber-200">Add your Anthropic key in Settings first. Nothing has been spent.</p>}
              <div className="mt-3 flex gap-2">
                <Button variant="primary" onClick={() => void approve()} loading={busy} disabled={quote.keyMissing}>
                  <Sparkles className="h-4 w-4" aria-hidden /> Approve and plan
                </Button>
                <Button variant="ghost" onClick={() => setQuote(null)}>Cancel</Button>
              </div>
            </div>
          )}
        </Card>
      )}
      <SendToEdit reel={sending} onClose={() => setSending(null)} />
      {!reels ? (
        <Skeleton className="h-40" />
      ) : reels.length === 0 ? (
        <EmptyState title="No reel ideas yet" hint="Sort some footage, then plan reels from it." />
      ) : (
        reels.map((r) => (
          <Card key={r.id} className="p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={r.style === 'vlog' ? 'violet' : 'cyan'}>{r.style === 'vlog' ? `Vlog${r.day ? ` Â· ${dayText(r.day)}` : ''}` : 'Topic'}</Badge>
                  {r.status !== 'idea' && <Badge tone={r.status === 'used' ? 'emerald' : 'amber'}>{r.status === 'used' ? 'Used' : 'Saved'}</Badge>}
                </div>
                <h3 className="mt-1.5 text-lg font-semibold">{r.title}</h3>
                {r.hook && <p className="mt-1 text-sm text-slate-300">Hook: â€œ{r.hook}â€</p>}
              </div>
              {canWrite && (
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => setSending(r)}><Film className="h-3.5 w-3.5" aria-hidden /> Use as B-roll in an edit</Button>
                  {r.status !== 'saved' && <Button size="sm" onClick={() => void status(r, 'saved')}>Save</Button>}
                  {r.status !== 'used' && <Button size="sm" onClick={() => void status(r, 'used')}>Mark used</Button>}
                  <Button size="sm" variant="ghost" onClick={() => void remove(r)} aria-label={`Delete ${r.title}`}><Trash2 className="h-3.5 w-3.5" aria-hidden /></Button>
                </div>
              )}
            </div>
            <ol className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
              {r.beats.map((b, i) => (
                <li key={i} className="flex gap-2 rounded-xl border border-slate-800 bg-slate-950/60 p-2">
                  {b.clip ? (
                    <button onClick={() => onOpenClip(b.clip!)} className="shrink-0" aria-label={`Open ${b.clip.name}`}>
                      {b.clip.thumb ? <img src={b.clip.thumb} alt="" className="h-14 w-24 rounded object-cover" /> : <div className="h-14 w-24 rounded bg-slate-900" />}
                    </button>
                  ) : (
                    <div className="grid h-14 w-24 shrink-0 place-items-center rounded bg-slate-900 text-[10px] text-slate-600">Clip removed</div>
                  )}
                  <div className="min-w-0 text-xs">
                    <div className="text-slate-500">{i + 1} Â· {b.seconds}s{b.clip ? ` Â· ${b.clip.folder}` : ''}</div>
                    <div className="mt-0.5 text-slate-200">{b.line || 'â€”'}</div>
                    {b.clip && <div className="mt-0.5 truncate text-slate-500" title={b.clip.name}>{b.clip.name}</div>}
                  </div>
                </li>
              ))}
            </ol>
            {r.caption && (
              <details className="mt-3 text-sm">
                <summary className="cursor-pointer text-slate-400 hover:text-slate-200">Caption</summary>
                <p className="mt-2 whitespace-pre-wrap text-slate-300">{r.caption}</p>
                <Button size="sm" className="mt-2" onClick={() => void navigator.clipboard?.writeText(r.caption).then(() => toast.success('Caption copied.'))}>
                  <Copy className="h-3.5 w-3.5" aria-hidden /> Copy
                </Button>
              </details>
            )}
            {r.why && <p className="mt-2 text-xs text-slate-500">Why it should work: {r.why}</p>}
          </Card>
        ))
      )}
    </section>
  );
}

/** Lays a reel's clips over one of the videos on the Editing page, then opens that edit. */
function SendToEdit({ reel, onClose }: { reel: Reel | null; onClose: () => void }) {
  const toast = useToast();
  const navigate = useNavigate();
  const videos = useApi<{ id: string; name: string; title?: string; durationSec: number | null; beats: { total: number } }[]>(reel ? '/edit/videos' : null);
  const [busy, setBusy] = useState('');
  async function send(videoId: string) {
    if (!reel) return;
    setBusy(videoId);
    try {
      const r = await api.post<{ placed: number }>(`/vault/reels/${reel.id}/to-edit`, { videoId });
      toast.success(`${r.placed} clip${r.placed === 1 ? '' : 's'} placed as B-roll. Check them, then render.`);
      onClose();
      navigate(`/edit?video=${videoId}`);
    } catch (e) {
      toast.error(errorMessage(e));
    }
    setBusy('');
  }
  return (
    <Modal open={!!reel} onClose={onClose} title="Use this reel's clips as B-roll">
      <p className="text-sm text-slate-400">Pick the video they go over. The clips are spread across its beats (or evenly along it if it has none), replacing any B-roll already on it. You can move or remove each one on the Editing page.</p>
      {videos.error ? (
        <p className="mt-3 text-sm text-rose-300">{videos.error}</p>
      ) : !videos.data ? (
        <Skeleton className="mt-3 h-24" />
      ) : videos.data.filter((v) => v.durationSec).length === 0 ? (
        <p className="mt-3 text-sm text-slate-500">There is no video on the Editing page yet. Upload the one you recorded there first.</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {videos.data.filter((v) => v.durationSec).map((v) => (
            <li key={v.id} className="flex items-center justify-between gap-3 rounded-xl border border-slate-800 p-2.5">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{v.title || v.name}</div>
                <div className="text-xs text-slate-500">{Math.round(v.durationSec ?? 0)}s · {v.beats.total} beat{v.beats.total === 1 ? '' : 's'}</div>
              </div>
              <Button size="sm" variant="primary" loading={busy === v.id} disabled={!!busy} onClick={() => void send(v.id)}>Use this video</Button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

function ClipModal({ clip, names, canWrite, onClose, onChanged, toast }: { clip: Clip | null; names: string[]; canWrite: boolean; onClose: () => void; onChanged: () => void; toast: ReturnType<typeof useToast> }) {
  const [src, setSrc] = useState('');
  const [folder, setFolder] = useState('');
  const [tags, setTags] = useState('');
  const [desc, setDesc] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    setSrc('');
    setConfirm(false);
    if (!clip) return;
    setFolder(clip.folder);
    setTags(clip.tags.join(', '));
    setDesc(clip.description);
    // The player gets a link that expires, so ask for a fresh one each time a clip is opened
    api.get<{ url: string }>(`/vault/clips/${clip.id}/stream-url`).then((r) => setSrc(r.url)).catch((e) => toast.error(errorMessage(e)));
  }, [clip, toast]);

  async function save() {
    if (!clip) return;
    setBusy(true);
    try {
      await api.patch(`/vault/clips/${clip.id}`, { ...(folder ? { folder } : {}), tags: tags.split(',').map((t) => t.trim()).filter(Boolean), description: desc });
      toast.success('Saved.');
      onChanged();
    } catch (e) {
      toast.error(errorMessage(e));
    }
    setBusy(false);
  }
  async function remove() {
    if (!clip) return;
    setBusy(true);
    try {
      await api.del(`/vault/clips/${clip.id}`);
      toast.success('Removed from the Vault.');
      onChanged();
    } catch (e) {
      toast.error(errorMessage(e));
    }
    setBusy(false);
  }

  return (
    <Modal open={!!clip} onClose={onClose} title={clip?.name ?? 'Clip'} wide>
      {clip && (
        <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div>
            {src ? <video key={src} src={src} controls className="max-h-[60vh] w-full rounded-xl bg-black" /> : <Skeleton className="aspect-video" />}
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
              <span>{dayText(clip.shotDate)}, {timeText(clip.shotAt)}</span>
              <span>{mmss(clip.durationSec)}</span>
              {clip.width && clip.height && <span>{clip.width}Ã—{clip.height}{clip.height > clip.width ? ' (vertical)' : ''}</span>}
              <span>{mb(clip.sizeBytes)}</span>
              <span className="inline-flex items-center gap-1">{clip.hasSound ? <Volume2 className="h-3 w-3" aria-hidden /> : <VolumeX className="h-3 w-3" aria-hidden />}{clip.hasSound ? 'Has sound' : 'Almost silent'}</span>
            </div>
            {clip.duplicateOf && <p className="mt-2 text-xs text-amber-300">This is a copy of a clip that is already in the Vault, so it is not counted.</p>}
          </div>
          <div className="space-y-3">
            <Field label="Folder">
              <Select value={folder} onChange={(e) => setFolder(e.target.value)} disabled={!canWrite}>
                {!clip.folder && <option value="">Not sorted</option>}
                {names.map((n) => <option key={n} value={n}>{n}</option>)}
              </Select>
            </Field>
            <Field label="Tags" hint="Separate with commas.">
              <Input value={tags} onChange={(e) => setTags(e.target.value)} disabled={!canWrite} />
            </Field>
            <Field label="What happens">
              <Input value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={200} disabled={!canWrite} />
            </Field>
            {canWrite && (
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <Button variant="primary" onClick={() => void save()} loading={busy}>Save</Button>
                {confirm ? (
                  <>
                    <Button variant="danger" onClick={() => void remove()} loading={busy}>Yes, remove it</Button>
                    <Button variant="ghost" onClick={() => setConfirm(false)}>Keep</Button>
                  </>
                ) : (
                  <Button variant="ghost" onClick={() => setConfirm(true)}><Trash2 className="h-4 w-4" aria-hidden /> Remove from Vault</Button>
                )}
              </div>
            )}
            {confirm && <p className="text-xs text-slate-500">{clip.source === 'folder' ? 'This only removes it from the Vault. The file stays in your folder, and reading the folder again will add it back.' : 'This clip was uploaded, so its file is deleted too.'}</p>}
          </div>
        </div>
      )}
    </Modal>
  );
}
