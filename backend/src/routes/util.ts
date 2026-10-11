import type { Request } from 'express';
import { notFound } from '../lib/errors';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function uuidParam(req: Request, name = 'id'): string {
  const v = req.params[name];
  if (!UUID.test(v)) throw notFound();
  return v;
}

export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID.test(v);
}

export function parseRange(v: unknown): { days: number; from: Date; to: Date; prevFrom: Date } {
  const days = ({ '7d': 7, '30d': 30, '90d': 90 } as Record<string, number>)[String(v)] ?? 30;
  const to = new Date();
  const from = new Date(to.getTime() - days * 86_400_000);
  const prevFrom = new Date(from.getTime() - days * 86_400_000);
  return { days, from, to, prevFrom };
}

/** Escape LIKE wildcards so user input is matched literally. */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
}

export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
  // Neutralise spreadsheet formula injection.
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  return [headers.map(csvCell).join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\n') + '\n';
}
