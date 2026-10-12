import dns from 'node:dns/promises';
import net from 'node:net';
import type { Response } from 'express';
import { Zip, ZipPassThrough } from 'fflate';
import { config } from '../config';
import { logger } from '../logger';
import { toCsv } from '../routes/util';
import { PROJECT_TYPES } from './projectTypes';
import { estimateItems, loadItems, loadProject, loadTakes, type ItemRow, type ProjectRow, type Take } from './projects';

const slug = (s: string, max = 40) =>
  s.normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').toLowerCase().slice(0, max) || 'untitled';

export interface Approved {
  item: ItemRow;
  take: Take;
  order: number;
}

/** Approved cards in board order, each with the take that was approved. */
export async function approvedClips(orgId: string, projectId: string): Promise<{ project: ProjectRow; items: ItemRow[]; approved: Approved[] }> {
  const project = await loadProject(orgId, projectId);
  const [items, takes] = await Promise.all([loadItems(orgId, projectId), loadTakes(orgId, projectId)]);
  const approved: Approved[] = [];
  for (const item of items) {
    if (!item.approved_asset_id) continue;
    const take = (takes.get(item.id) ?? []).find((t) => t.id === item.approved_asset_id);
    if (take) approved.push({ item, take, order: approved.length + 1 });
  }
  return { project, items, approved };
}

const pad = (n: number) => String(n).padStart(3, '0');
const extOf = (take: Take) => {
  const m = /\.(mp4|mov|webm|png|jpe?g|webp|gif)(?:\?|#|$)/i.exec(take.url);
  return (m?.[1] ?? (take.type === 'video' ? 'mp4' : 'png')).toLowerCase();
};
export const clipName = (a: Approved) => `${pad(a.order)}-${slug(a.item.group_name, 24)}-${slug(a.item.title)}.${extOf(a.take)}`.replace(/^(\d+)--/, '$1-');

/** A readable production script: the brief, then every scene with its prompts, notes and where each approved clip is. */
export async function scriptMarkdown(orgId: string, projectId: string): Promise<string> {
  const { project, items, approved } = await approvedClips(orgId, projectId);
  const def = PROJECT_TYPES[project.type];
  const byItem = new Map(approved.map((a) => [a.item.id, a]));
  const lines: string[] = [`# ${project.name}`, '', `*${def.label}* · ${project.aspect} · exported ${new Date().toISOString().slice(0, 10)}`, ''];
  if (project.description) lines.push(project.description, '');
  const brief = def.briefFields.filter((f) => project.brief?.[f.key]?.trim());
  if (brief.length) {
    lines.push(`## ${project.type === 'micro_drama' ? 'Story bible' : 'Brand kit'}`, '');
    for (const f of brief) lines.push(`**${f.label}**`, '', project.brief[f.key].trim(), '');
  }
  lines.push(`## ${def.itemLabel} list`, '');
  const groups = new Map<string, ItemRow[]>();
  for (const i of items) (groups.get(i.group_name) ?? groups.set(i.group_name, []).get(i.group_name)!).push(i);
  for (const [group, list] of groups) {
    lines.push(`### ${group || `No ${def.groupLabel.toLowerCase()}`}`, '');
    for (const i of list) {
      const a = byItem.get(i.id);
      lines.push(`#### ${i.title}  \`${i.status}\`${a ? `  · clip ${pad(a.order)}` : ''}`, '');
      if (i.prompt) lines.push(`**Prompt:** ${i.prompt.replace(/\n+/g, ' ')}`, '');
      if (i.notes) lines.push(`**Notes:** ${i.notes.replace(/\n+/g, ' ')}`, '');
      if (i.model_id) lines.push(`*Model:* ${i.model_id}${i.mode ? ` (${i.mode})` : ''}`, '');
      if (a) lines.push(`*Approved ${a.take.type}:* ${a.take.url}`, '');
    }
  }
  return lines.join('\n') + '\n';
}

export async function manifestCsv(orgId: string, projectId: string): Promise<string> {
  const { items, approved } = await approvedClips(orgId, projectId);
  const est = await estimateItems(orgId, items);
  const byItem = new Map(approved.map((a) => [a.item.id, a]));
  const cost = new Map(est.estimates.map((e) => [e.itemId, e.ok ? e.costUsd : null]));
  // The byte-order mark makes Excel read the file as UTF-8 (so accents and curly quotes survive).
  return '﻿' + toCsv(
    ['order', 'group', 'title', 'status', 'model', 'mode', 'prompt', 'notes', 'estimated_cost_usd', 'clip_file', 'approved_url'],
    items.map((i) => {
      const a = byItem.get(i.id);
      return [a?.order ?? '', i.group_name, i.title, i.status, i.model_id, i.mode, i.prompt, i.notes, cost.get(i.id) ?? '', a ? clipName(a) : '', a?.take.url ?? ''];
    }),
  );
}

// ---- fetching clips safely ---------------------------------------------------------------------------
const privateV4 = (ip: string) => {
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
};
export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) return privateV4(ip);
  const v = ip.toLowerCase();
  if (v === '::1' || v === '::' || v.startsWith('fe80') || v.startsWith('fc') || v.startsWith('fd')) return true;
  // IPv4-mapped addresses (::ffff:a.b.c.d). URL parsing rewrites these to hex (::ffff:7f00:1), so accept both spellings.
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  if (dotted) return privateV4(dotted[1]);
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return privateV4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return false;
}

