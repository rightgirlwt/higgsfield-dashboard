import { Activity, BarChart3, Bell, Camera, Clapperboard, FolderOpen, GraduationCap, LogOut, Menu, Mic, Moon, Search, Settings, Sparkles, Sun, Wand2, X, type LucideIcon } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../auth/context';
import { api, setWorkspaceId } from '../lib/api';
import { timeAgo } from '../lib/format';
import { useApi } from '../lib/hooks';
import { useTheme } from '../lib/theme';
import type { Alert } from '../lib/types';
import { useRealtime } from '../state/Realtime';
import { SearchPalette } from './SearchPalette';
import { Badge, Button, cx, IconButton } from './ui';

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
  /** Shown indented under it, always. */
  children?: { to: string; label: string; icon: LucideIcon }[];
}

/** Metrics is the home page. Overview lives inside Monitoring; Prompts and Workflows live inside Settings. */
const nav: NavItem[] = [
  { to: '/', label: 'Metrics', icon: BarChart3, end: true },
  {
    to: '/studio',
    label: 'Studio',
    icon: Sparkles,
    children: [
      { to: '/edit', label: 'Editing', icon: Wand2 },
      { to: '/voices', label: 'Voices', icon: Mic },
      { to: '/media', label: 'Media', icon: Camera },
      { to: '/projects', label: 'Projects', icon: Clapperboard },
    ],
  },
  { to: '/vault', label: 'Vault', icon: FolderOpen },
  { to: '/study', label: 'Study', icon: GraduationCap },
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
  const { reload } = list;
  useEffect(() => {
    window.addEventListener('workspaces-changed', reload);
    return () => window.removeEventListener('workspaces-changed', reload);
  }, [reload]);
  if (!list.data || list.data.workspaces.length < 2) return null;
  const change = (id: string) => {
    setWorkspaceId(id);
    window.location.assign('/');
  };
  return (
    <div className="mb-5">
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

  // The pages under Studio: smaller and indented, same white pill when open.
  const child = ({ isActive }: { isActive: boolean }) =>
    cx('flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[13px] font-medium transition', isActive ? 'bg-white text-cyan-600 shadow-md' : 'text-white/75 hover:bg-white/12 hover:text-white');

  const sidebar = (
    <>
      <div className="mb-6 flex items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-white font-bold text-cyan-600 shadow-md" aria-hidden>R</div>
        <div className="text-lg font-semibold leading-tight text-white">RGM Dashboard</div>
      </div>
      <WorkspaceSwitcher />
      <nav aria-label="Primary" className="space-y-1">
        {nav.map(({ to, label, icon: Icon, end, children }) => (
          <div key={to} className="space-y-1">
            <NavLink to={to} end={end} className={link} onClick={() => setMobileNav(false)}>
              <Icon className="h-4 w-4" aria-hidden />
              {label}
            </NavLink>
            {children && (
              <div className="ml-5 space-y-0.5 border-l border-white/20 pl-2.5">
                {children.map(({ to: childTo, label: childLabel, icon: ChildIcon }) => (
                  <NavLink key={childTo} to={childTo} className={child} onClick={() => setMobileNav(false)}>
                    <ChildIcon className="h-3.5 w-3.5" aria-hidden />
                    {childLabel}
                  </NavLink>
                ))}
              </div>
            )}
          </div>
        ))}
      </nav>
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
