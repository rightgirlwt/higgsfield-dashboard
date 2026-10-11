import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorMessage } from './api';

export interface ApiState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
  setData: (d: T | null) => void;
}

/** GET `path` (or skip when null); refetches on path change; aborts stale requests. */
export function useApi<T>(path: string | null): ApiState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (path === null) {
      setLoading(false);
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    api
      .get<T>(path, ctrl.signal)
      .then((d) => {
        setData(d);
        setLoading(false);
      })
      .catch((e) => {
        if ((e as Error).name === 'AbortError') return;
        setError(errorMessage(e));
        setLoading(false);
      });
    return () => ctrl.abort();
  }, [path, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload, setData };
}

export function useDebounced<T>(value: T, delay = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return v;
}

/** Fires `cb` when the element scrolls into view (infinite scroll sentinel). */
export function useInView(cb: () => void, enabled: boolean) {
  const ref = useRef<HTMLDivElement | null>(null);
  const saved = useRef(cb);
  saved.current = cb;
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    const io = new IntersectionObserver((entries) => entries[0]?.isIntersecting && saved.current(), { rootMargin: '400px' });
    io.observe(el);
    return () => io.disconnect();
  }, [enabled]);
  return ref;
}

export function useDocumentTitle(title: string) {
  useEffect(() => {
    document.title = `${title} · Higgsfield Studio`;
  }, [title]);
}
