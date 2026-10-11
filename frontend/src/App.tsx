import {
  Activity,
  ArrowRight,
  Bell,
  Camera,
  CreditCard,
  Database,
  LayoutGrid,
  MessageSquareText,
  Play,
  Search,
  Settings,
  Sparkles,
  Video,
  Workflow,
} from 'lucide-react';

const kpis = [
  { label: 'Monthly Spend', value: '$8,420', delta: '+12.4%', tone: 'emerald' },
  { label: 'Prompt Runs', value: '24.6K', delta: '+18.2%', tone: 'blue' },
  { label: 'Active Workflows', value: '32', delta: '+4', tone: 'violet' },
  { label: 'Media Assets', value: '7,210', delta: '+9.1%', tone: 'amber' },
];

const charts = [
  { day: 'Mon', spend: 420 },
  { day: 'Tue', spend: 540 },
  { day: 'Wed', spend: 470 },
  { day: 'Thu', spend: 620 },
  { day: 'Fri', spend: 710 },
  { day: 'Sat', spend: 680 },
  { day: 'Sun', spend: 760 },
];

const promptRuns = [
  { name: 'Customer QA Review', model: 'Claude 3.5 Sonnet', status: 'Completed', cost: '$242.10' },
  { name: 'Scene Captioning', model: 'Claude 3 Opus', status: 'Running', cost: '$186.40' },
  { name: 'Workflow Summary', model: 'Claude 3.5 Haiku', status: 'Completed', cost: '$94.20' },
  { name: 'Incident Triage', model: 'Claude 3.5 Sonnet', status: 'Queued', cost: '$154.80' },
];

const workflowNodes = [
  { title: 'Higgsfield Input', status: 'Healthy', type: 'source' },
  { title: 'Prompt Router', status: 'Healthy', type: 'logic' },
  { title: 'Vision Analysis', status: 'Running', type: 'ai' },
  { title: 'Upload Archive', status: 'Healthy', type: 'action' },
  { title: 'Notify Team', status: 'Queued', type: 'action' },
];

const mediaItems = [
  { type: 'video', title: 'Warehouse scan 14:20', date: 'Today · 2:20 PM', tags: ['motion', 'inventory'] },
  { type: 'photo', title: 'Dock camera frame', date: 'Today · 1:42 PM', tags: ['dock', 'alerts'] },
  { type: 'video', title: 'Operator walkthrough', date: 'Yesterday · 9:14 AM', tags: ['ops', 'review'] },
  { type: 'photo', title: 'Inspection snapshot', date: 'Yesterday · 7:03 AM', tags: ['quality', 'review'] },
];

const navItems = [
  { label: 'Overview', icon: LayoutGrid, active: true },
  { label: 'Prompts', icon: MessageSquareText },
  { label: 'Workflows', icon: Workflow },
  { label: 'Media', icon: Camera },
  { label: 'Monitoring', icon: Activity },
  { label: 'Settings', icon: Settings },
];

