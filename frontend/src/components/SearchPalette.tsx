import { Film, GitBranch, MessageSquareText, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, qs } from '../lib/api';
import { useDebounced } from '../lib/hooks';
import type { SearchResults } from '../lib/types';
import { Badge, Input, Modal, Spinner } from './ui';

/** Global search across prompts, workflows and media (Ctrl/⌘+K). */
export function SearchPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim(), 250);
  const [res, setRes] = useState<SearchResults | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (dq.length < 2) {
      setRes(null);
      return;
    }
    let live = true;
    setLoading(true);
    setFailed(false);
    api
      .get<SearchResults>(`/search${qs({ q: dq })}`)
      .then((r) => live && setRes(r))
      .catch(() => live && setFailed(true))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [dq]);

  const empty = res && !res.prompts.length && !res.workflows.length && !res.media.length;
  const row = 'flex items-center gap-3 rounded-xl px-3 py-2 text-sm text-slate-200 hover:bg-slate-800';

  return (
    <Modal open={open} onClose={onClose} title="Search">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-500" aria-hidden />
        <Input aria-label="Search prompts, workflows and media" className="pl-9" placeholder="Search prompts, workflows, media…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="mt-4 min-h-24" aria-live="polite">
        {loading && <Spinner label="Searching" />}
        {failed && <p className="text-sm text-rose-300">Search failed. Try again.</p>}
        {dq.length < 2 && <p className="text-sm text-slate-500">Type at least 2 characters.</p>}
        {empty && !loading && <p className="text-sm text-slate-400">No results for “{dq}”.</p>}
        {res && (
          <div className="space-y-4">
            {res.prompts.length > 0 && (
              <section>
                <h3 className="mb-1 px-3 text-xs uppercase tracking-wider text-slate-500">Prompts</h3>
                {res.prompts.map((p) => (
                  <Link key={p.id} to={`/prompts?id=${p.id}`} onClick={onClose} className={row}>
                    <MessageSquareText className="h-4 w-4 text-violet-300" aria-hidden />
                    {p.name}
                    {p.isTemplate && <Badge tone="violet">template</Badge>}
                  </Link>
                ))}
              </section>
            )}
            {res.workflows.length > 0 && (
              <section>
                <h3 className="mb-1 px-3 text-xs uppercase tracking-wider text-slate-500">Workflows</h3>
                {res.workflows.map((w) => (
                  <Link key={w.id} to={`/workflows/${w.id}`} onClick={onClose} className={row}>
                    <GitBranch className="h-4 w-4 text-cyan-300" aria-hidden />
                    {w.name}
                    <Badge>{w.status}</Badge>
                  </Link>
                ))}
              </section>
            )}
            {res.media.length > 0 && (
              <section>
                <h3 className="mb-1 px-3 text-xs uppercase tracking-wider text-slate-500">Media</h3>
                {res.media.map((m) => (
                  <Link key={m.id} to={`/media?q=${encodeURIComponent(m.title)}`} onClick={onClose} className={row}>
                    <img src={m.thumbUrl} alt="" className="h-8 w-12 rounded object-cover" />
                    <Film className="sr-only" aria-hidden />
                    {m.title}
                    <Badge>{m.type}</Badge>
                  </Link>
                ))}
              </section>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
