import { useSearchParams } from 'react-router-dom';
import { PageHeader } from '../components/ui';
import { useDocumentTitle } from '../lib/hooks';
import AdsView from './metrics/AdsView';
import AllView, { type ViewId } from './metrics/AllView';
import FacebookView from './metrics/FacebookView';
import InstagramView from './metrics/InstagramView';

const VIEWS: [ViewId, string][] = [['all', 'All'], ['instagram', 'Instagram'], ['facebook', 'Facebook'], ['ads', 'Ads']];

/** Everything on one page (All), or one channel at a time. The channel is kept in the address (?view=ads) so it can be bookmarked. */
export default function Metrics() {
  useDocumentTitle('Metrics');
  const [params, setParams] = useSearchParams();
  const raw = params.get('view');
  const view: ViewId = VIEWS.some(([id]) => id === raw) ? (raw as ViewId) : 'all';
  const open = (v: ViewId) => setParams(v === 'all' ? {} : { view: v }, { replace: true });

  return (
    <div>
      <PageHeader eyebrow="How it is landing" title="Metrics" />
      <div className="mb-4 flex flex-wrap gap-2" role="tablist" aria-label="Channels">
        {VIEWS.map(([id, label]) => (
          <button key={id} role="tab" aria-selected={view === id} onClick={() => open(id)} className={`rounded-full border px-4 py-1.5 text-sm font-medium ${view === id ? 'border-cyan-500/60 bg-cyan-500/10 text-cyan-200' : 'border-slate-700 text-slate-400 hover:border-slate-500'}`}>
            {label}
          </button>
        ))}
      </div>
      {view === 'all' && <AllView onOpen={open} />}
      {view === 'instagram' && <InstagramView />}
      {view === 'facebook' && <FacebookView />}
      {view === 'ads' && <AdsView />}
    </div>
  );
}