/** The export fetches URLs from our own database; still, never let it be pointed at the server's internal network. */
export async function isSafeFetchUrl(raw: string, opts: { allowLoopback?: boolean } = {}): Promise<boolean> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  if (opts.allowLoopback) return u.protocol === 'http:' || u.protocol === 'https:';
  if (u.protocol !== 'https:') return false;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) return !isPrivateAddress(host);
  try {
    const addrs = await dns.lookup(host, { all: true });
    return addrs.length > 0 && addrs.every((a) => !isPrivateAddress(a.address));
  } catch {
    return false;
  }
}

const MAX_CLIPS = 100;
const MAX_CLIP_BYTES = 300 * 1024 * 1024;

const drained = (res: Response) => new Promise<void>((r) => res.once('drain', r));

/**
 * Streams a ZIP of the approved clips (in board order) plus a manifest and the script. Clips are fetched and written one at a time,
 * so memory stays flat however long the project is. Anything that can't be fetched is listed in MISSING.txt instead of failing the download.
 */
export async function streamClipsZip(orgId: string, projectId: string, res: Response): Promise<void> {
  const { project, approved } = await approvedClips(orgId, projectId);
  if (approved.length === 0) return void res.status(400).json({ error: { code: 'bad_request', message: 'Nothing is approved yet. Approve a take on at least one card first.' } });
  if (approved.length > MAX_CLIPS) return void res.status(400).json({ error: { code: 'bad_request', message: `Too many clips for one download (${approved.length}). The limit is ${MAX_CLIPS}.` } });

  res.status(200);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${slug(project.name, 50)}-approved-clips.zip"`);
  let failed = false;
  const zip = new Zip((err, chunk, final) => {
    if (err) {
      failed = true;
      res.destroy(err);
      return;
    }
    if (failed || res.destroyed) return;
    res.write(Buffer.from(chunk)); // backpressure is awaited in the loop below
    if (final) res.end();
  });

  const addText = (name: string, text: string) => {
    const f = new ZipPassThrough(name);
    zip.add(f);
    f.push(new TextEncoder().encode(text), true);
  };
  const missing: string[] = [];
  try {
    for (const a of approved) {
      if (res.destroyed) return;
      const name = clipName(a);
      if (!(await isSafeFetchUrl(a.take.url, { allowLoopback: config.isTest }))) {
        missing.push(`${name}: the address isn't a public https link, so it wasn't downloaded (${a.take.url})`);
        continue;
      }
      try {
        const r = await fetch(a.take.url, { redirect: 'follow', signal: AbortSignal.timeout(180_000) });
        if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
        const declared = Number(r.headers.get('content-length') ?? 0);
        if (declared > MAX_CLIP_BYTES) throw new Error('file is larger than 300 MB');
        // Fetch fully before adding to the zip, so a failed download never leaves a truncated entry behind.
        const chunks: Uint8Array[] = [];
        let size = 0;
        const reader = r.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_CLIP_BYTES) throw new Error('file is larger than 300 MB');
          chunks.push(value);
        }
        const f = new ZipPassThrough(name);
        zip.add(f);
        for (const [n, c] of chunks.entries()) {
          f.push(c, n === chunks.length - 1);
          if (res.writableNeedDrain) await drained(res);
        }
        if (chunks.length === 0) f.push(new Uint8Array(0), true);
      } catch (e) {
        missing.push(`${name}: ${e instanceof Error ? e.message : 'download failed'}`);
      }
    }
    addText('manifest.csv', await manifestCsv(orgId, projectId));
    addText('script.md', await scriptMarkdown(orgId, projectId));
    if (missing.length) addText('MISSING.txt', `These clips could not be included:\n\n${missing.join('\n')}\n`);
    zip.end();
  } catch (e) {
    logger.error('zip export failed', { err: String(e) });
    res.destroy(e instanceof Error ? e : new Error(String(e)));
  }
}