function App() {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <div className="flex min-h-screen">
        <aside className="w-72 border-r border-slate-800 bg-slate-900/80 p-6 backdrop-blur-xl">
          <div className="mb-8 flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-cyan-500 to-violet-500 font-bold text-white">
              H
            </div>
            <div>
              <div className="text-sm text-slate-400">Studio</div>
              <div className="text-lg font-semibold">Higgsfield</div>
            </div>
          </div>

          <nav className="space-y-2">
            {navItems.map(({ label, icon: Icon, active }) => (
              <button
                key={label}
                className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition ${
                  active
                    ? 'bg-slate-800 text-white shadow-lg shadow-cyan-950/30'
                    : 'text-slate-400 hover:bg-slate-800/70 hover:text-slate-100'
                }`}
              >
                <Icon className="h-4 w-4" />
                {label}
              </button>
            ))}
          </nav>

          <div className="mt-10 rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
            <div className="mb-2 flex items-center justify-between text-xs uppercase tracking-[0.2em] text-slate-500">
              <span>System</span>
              <span className="rounded-full bg-emerald-500/15 px-2 py-1 text-[10px] font-semibold text-emerald-300">
                Live
              </span>
            </div>
            <div className="space-y-3 text-sm text-slate-300">
              <div className="flex items-center justify-between">
                <span>API health</span>
                <span className="font-medium text-emerald-400">99.8%</span>
              </div>
              <div className="flex items-center justify-between">
                <span>Latency</span>
                <span className="font-medium text-cyan-300">263 ms</span>
              </div>
              <div className="flex items-center justify-between">
                <span>Queue</span>
                <span className="font-medium text-violet-300">12 jobs</span>
              </div>
            </div>
          </div>
        </aside>

        <main className="flex-1 p-6">
          <header className="mb-8 flex items-center justify-between">
            <div>
              <p className="text-sm text-cyan-300">Operations Overview</p>
              <h1 className="mt-1 text-3xl font-semibold tracking-tight">Higgsfield Studio</h1>
            </div>

            <div className="flex items-center gap-3">
              <button className="flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200">
                <Search className="h-4 w-4" />
                Search
              </button>
              <button className="rounded-xl border border-slate-700 bg-slate-900 p-2 text-slate-200">
                <Bell className="h-4 w-4" />
              </button>
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-sky-500 to-violet-500 font-semibold text-white">
                RH
              </div>
            </div>
          </header>

          <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            {kpis.map((kpi) => (
              <div key={kpi.label} className="rounded-2xl border border-slate-800 bg-slate-900/80 p-5 shadow-lg shadow-slate-950/50">
                <div className="mb-8 flex items-center justify-between">
                  <span className="text-sm text-slate-400">{kpi.label}</span>
                  <span className="rounded-full bg-slate-800 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.15em] text-slate-200">
                    {kpi.delta}
                  </span>
                </div>
                <div className="flex items-end justify-between">
                  <div className="text-3xl font-semibold">{kpi.value}</div>
                  <div
                    className={`h-2.5 w-2.5 rounded-full ${
                      kpi.tone === 'emerald'
                        ? 'bg-emerald-400'
                        : kpi.tone === 'blue'
                          ? 'bg-cyan-400'
                          : kpi.tone === 'violet'
                            ? 'bg-violet-400'
                            : 'bg-amber-400'
                    }`}
                  />
                </div>
              </div>
            ))}
          </section>

          <section className="mt-8 grid gap-6 xl:grid-cols-[2fr_1fr]">
            <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-5">
              <div className="mb-5 flex items-center justify-between">
                <div>
                  <p className="text-sm text-slate-400">Spend trend</p>
                  <h2 className="text-xl font-semibold">API Cost</h2>
                </div>
                <button className="inline-flex items-center gap-2 rounded-xl bg-cyan-500/10 px-3 py-2 text-sm font-medium text-cyan-300">
                  <CreditCard className="h-4 w-4" />
                  Export report
                </button>
              </div>

              <div className="flex h-56 items-end gap-4 px-2 pb-2 pt-4">
                {charts.map((point) => (
                  <div key={point.day} className="flex flex-1 flex-col items-center gap-3">
                    <div className="w-full rounded-t-2xl bg-gradient-to-t from-cyan-500 to-violet-500" style={{ height: `${(point.spend / 760) * 100}%` }} />
                    <span className="text-xs text-slate-400">{point.day}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-5">
              <div className="mb-4 flex items-center justify-between">
                <div>
                  <p className="text-sm text-slate-400">AI Signals</p>
                  <h2 className="text-xl font-semibold">Live status</h2>
                </div>
                <Sparkles className="h-5 w-5 text-violet-300" />
              </div>

              <div className="space-y-4">
                {workflowNodes.map((node) => (
                  <div key={node.title} className="flex items-center justify-between rounded-xl border border-slate-800 bg-slate-950/60 p-3">
                    <div className="flex items-center gap-3">
                      <div
                        className={`h-2.5 w-2.5 rounded-full ${
                          node.status === 'Healthy'
                            ? 'bg-emerald-400'
                            : node.status === 'Running'
                              ? 'bg-cyan-400'
                              : 'bg-amber-400'
                        }`}
                      />
                      <div>
                        <div className="text-sm font-medium text-slate-100">{node.title}</div>
                        <div className="text-xs text-slate-400">{node.type}</div>
                      </div>
                    </div>
                    <span className="text-xs text-slate-300">{node.status}</span>
                  </div>
                ))}
              </div>
            </div>
          </section>

          <section className="mt-8 grid gap-6 xl:grid-cols-[1.4fr_1fr]">
            <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-5">
              <div className="mb-5 flex items-center justify-between">
                <div>
                  <p className="text-sm text-slate-400">Prompt lab</p>
                  <h2 className="text-xl font-semibold">Recent runs</h2>
                </div>
                <button className="inline-flex items-center gap-2 rounded-xl bg-violet-500/10 px-3 py-2 text-sm font-medium text-violet-200">
                  <Play className="h-4 w-4" />
                  Run prompt
                </button>
              </div>

              <div className="space-y-3">
                {promptRuns.map((run) => (
                  <div key={run.name} className="flex items-center justify-between rounded-xl border border-slate-800 bg-slate-950/60 p-3">
                    <div>
                      <div className="font-medium text-slate-100">{run.name}</div>
                      <div className="mt-1 text-xs text-slate-400">{run.model}</div>
                    </div>
                    <div className="flex items-center gap-4">
                      <span
                        className={`rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.15em] ${
                          run.status === 'Completed'
                            ? 'bg-emerald-500/15 text-emerald-300'
                            : run.status === 'Running'
                              ? 'bg-cyan-500/15 text-cyan-300'
                              : 'bg-amber-500/15 text-amber-300'
                        }`}
                      >
                        {run.status}
                      </span>
                      <span className="min-w-20 text-right text-sm text-slate-200">{run.cost}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-5">
              <div className="mb-5 flex items-center justify-between">
                <div>
                  <p className="text-sm text-slate-400">Media archive</p>
                  <h2 className="text-xl font-semibold">Recent assets</h2>
                </div>
                <Camera className="h-5 w-5 text-cyan-300" />
              </div>

              <div className="space-y-3">
                {mediaItems.map((item) => (
                  <div key={`${item.title}-${item.date}`} className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
                    <div className="mb-2 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <div className="rounded-md bg-slate-800 p-1.5 text-slate-200">
                          {item.type === 'video' ? <Video className="h-4 w-4" /> : <Database className="h-4 w-4" />}
                        </div>
                        <span className="text-sm font-medium text-slate-100">{item.title}</span>
                      </div>
                      <ArrowRight className="h-4 w-4 text-slate-500" />
                    </div>
                    <div className="text-xs text-slate-400">{item.date}</div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {item.tags.map((tag) => (
                        <span key={tag} className="rounded-full border border-slate-700 bg-slate-800 px-2 py-1 text-[10px] uppercase tracking-[0.14em] text-slate-300">
                          {tag}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}

export default App;
