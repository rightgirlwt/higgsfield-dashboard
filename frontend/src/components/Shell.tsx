import { Activity, Bell, Camera, LayoutGrid, LogOut, Menu, MessageSquareText, Search, Settings, Workflow, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../auth/context';
import { api } from '../lib/api';
import { ms, timeAgo } from '../lib/format';
import { useApi } from '../lib/hooks';
import type { Alert } from '../lib/types';
import { useRealtime } from '../state/Realtime';
import { SearchPalette } from './SearchPalette';
import { Badge, Button, cx, IconButton } from './ui';

const nav = [
  { to: '/', label: 'Overview', icon: LayoutGrid, end: true },
  { to: '/prompts', label: 'Prompts', icon: MessageSquareText },
  { to: '/workflows', label: 'Workflows', icon: Workflow },
  { to: '/media', label: 'Media', icon: Camera },
  { to: '/monitoring', label: 'Monitoring', icon: Activity },
  { to: '/settings', label: 'Settings', icon: Settings },
];

function SystemPanel() {
  const { snapshot, connected } = useRealtime();
  const health = snapshot?.apiHealthPct;
  const healthTone = health === undefined ? 'text-slate-400' : health >= 99 ? 'text-emerald-400' : health >= 90 ? 'text-amber-300' : 'text-rose-400';
  return (
    <section aria-label="System status" className="mt-8 rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
      <div className="mb-3 flex items-center justify-between text-xs uppercase tracking-[0.2em] text-slate-500">
        <span>System</span>
        <Badge tone={connected ? 'emerald' : 'rose'}>{connected ? 'Live' : 'Offline'}</Badge>
      </div>
      <dl className="space-y-3 text-sm text-slate-300">
        <div className="flex items-center justify-between">
          <dt>API health</dt>
          <dd className={cx('font-medium', healthTone)}>{health === undefined ? '—' : `${health}%`}</dd>
        </div>
        <div className="flex items-center justify-between">
          <dt>Latency</dt>
          <dd className="font-medium text-cyan-300">{snapshot ? ms(snapshot.latencyMs) : '—'}</dd>
        </div>
        <div className="flex items-center justify-between">
          <dt>Queue</dt>
          <dd className="font-medium text-violet-300">{snapshot ? `${snapshot.queueSize} job${snapshot.queueSize === 1 ? '' : 's'}` : '—'}</dd>
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
  const link = ({ isActive }: { isActive: boolean }) =>
    cx('flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition', isActive ? 'bg-slate-800 text-white shadow-lg shadow-cyan-950/30' : 'text-slate-400 hover:bg-slate-800/70 hover:text-slate-100');

  const sidebar = (
    <>
      <div className="mb-8 flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-cyan-500 to-violet-500 font-bold text-white" aria-hidden>H</div>
        <div>
          <div className="text-sm text-slate-400">Studio</div>
          <div className="text-lg font-semibold">Higgsfield</div>
        </div>
      </div>
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
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[70] focus:rounded-lg focus:bg-cyan-500 focus:px-3 focus:py-2 focus:text-slate-950">
        Skip to content
      </a>
      <div className="flex min-h-screen">
        <aside className="hidden w-64 shrink-0 border-r border-slate-800 bg-slate-900/80 p-5 backdrop-blur-xl lg:block xl:w-72 xl:p-6">{sidebar}</aside>

        {mobileNav && (
          <div className="fixed inset-0 z-40 lg:hidden">
            <div className="absolute inset-0 bg-slate-950/80" onClick={() => setMobileNav(false)} aria-hidden />
            <aside className="relative h-full w-72 overflow-auto border-r border-slate-800 bg-slate-900 p-5 animate-fade-in">
              <IconButton label="Close menu" className="absolute right-3 top-3 border-transparent" onClick={() => setMobileNav(false)}>
                <X className="h-4 w-4" aria-hidden />
              </IconButton>
              {sidebar}
            </aside>
          </div>
        )}

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center justify-between gap-3 border-b border-slate-800/70 px-4 py-3 md:px-6">
            <IconButton label="Open menu" className="lg:hidden" onClick={() => setMobileNav(true)}>
              <Menu className="h-4 w-4" aria-hidden />
            </IconButton>
            <div className="flex-1" />
            <Button onClick={() => setSearchOpen(true)} aria-keyshortcuts="Control+K Meta+K">
              <Search className="h-4 w-4" aria-hidden />
              <span className="hidden sm:inline">Search</span>
              <kbd className="hidden rounded border border-slate-600 px-1 text-[10px] text-slate-400 sm:inline">Ctrl K</kbd>
            </Button>
            <AlertsMenu />
            <div className="flex items-center gap-2">
              <div className="hidden text-right sm:block">
                <div className="text-sm font-medium leading-tight">{me.name}</div>
                <div className="text-xs capitalize text-slate-400">{me.role}</div>
              </div>
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-sky-500 to-violet-500 text-sm font-semibold text-white" aria-hidden>{initials}</div>
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
