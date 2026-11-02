import { useSearchParams } from 'react-router-dom';
import Monitoring from './Monitoring';
import Overview from './Overview';

const TABS = [
  ['overview', 'Overview'],
  ['system', 'System health'],
] as const;

/** The old Overview page and the Monitoring page together, so the sidebar needs one item for both. The tab is kept in the address (?tab=system). */
export default function MonitoringHub() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'system' ? 'system' : 'overview';
  return (
    <div>
      <div className="mb-4 flex flex-wrap gap-2" role="tablist" aria-label="Monitoring sections">
        {TABS.map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            onClick={() => setParams(id === 'overview' ? {} : { tab: id }, { replace: true })}
            className={`rounded-full border px-4 py-1.5 text-sm font-medium ${tab === id ? 'border-cyan-500/60 bg-cyan-500/10 text-cyan-200' : 'border-slate-700 text-slate-400 hover:border-slate-500'}`}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'overview' ? <Overview /> : <Monitoring />}
    </div>
  );
}
