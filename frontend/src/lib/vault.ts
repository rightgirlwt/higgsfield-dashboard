import { useEffect, useRef, useState } from 'react';
import { api } from './api';

export interface Clip {
  id: string;
  name: string;
  kind: 'video' | 'photo';
  source: 'folder' | 'upload';
  sizeBytes: number;
  durationSec: number | null;
  width: number | null;
  height: number | null;
  shotAt: string;
  shotDate: string;
  hasSound: boolean;
  duplicateOf: string | null;
  folder: string;
  tags: string[];
  description: string;
  sorted: boolean;
  thumb: string;
}

export interface Stats {
  clips: number;
  photos: number;
  videos: number;
  sortedVideos: number;
  duplicates: number;
  unsorted: number;
  days: number;
  seconds: number;
  folders: { folder: string; n: number }[];
  folderNames: string[];
}

export interface Job {
  id: string;
  kind: 'scan' | 'sort' | 'organize';
  state: 'running' | 'done' | 'error';
  total: number;
  done: number;
  added: number;
  duplicates: number;
  failed: number;
  costUsd: number;
  note: string;
  error: string;
  /** Sorting: the files filed since the last poll, in order. */
  log: { id: string; folder: string }[];
  logged: number;
}

/**
 * Follows a scan, sort or organize job until it finishes, then says so. `onLog` gets each newly filed file once, in order
 * (sorting only), before `onFinish` is called.
 */
export function useJob(jobId: string | null, onFinish: (job: Job) => void, onLog?: (entries: Job['log']) => void, everyMs = 1000) {
  const [job, setJob] = useState<Job | null>(null);
  const finish = useRef(onFinish);
  finish.current = onFinish;
  const logged = useRef(onLog);
  logged.current = onLog;
  useEffect(() => {
    if (!jobId) return;
    let stop = false;
    let seen = 0;
    const tick = async () => {
      try {
        const j = await api.get<Job>(`/vault/jobs/${jobId}?since=${seen}`);
        if (stop) return;
        seen = j.logged ?? seen;
        if (j.log?.length) logged.current?.(j.log);
        setJob(j);
        if (j.state !== 'running') return finish.current(j);
      } catch {
        if (stop) return;
        return finish.current({ id: jobId, kind: 'scan', state: 'error', total: 0, done: 0, added: 0, duplicates: 0, failed: 0, costUsd: 0, note: '', error: 'Lost track of this job (did the server restart?).', log: [], logged: 0 });
      }
      setTimeout(tick, everyMs);
    };
    void tick();
    return () => {
      stop = true;
    };
  }, [jobId, everyMs]);
  return jobId ? job : null;
}
