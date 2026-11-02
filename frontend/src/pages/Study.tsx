import { Copy, GraduationCap, Link2, Sparkles, Trash2, Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useCan } from '../auth/context';
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, Field, Input, PageHeader, ProgressBar, Skeleton, Textarea } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { usd } from '../lib/format';
import { useApi, useDocumentTitle } from '../lib/hooks';
import { scriptText, type Quote, type Script, type Study } from '../lib/study';
import { useToast } from '../state/Toast';

const TYPES: Record<string, string> = { mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm' };
const mmss = (s: number | null) => (s === null ? '' : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`);

export default function StudySession() {
  useDocumentTitle('Study Session');
  const toast = useToast();
  const canWrite = useCan('user');
  const list = useApi<Study[]>('/study');
  const [params, setParams] = useSearchParams();
  const picked = params.get('id') ?? '';
  const select = (id: string) => setParams(id ? { id } : {}, { replace: true });
  const [uploading, setUploading] = useState<{ at: number; of: number } | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [link, setLink] = useState('');
  const [fetching, setFetching] = useState(false);
  const studies = list.data ?? [];

  async function openLink() {
    setFetching(true);
    try {
      const r = await api.post<{ id: string; duplicate: boolean; costUsd: number; studyError: string }>('/study/from-link', { url: link });
      if (r.studyError) toast.error(`Opened the reel, but could not study it: ${r.studyError}`);
      else toast.success(r.costUsd > 0 ? `Opened and studied for ${usd(r.costUsd)}.` : 'Already in Study Session. Its numbers are refreshed.');
      setLink('');
      list.reload();
      select(r.id);
    } catch (e) {
      toast.error(errorMessage(e));
    }
    setFetching(false);
  }
  const current = studies.find((s) => s.id === picked) ?? null;

  async function upload(files: File[]) {
    let last = '';
    let added = 0;
    for (let i = 0; i < files.length; i++) {
      setUploading({ at: i + 1, of: files.length });
      const f = files[i];
      try {
        const type = f.type || TYPES[f.name.split('.').pop()?.toLowerCase() ?? ''] || '';
        const r = await api.upload<{ id: string; duplicate: boolean }>(`/study/upload?filename=${encodeURIComponent(f.name)}`, f, type);
        last = r.id;
        if (r.duplicate) toast.success(`${f.name} is already in Study Session.`);
        else added++;
      } catch (e) {
        toast.error(`${f.name}: ${errorMessage(e)}`);
      }
    }
    setUploading(null);
    if (added) toast.success(`${added} reference video${added === 1 ? '' : 's'} added. Nothing was spent.`);
    list.reload();
    if (last) select(last);
  }

  return (
    <div>
      <PageHeader eyebrow="Learn from what works" title="Study Session" />
      <Card className="p-4">
        <CardHeader eyebrow="Free" title="Add a reel to study" />
        <p className="mt-2 text-sm text-slate-400">
          Upload a reel you like, or one that did well. Reading it is free: its length, where it cuts and how fast it moves. Claude only looks at it after you see the price. Then you can write a script on the same structure, or have your Vault reel ideas built the same way.
        </p>
        {canWrite ? (
          <>
          <form className="mt-3 flex flex-wrap items-end gap-2" onSubmit={(e) => (e.preventDefault(), link.trim() && !fetching && void openLink())}>
            <div className="min-w-60 flex-1">
              <Field label="Paste a link" hint="Instagram, TikTok, YouTube or Facebook. The reel is saved on this computer with its caption and numbers, and Claude studies it right away (about 2 cents, shown when it is done). Private posts will not open: upload the file instead.">
                <Input value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://www.instagram.com/reel/…" inputMode="url" />
              </Field>
            </div>
            <Button type="submit" variant="primary" loading={fetching} disabled={!link.trim() || !!uploading}>
              <Link2 className="h-4 w-4" aria-hidden /> {fetching ? 'Opening and studying…' : 'Open and study'}
            </Button>
          </form>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <input ref={picker} type="file" accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.m4v,.webm" multiple hidden onChange={(e) => (e.target.files?.length && void upload([...e.target.files]), (e.target.value = ''))} />
            <Button onClick={() => picker.current?.click()} disabled={!!uploading || fetching}>
              <Upload className="h-4 w-4" aria-hidden /> Or upload a video file
            </Button>
            <span className="text-xs text-slate-500">MP4, MOV or WebM, up to 3 minutes and 500 MB each.</span>
          </div>
          </>
        ) : (
          <p className="mt-3 text-sm text-slate-500">You can look but not add. Ask an editor to add reference videos.</p>
        )}
        {uploading && (
          <div className="mt-3 text-xs text-slate-400" aria-live="polite">
            Reading video {uploading.at} of {uploading.of}…
            <div className="mt-1"><ProgressBar value={((uploading.at - 1) / uploading.of) * 100} label="Uploading" /></div>
          </div>
        )}
      </Card>

      {list.error ? (
        <ErrorState message={list.error} onRetry={list.reload} />
      ) : !list.data ? (
        <Skeleton className="mt-4 h-40" />
      ) : studies.length === 0 ? (
        <div className="mt-4"><EmptyState title="Nothing to study yet" hint="Upload a reel you wish you had made. Claude will show you how it was built." /></div>
      ) : (
        <div className="mt-4 grid gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
          <ul className="space-y-2" aria-label="Reference videos">
            {studies.map((s) => (
              <li key={s.id}>
                <button
                  onClick={() => select(s.id)}
                  aria-current={s.id === picked ? 'true' : undefined}
                  className={`flex w-full gap-3 rounded-xl border p-2 text-left transition ${s.id === picked ? 'border-cyan-500/60 bg-cyan-500/5' : 'border-slate-800 hover:border-slate-600'}`}
                >
                  {s.poster ? <img src={s.poster} alt="" className="h-20 w-12 shrink-0 rounded object-cover" /> : <div className="h-20 w-12 shrink-0 rounded bg-slate-900" />}
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{s.title}</div>
                    <div className="mt-0.5 text-xs text-slate-500">{mmss(s.durationSec)} · {s.pacing.shots} shot{s.pacing.shots === 1 ? '' : 's'}</div>
                    <div className="mt-1.5">{s.analysis ? <Badge tone="emerald">Studied</Badge> : <Badge>Not studied</Badge>}{s.scripts.length > 0 && <Badge tone="violet" className="ml-1">{s.scripts.length} script{s.scripts.length === 1 ? '' : 's'}</Badge>}</div>
                  </div>
                </button>
              </li>
            ))}
          </ul>
          <div className="min-w-0">
            {current ? (
              <StudyView key={current.id} study={current} canWrite={canWrite} reload={list.reload} onGone={() => (select(''), list.reload())} />
            ) : (
              <Card className="grid place-items-center p-10 text-center text-sm text-slate-500">
                <GraduationCap className="mb-2 h-6 w-6 text-slate-600" aria-hidden />
                Pick a reel on the left to study it.
              </Card>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function StudyView({ study, canWrite, reload, onGone }: { study: Study; canWrite: boolean; reload: () => void; onGone: () => void }) {
  const toast = useToast();
  const video = useRef<HTMLVideoElement>(null);
  const [src, setSrc] = useState('');
  const [title, setTitle] = useState(study.title);
  const [note, setNote] = useState(study.note);
  const [link, setLink] = useState(study.sourceUrl);
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const dirty = title !== study.title || note !== study.note || link !== study.sourceUrl;
  const a = study.analysis;

  useEffect(() => {
    // The player gets a link that expires, so ask for a fresh one each time a video is opened
    api.get<{ url: string }>(`/study/${study.id}/stream-url`).then((r) => setSrc(r.url)).catch((e) => toast.error(errorMessage(e)));
  }, [study.id, toast]);

  const seek = (sec: number) => {
    if (!video.current) return;
    video.current.currentTime = sec;
    void video.current.play().catch(() => undefined);
  };
  const copy = (text: string, what: string) => void navigator.clipboard?.writeText(text).then(() => toast.success(`${what} copied.`));

  async function save() {
    setSaving(true);
    try {
      await api.patch(`/study/${study.id}`, { title, note, sourceUrl: link });
      toast.success('Saved.');
      reload();
    } catch (e) {
      toast.error(errorMessage(e));
    }
    setSaving(false);
  }
  async function remove() {
    try {
      await api.del(`/study/${study.id}`);
      toast.success('Removed, and the file deleted from this computer.');
      onGone();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="grid gap-4 md:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]">
          <div>
            {src ? <video ref={video} key={src} src={src} controls className="max-h-[60vh] w-full rounded-xl bg-black" /> : <Skeleton className="aspect-[9/16] max-h-[60vh]" />}
          </div>
          <div className="space-y-3">
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-400">
              <span>{mmss(study.durationSec)} long</span>
              <span>{study.pacing.shots} shot{study.pacing.shots === 1 ? '' : 's'}</span>
              {study.pacing.averageShotSec !== null && <span>average shot {study.pacing.averageShotSec}s</span>}
              {study.pacing.firstCutSec !== null && <span>first cut at {study.pacing.firstCutSec}s</span>}
              {study.width && study.height && <span>{study.width}×{study.height}</span>}
              {study.costUsd > 0 && <span>{usd(study.costUsd)} spent on it</span>}
            </div>
            <Field label="Name">
              <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} disabled={!canWrite} />
            </Field>
            <Field label="What you like about it" hint="Claude reads this too, so it knows what to look for.">
              <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={600} placeholder="The way it opens, the pacing, the captions…" disabled={!canWrite} />
            </Field>
            <Field label="Where it came from" hint="A link back to the original, for your own reference. It is not opened.">
              <Input value={link} onChange={(e) => setLink(e.target.value)} maxLength={500} placeholder="https://www.instagram.com/reel/…" disabled={!canWrite} />
            </Field>
            {canWrite && (
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="primary" onClick={() => void save()} loading={saving} disabled={!dirty || !title.trim()}>Save</Button>
                {study.sourceUrl && <a href={study.sourceUrl} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-xs text-cyan-300 hover:underline"><Link2 className="h-3 w-3" aria-hidden /> Open original</a>}
                <span className="grow" />
                {confirm ? (
                  <>
                    <Button variant="danger" onClick={() => void remove()}>Yes, delete the video</Button>
                    <Button variant="ghost" onClick={() => setConfirm(false)}>Keep it</Button>
                  </>
                ) : (
                  <Button variant="ghost" onClick={() => setConfirm(true)} aria-label={`Delete ${study.title}`}><Trash2 className="h-4 w-4" aria-hidden /></Button>
                )}
              </div>
            )}
          </div>
        </div>
      </Card>

      {(study.meta.caption || study.meta.likes != null || study.meta.comments != null) && <PostCard study={study} canWrite={canWrite} onDone={reload} />}

      {canWrite && <AnalyseCard study={study} onDone={reload} />}

      {a ? (
        <>
          <Card className="p-4">
            <CardHeader eyebrow="What Claude saw" title={a.summary} />
            <p className="mt-2 text-sm text-slate-400">{a.format}</p>
            <div className="mt-4 rounded-xl border border-cyan-500/30 bg-cyan-500/5 p-3">
              <div className="flex flex-wrap items-center gap-2"><Badge tone="cyan">The hook</Badge>{a.hook.technique && <span className="text-sm font-medium">{a.hook.technique}</span>}</div>
              {a.hook.said && <p className="mt-2 text-sm text-slate-200">Says: “{a.hook.said}”</p>}
              {a.hook.shown && <p className="mt-1 text-sm text-slate-300">Shows: {a.hook.shown}</p>}
              {a.hook.why && <p className="mt-1 text-sm text-slate-400">{a.hook.why}</p>}
            </div>
            <ol className="mt-4 space-y-2" aria-label="How it is built">
              {a.structure.map((s, i) => (
                <li key={i} className="flex gap-3 rounded-xl border border-slate-800 p-2.5">
                  <button onClick={() => seek(s.at)} className="h-fit shrink-0 rounded-md bg-slate-800 px-2 py-1 text-xs font-mono text-cyan-300 hover:bg-slate-700" aria-label={`Play from ${s.at} seconds`}>{s.at}s</button>
                  <div className="min-w-0 text-sm"><div className="font-medium">{s.label}</div><div className="text-slate-400">{s.what}</div></div>
                </li>
              ))}
            </ol>
            <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
              {([['Pacing', a.pacing], ['Text on screen', a.onScreenText], ['Sound', a.audio], ['Call to action', a.cta]] as const).filter(([, v]) => v).map(([k, v]) => (
                <div key={k}><dt className="text-xs uppercase tracking-wider text-slate-500">{k}</dt><dd className="mt-0.5 text-slate-300">{v}</dd></div>
              ))}
            </dl>
          </Card>

          <div className="grid gap-4 md:grid-cols-2">
            <Card className="p-4">
              <CardHeader eyebrow="Worth borrowing" title="What to steal" />
              <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm text-slate-300">{a.steal.map((t, i) => <li key={i}>{t}</li>)}</ul>
            </Card>
            <Card className="p-4">
              <CardHeader eyebrow="Careful" title="What will not transfer" />
              {a.avoid.length ? <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm text-slate-300">{a.avoid.map((t, i) => <li key={i}>{t}</li>)}</ul> : <p className="mt-2 text-sm text-slate-500">Nothing flagged.</p>}
            </Card>
          </div>

          {a.template && (
            <Card className="p-4">
              <CardHeader eyebrow="Fill in the blanks" title="The skeleton" action={<Button size="sm" onClick={() => copy(a.template, 'Skeleton')}><Copy className="h-3.5 w-3.5" aria-hidden /> Copy</Button>} />
              <p className="mt-2 whitespace-pre-wrap text-sm text-slate-300">{a.template}</p>
            </Card>
          )}

          {canWrite && <ScriptCard study={study} onDone={reload} copy={copy} />}
          <Card className="p-4">
            <CardHeader eyebrow="Next" title="Plan reels from your footage in this style" />
            <p className="mt-2 text-sm text-slate-400">In the Vault, under Reel ideas, tick this reel under “Model them on”. Claude then borrows how it is built, not what it says, and the reels are made from your own clips.</p>
          </Card>
        </>
      ) : (
        !canWrite && <Card className="p-4 text-sm text-slate-500">This reel has not been studied yet.</Card>
      )}
    </div>
  );
}

const num = (n: number | null | undefined) => (n == null ? null : n.toLocaleString());

/** The caption and public numbers from the link. Numbers are a snapshot, so the page says when it was taken and can re-read it. */
function PostCard({ study, canWrite, onDone }: { study: Study; canWrite: boolean; onDone: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const m = study.meta;
  const stats: [string, number | null | undefined][] = [['Likes', m.likes], ['Comments', m.comments], ['Views', m.views]];
  async function refresh() {
    setBusy(true);
    try {
      await api.post(`/study/${study.id}/refresh`);
      toast.success('Numbers refreshed.');
      onDone();
    } catch (e) {
      toast.error(errorMessage(e));
    }
    setBusy(false);
  }
  return (
    <Card className="p-4">
      <CardHeader
        eyebrow={[m.platform, m.uploader && `@${m.uploader.replace(/^@/, '')}`, m.postedAt && `posted ${new Date(m.postedAt).toLocaleDateString()}`].filter(Boolean).join(' · ') || 'From a link'}
        title="Its caption and numbers"
        action={canWrite && study.sourceUrl ? <Button size="sm" onClick={() => void refresh()} loading={busy}>Refresh numbers</Button> : undefined}
      />
      <dl className="mt-3 flex flex-wrap gap-6">
        {stats.map(([k, v]) => (
          <div key={k}>
            <dt className="text-xs uppercase tracking-wider text-slate-500">{k}</dt>
            <dd className="mt-0.5 text-lg font-semibold">{num(v) ?? <span className="text-sm font-normal text-slate-500" title="The platform did not share it">hidden</span>}</dd>
          </div>
        ))}
      </dl>
      {m.fetchedAt && <p className="mt-1 text-xs text-slate-500">As of {new Date(m.fetchedAt).toLocaleString()}. These say how it landed, not why.</p>}
      {m.caption && <p className="mt-3 whitespace-pre-wrap text-sm text-slate-300">{m.caption}</p>}
      {m.caption && (
        <Button size="sm" className="mt-2" onClick={() => void navigator.clipboard?.writeText(m.caption ?? '').then(() => toast.success('Caption copied.'))}>
          <Copy className="h-3.5 w-3.5" aria-hidden /> Copy caption
        </Button>
      )}
    </Card>
  );
}

function PriceBox({ quote, what, busy, onApprove, onCancel }: { quote: Quote; what: string; busy: boolean; onApprove: () => void; onCancel: () => void }) {
  return (
    <div className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-sm" role="status">
      <p>
        {what} with Claude Sonnet 5.5 will cost about <strong>{usd(quote.estimateUsd)}</strong>, and never more than <strong>{usd(quote.maxUsd)}</strong>.
      </p>
      {quote.keyMissing && <p className="mt-2 text-amber-200">Add your Anthropic key in Settings first. Nothing has been spent.</p>}
      <div className="mt-3 flex gap-2">
        <Button variant="primary" onClick={onApprove} loading={busy} disabled={quote.keyMissing}><Sparkles className="h-4 w-4" aria-hidden /> Approve</Button>
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

function AnalyseCard({ study, onDone }: { study: Study; onDone: () => void }) {
  const toast = useToast();
  const [quote, setQuote] = useState<Quote | null>(null);
  const [busy, setBusy] = useState(false);
  async function ask() {
    setBusy(true);
    try {
      setQuote(await api.post<Quote>(`/study/${study.id}/analyse`, { approved: false }));
    } catch (e) {
      toast.error(errorMessage(e));
    }
    setBusy(false);
  }
  async function approve() {
    setBusy(true);
    try {
      const r = await api.post<{ costUsd: number }>(`/study/${study.id}/analyse`, { approved: true });
      setQuote(null);
      toast.success(`Studied for ${usd(r.costUsd)}.`);
      onDone();
    } catch (e) {
      toast.error(errorMessage(e));
    }
    setBusy(false);
  }
  return (
    <Card className="p-4">
      <CardHeader eyebrow="Costs a little" title={study.analysis ? 'Study it again' : 'Have Claude study this reel'} />
      <p className="mt-2 text-sm text-slate-400">
        Claude looks at ten frames spread through the video, the cuts found above{study.transcribed ? ', and the words said' : ' and, if the transcriber is set up, the words said'}. It tells you how the hook works, how the reel is built beat by beat, and what you can reuse.
      </p>
      {!quote && (
        <Button className="mt-3" onClick={() => void ask()} loading={busy}>
          <GraduationCap className="h-4 w-4" aria-hidden /> See the price
        </Button>
      )}
      {quote && <PriceBox quote={quote} what="Studying this reel" busy={busy} onApprove={() => void approve()} onCancel={() => setQuote(null)} />}
    </Card>
  );
}

function ScriptCard({ study, onDone, copy }: { study: Study; onDone: () => void; copy: (text: string, what: string) => void }) {
  const toast = useToast();
  const [topic, setTopic] = useState('');
  const [quote, setQuote] = useState<Quote | null>(null);
  const [busy, setBusy] = useState(false);
  async function ask() {
    setBusy(true);
    try {
      setQuote(await api.post<Quote>(`/study/${study.id}/script`, { topic, approved: false }));
    } catch (e) {
      toast.error(errorMessage(e));
    }
    setBusy(false);
  }
  async function approve() {
    setBusy(true);
    try {
      const r = await api.post<{ costUsd: number }>(`/study/${study.id}/script`, { topic, approved: true });
      setQuote(null);
      setTopic('');
      toast.success(`Script written for ${usd(r.costUsd)}.`);
      onDone();
    } catch (e) {
      toast.error(errorMessage(e));
    }
    setBusy(false);
  }
  async function remove(s: Script) {
    try {
      await api.del(`/study/${study.id}/scripts/${s.id}`);
      onDone();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }
  return (
    <Card className="p-4">
      <CardHeader eyebrow="Costs a little" title="Write your own on this structure" />
      <p className="mt-2 text-sm text-slate-400">Say what your reel is about. Claude keeps how this one is built (the hook technique, the pacing, the order) and writes it in your voice for this account, with none of the original's words.</p>
      <form className="mt-3 space-y-3" onSubmit={(e) => (e.preventDefault(), topic.trim().length >= 3 && !busy && void ask())}>
        <Field label="Your topic" hint="Facts you want in it. Claude will not invent numbers, names or results.">
          <Textarea rows={3} value={topic} onChange={(e) => (setTopic(e.target.value), setQuote(null))} maxLength={500} className="font-sans" placeholder="What to say to the insurance adjuster after a crash" />
        </Field>
        {!quote && <Button type="submit" loading={busy} disabled={topic.trim().length < 3}>See the price</Button>}
      </form>
      {quote && <PriceBox quote={quote} what="Writing this script" busy={busy} onApprove={() => void approve()} onCancel={() => setQuote(null)} />}
      {study.scripts.length > 0 && (
        <div className="mt-5 space-y-3">
          {study.scripts.map((s) => (
            <article key={s.id} className="rounded-xl border border-slate-800 p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <h4 className="font-semibold">{s.title || 'Untitled script'}</h4>
                  <p className="text-xs text-slate-500">About: {s.topic}</p>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => copy(scriptText(s), 'Script')}><Copy className="h-3.5 w-3.5" aria-hidden /> Copy</Button>
                  <Button size="sm" variant="ghost" onClick={() => void remove(s)} aria-label={`Delete script ${s.title}`}><Trash2 className="h-3.5 w-3.5" aria-hidden /></Button>
                </div>
              </div>
              <p className="mt-2 text-sm text-slate-200"><span className="text-xs uppercase tracking-wider text-slate-500">Hook </span>{s.hook}</p>
              <ol className="mt-2 space-y-1.5">
                {s.beats.map((b, i) => (
                  <li key={i} className="flex gap-2 text-sm">
                    <span className="mt-0.5 text-xs text-slate-500">{i + 1}</span>
                    <div className="min-w-0">
                      <div className="text-slate-200">{b.say}</div>
                      {(b.onScreen || b.shot) && <div className="text-xs text-slate-500">{b.onScreen && <>On screen: {b.onScreen}. </>}{b.shot && <>Shot: {b.shot}.</>}{b.seconds ? ` ${b.seconds}s` : ''}</div>}
                    </div>
                  </li>
                ))}
              </ol>
              {s.caption && (
                <details className="mt-2 text-sm">
                  <summary className="cursor-pointer text-slate-400 hover:text-slate-200">Caption</summary>
                  <p className="mt-1 whitespace-pre-wrap text-slate-300">{s.caption}</p>
                </details>
              )}
              {s.notes && <p className="mt-2 text-xs text-slate-500">{s.notes}</p>}
              {s.tells.length > 0 && (
                <div className="mt-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-2 text-xs text-amber-200">
                  <div className="font-medium">Reads a little machine-written here. Reword these before you post:</div>
                  <ul className="mt-1 list-disc pl-4">{s.tells.map((t, i) => <li key={i}>{t}</li>)}</ul>
                </div>
              )}
            </article>
          ))}
        </div>
      )}
    </Card>
  );
}
