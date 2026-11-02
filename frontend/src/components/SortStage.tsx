import { FolderOpen, Sparkles, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import { usd } from '../lib/format';
import { useApi } from '../lib/hooks';
import { useJob, type Clip, type Job, type Stats } from '../lib/vault';
import { useToast } from '../state/Toast';

/**
 * Sorting, shown the way it happens: the unsorted files are a ball of small tiles, and each one that Claude files flies out of
 * the ball into its folder card while the counters tick up. The look is the agency's own: cream and soft pink, mauve accents, a serif title.
 */

const SIZE = 300;
const TILES = 130;
const RADIUS = SIZE / 2 - 20;
/** A ball needs a lot of tiles to read as a ball, so a small Vault repeats its thumbnails; the real count is in the counters. */
const TILE_W = Math.sqrt((2.4 * Math.PI * RADIUS * RADIUS) / TILES);
const TILE_H = TILE_W * 0.85;
const SHAPES = Array.from({ length: TILES }, (_, i) => {
  const r = RADIUS * Math.sqrt((i + 0.5) / TILES) + (((i * 53) % 7) - 3);
  const a = i * 2.39996;
  return { cx: SIZE / 2 + r * Math.cos(a), cy: SIZE / 2 + r * Math.sin(a), rot: (i * 137.5) % 360, z: (i * 7) % TILES };
});

const MAUVE = '#99577a';
const GOLD = '#ebac65';
const INK = '#1c1c1c';
const SOFT = '#5b4452';
const SLOTS = 6;

interface Landed {
  n: number;
  thumbs: string[];
}
interface Flight {
  key: number;
  thumb: string;
  sx: number;
  sy: number;
  dx: number;
  dy: number;
  rot: number;
  folder: string;
}

const reducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** One tile in the air. It lands (and is counted) exactly once, when its animation ends. */
function Flyer({ f, onLand }: { f: Flight; onLand: (f: Flight) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const landed = useRef(false);
  const land = useRef(onLand);
  land.current = onLand;
  useEffect(() => {
    const el = ref.current;
    const once = () => {
      if (landed.current) return;
      landed.current = true;
      land.current(f);
    };
    if (!el || !el.animate || reducedMotion()) {
      once();
      return;
    }
    const a = el.animate(
      [
        { transform: `translate(0px, 0px) rotate(${f.rot}deg) scale(1)` },
        { transform: `translate(${f.dx * 0.5}px, ${f.dy * 0.5 - 36}px) rotate(${f.rot / 2}deg) scale(1.35)`, offset: 0.45 },
        { transform: `translate(${f.dx}px, ${f.dy}px) rotate(0deg) scale(0.75)` },
      ],
      { duration: 820, easing: 'cubic-bezier(0.45, 0.05, 0.25, 1)', fill: 'forwards' },
    );
    a.onfinish = once;
    return () => a.cancel();
  }, [f]);
  return (
    <div
      ref={ref}
      aria-hidden
      className="pointer-events-none absolute z-30 overflow-hidden rounded-[3px] border-[1.5px] border-[#fdf8f3] bg-white shadow-[0_6px_14px_rgba(80,40,60,0.35)]"
      style={{ left: f.sx - TILE_W / 2, top: f.sy - TILE_H / 2, width: TILE_W, height: TILE_H }}
    >
      {f.thumb && <img src={f.thumb} alt="" className="h-full w-full object-cover" />}
    </div>
  );
}

function Counter({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dd className="font-serif text-3xl tabular-nums leading-none">{value.toLocaleString()}</dd>
      <dt className="mt-1 text-[10px] font-semibold uppercase tracking-[0.14em]" style={{ color: MAUVE }}>{label}</dt>
    </div>
  );
}

export function SortStage({ stats, onDone, onActive }: { stats: Stats; onDone: () => void; onActive: (on: boolean) => void }) {
  const toast = useToast();
  const waiting = useApi<{ items: Clip[] }>(`/vault/clips?unsorted=1&limit=100&n=${stats.unsorted}`);
  const [phase, setPhase] = useState<'idle' | 'running' | 'done'>('idle');
  const [snapshot, setSnapshot] = useState<Clip[] | null>(null);
  const [landed, setLanded] = useState<Record<string, Landed>>({});
  const [landedRun, setLandedRun] = useState(0);
  const [flights, setFlights] = useState<Flight[]>([]);
  const [pending, setPending] = useState(0);
  const [pulse, setPulse] = useState('');
  const [, setGoneTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [summary, setSummary] = useState<{ filed: number; failed: number; cost: number; note: string } | null>(null);

  const stageRef = useRef<HTMLElement>(null);
  const ballRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef<Record<string, HTMLElement | null>>({});
  const gone = useRef(new Set<number>());
  const launched = useRef(0);
  const logged = useRef(0);
  const flightKey = useRef(0);
  const timers = useRef<number[]>([]);
  const began = useRef({ unsorted: 0, sorted: 0, foldersKey: '' });

  const foldersKey = JSON.stringify(stats.folders);
  const items = (phase === 'idle' ? waiting.data?.items : (snapshot ?? waiting.data?.items)) ?? [];
  const names = stats.folderNames;

  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), []);
  useEffect(() => {
    if (!pulse) return;
    const t = window.setTimeout(() => setPulse(''), 450);
    return () => window.clearTimeout(t);
  }, [pulse]);

  // The cards show what is really in each folder, whenever nothing is mid-flight (and, after a run, once the new totals have arrived).
  useEffect(() => {
    if (phase === 'running' || pending > 0) return;
    if (phase === 'done' && foldersKey === began.current.foldersKey) return;
    let stop = false;
    void (async () => {
      const next: Record<string, Landed> = {};
      await Promise.all(
        stats.folders.map(async (f) => {
          const r = await api.get<{ items: Clip[] }>(`/vault/clips?folder=${encodeURIComponent(f.folder)}&limit=${SLOTS}`).catch(() => ({ items: [] as Clip[] }));
          next[f.folder] = { n: f.n, thumbs: r.items.map((c) => c.thumb).filter(Boolean) };
        }),
      );
      if (!stop) setLanded(next);
    })();
    return () => {
      stop = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [foldersKey, phase, pending]);

  const onLand = useCallback((f: Flight) => {
    setFlights((fs) => fs.filter((x) => x.key !== f.key));
    setLanded((prev) => {
      const cur = prev[f.folder] ?? { n: 0, thumbs: [] };
      return { ...prev, [f.folder]: { n: cur.n + 1, thumbs: [f.thumb, ...cur.thumbs].filter(Boolean).slice(0, SLOTS) } };
    });
    setLandedRun((n) => n + 1);
    setPulse(f.folder);
    setPending((p) => Math.max(0, p - 1));
  }, []);

  /** Sends one filed clip on its way: takes its tile out of the ball and flies it to its folder, thinning the ball in step with progress. */
  const launch = useCallback(
    (e: { id: string; folder: string }) => {
      const stage = stageRef.current;
      const ball = ballRef.current;
      const card = cardRefs.current[e.folder];
      launched.current += 1;
      const g = gone.current;
      const free = SHAPES.map((_, i) => i).filter((i) => !g.has(i));
      const mine = free.filter((i) => items.length && items[i % items.length]?.id === e.id);
      const pool = mine.length ? mine : free;
      const t = pool.length ? pool[Math.floor(Math.random() * pool.length)] : -1;
      if (t >= 0) g.add(t);
      const total = Math.max(1, began.current.unsorted);
      const keep = launched.current >= total ? 0 : Math.round(TILES * (1 - launched.current / total));
      while (TILES - g.size > keep) {
        const rest = SHAPES.map((_, i) => i).filter((i) => !g.has(i));
        if (!rest.length) break;
        g.add(rest[Math.floor(Math.random() * rest.length)]);
      }
      setGoneTick((n) => n + 1);
      const thumb = t >= 0 && items.length ? (items[t % items.length]?.thumb ?? '') : '';
      const sr = stage?.getBoundingClientRect();
      const br = ball?.getBoundingClientRect();
      const cr = card?.getBoundingClientRect();
      const shape = t >= 0 ? SHAPES[t] : { cx: SIZE / 2, cy: SIZE / 2, rot: 0 };
      const sx = sr && br ? br.left - sr.left + shape.cx : 0;
      const sy = sr && br ? br.top - sr.top + shape.cy : 0;
      const dx = sr && cr ? cr.left - sr.left + cr.width / 2 - sx : 0;
      const dy = sr && cr ? cr.top - sr.top + cr.height * 0.62 - sy : 0;
      setFlights((fs) => [...fs, { key: ++flightKey.current, thumb, sx, sy, dx, dy, rot: shape.rot, folder: e.folder }]);
    },
    [items],
  );

  const onLog = useCallback(
    (entries: Job['log']) => {
      logged.current += entries.length;
      entries.forEach((e, i) => {
        setPending((p) => p + 1);
        timers.current.push(window.setTimeout(() => launch(e), i * 130));
      });
    },
    [launch],
  );

  const job = useJob(
    jobId,
    (j) => {
      setJobId(null);
      setPhase('done');
      setSummary({ filed: logged.current, failed: j.failed, cost: j.costUsd, note: j.note });
      if (j.state === 'error') toast.error(j.error);
      else toast.success(`Sorted ${logged.current} file${logged.current === 1 ? '' : 's'} for ${usd(j.costUsd)}${j.failed ? ` (${j.failed} could not be sorted)` : ''}.${j.note ? ' ' + j.note : ''}`);
      onDone();
    },
    onLog,
    700,
  );

  /** One click. The server still works out the most this run can cost and stops there; what it cost is shown when it finishes. */
  async function begin() {
    setBusy(true);
    try {
      const q = await api.post<{ keyMissing: boolean }>('/vault/sort', { approved: false });
      if (q.keyMissing) throw new Error('Add your Anthropic key in Settings first. Nothing has been spent.');
      gone.current = new Set();
      launched.current = 0;
      logged.current = 0;
      setGoneTick(0);
      setLandedRun(0);
      setSnapshot(waiting.data?.items ?? []);
      const j = await api.post<Job>('/vault/sort', { approved: true });
      began.current = { unsorted: j.total, sorted: stats.clips - stats.unsorted, foldersKey };
      setSummary(null);
      setPhase('running');
      setJobId(j.id);
      onActive(true);
    } catch (e) {
      toast.error(errorMessage(e));
    }
    setBusy(false);
  }

  function close() {
    setPhase('idle');
    setSummary(null);
    setSnapshot(null);
    gone.current = new Set();
    setGoneTick((n) => n + 1);
    onActive(false);
  }

  const idleSorted = stats.clips - stats.unsorted;
  const sortedNow = phase === 'idle' ? idleSorted : Math.max(idleSorted, began.current.sorted + landedRun);
  const folderCount = useMemo(() => Object.values(landed).filter((l) => l.n > 0).length, [landed]);
  const g = gone.current;
  const running = phase === 'running';

  return (
    <section
      ref={stageRef}
      className="relative mt-4 overflow-hidden rounded-3xl border p-5 sm:p-6"
      style={{ background: 'linear-gradient(135deg, #fdf8f3 0%, #f7e6ee 52%, #ecc9db 100%)', borderColor: '#ecd3df', color: INK }}
      aria-label="Sort your photos and videos"
    >
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-[0.16em]" style={{ color: MAUVE }}>
            {phase === 'idle' ? 'A few cents in all' : running ? 'Claude is looking at each one' : 'All filed'}
          </p>
          <h2 className="mt-1 font-serif text-3xl leading-tight">
            {phase === 'idle' ? (
              <>
                {stats.unsorted} file{stats.unsorted === 1 ? '' : 's'} to <em style={{ color: MAUVE }}>sort</em>
              </>
            ) : running ? (
              <>
                Sorting your <em style={{ color: MAUVE }}>photos &amp; videos</em>
              </>
            ) : (
              <>
                Your files are in <em style={{ color: MAUVE }}>folders</em>
              </>
            )}
          </h2>
        </div>
        <dl className="flex flex-wrap gap-x-7 gap-y-3" aria-label="Sorting progress">
          <Counter label="Files" value={stats.clips} />
          <Counter label="Sorted" value={sortedNow} />
          <Counter label="Waiting" value={Math.max(0, stats.clips - sortedNow)} />
          <Counter label="Folders" value={folderCount} />
        </dl>
      </header>

      <div className="mt-6 grid items-center gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <ul className="order-last grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:order-first" aria-label="Folders">
          {names.map((name) => {
            const l = landed[name] ?? { n: 0, thumbs: [] };
            return (
              <li
                key={name}
                ref={(el) => void (cardRefs.current[name] = el)}
                className="rounded-xl border bg-white/70 p-2 transition-shadow duration-300"
                style={{ borderColor: '#f3e1ea', boxShadow: pulse === name ? `0 0 0 3px ${GOLD}` : '0 1px 2px rgba(80,40,60,0.08)', opacity: l.n === 0 && phase === 'idle' ? 0.78 : 1 }}
              >
                <div className="mb-1.5 flex items-center justify-between gap-1 text-[11px]">
                  <span className="inline-flex min-w-0 items-center gap-1.5 font-medium">
                    <FolderOpen className="h-3.5 w-3.5 shrink-0" style={{ color: GOLD }} aria-hidden />
                    <span className="truncate">{name}</span>
                  </span>
                  <span className="tabular-nums font-semibold" style={{ color: MAUVE }}>{l.n}</span>
                </div>
                <div className="grid grid-cols-6 gap-0.5">
                  {Array.from({ length: SLOTS }, (_, i) => (l.thumbs[i] ? <img key={`${i}-${l.thumbs[i].length}`} src={l.thumbs[i]} alt="" className="aspect-[4/3] w-full rounded-[2px] object-cover" /> : <div key={i} className="aspect-[4/3] rounded-[2px] bg-[#f1dfe8]" />))}
                </div>
              </li>
            );
          })}
        </ul>

        <div className="order-first flex flex-col items-center lg:order-last">
          <div ref={ballRef} className="relative shrink-0" style={{ width: SIZE, height: SIZE }} role="img" aria-label={`${Math.max(0, stats.clips - sortedNow)} files waiting to be sorted`}>
            {SHAPES.map((s, i) => {
              const thumb = items.length ? items[i % items.length]?.thumb : '';
              const style = { width: TILE_W, height: TILE_H, left: s.cx - TILE_W / 2, top: s.cy - TILE_H / 2, transform: `rotate(${s.rot}deg) scale(${g.has(i) ? 0.6 : 1})`, zIndex: s.z, opacity: g.has(i) ? 0 : 1, transition: 'opacity 0.35s ease, transform 0.35s ease' };
              const cls = 'absolute rounded-[3px] border-[1.5px] border-[#fdf8f3] object-cover shadow-[0_1px_3px_rgba(80,40,60,0.35)]';
              return thumb ? <img key={i} src={thumb} alt="" className={cls} style={style} /> : <div key={i} className={`${cls} bg-white/70`} style={style} />;
            })}
          </div>
          <div className="mt-3 w-full max-w-xs text-center text-sm" aria-live="polite">
            {phase === 'idle' && (
              <>
                <p style={{ color: SOFT }}>Claude looks at each photo, and at three frames from each video, and files it in a folder, with tags and a one-line description.</p>
                <button
                  onClick={() => void begin()}
                  disabled={busy}
                  className="mt-3 inline-flex items-center gap-2 rounded-full px-5 py-2.5 text-sm font-semibold text-[#fdf8f3] shadow-sm transition hover:brightness-110 disabled:opacity-60"
                  style={{ background: MAUVE }}
                >
                  <Sparkles className="h-4 w-4" aria-hidden /> {busy ? 'Starting…' : 'Sort with Claude'}
                </button>
              </>
            )}
            {running && (
              <p style={{ color: SOFT }}>
                {job ? `${job.done} of ${job.total}` : 'Starting'} · spent {usd(job?.costUsd ?? 0)}
              </p>
            )}
            {phase === 'done' && summary && (
              <>
                <p style={{ color: SOFT }}>
                  Filed {summary.filed} for {usd(summary.cost)}
                  {summary.failed ? `, ${summary.failed} could not be sorted` : ''}.{summary.note ? ` ${summary.note}` : ''}
                </p>
                <button onClick={close} className="mt-3 inline-flex items-center gap-1.5 rounded-full border px-4 py-2 text-sm font-medium transition hover:bg-white/60" style={{ borderColor: MAUVE, color: MAUVE }}>
                  <X className="h-3.5 w-3.5" aria-hidden /> Close
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {flights.map((f) => (
        <Flyer key={f.key} f={f} onLand={onLand} />
      ))}
    </section>
  );
}
