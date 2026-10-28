import { Activity, Bell, Camera, Clapperboard, LayoutGrid, LogOut, Menu, MessageSquareText, Mic, Moon, Search, Settings, Sparkles, Sun, Workflow, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../auth/context';
import { api, setWorkspaceId } from '../lib/api';
import { ms, timeAgo } from '../lib/format';
import { useApi } from '../lib/hooks';
import { useTheme } from '../lib/theme';
import type { Alert } from '../lib/types';
import { useRealtime } from '../state/Realtime';
import { SearchPalette } from './SearchPalette';
import { Badge, Button, cx, IconButton } from './ui';

const nav = [
  { to: '/', label: 'Overview', icon: LayoutGrid, end: true },
  { to: '/projects', label: 'Projects', icon: Clapperboard },
  { to: '/studio', label: 'Studio', icon: Sparkles },
  { to: '/voices', label: 'Voices', icon: Mic },
  { to: '/prompts', label: 'Prompts', icon: MessageSquareText },
  { to: '/workflows', label: 'Workflows', icon: Workflow },
  { to: '/media', label: 'Media', icon: Camera },
  { to: '/monitoring', label: 'Monitoring', icon: Activity },
  { to: '/settings', label: 'Settings', icon: Settings },
];

interface WorkspaceList {
  workspaces: { id: string; name: string }[];
  current: string;
}

/** Projects and the media library show one workspace at a time. Changing it reloads the page so every screen starts fresh. */
function WorkspaceSwitcher() {
  const list = useApi<WorkspaceList>('/workspaces');
  if (!list.data || list.data.workspaces.length < 2) return null;
  const change = (id: string) => {
    setWorkspaceId(id);
    window.location.assign('/');
  };
  return (
    <div className="mb-6">
      <label htmlFor="workspace" className="mb-1.5 block text-xs uppercase tracking-wider text-white/70">Workspace</label>
      <select
        id="workspace"
        value={list.data.current}
        onChange={(e) => change(e.target.value)}
        className="w-full rounded-2xl border-0 bg-white px-3.5 py-2.5 text-sm font-semibold text-cyan-600 shadow-md focus:outline-none focus:ring-2 focus:ring-white/70"
      >
        {list.data.workspaces.map((w) => (
          <option key={w.id} value={w.id}>{w.name}</option>
        ))}
      </select>
    </div>
  );
}

function SystemPanel() {
  const { snapshot, connected } = useRealtime();
  const health = snapshot?.apiHealthPct;
  const healthTone = health === undefined ? 'text-slate-400' : health >= 99 ? 'text-emerald-400' : health >= 90 ? 'text-amber-300' : 'text-rose-400';
  // Sits on the brand-coloured sidebar, so it uses white-on-translucent styling in both themes.
  void healthTone;
  return (
    <section aria-label="System status" className="mt-auto rounded-2xl bg-white/12 p-4 text-white ring-1 ring-white/15">
      <div className="mb-3 flex items-center justify-between text-xs uppercase tracking-[0.2em] text-white/70">
        <span>System</span>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-white/20 px-2 py-0.5 text-[10px] font-semibold tracking-wider text-white">
          <span className={cx('h-1.5 w-1.5 rounded-full', connected ? 'bg-emerald-300' : 'bg-rose-300')} aria-hidden />
          {connected ? 'Live' : 'Offline'}
        </span>
      </div>
      <dl className="space-y-2.5 text-sm text-white/85">
        <div className="flex items-center justify-between">
          <dt>API health</dt>
          <dd className="font-semibold text-white">{health === undefined ? '—' : `${health}%`}</dd>
        </div>
        <div className="flex items-center justify-between">
          <dt>Latency</dt>
          <dd className="font-semibold text-white">{snapshot ? ms(snapshot.latencyMs) : '—'}</dd>
        </div>
        <div className="flex items-center justify-between">
          <dt>Queue</dt>
          <dd className="font-semibold text-white">{snapshot ? `${snapshot.queueSize} job${snapshot.queueSize === 1 ? '' : 's'}` : '—'}</dd>
        </div>
      </dl>
    </section>
  );
}

function AlertsMenu() {
  const { alertTick } = useRealtime();
  const alerts = useApi<Alert[]>('/monitoring/alerts');
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const reload = alerts.reload;
  useEffect(reload, [alertTick, reload]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const unread = alerts.data?.filter((a) => !a.acknowledged).length ?? 0;
  const ackAll = async () => {
    await api.post('/monitoring/alerts/ack-all');
    alerts.reload();
  };
  const sev = { info: 'cyan', warning: 'amber', critical: 'rose' } as const;
  return (
    <div className="relative" ref={ref}>
      <IconButton label={unread ? `Alerts, ${unread} unread` : 'Alerts'} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((o) => !o)}>
        <Bell className="h-4 w-4" aria-hidden />
        {unread > 0 && <span className="absolute -right-1 -top-1 grid h-4 min-w-4 place-items-center rounded-full bg-rose-500 px-1 text-[10px] font-bold text-white">{unread}</span>}
      </IconButton>
      {open && (
        <div role="dialog" aria-label="Alerts" className="absolute right-0 z-40 mt-2 w-80 max-w-[90vw] rounded-2xl border border-slate-700 bg-slate-900 p-3 shadow-2xl animate-fade-in">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold">Alerts</h2>
            {unread > 0 && (
              <Button size="sm" variant="ghost" onClick={ackAll}>
                Mark all read
              </Button>
            )}
          </div>
          <ul className="max-h-80 space-y-2 overflow-auto">
            {alerts.data?.length === 0 && <li className="p-3 text-sm text-slate-400">No alerts.</li>}
            {alerts.data?.slice(0, 15).map((a) => (
              <li key={a.id} className={cx('rounded-xl border border-slate-800 p-3 text-sm', a.acknowledged ? 'opacity-60' : 'bg-slate-950/60')}>
                <div className="mb-1 flex items-center justify-between">
                  <Badge tone={sev[a.severity]}>{a.severity}</Badge>
                  <span className="text-xs text-slate-500">{timeAgo(a.createdAt)}</span>
                </div>
                {a.message}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function Shell() {
  const { me, signOut } = useAuth();
  const [mobileNav, setMobileNav] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const closeSearch = useCallback(() => setSearchOpen(false), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const initials = me.name.split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
  const { theme, toggle: toggleTheme } = useTheme();
  // Active item = white pill with brand-coloured text (as in the design reference); others are white on the brand colour.
  const link = ({ isActive }: { isActive: boolean }) =>
    cx('flex w-full items-center gap-3 rounded-2xl px-3.5 py-2.5 text-left text-sm font-medium transition', isActive ? 'bg-white text-cyan-600 shadow-md' : 'text-white/80 hover:bg-white/12 hover:text-white');

  const sidebar = (
    <>
      <div className="mb-8 flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-white font-bold text-cyan-600 shadow-md" aria-hidden>H</div>
        <div>
          <div className="text-xs uppercase tracking-wider text-white/70">Studio</div>
          <div className="text-lg font-semibold leading-tight text-white">Higgsfield</div>
        </div>
      </div>
      <WorkspaceSwitcher />
      <nav aria-label="Primary" className="space-y-1.5">
        {nav.map(({ to, label, icon: Icon, end }) => (
          <NavLink key={to} to={to} end={end} className={link} onClick={() => setMobileNav(false)}>
            <Icon className="h-4 w-4" aria-hidden />
            {label}
          </NavLink>
        ))}
      </nav>
      <SystemPanel />
    </>
  );

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[70] focus:rounded-lg focus:bg-cyan-500 focus:px-3 focus:py-2 focus:text-white">
        Skip to content
      </a>
      <div className="flex min-h-screen">
        <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col overflow-y-auto rounded-r-[2rem] bg-sidebar p-5 text-white lg:flex xl:w-72 xl:p-6">{sidebar}</aside>

        {mobileNav && (
          <div className="fixed inset-0 z-40 lg:hidden">
            <div className="absolute inset-0 bg-black/50" onClick={() => setMobileNav(false)} aria-hidden />
            <aside className="relative flex h-full w-72 flex-col overflow-auto rounded-r-[2rem] bg-sidebar p-5 text-white animate-fade-in">
              <button aria-label="Close menu" onClick={() => setMobileNav(false)} className="absolute right-3 top-3 grid h-9 w-9 place-items-center rounded-xl text-white/80 hover:bg-white/12">
                <X className="h-4 w-4" aria-hidden />
              </button>
              {sidebar}
            </aside>
          </div>
        )}

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center justify-between gap-3 px-4 py-4 md:px-6">
            <IconButton label="Open menu" className="lg:hidden" onClick={() => setMobileNav(true)}>
              <Menu className="h-4 w-4" aria-hidden />
            </IconButton>
            {/* Big search field with a brand-coloured icon tile, like the design reference */}
            <button
              onClick={() => setSearchOpen(true)}
              aria-keyshortcuts="Control+K Meta+K"
              aria-label="Search prompts, workflows and media"
              className="flex min-w-0 flex-1 items-center gap-3 rounded-2xl border border-slate-800 bg-slate-900 p-1.5 pr-4 text-left text-sm text-slate-500 shadow-card transition hover:border-slate-700 md:max-w-xl"
            >
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-cyan-500 text-white"><Search className="h-4 w-4" aria-hidden /></span>
              <span className="truncate">Search prompts, workflows, media…</span>
              <kbd className="ml-auto hidden shrink-0 whitespace-nowrap rounded-md border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-400 sm:inline">Ctrl K</kbd>
            </button>
            <div className="flex-1" />
            <IconButton label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'} onClick={toggleTheme}>
              {theme === 'dark' ? <Sun className="h-4 w-4" aria-hidden /> : <Moon className="h-4 w-4" aria-hidden />}
            </IconButton>
            <AlertsMenu />
            <div className="flex items-center gap-2">
              <div className="hidden text-right sm:block">
                <div className="text-sm font-medium leading-tight">{me.name}</div>
                <div className="text-xs capitalize text-slate-400">{me.role === 'user' ? 'team' : me.role}</div>
              </div>
              <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-gradient-to-br from-cyan-500 to-cyan-700 text-sm font-semibold text-white" aria-hidden>{initials}</div>
              <IconButton label="Sign out" onClick={() => void signOut()}>
                <LogOut className="h-4 w-4" aria-hidden />
              </IconButton>
            </div>
          </div>
          <main id="main" tabIndex={-1} className="min-w-0 flex-1 p-4 md:p-6">
            <Outlet />
          </main>
        </div>
      </div>
      <SearchPalette open={searchOpen} onClose={closeSearch} />
    </div>
  );
}
