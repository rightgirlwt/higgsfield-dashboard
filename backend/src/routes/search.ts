import { Router } from 'express';
import { getDb } from '../ctx';
import { wrap } from '../lib/errors';
import { likePattern } from './util';

export const search = Router();

/** Global search across prompts, workflows and media (org-scoped, case-insensitive substring). */
search.get(
  '/',
  wrap(async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (q.length < 2) {
      res.json({ prompts: [], workflows: [], media: [] });
      return;
    }
    const org = req.user!.orgId;
    const like = likePattern(q.slice(0, 100));
    const db = getDb();
    const [p, w, m] = await Promise.all([
      db.query(`SELECT DISTINCT p.id, p.name, p.is_template FROM prompts p JOIN prompt_versions v ON v.prompt_id=p.id
                WHERE p.org_id=$1 AND (p.name ILIKE $2 OR p.description ILIKE $2 OR v.user_prompt ILIKE $2 OR v.system_prompt ILIKE $2) LIMIT 6`, [org, like]),
      db.query(`SELECT id, name, status FROM workflows WHERE org_id=$1 AND (name ILIKE $2 OR description ILIKE $2) LIMIT 6`, [org, like]),
      db.query(`SELECT id, title, type, thumb_url FROM media_assets WHERE org_id=$1 AND (title ILIKE $2 OR EXISTS (SELECT 1 FROM unnest(tags) t WHERE t ILIKE $2)) ORDER BY created_at DESC LIMIT 6`, [org, like]),
    ]);
    res.json({
      prompts: p.rows.map((r) => ({ id: r.id, name: r.name, isTemplate: r.is_template })),
      workflows: w.rows,
      media: m.rows.map((r) => ({ id: r.id, title: r.title, type: r.type, thumbUrl: r.thumb_url })),
    });
  }),
);
