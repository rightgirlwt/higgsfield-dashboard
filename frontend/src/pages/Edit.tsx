import { ArrowLeft, Check, Film, Play, Plus, Send, Sparkles, Trash2, Upload } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useCan } from '../auth/context';
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, Field, Input, PageHeader, Select, Skeleton, Textarea } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { timeAgo, usd } from '../lib/format';
import { useApi, useDocumentTitle } from '../lib/hooks';
import { useToast } from '../state/Toast';

interface Effect {
  name: string;
  description: string;
}
interface EffectList {
  engine: { ready: boolean; message: string };
  effects: Effect[];
}
interface ApiStep {
  fx: string;
  start: number;
  end: number;
  text?: string;
  options: Record<string, string | number>;
}
interface BeatCounts {
  total: number;
  draft: number;
  in_review: number;
  changes_needed: number;
  approved: number;
}
interface Video {
  id: string;
  name: string;
  title?: string;
  addedBy?: string;
  createdAt: string;
  beats: BeatCounts;
  durationSec: number | null;
  plan?: { steps: ApiStep[]; label: { enabled: boolean; text: string }; captions?: { enabled: boolean; wordsPerLine: number; style?: CapStyle } };
}
interface Step {
  key: number;
  fx: string;
  start: number;
  end: number;
  text: string;
  color: string;
}
interface Job {
  id: string;
  status: 'running' | 'done' | 'failed';
  message: string;
  fileName?: string;
  mediaId?: string;
}
interface WorkspaceList {
  workspaces: { id: string; name: string }[];
  current: string;
}
type BeatStatus = 'draft' | 'in_review' | 'changes_needed' | 'approved';
interface Adjustment {
  id: string;
  text: string;
  done: boolean;
}
interface Beat {
  id: string;
  title: string;
  startSec: number;
  endSec: number;
  youSay: string;
  onScreen: string;
  visual: string;
  animation: string;
  status: BeatStatus;
  changeRequest: string;
  adjustments: Adjustment[];
  updatedAt: string;
}

interface CapStyle {
  textColor: string;
  highlightColor: string;
  outlineColor: string;
  italic: 'off' | 'all' | 'spoken';
  emphasize: boolean;
  size: 'small' | 'medium' | 'large';
  position: 'top' | 'middle' | 'bottom';
  caps: boolean;
  font: string;
  bold: boolean;
}
/** Each workspace starts from its own brand look; the team can change any of it per video. */
const BASE_CAPTIONS: CapStyle = { textColor: '#ffffff', highlightColor: '#ebac65', outlineColor: '#99577a', italic: 'off', emphasize: false, size: 'medium', position: 'bottom', caps: true, font: 'Archivo Black', bold: false };
// cream, gold, mauve, in the Right Girl Media brand font (Trirong only comes in a light weight here, so it is made bolder)
const RGM_CAPTIONS: CapStyle = { ...BASE_CAPTIONS, textColor: '#fdf8f3', highlightColor: '#ebac65', outlineColor: '#99577a', font: 'Trirong Medium', bold: true };
const GLG_CAPTIONS: CapStyle = { ...BASE_CAPTIONS, textColor: '#ffffff', highlightColor: '#c8102e', outlineColor: '#0b1f4b' }; // white, red, navy

const DEFAULT_LABEL ='DRAMATIZATION | AI-GENERATED VIDEO';
const VIDEO_ACCEPT = 'video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm';
const num = (v: string, fallback = 0) => (Number.isFinite(Number(v)) && v !== '' ? Number(v) : fallback);
const round1 = (n: number) => Math.round(n * 10) / 10;
const clock = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;

const STATUS: Record<BeatStatus, { label: string; tone: 'slate' | 'cyan' | 'amber' | 'emerald' }> = {
  draft: { label: 'DRAFT', tone: 'slate' },
  in_review: { label: 'IN REVIEW', tone: 'cyan' },
  changes_needed: { label: 'CHANGES NEEDED', tone: 'amber' },
  approved: { label: 'APPROVED', tone: 'emerald' },
};

/** What the engine reads: text and colour are sent as options only when filled in. */
const toApiStep = (s: Step): ApiStep => ({ fx: s.fx, start: s.start, end: s.end, ...(s.text.trim() ? { text: s.text.trim() } : {}), options: s.color.trim() ? { color: s.color.trim() } : {} });

