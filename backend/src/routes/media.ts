import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../ctx';
import { badRequest, notFound, wrap } from '../lib/errors';
import { placeholderImage } from '../lib/placeholder';
import { createUploadUrl } from '../services/storage';
import { isUuid, likePattern, toCsv, uuidParam } from './util';

export const media = Router();

const mapMedia = (m: any) => ({
  id: m.id, type: m.type, title: m.title, url: m.url, thumbUrl: m.thumb_url, tags: m.tags, metadata: m.metadata,
  workflowId: m.workflow_id, workflowName: m.workflow_name ?? null, runId: m.run_id, createdAt: new Date(m.created_at).toISOString(),
});

function filters(req: any, startIdx = 1) {
  const params: unknown[] = [req.user.orgId];
  const where: string[] = ['m.org_id = $1'];
  const add = (sql: string, v: unknown) => (params.push(v), where.push(sql.replace('?', `$${params.length}`)));
  if (req.query.type === 'photo' || req.query.type === 'video') add('m.type = ?', req.query.type);
  if (typeof req.query.tag === 'string' && req.query.tag) add('? = ANY(m.tags)', req.query.tag.toLowerCase());
  if (isUuid(req.query.workflowId)) add('m.workflow_id = ?', req.query.workflowId);
  if (req.query.source === 'studio') add("m.metadata->>'source' = ?", 'studio');
  if (isUuid(req.query.runId)) add('m.run_id = ?', req.query.runId);
  if (typeof req.query.from === 'string' && !Number.isNaN(Date.parse(req.query.from))) add('m.created_at >= ?', new Date(req.query.from).toISOString());
  if (typeof req.query.to === 'string' && !Number.isNaN(Date.parse(req.query.to))) {
    // `to` is an inclusive calendar day when given as YYYY-MM-DD.
    const d = new Date(req.query.to);
    if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.to)) d.setUTCDate(d.getUTCDate() + 1);
    add('m.created_at < ?', d.toISOString());
  }
  if (typeof req.query.q === 'string' && req.query.q.trim()) add('(m.title ILIKE ? )', likePattern(req.query.q.trim()));
  void startIdx;
  return { params, where };
}

/** Keyset pagination on (created_at, id) so infinite scroll stays stable while new assets arrive. */
media.get(
  '/',
  wrap(async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 24, 1), 60);
    const { params, where } = filters(req);
    const countParams = [...params];
    const countWhere = where.join(' AND ');
    if (typeof req.query.cursor === 'string' && req.query.cursor) {
      const [ts, id] = Buffer.from(req.query.cursor, 'base64url').toString().split('|');
      if (!ts || !isUuid(id) || Number.isNaN(Date.parse(ts))) throw badRequest('Invalid cursor');
      params.push(ts, id);
      where.push(`(m.created_at, m.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
    }
    params.push(limit + 1);
    const db = getDb();
    const [list, total] = await Promise.all([
      db.query(
        `SELECT m.*, w.name AS workflow_name FROM media_assets m LEFT JOIN workflows w ON w.id = m.workflow_id
         WHERE ${where.join(' AND ')} ORDER BY m.created_at DESC, m.id DESC LIMIT $${params.length}`,
        params,
      ),
      db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM media_assets m WHERE ${countWhere}`, countParams),
    ]);
    const rows = list.rows.slice(0, limit);
    const last = rows[rows.length - 1];
    res.json({
      items: rows.map(mapMedia),
      total: total.rows[0].n,
      nextCursor: list.rows.length > limit && last ? Buffer.from(`${new Date(last.created_at).toISOString()}|${last.id}`).toString('base64url') : null,
    });
  }),
);

media.get(
  '/tags',
  wrap(async (req, res) => {
    const { rows } = await getDb().query<{ tag: string; n: number }>(
      `SELECT t AS tag, COUNT(*)::int AS n FROM media_assets, unnest(tags) AS t WHERE org_id=$1 GROUP BY t ORDER BY n DESC, t LIMIT 100`,
      [req.user!.orgId],
    );
    res.json(rows);
  }),
);

media.get(
  '/export',
  wrap(async (req, res) => {
    const { params, where } = filters(req);
    const { rows } = await getDb().query(
      `SELECT m.*, w.name AS workflow_name FROM media_assets m LEFT JOIN workflows w ON w.id = m.workflow_id
       WHERE ${where.join(' AND ')} ORDER BY m.created_at DESC LIMIT 10000`,
      params,
    );
    const items = rows.map(mapMedia);
    if (req.query.format === 'json') {
      res.setHeader('Content-Disposition', 'attachment; filename="media-export.json"');
      res.json(items.map((i) => ({ ...i, thumbUrl: undefined })));
      return;
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="media-export.csv"');
    res.send(
      toCsv(
        ['id', 'type', 'title', 'created_at', 'tags', 'workflow', 'url'],
        items.map((i) => [i.id, i.type, i.title, i.createdAt, i.tags.join('|'), i.workflowName ?? '', i.url.startsWith('data:') ? '(generated placeholder)' : i.url]),
      ),
    );
  }),
);

const httpUrl = z.string().url().max(2000).refine((u) => /^https?:\/\//i.test(u), 'Must be an http(s) URL');

media.post(
  '/',
  wrap(async (req, res) => {
    const b = z
      .object({
        type: z.enum(['photo', 'video']),
        title: z.string().min(1).max(200),
        url: httpUrl,
        thumbUrl: httpUrl.optional(),
        tags: z.array(z.string().min(1).max(30)).max(20).default([]),
        workflowId: z.string().uuid().optional(),
        metadata: z.record(z.string(), z.any()).default({}),
      })
      .parse(req.body);
    const { rows } = await getDb().query(
      `INSERT INTO media_assets (org_id, type, title, url, thumb_url, tags, metadata, workflow_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8) RETURNING *`,
      [req.user!.orgId, b.type, b.title, b.url, b.thumbUrl ?? (b.type === 'photo' ? b.url : placeholderImage(b.title, 'video')), [...new Set(b.tags.map((t) => t.toLowerCase()))], JSON.stringify(b.metadata), b.workflowId ?? null],
    );
    res.status(201).json(mapMedia(rows[0]));
  }),
);

media.post(
  '/upload-url',
  wrap(async (req, res) => {
    const b = z.object({ filename: z.string().min(1).max(200), contentType: z.string().max(100) }).parse(req.body);
    res.json(await createUploadUrl(req.user!.orgId, b.filename, b.contentType));
  }),
);

media.delete(
  '/:id',
  wrap(async (req, res) => {
    const r = await getDb().query('DELETE FROM media_assets WHERE id=$1 AND org_id=$2', [uuidParam(req), req.user!.orgId]);
    if (r.rowCount === 0) throw notFound('Media not found');
    res.status(204).end();
  }),
);

