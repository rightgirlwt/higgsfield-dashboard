import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { io, type Socket } from 'socket.io-client';
import { useAuth } from '../auth/context';
import type { Alert, Run, RunLog, Snapshot } from '../lib/types';
import { useToast } from './Toast';

export interface HistoryPoint {
  t: number;
  latencyMs: number;
  queueSize: number;
  activeJobs: number;
  apiHealthPct: number;
}

interface RealtimeValue {
  connected: boolean;
  snapshot: Snapshot | null;
  history: HistoryPoint[];
  logs: RunLog[];
  jobs: Record<string, Run>;
  /** Bumped whenever a run changes state so pages can refetch lists. */
  runTick: number;
  /** Bumped whenever spend is recorded (including chat), so spend figures can refresh instantly. */
  usageTick: number;
  alertTick: number;
  clearLogs: () => void;
}

const Ctx = createContext<RealtimeValue | null>(null);
const MAX_LOGS = 500;
const MAX_HISTORY = 60;
const BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '';

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const { getToken } = useAuth();
  const toast = useToast();
  const [connected, setConnected] = useState(false);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  const [logs, setLogs] = useState<RunLog[]>([]);
  const [jobs, setJobs] = useState<Record<string, Run>>({});
  const [runTick, setRunTick] = useState(0);
  const [alertTick, setAlertTick] = useState(0);
  const [usageTick, setUsageTick] = useState(0);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    const socket = io(BASE || undefined, {
      // Function form so reconnects pick up a fresh (e.g. Clerk) token.
      auth: (cb) => {
        getToken().then((token) => cb({ token }));
      },
      reconnectionDelayMax: 10_000,
    });
    socketRef.current = socket;
    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));
    socket.on('connect_error', () => setConnected(false));
    socket.on('monitoring:update', (s: Snapshot) => {
      setSnapshot(s);
      setHistory((h) => [...h.slice(-(MAX_HISTORY - 1)), { t: Date.now(), latencyMs: s.latencyMs, queueSize: s.queueSize, activeJobs: s.activeJobs, apiHealthPct: s.apiHealthPct }]);
    });
    socket.on('log:new', (l: RunLog) => setLogs((x) => [l, ...x].slice(0, MAX_LOGS)));
    socket.on('job:update', (r: Run) => {
      setJobs((j) => ({ ...j, [r.id]: r }));
      setRunTick((t) => t + 1);
    });
    socket.on('usage:new', () => setUsageTick((t) => t + 1));
    socket.on('alert:new', (a: Alert) => {
      setAlertTick((t) => t + 1);
      (a.severity === 'critical' ? toast.error : toast.info)(a.message);
    });
    return () => {
      socket.disconnect();
    };
  }, [getToken, toast]);

  const value = useMemo<RealtimeValue>(() => ({ connected, snapshot, history, logs, jobs, runTick, usageTick, alertTick, clearLogs: () => setLogs([]) }), [connected, snapshot, history, logs, jobs, runTick, usageTick, alertTick]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useRealtime(): RealtimeValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useRealtime must be used inside RealtimeProvider');
  return v;
}