export default function Edit() {
  useDocumentTitle('Editing');
  const toast = useToast();
  const canWrite = useCan('user');
  const isReviewer = useCan('admin');
  const effects = useApi<EffectList>('/edit/effects');
  const videos = useApi<Video[]>('/edit/videos');
  const workspaces = useApi<WorkspaceList>('/workspaces');
  const fonts = useApi<{ family: string; source: 'team' | 'skill' }[]>('/edit/fonts');
  const [videoId, setVideoId] = useState('');
  const [search, setSearch] = useState('');
  const [steps, setSteps] = useState<Step[]>([]);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [labelOn, setLabelOn] = useState(false);
  const [labelText, setLabelText] = useState(DEFAULT_LABEL);
  const [capsOn, setCapsOn] = useState(false);
  const [perLine, setPerLine] = useState(3);
  const [capStyle, setCapStyle] = useState<CapStyle>(RGM_CAPTIONS);
  const [job, setJob] = useState<Job | null>(null);
  const [beatId, setBeatId] = useState('');
  const nextKey = useRef(1);
  const fileInput = useRef<HTMLInputElement>(null);
  const loadedFor = useRef('');
  const savedPlan = useRef('');

  const video = videos.data?.find((v) => v.id === videoId) ?? null;
  const duration = video?.durationSec ?? 60;
  const beats = useApi<Beat[]>(videoId ? `/edit/videos/${videoId}/beats` : null);
  const beatList = beats.data ?? [];
  const beat = beatList.find((b) => b.id === beatId) ?? beatList[0] ?? null;
  const workspaceName = workspaces.data?.workspaces.find((w) => w.id === workspaces.data?.current)?.name ?? '';
  const isLegal = /greene legal/i.test(workspaceName);
  const workspaceCaptions = isLegal ? GLG_CAPTIONS : RGM_CAPTIONS;
  const captionsBody = { enabled: capsOn, wordsPerLine: perLine, style: capStyle };

  useEffect(() => () => void (previewUrl && URL.revokeObjectURL(previewUrl)), [previewUrl]);

  // Load the saved edit when a video is chosen, so Elle and Ruth see the same effects and label.
  useEffect(() => {
    if (!video || loadedFor.current === video.id) return;
    loadedFor.current = video.id;
    const p = video.plan;
    setSteps((p?.steps ?? []).map((s) => ({ key: nextKey.current++, fx: s.fx, start: s.start, end: s.end, text: s.text ?? '', color: String(s.options?.color ?? '') })));
    setLabelOn(p?.label.enabled ?? false);
    setLabelText(p?.label.text ?? DEFAULT_LABEL);
    setCapsOn(p?.captions?.enabled ?? false);
    setPerLine(p?.captions?.wordsPerLine ?? 3);
    const style = p?.captions?.style ?? workspaceCaptions;
    setCapStyle(style);
    savedPlan.current = JSON.stringify({
      steps: p?.steps ?? [], label: p?.label ?? { enabled: false, text: DEFAULT_LABEL }, captions: { enabled: p?.captions?.enabled ?? false, wordsPerLine: p?.captions?.wordsPerLine ?? 3, style },
    });
    setPreviewUrl(null);
    setBeatId('');
  }, [video]);

  // ...and save it again a moment after it changes.
  useEffect(() => {
    if (!videoId || loadedFor.current !== videoId || !canWrite) return;
    const body = { steps: steps.map(toApiStep), label: { enabled: labelOn, text: labelText }, captions: captionsBody };
    const json = JSON.stringify(body);
    if (json === savedPlan.current) return;
    const t = setTimeout(() => {
      api.put(`/edit/videos/${videoId}/plan`, body).then(() => void (savedPlan.current = json)).catch((e) => toast.error(errorMessage(e)));
    }, 800);
    return () => clearTimeout(t);
  }, [steps, labelOn, labelText, capsOn, perLine, capStyle, videoId, canWrite, toast]);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    const all = [...(effects.data?.effects ?? [])].sort((a, b) => a.name.localeCompare(b.name));
    return q ? all.filter((e) => e.name.includes(q) || e.description.toLowerCase().includes(q)) : all;
  }, [effects.data, search]);

  async function upload(file: File) {
    setUploading(true);
    try {
      const v = await api.upload<Video>(`/edit/videos?filename=${encodeURIComponent(file.name)}`, file);
      videos.reload();
      setVideoId(v.id);
      toast.success('Video added.');
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  /** An effect goes on the beat being reviewed; with no beats yet it starts at the preview time and lasts 3 seconds. */
  const addStep = (fx: string) => {
    const start = beat ? beat.startSec : Math.min(1, Math.max(0, duration - 0.5));
    const end = beat ? beat.endSec : Math.min(round1(start + 3), duration);
    setSteps((p) => [...p, { key: nextKey.current++, fx, start, end, text: '', color: '' }]);
  };
  const patch = (key: number, p: Partial<Step>) => setSteps((all) => all.map((s) => (s.key === key ? { ...s, ...p } : s)));

  async function preview(at: number) {
    setPreviewing(true);
    try {
      const blob = await api.postBlob('/edit/preview', { videoId, steps: steps.map(toApiStep), time: at, label: { enabled: labelOn, text: labelText }, captions: captionsBody });
      setPreviewUrl(URL.createObjectURL(blob));
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setPreviewing(false);
    }
  }

  async function render() {
    try {
      setJob(await api.post<Job>('/edit/render', { videoId, steps: steps.map(toApiStep), label: { enabled: labelOn, text: labelText }, captions: captionsBody }));
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  // Follow a running render until it finishes.
  const jobId = job?.status === 'running' ? job.id : null;
  useEffect(() => {
    if (!jobId) return;
    const timer = setInterval(() => {
      api.get<Job>(`/edit/jobs/${jobId}`).then(setJob).catch((e) => setJob({ id: jobId, status: 'failed', message: errorMessage(e) }));
    }, 2500);
    return () => clearInterval(timer);
  }, [jobId]);

  // ---- beats ----
  async function act<T>(fn: () => Promise<T>, ok?: string): Promise<T | null> {
    try {
      const r = await fn();
      beats.reload();
      if (ok) toast.success(ok);
      return r;
    } catch (e) {
      toast.error(errorMessage(e));
      return null;
    }
  }
  const addBeat = (b: { title: string; startSec: number; endSec: number }) =>
    act(() => api.post<Beat>(`/edit/videos/${videoId}/beats`, b)).then((r) => r && setBeatId(r.id));

  const ready = effects.data?.engine.ready;
  const canRun = canWrite && !!videoId && (steps.length > 0 || labelOn || capsOn) && steps.every((s) => s.end > s.start);

  return (
    <div>
      <PageHeader eyebrow="Effects and label" title="Editing" />
      <p className="mb-5 max-w-3xl text-sm text-slate-400">
        Split a video into beats, add effects and the dramatization label, then review it beat by beat. Previews and renders happen on this computer and cost nothing. Effects work best on videos where one person faces the camera: they follow the face, and long text can be cut at the edge on other footage.
      </p>

      {effects.error ? (
        <ErrorState message={effects.error} onRetry={effects.reload} />
      ) : !effects.data ? (
        <Skeleton className="h-64" />
      ) : !ready ? (
        <EmptyState title="The effects engine is not set up" hint={effects.data.engine.message} />
      ) : (
        <div className="space-y-6">
          <input ref={fileInput} type="file" accept={VIDEO_ACCEPT} hidden onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
          {!videoId ? (
            <EditList videos={videos.data} loading={!videos.data && !videos.error} canWrite={canWrite} uploading={uploading} workspaceName={workspaceName} onOpen={setVideoId} onAdd={() => fileInput.current?.click()} isReviewer={isReviewer} />
          ) : (
            <Card className="p-4">
              <div className="flex flex-wrap items-center gap-3">
                <Button onClick={() => { setVideoId(''); videos.reload(); }}>
                  <ArrowLeft className="h-4 w-4" aria-hidden /> All edits
                </Button>
                <Input
                  aria-label="Edit name"
                  className="min-w-0 flex-1 font-semibold"
                  key={video?.id}
                  defaultValue={video?.title || video?.name || ''}
                  disabled={!canWrite}
                  onBlur={(e) => {
                    const t = e.target.value.trim();
                    if (video && t && t !== (video.title || video.name)) api.patch(`/edit/videos/${video.id}`, { title: t }).then(videos.reload).catch((er) => toast.error(errorMessage(er)));
                  }}
                />
                <span className="text-xs text-slate-500">{video?.addedBy ? `Added by ${video.addedBy}` : ''}{video?.durationSec ? ` · ${video.durationSec}s` : ''}</span>
              </div>
            </Card>
          )}

          {videoId && (
          <>
          <BeatStrip beats={beatList} duration={duration} selectedId={beat?.id ?? ''} onSelect={setBeatId} onAdd={addBeat} canWrite={canWrite} videoId={videoId} onSuggested={beats.reload} />

          <Timeline videoId={videoId} duration={duration} beats={beatList} steps={steps} capsOn={capsOn} selectedId={beat?.id ?? ''} onSelect={setBeatId} />

          <div className="grid gap-6 xl:grid-cols-[1fr_1.15fr]">
            <div className="space-y-6">
              <Card className="p-5">
                <CardHeader eyebrow="Effects library" title="Pick effects" />
                <Input aria-label="Search effects" placeholder="Search, for example spotlight or headline" value={search} onChange={(e) => setSearch(e.target.value)} />
                {beat && <p className="mt-2 text-xs text-slate-500">New effects go on the selected beat: {beat.title || 'untitled'} ({clock(beat.startSec)} to {clock(beat.endSec)}).</p>}
                <ul className="mt-4 grid max-h-[26rem] gap-2 overflow-auto sm:grid-cols-2">
                  {shown.map((e) => (
                    <li key={e.name} className="flex items-start justify-between gap-2 rounded-xl border border-slate-800 p-3">
                      <div className="min-w-0">
                        <div className="text-sm font-semibold">{e.name}</div>
                        <p className="text-xs text-slate-400">{e.description}</p>
                      </div>
                      <Button size="sm" variant="ghost" aria-label={`Add ${e.name}`} disabled={!videoId || !canWrite} onClick={() => addStep(e.name)}>
                        <Plus className="h-4 w-4" aria-hidden />
                      </Button>
                    </li>
                  ))}
                  {shown.length === 0 && <li className="p-3 text-sm text-slate-400">No effect matches that.</li>}
                </ul>
              </Card>

              <Card className="p-5">
                <CardHeader eyebrow="Your effects" title="Applied to this video" />
                {steps.length === 0 ? (
                  <p className="text-sm text-slate-400">Add an effect from the library, or turn on the label below to add only the label.</p>
                ) : (
                  <ul className="space-y-3">
                    {steps.map((s) => (
                      <li key={s.key} className="rounded-xl border border-slate-800 p-3">
                        <div className="mb-2 flex items-center justify-between">
                          <Badge tone="cyan">{s.fx}</Badge>
                          <Button size="sm" variant="ghost" aria-label={`Remove ${s.fx}`} disabled={!canWrite} onClick={() => setSteps((p) => p.filter((x) => x.key !== s.key))}>
                            <Trash2 className="h-4 w-4 text-rose-300" aria-hidden />
                          </Button>
                        </div>
                        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                          <Field label="Start (s)" htmlFor={`s-${s.key}`}><Input id={`s-${s.key}`} type="number" min={0} step={0.1} value={s.start} onChange={(e) => patch(s.key, { start: num(e.target.value) })} /></Field>
                          <Field label="End (s)" htmlFor={`e-${s.key}`}><Input id={`e-${s.key}`} type="number" min={0} step={0.1} value={s.end} onChange={(e) => patch(s.key, { end: num(e.target.value) })} /></Field>
                          <Field label="Text" htmlFor={`t-${s.key}`}><Input id={`t-${s.key}`} value={s.text} placeholder="optional" onChange={(e) => patch(s.key, { text: e.target.value })} /></Field>
                          <Field label="Colour" htmlFor={`c-${s.key}`}><Input id={`c-${s.key}`} value={s.color} placeholder="#99577a" onChange={(e) => patch(s.key, { color: e.target.value })} /></Field>
                        </div>
                        {s.end <= s.start && <p className="mt-1 text-xs text-rose-300">The end must be after the start.</p>}
                      </li>
                    ))}
                  </ul>
                )}
              </Card>

              <Card className="p-5">
                <CardHeader eyebrow="Captions, label and render" title="Finish the draft" />
                <label className="mb-4 flex items-start gap-3 text-sm">
                  <input type="checkbox" className="mt-1" checked={capsOn} disabled={!canWrite} onChange={(e) => setCapsOn(e.target.checked)} />
                  <span>
                    Add captions
                    <span className="block text-xs text-slate-500">
                      The words appear as they are spoken, a few at a time, with the word being said in yellow. The first time, the video is transcribed on this computer (free, about a minute).
                    </span>
                  </span>
                </label>
                {capsOn && (
                  <div className="-mt-1 mb-4 space-y-3 rounded-xl border border-slate-800 p-3 text-xs text-slate-400">
                    <div className="grid grid-cols-3 gap-3">
                      {([['textColor', 'Text'], ['highlightColor', 'Spoken word'], ['outlineColor', 'Outline']] as const).map(([key, label]) => (
                        <label key={key} className="flex items-center gap-2">
                          <input type="color" aria-label={`${label} colour`} className="h-8 w-8 shrink-0 cursor-pointer rounded border border-slate-700 bg-transparent" value={capStyle[key]} disabled={!canWrite} onChange={(e) => setCapStyle({ ...capStyle, [key]: e.target.value })} />
                          {label}
                        </label>
                      ))}
                    </div>
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                      <Field label="Words at once" htmlFor="cap-n">
                        <Select id="cap-n" value={perLine} disabled={!canWrite} onChange={(e) => setPerLine(Number(e.target.value))}>
                          {[1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n}</option>)}
                        </Select>
                      </Field>
                      <Field label="Italic" htmlFor="cap-i">
                        <Select id="cap-i" value={capStyle.italic} disabled={!canWrite} onChange={(e) => setCapStyle({ ...capStyle, italic: e.target.value as CapStyle['italic'] })}>
                          <option value="off">Off</option>
                          <option value="spoken">Spoken word only</option>
                          <option value="all">Whole caption</option>
                        </Select>
                      </Field>
                      <Field label="Size" htmlFor="cap-s">
                        <Select id="cap-s" value={capStyle.size} disabled={!canWrite} onChange={(e) => setCapStyle({ ...capStyle, size: e.target.value as CapStyle['size'] })}>
                          <option value="small">Small</option>
                          <option value="medium">Medium</option>
                          <option value="large">Large</option>
                        </Select>
                      </Field>
                      <Field label="Position" htmlFor="cap-p">
                        <Select id="cap-p" value={capStyle.position} disabled={!canWrite} onChange={(e) => setCapStyle({ ...capStyle, position: e.target.value as CapStyle['position'] })}>
                          <option value="top">Top</option>
                          <option value="middle">Middle</option>
                          <option value="bottom">Bottom</option>
                        </Select>
                      </Field>
                    </div>
                    <Field label="Font" htmlFor="cap-f">
                      <Select id="cap-f" value={capStyle.font} disabled={!canWrite} onChange={(e) => setCapStyle({ ...capStyle, font: e.target.value })}>
                        {!fonts.data?.some((f) => f.family === capStyle.font) && <option value={capStyle.font}>{capStyle.font} (not installed, a default will be used)</option>}
                        {fonts.data?.map((f) => <option key={f.family} value={f.family}>{f.family}</option>)}
                      </Select>
                    </Field>
                    <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
                      <label className="flex items-center gap-2"><input type="checkbox" checked={capStyle.bold} disabled={!canWrite} onChange={(e) => setCapStyle({ ...capStyle, bold: e.target.checked })} /> Bold</label>
                      <label className="flex items-center gap-2"><input type="checkbox" checked={capStyle.emphasize} disabled={!canWrite} onChange={(e) => setCapStyle({ ...capStyle, emphasize: e.target.checked })} /> Make the spoken word bigger</label>
                      <label className="flex items-center gap-2"><input type="checkbox" checked={capStyle.caps} disabled={!canWrite} onChange={(e) => setCapStyle({ ...capStyle, caps: e.target.checked })} /> All capitals</label>
                      <Button disabled={!canWrite} onClick={() => setCapStyle(workspaceCaptions)}>Use the {isLegal ? 'Greene Legal Group' : 'Right Girl Media'} look</Button>
                    </div>
                  </div>
                )}
                <label className="flex items-start gap-3 text-sm">
                  <input type="checkbox" className="mt-1" checked={labelOn} disabled={!canWrite} onChange={(e) => setLabelOn(e.target.checked)} />
                  <span>
                    Add the dramatization label for the whole video
                    <span className="block text-xs text-slate-500">
                      Off unless you turn it on. It can be used on its own, with no effects. {isLegal ? 'This is Greene Legal Group: AI-generated or dramatized video needs a visible label before it is posted.' : 'For example DRAMATIZATION on AI-generated video.'}
                    </span>
                  </span>
                </label>
                {labelOn && (
                  <div className="mt-3">
                    <Field label="Label text" htmlFor="label"><Input id="label" maxLength={80} value={labelText} disabled={!canWrite} onChange={(e) => setLabelText(e.target.value)} /></Field>
                  </div>
                )}
                {isLegal && !labelOn && <p className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-2 text-xs text-amber-200">No label is on. If this video is AI-generated or a dramatization, turn the label on or add it yourself before posting.</p>}
                <Button className="mt-4" variant="primary" disabled={!canRun || job?.status === 'running'} onClick={() => void render()}>
                  <Play className="h-4 w-4" aria-hidden /> Render video
                </Button>
                {job && (
                  <div className="mt-4 text-sm" role="status">
                    {job.status === 'running' && <p className="text-slate-300">{job.message}</p>}
                    {job.status === 'failed' && <p className="text-rose-300">The render failed: {job.message}</p>}
                    {job.status === 'done' && job.fileName && (
                      <div className="space-y-2">
                        <p className="text-emerald-300">Done. It is saved in the <Link className="underline" to="/media">Media</Link> library. Watch it before you post.</p>
                        <video controls className="max-h-[32rem] rounded-xl border border-slate-800" src={`/api/edit/files/${job.fileName}`} />
                      </div>
                    )}
                  </div>
                )}
              </Card>
            </div>

            <ReviewPanel
              beat={beat}
              index={beat ? beatList.findIndex((b) => b.id === beat.id) : -1}
              total={beatList.length}
              beats={beatList}
              onSelect={setBeatId}
              steps={steps}
              labelOn={labelOn}
              capsOn={capsOn}
              previewUrl={previewUrl}
              previewing={previewing}
              onPreview={(at) => void preview(at)}
              canRun={canRun}
              canWrite={canWrite}
              isReviewer={isReviewer}
              act={act}
            />
          </div>
          </>
          )}
        </div>
      )}
    </div>
  );
}

// Which timeline row an effect belongs on: camera moves, then colour and transition looks, and everything else is a title or card.
const ZOOM_FX = new Set(['lean-in', 'slow-push', 'over-the-shoulder-zoom', 'locked-on']);
const LOOK_FX = new Set(['moody', 'spotlight', 'swipe', 'uninstall', 'rabbit-hole', 'dot-reveal', 'pause-point']);
const rowOf = (fx: string): 'zoom' | 'look' | 'cards' => (ZOOM_FX.has(fx) ? 'zoom' : LOOK_FX.has(fx) ? 'look' : 'cards');

interface Bar {
  key: string | number;
  start: number;
  end: number;
  label: string;
  className: string;
  onClick?: () => void;
}

/** Bars that overlap in time go on separate lines so none hides another. */
function lanes(bars: Bar[]): Bar[][] {
  const out: Bar[][] = [];
  for (const b of [...bars].sort((a, c) => a.start - c.start)) {
    const lane = out.find((l) => l[l.length - 1].end <= b.start);
    if (lane) lane.push(b);
    else out.push([b]);
  }
  return out;
}

/** The whole video on one time axis: the beats, the effects by kind, where the shots cut, and where the captions run. */
function Timeline({ videoId, duration, beats, steps, capsOn, selectedId, onSelect }: {
  videoId: string; duration: number; beats: Beat[]; steps: Step[]; capsOn: boolean; selectedId: string; onSelect: (id: string) => void;
}) {
  const cuts = useApi<number[]>(`/edit/videos/${videoId}/cuts`);
  const words = useApi<{ w: string; s: number; e: number }[]>(`/edit/videos/${videoId}/words`);
  const reloadWords = words.reload;
  useEffect(() => {
    if (capsOn) reloadWords();
  }, [capsOn, reloadWords]);

  const total = Math.max(duration, 1);
  const pct = (t: number) => `${Math.min(100, Math.max(0, (t / total) * 100))}%`;
  const span = (a: number, b: number) => ({ left: pct(a), width: `${Math.max(0.6, ((Math.min(b, total) - a) / total) * 100)}%` });
  const tick = total <= 20 ? 2 : total <= 60 ? 5 : total <= 180 ? 15 : 30;
  const ticks = Array.from({ length: Math.floor(total / tick) + 1 }, (_, i) => i * tick);

  const fxBars = (row: 'zoom' | 'look' | 'cards'): Bar[] =>
    steps.filter((s) => rowOf(s.fx) === row).map((s) => ({ key: s.key, start: s.start, end: s.end, label: s.text ? `${s.fx}: ${s.text}` : s.fx, className: 'bg-cyan-500/30 border-cyan-500/60' }));
  const beatBars: Bar[] = beats.map((b, i) => ({
    key: b.id, start: b.startSec, end: b.endSec, label: `${i + 1} ${b.title || 'Untitled'}`, onClick: () => onSelect(b.id),
    className: `${b.id === selectedId ? 'ring-1 ring-cyan-400 ' : ''}${b.status === 'approved' ? 'bg-emerald-500/30 border-emerald-500/60' : b.status === 'changes_needed' ? 'bg-amber-500/30 border-amber-500/60' : b.status === 'in_review' ? 'bg-cyan-500/30 border-cyan-500/60' : 'bg-slate-600/30 border-slate-500/60'}`,
  }));
  // Speech runs: words close together make one block, which is where captions appear
  const speech: Bar[] = [];
  for (const w of words.data ?? []) {
    const last = speech[speech.length - 1];
    if (last && w.s - last.end < 0.7) last.end = w.e;
    else speech.push({ key: `s${w.s}`, start: w.s, end: w.e, label: '', className: 'bg-fuchsia-500/30 border-fuchsia-500/60' });
  }

  const rows: { name: string; note?: string; bars: Bar[]; empty?: string }[] = [
    { name: 'Beats', bars: beatBars, empty: 'Add beats above' },
    { name: 'Titles & Cards', bars: fxBars('cards'), empty: 'None yet' },
    { name: 'Zoom', bars: fxBars('zoom'), empty: 'None yet' },
    ...(steps.some((s) => rowOf(s.fx) === 'look') ? [{ name: 'Looks', bars: fxBars('look') }] : []),
    {
      name: 'Captions',
      bars: capsOn ? speech.length ? speech : [{ key: 'all', start: 0, end: total, label: 'Follows the speech', className: 'bg-fuchsia-500/15 border-fuchsia-500/40' }] : [],
      empty: 'Off',
    },
  ];

  return (
    <Card className="p-5">
      <CardHeader eyebrow="Timeline" title="Everything on one line" />
      <div className="overflow-x-auto">
        <div className="min-w-[36rem]">
          <div className="grid grid-cols-[7.5rem_1fr] gap-x-3 text-xs">
            <div />
            <div className="relative mb-1 h-4 text-slate-500" aria-hidden>
              {ticks.map((t) => (
                <span key={t} className="absolute -translate-x-1/2" style={{ left: pct(t) }}>{t}s</span>
              ))}
            </div>
            {rows.map((r) => {
              const laned = lanes(r.bars);
              return (
                <div key={r.name} className="contents">
                  <div className="flex items-center py-1 text-slate-400">{r.name}</div>
                  <div className="relative my-0.5 rounded-lg bg-slate-900/40" style={{ height: `${Math.max(1, laned.length) * 1.5 + 0.25}rem` }}>
                    {r.bars.length === 0 && <span className="absolute inset-0 flex items-center pl-2 text-slate-600">{r.empty}</span>}
                    {laned.map((lane, li) =>
                      lane.map((b) => (
                        <button
                          key={b.key}
                          type="button"
                          title={`${b.label} (${clock(b.start)} to ${clock(b.end)})`}
                          onClick={b.onClick}
                          disabled={!b.onClick}
                          style={{ ...span(b.start, b.end), top: `${li * 1.5 + 0.125}rem`, height: '1.25rem' }}
                          className={`absolute overflow-hidden whitespace-nowrap rounded border px-1 text-left leading-5 ${b.className}`}
                        >
                          {b.label}
                        </button>
                      )),
                    )}
                  </div>
                </div>
              );
            })}
            <div className="flex items-center py-1 text-slate-400">Your cuts <span className="ml-1 text-slate-600">(detected)</span></div>
            <div className="relative my-0.5 h-7 rounded-lg bg-slate-900/40">
              {cuts.error ? (
                <span className="absolute inset-0 flex items-center pl-2 text-slate-600">Could not look for cuts</span>
              ) : !cuts.data ? (
                <span className="absolute inset-0 flex items-center pl-2 text-slate-600">Looking for cuts…</span>
              ) : cuts.data.length === 0 ? (
                <span className="absolute inset-0 flex items-center pl-2 text-slate-600">One continuous shot</span>
              ) : (
                cuts.data.map((t) => (
                  <span key={t} title={`Cut at ${clock(t)}`} className="absolute top-1 bottom-1 w-0.5 -translate-x-1/2 rounded bg-amber-400" style={{ left: pct(t) }} />
                ))
              )}
            </div>
          </div>
        </div>
      </div>
      <p className="mt-2 text-xs text-slate-500">Click a beat to review it. Cuts are where the picture changes to a different shot, found automatically.</p>
    </Card>
  );
}

/** The worst state across a video's beats is the one that needs attention first. */
function overall(c: BeatCounts): BeatStatus | 'none' {
  if (c.total === 0) return 'none';
  if (c.changes_needed) return 'changes_needed';
  if (c.in_review) return 'in_review';
  if (c.draft) return 'draft';
  return 'approved';
}

type ListFilter = 'all' | 'in_review' | 'changes_needed' | 'approved';

/** Every edit in this workspace as a card, so each one's storyboard can be opened and reviewed on its own. */
function EditList({ videos, loading, canWrite, uploading, workspaceName, onOpen, onAdd, isReviewer }: {
  videos: Video[] | null; loading: boolean; canWrite: boolean; uploading: boolean; workspaceName: string; onOpen: (id: string) => void; onAdd: () => void; isReviewer: boolean;
}) {
  const [filter, setFilter] = useState<ListFilter>('all');
  const list = (videos ?? []).filter((v) => filter === 'all' || overall(v.beats) === filter);
  const count = (f: ListFilter) => (videos ?? []).filter((v) => f === 'all' || overall(v.beats) === f).length;
  const tabs: { id: ListFilter; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'in_review', label: isReviewer ? 'Needs my review' : 'In review' },
    { id: 'changes_needed', label: 'Changes requested' },
    { id: 'approved', label: 'Approved' },
  ];
  return (
    <Card className="p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <CardHeader eyebrow="Edits" title={workspaceName ? `Videos in ${workspaceName}` : 'Videos'} />
        <Button variant="primary" loading={uploading} disabled={!canWrite} onClick={onAdd}>
          <Upload className="h-4 w-4" aria-hidden /> Add a video
        </Button>
      </div>
      <div className="mb-4 flex flex-wrap gap-2" role="tablist" aria-label="Filter edits">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={filter === t.id}
            onClick={() => setFilter(t.id)}
            className={`rounded-full border px-3 py-1 text-xs transition ${filter === t.id ? 'border-cyan-500 bg-cyan-500/10 font-semibold' : 'border-slate-800 hover:border-slate-700'}`}
          >
            {t.label} ({count(t.id)})
          </button>
        ))}
      </div>
      {loading ? (
        <Skeleton className="h-40" />
      ) : list.length === 0 ? (
        <EmptyState title={videos?.length ? 'Nothing here' : 'No videos yet'} hint={videos?.length ? 'No edit is in this state right now.' : 'Add a video to start its storyboard. MP4, MOV or WebM, up to 500 MB.'} />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {list.map((v) => {
            const st = overall(v.beats);
            return (
              <li key={v.id}>
                <button onClick={() => onOpen(v.id)} className="w-full rounded-xl border border-slate-800 p-4 text-left transition hover:border-cyan-500/60">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate font-semibold">{v.title || v.name}</div>
                      <div className="mt-0.5 text-xs text-slate-500">
                        {v.addedBy ? `${v.addedBy} · ` : ''}{timeAgo(v.createdAt)}{v.durationSec ? ` · ${v.durationSec}s` : ''}
                      </div>
                    </div>
                    {st === 'none' ? <Badge tone="slate">NO BEATS</Badge> : <Badge tone={STATUS[st].tone}>{STATUS[st].label}</Badge>}
                  </div>
                  <div className="mt-3 flex gap-0.5" aria-hidden>
                    {v.beats.total === 0 ? <span className="h-1.5 w-full rounded bg-slate-800" /> : null}
                    {(['approved', 'in_review', 'changes_needed', 'draft'] as const).map((s) =>
                      v.beats[s] ? <span key={s} style={{ flexGrow: v.beats[s] }} className={`h-1.5 rounded ${s === 'approved' ? 'bg-emerald-400' : s === 'changes_needed' ? 'bg-amber-400' : s === 'in_review' ? 'bg-cyan-400' : 'bg-slate-600'}`} /> : null,
                    )}
                  </div>
                  <div className="mt-1 text-xs text-slate-400">{v.beats.total ? `${v.beats.approved} of ${v.beats.total} beats approved` : 'Open to add beats'}</div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

/** The video as numbered beats, each as wide as it lasts. */
function BeatStrip({ beats, duration, selectedId, onSelect, onAdd, canWrite, videoId, onSuggested }: {
  beats: Beat[]; duration: number; selectedId: string; onSelect: (id: string) => void; onAdd: (b: { title: string; startSec: number; endSec: number }) => void; canWrite: boolean;
  videoId: string; onSuggested: () => void;
}) {
  const toast = useToast();
  const [quote, setQuote] = useState<{ estimateUsd: number; maxUsd: number } | null>(null);
  const [busy, setBusy] = useState<'quote' | 'run' | null>(null);

  // Step 1 is free (transcribing runs on this computer); step 2 only happens after Elle sees the price and confirms.
  async function getQuote() {
    setBusy('quote');
    try {
      setQuote(await api.post<{ estimateUsd: number; maxUsd: number }>(`/edit/videos/${videoId}/suggest-beats`, { approved: false }));
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }
  async function runSuggest() {
    setBusy('run');
    try {
      const r = await api.post<{ costUsd: number; beats: { title: string; startSec: number; endSec: number; youSay: string }[] }>(`/edit/videos/${videoId}/suggest-beats`, { approved: true });
      for (const b of r.beats) await api.post(`/edit/videos/${videoId}/beats`, b);
      onSuggested();
      setQuote(null);
      toast.success(`Added ${r.beats.length} beats (cost ${usd(r.costUsd)}).`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }
  const lastEnd = beats.reduce((m, b) => Math.max(m, b.endSec), 0);
  const [title, setTitle] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const s = start === '' ? lastEnd : num(start);
  const e = end === '' ? Math.min(round1(s + 5), duration) : num(end);
  return (
    <Card className="p-5">
      <CardHeader eyebrow="Beats" title="Structure" />
      {beats.length === 0 ? (
        <p className="text-sm text-slate-400">No beats yet. A beat is one part of the video, such as the hook or a tip. Add the first one below.</p>
      ) : (
        <div className="flex gap-1 overflow-x-auto pb-1" role="tablist" aria-label="Beats">
          {beats.map((b, i) => (
            <button
              key={b.id}
              role="tab"
              aria-selected={b.id === selectedId}
              onClick={() => onSelect(b.id)}
              style={{ flexGrow: Math.max(b.endSec - b.startSec, 0.5), flexBasis: 0, minWidth: '6rem' }}
              className={`rounded-xl border px-2 py-2 text-left text-xs transition ${b.id === selectedId ? 'border-cyan-500 bg-cyan-500/10' : 'border-slate-800 hover:border-slate-700'}`}
            >
              <div className="flex items-center justify-between gap-1">
                <span className="font-semibold">{i + 1}</span>
                <span className={`h-2 w-2 rounded-full ${b.status === 'approved' ? 'bg-emerald-400' : b.status === 'changes_needed' ? 'bg-amber-400' : b.status === 'in_review' ? 'bg-cyan-400' : 'bg-slate-500'}`} aria-label={STATUS[b.status].label} />
              </div>
              <div className="truncate">{b.title || 'Untitled'}</div>
            </button>
          ))}
        </div>
      )}
      {canWrite && beats.length === 0 && (
        <div className="mt-3 rounded-xl border border-slate-800 p-3 text-sm">
          {!quote ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className="text-slate-400">Let Claude propose the beats from what is said in the video. Step one is free: it listens on this computer, then shows the price.</span>
              <Button loading={busy === 'quote'} onClick={() => void getQuote()}><Sparkles className="h-4 w-4" aria-hidden /> Suggest beats</Button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span>This will cost about <strong>{usd(quote.estimateUsd)}</strong> (at most {usd(quote.maxUsd)}) on your Claude account. Nothing is spent until you confirm.</span>
              <span className="flex gap-2">
                <Button onClick={() => setQuote(null)} disabled={busy === 'run'}>Cancel</Button>
                <Button variant="primary" loading={busy === 'run'} onClick={() => void runSuggest()}>Confirm and suggest</Button>
              </span>
            </div>
          )}
        </div>
      )}
      {canWrite && (
        <div className="mt-4 grid grid-cols-2 items-end gap-2 sm:grid-cols-[2fr_1fr_1fr_auto]">
          <Field label="New beat" htmlFor="nb-title"><Input id="nb-title" value={title} placeholder="Hook" onChange={(ev) => setTitle(ev.target.value)} /></Field>
          <Field label="Start (s)" htmlFor="nb-start"><Input id="nb-start" type="number" min={0} step={0.1} value={start} placeholder={String(round1(lastEnd))} onChange={(ev) => setStart(ev.target.value)} /></Field>
          <Field label="End (s)" htmlFor="nb-end"><Input id="nb-end" type="number" min={0} step={0.1} value={end} placeholder={String(round1(Math.min(s + 5, duration)))} onChange={(ev) => setEnd(ev.target.value)} /></Field>
          <Button
            disabled={e <= s}
            onClick={() => {
              onAdd({ title: title.trim(), startSec: s, endSec: e });
              setTitle('');
              setStart('');
              setEnd('');
            }}
          >
            <Plus className="h-4 w-4" aria-hidden /> Add beat
          </Button>
        </div>
      )}
    </Card>
  );
}

function ReviewPanel({ beat, index, total, beats, onSelect, steps, labelOn, capsOn, previewUrl, previewing, onPreview, canRun, canWrite, isReviewer, act }: {
  beat: Beat | null; index: number; total: number; beats: Beat[]; onSelect: (id: string) => void; steps: Step[]; labelOn: boolean; capsOn: boolean; previewUrl: string | null; previewing: boolean;
  onPreview: (at: number) => void; canRun: boolean; canWrite: boolean; isReviewer: boolean; act: <T>(fn: () => Promise<T>, ok?: string) => Promise<T | null>;
}) {
  const [request, setRequest] = useState('');
  useEffect(() => setRequest(''), [beat?.id]);

  if (!beat) {
    return (
      <Card className="h-fit p-5">
        <CardHeader eyebrow="Review beat by beat" title="Nothing to review yet" />
        <p className="text-sm text-slate-400">Add a beat above to start. Each beat gets its own notes, status and change requests.</p>
      </Card>
    );
  }
  const st = STATUS[beat.status];
  const changed = steps.filter((s) => s.start < beat.endSec && s.end > beat.startSec).map((s) => `Applied "${s.fx}"${s.text ? ` with the text "${s.text}"` : ''}`);
  if (capsOn) changed.push('Added word-by-word captions');
  if (labelOn) changed.push('Added the dramatization label');
  const save = (patch: Partial<Pick<Beat, 'title' | 'youSay' | 'onScreen' | 'visual' | 'animation'>>) => act(() => api.patch<Beat>(`/edit/beats/${beat.id}`, patch));
  const text = (key: 'youSay' | 'onScreen' | 'visual' | 'animation', label: string, rows = 2) => (
    <Field label={label} htmlFor={`f-${key}-${beat.id}`}>
      <Textarea
        id={`f-${key}-${beat.id}`}
        key={`${beat.id}-${key}-${beat.updatedAt}`}
        rows={rows}
        defaultValue={beat[key]}
        disabled={!canWrite}
        onBlur={(e) => e.target.value !== beat[key] && void save({ [key]: e.target.value })}
      />
    </Field>
  );
  const mid = round1((beat.startSec + beat.endSec) / 2);

  return (
    <Card className="h-fit p-5">
      <CardHeader eyebrow="Review beat by beat" title={`${index + 1}. ${beat.title || 'Untitled'}`} />
      <div className="mb-4 flex gap-1 overflow-x-auto pb-1" role="tablist" aria-label="Beats to review">
        {beats.map((b, i) => (
          <button key={b.id} role="tab" aria-selected={b.id === beat.id} onClick={() => onSelect(b.id)} className={`whitespace-nowrap rounded-full border px-3 py-1 text-xs ${b.id === beat.id ? 'border-cyan-500 bg-cyan-500/10' : 'border-slate-800 text-slate-400'}`}>
            {i + 1}. {b.title || 'Untitled'}
          </button>
        ))}
      </div>

      <div className="grid gap-5 md:grid-cols-[11rem_1fr]">
        <div>
          <div className="aspect-[9/16] w-full overflow-hidden rounded-2xl border border-slate-800 bg-slate-900">
            {previewUrl ? <img src={previewUrl} alt="Preview of this beat with the effects applied" className="h-full w-full object-cover" /> : <div className="grid h-full place-items-center p-3 text-center text-xs text-slate-500">No preview yet</div>}
          </div>
          <Button className="mt-2 w-full" size="sm" loading={previewing} disabled={!canRun} onClick={() => onPreview(mid)}>
            <Film className="h-4 w-4" aria-hidden /> Preview this beat
          </Button>
          <p className="mt-1 text-[11px] text-slate-500">Takes 20 to 30 seconds with effects.</p>
        </div>

        <div className="min-w-0 space-y-3">
          <div className="flex items-start justify-between gap-2">
            <p className="text-xs text-slate-500">Beat {index + 1} of {total} · {clock(beat.startSec)} to {clock(beat.endSec)}</p>
            <div className="flex items-center gap-2 text-xs">Status <Badge tone={st.tone}>{st.label}</Badge></div>
          </div>
          <Field label="Beat title" htmlFor={`title-${beat.id}`}>
            <Input id={`title-${beat.id}`} key={`${beat.id}-t-${beat.updatedAt}`} defaultValue={beat.title} disabled={!canWrite} onBlur={(e) => e.target.value !== beat.title && void save({ title: e.target.value })} />
          </Field>
          {text('youSay', 'You say')}
          {text('onScreen', 'On-screen text')}
          {text('visual', 'Visual')}
          {text('animation', 'Animation')}
        </div>
      </div>

      <div className="mt-5 grid gap-5 md:grid-cols-2">
        <section aria-label="What is changed">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">What's changed</h3>
          {changed.length === 0 ? <p className="text-sm text-slate-500">Nothing applied to this beat yet.</p> : <ul className="list-disc space-y-1 pl-5 text-sm">{changed.map((c) => <li key={c}>{c}</li>)}</ul>}
        </section>
        <section aria-label="What needs adjustment">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">What needs adjustment</h3>
          {beat.adjustments.length === 0 ? (
            <p className="text-sm text-slate-500">Nothing requested.</p>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {beat.adjustments.map((a) => (
                <li key={a.id}>
                  <label className="flex items-start gap-2">
                    <input type="checkbox" className="mt-1" checked={a.done} disabled={!canWrite} onChange={(e) => void act(() => api.patch(`/edit/beats/${beat.id}/adjustments/${a.id}`, { done: e.target.checked }))} />
                    <span className={a.done ? 'text-slate-500 line-through' : ''}>{a.text}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <div className="mt-5 border-t border-slate-800 pt-4">
        {isReviewer ? (
          <>
            <Field label="Change request (optional)" htmlFor="change-request">
              <Textarea id="change-request" rows={3} value={request} placeholder="e.g. Hold the before/after cards longer, or make the header say ... (one change per line)" onChange={(e) => setRequest(e.target.value)} />
            </Field>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant="primary" disabled={beat.status === 'approved'} onClick={() => void act(() => api.post(`/edit/beats/${beat.id}/approve`), 'Beat approved.')}>
                <Check className="h-4 w-4" aria-hidden /> {beat.status === 'approved' ? 'Approved' : 'Approve'}
              </Button>
              <Button disabled={!request.trim()} onClick={() => void act(() => api.post(`/edit/beats/${beat.id}/request-changes`, { request }), 'Changes requested.').then((r) => r && setRequest(''))}>
                Request changes
              </Button>
            </div>
          </>
        ) : (
          <>
            {beat.status === 'changes_needed' && beat.changeRequest && (
              <p className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-2 text-sm text-amber-100">Requested: {beat.changeRequest}</p>
            )}
            <Button variant="primary" disabled={!canWrite || beat.status === 'in_review' || beat.status === 'approved'} onClick={() => void act(() => api.post(`/edit/beats/${beat.id}/submit`), 'Submitted for review.')}>
              <Send className="h-4 w-4" aria-hidden /> {beat.status === 'in_review' ? 'Waiting for review' : beat.status === 'approved' ? 'Approved' : 'Submit for review'}
            </Button>
          </>
        )}
      </div>
    </Card>
  );
}
