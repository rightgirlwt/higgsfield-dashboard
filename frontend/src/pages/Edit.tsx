import { Film, Play, Plus, Trash2, Upload } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useCan } from '../auth/context';
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, Field, Input, PageHeader, Select, Skeleton } from '../components/ui';
import { api, errorMessage } from '../lib/api';
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
interface Video {
  id: string;
  name: string;
  durationSec: number | null;
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

const DEFAULT_LABEL = 'DRAMATIZATION | AI-GENERATED VIDEO';
const VIDEO_ACCEPT = 'video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm';
const num = (v: string, fallback = 0) => (Number.isFinite(Number(v)) && v !== '' ? Number(v) : fallback);

/** What the engine reads: text and colour are sent as options only when filled in. */
const toApiStep = (s: Step) => ({ fx: s.fx, start: s.start, end: s.end, ...(s.text.trim() ? { text: s.text.trim() } : {}), options: s.color.trim() ? { color: s.color.trim() } : {} });

export default function Edit() {
  useDocumentTitle('Editing');
  const toast = useToast();
  const canWrite = useCan('user');
  const effects = useApi<EffectList>('/edit/effects');
  const videos = useApi<Video[]>('/edit/videos');
  const workspaces = useApi<WorkspaceList>('/workspaces');
  const [videoId, setVideoId] = useState('');
  const [search, setSearch] = useState('');
  const [steps, setSteps] = useState<Step[]>([]);
  const [time, setTime] = useState(1);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [labelOn, setLabelOn] = useState(false);
  const [labelText, setLabelText] = useState(DEFAULT_LABEL);
  const [job, setJob] = useState<Job | null>(null);
  const nextKey = useRef(1);
  const fileInput = useRef<HTMLInputElement>(null);

  const video = videos.data?.find((v) => v.id === videoId) ?? null;
  const duration = video?.durationSec ?? 60;
  const workspaceName = workspaces.data?.workspaces.find((w) => w.id === workspaces.data?.current)?.name ?? '';
  const isLegal = /greene legal/i.test(workspaceName);

  useEffect(() => {
    if (!videoId && videos.data?.length) setVideoId(videos.data[0].id);
  }, [videos.data, videoId]);
  useEffect(() => () => void (previewUrl && URL.revokeObjectURL(previewUrl)), [previewUrl]);

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

  const addStep = (fx: string) => {
    const start = Math.min(Math.round(time * 10) / 10, Math.max(0, duration - 0.5));
    setSteps((p) => [...p, { key: nextKey.current++, fx, start, end: Math.min(Math.round((start + 3) * 10) / 10, duration), text: '', color: '' }]);
  };
  const patch = (key: number, p: Partial<Step>) => setSteps((all) => all.map((s) => (s.key === key ? { ...s, ...p } : s)));

  async function preview() {
    setPreviewing(true);
    try {
      const blob = await api.postBlob('/edit/preview', { videoId, steps: steps.map(toApiStep), time, label: { enabled: labelOn, text: labelText } });
      setPreviewUrl(URL.createObjectURL(blob));
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setPreviewing(false);
    }
  }

  async function render() {
    try {
      const j = await api.post<Job>('/edit/render', { videoId, steps: steps.map(toApiStep), label: { enabled: labelOn, text: labelText } });
      setJob(j);
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

  const ready = effects.data?.engine.ready;
  const canRun = canWrite && !!videoId && (steps.length > 0 || labelOn) && steps.every((s) => s.end > s.start);

  return (
    <div>
      <PageHeader eyebrow="Effects and label" title="Editing" />
      <p className="mb-5 max-w-3xl text-sm text-slate-400">
        Add effects and the dramatization label to a video: orbiting reels, spotlight, glass widgets, headlines and 40 more. Previews and renders happen on this computer and cost nothing. They work best on videos where one person faces the camera: the effects follow the face, and long text can be cut at the edge on other footage.
      </p>

      {effects.error ? (
        <ErrorState message={effects.error} onRetry={effects.reload} />
      ) : !effects.data ? (
        <Skeleton className="h-64" />
      ) : !ready ? (
        <EmptyState title="The effects engine is not set up" hint={effects.data.engine.message} />
      ) : (
        <div className="grid gap-6 xl:grid-cols-[1.1fr_1fr]">
          <div className="space-y-6">
            <Card className="p-5">
              <CardHeader eyebrow="1" title="Video" />
              <div className="flex flex-wrap items-center gap-3">
                <Select aria-label="Video" className="min-w-0 flex-1" value={videoId} onChange={(e) => setVideoId(e.target.value)} disabled={!videos.data?.length}>
                  {!videos.data?.length && <option value="">No videos yet</option>}
                  {videos.data?.map((v) => (
                    <option key={v.id} value={v.id}>{v.name}{v.durationSec ? ` (${v.durationSec}s)` : ''}</option>
                  ))}
                </Select>
                <input ref={fileInput} type="file" accept={VIDEO_ACCEPT} hidden onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
                <Button loading={uploading} disabled={!canWrite} onClick={() => fileInput.current?.click()}>
                  <Upload className="h-4 w-4" aria-hidden /> Add a video
                </Button>
              </div>
              <p className="mt-2 text-xs text-slate-500">MP4, MOV or WebM, up to 500 MB. Videos are kept in the workspace you are in{workspaceName ? ` (${workspaceName})` : ''}.</p>
            </Card>

            <Card className="p-5">
              <CardHeader eyebrow="2" title="Pick effects" />
              <Input aria-label="Search effects" placeholder="Search, for example spotlight or headline" value={search} onChange={(e) => setSearch(e.target.value)} />
              <ul className="mt-4 grid max-h-[28rem] gap-2 overflow-auto sm:grid-cols-2">
                {shown.map((e) => (
                  <li key={e.name} className="flex items-start justify-between gap-2 rounded-xl border border-slate-800 p-3">
                    <div className="min-w-0">
                      <div className="text-sm font-semibold">{e.name}</div>
                      <p className="text-xs text-slate-400">{e.description}</p>
                    </div>
                    <Button size="sm" variant="ghost" aria-label={`Add ${e.name}`} disabled={!videoId} onClick={() => addStep(e.name)}>
                      <Plus className="h-4 w-4" aria-hidden />
                    </Button>
                  </li>
                ))}
                {shown.length === 0 && <li className="p-3 text-sm text-slate-400">No effect matches that.</li>}
              </ul>
            </Card>
          </div>

          <div className="space-y-6">
            <Card className="p-5">
              <CardHeader eyebrow="3" title="Your effects" />
              {steps.length === 0 ? (
                <p className="text-sm text-slate-400">Add an effect from the list, or skip to step 5 to add only the label. An effect starts at the time shown in the preview slider below and lasts 3 seconds, which you can change.</p>
              ) : (
                <ul className="space-y-3">
                  {steps.map((s) => (
                    <li key={s.key} className="rounded-xl border border-slate-800 p-3">
                      <div className="mb-2 flex items-center justify-between">
                        <Badge tone="cyan">{s.fx}</Badge>
                        <Button size="sm" variant="ghost" aria-label={`Remove ${s.fx}`} onClick={() => setSteps((p) => p.filter((x) => x.key !== s.key))}>
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
              <CardHeader eyebrow="4" title="Preview a frame" />
              <Field label={`Time in the video: ${time.toFixed(1)} s`} htmlFor="time">
                <input id="time" type="range" min={0} max={duration} step={0.1} value={time} onChange={(e) => setTime(Number(e.target.value))} className="w-full" />
              </Field>
              <Button className="mt-3" loading={previewing} disabled={!canRun} onClick={() => void preview()}>
                <Film className="h-4 w-4" aria-hidden /> Preview this frame
              </Button>
              <span className="ml-3 text-xs text-slate-500">Takes about 20 to 30 seconds.</span>
              {previewUrl && <img src={previewUrl} alt="Preview of the chosen frame with the effects and label applied" className="mt-4 max-h-[32rem] rounded-xl border border-slate-800" />}
            </Card>

            <Card className="p-5">
              <CardHeader eyebrow="5" title="Label and render" />
              <label className="flex items-start gap-3 text-sm">
                <input type="checkbox" className="mt-1" checked={labelOn} onChange={(e) => setLabelOn(e.target.checked)} />
                <span>
                  Add the dramatization label for the whole video
                  <span className="block text-xs text-slate-500">
                    Off unless you turn it on. It can be used on its own, with no effects. {isLegal ? 'This is Greene Legal Group: AI-generated or dramatized video needs a visible label before it is posted.' : 'For example DRAMATIZATION on AI-generated video.'}
                  </span>
                </span>
              </label>
              {labelOn && (
                <div className="mt-3">
                  <Field label="Label text" htmlFor="label"><Input id="label" maxLength={80} value={labelText} onChange={(e) => setLabelText(e.target.value)} /></Field>
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
        </div>
      )}
    </div>
  );
}
