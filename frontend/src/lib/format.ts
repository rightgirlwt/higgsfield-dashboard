export function usd(n: number, opts: { compact?: boolean } = {}): string {
  const abs = Math.abs(n);
  if (opts.compact && abs >= 10_000) return `$${(n / 1000).toFixed(1)}K`;
  if (abs > 0 && abs < 0.01) return `$${n.toFixed(5)}`;
  if (abs < 1) return `$${n.toFixed(4)}`;
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
}

/** List price per 1M tokens, e.g. $0.10 / $4.00 (usd() would print 4 decimals for sub-$1 values). */
export function price(n: number): string {
  return `$${n.toFixed(2)}`;
}

export function num(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 10_000) return `${(n / 1000).toFixed(1)}K`;
  return Math.round(n).toLocaleString('en-US');
}

export function pct(n: number | null): string {
  if (n === null) return 'new';
  return `${n > 0 ? '+' : ''}${n.toFixed(1)}%`;
}

export function ms(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  return n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${Math.round(n)}ms`;
}

export function timeAgo(iso: string | null): string {
  if (!iso) return '—';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function dateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yest = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yest.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

export function estimateTokens(text: string): number {
  return Math.max(0, Math.ceil(text.length / 4));
}

export function extractVariables(...texts: string[]): string[] {
  const found = new Set<string>();
  for (const t of texts) for (const m of t.matchAll(/\{\{\s*([a-zA-Z_][\w.-]*)\s*\}\}/g)) found.add(m[1]);
  return [...found];
}
