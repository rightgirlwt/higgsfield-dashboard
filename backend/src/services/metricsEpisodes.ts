import { getDb } from '../ctx';
import { badRequest, notFound } from '../lib/errors';

/**
 * Ties an Instagram post to an episode of a project (a micro drama), so what the episode cost to make can sit next to the views and
 * follows it earned. The cost is what the project's finished generations were billed, summed over the shots in that episode.
 */

export interface PostLink {
  projectId: string;
  projectName: string;
  episode: number;
  /** What the episode's shots cost to generate, in USD. */
  spendUsd: number;
}

/** The episode a shot belongs to, from the text it is filed under ("Ep 4 · Scene 2"). Mirrors frontend/src/lib/episodes.ts. */
export function episodeOfGroup(group: string): number | null {
  const m = /^\s*ep(?:isode)?\.?\s*(\d+)/i.exec(group);
  return m ? Number(m[1]) : null;
}

/** Generation cost per episode number for one project. */
export async function episodeSpend(orgId: string, projectId: string): Promise<Map<number, number>> {
  const { rows } = await getDb().query<{ group_name: string; usd: number }>(
    `SELECT i.group_name, COALESCE(SUM(j.cost_usd),0)::float8 AS usd
       FROM project_items i
       LEFT JOIN job_runs j ON j.org_id=i.org_id AND j.kind='generation' AND j.status='completed' AND j.input->>'itemId' = i.id::text
      WHERE i.org_id=$1 AND i.project_id=$2
      GROUP BY i.group_name`,
    [orgId, projectId],
  );
  const out = new Map<number, number>();
  for (const r of rows) {
    const ep = episodeOfGroup(r.group_name);
    if (ep !== null) out.set(ep, (out.get(ep) ?? 0) + r.usd);
  }
  return out;
}

/** The links for a set of posts, with each episode's cost worked out once per project. */
export async function linksFor(orgId: string, posts: { id: string; project_id: string | null; episode: number | null }[]): Promise<Map<string, PostLink>> {
  const linked = posts.filter((p) => p.project_id && p.episode !== null);
  const out = new Map<string, PostLink>();
  if (linked.length === 0) return out;
  const ids = [...new Set(linked.map((p) => p.project_id as string))];
  const names = await getDb().query<{ id: string; name: string }>('SELECT id, name FROM projects WHERE org_id=$1 AND id = ANY($2::uuid[])', [orgId, ids]);
  const nameOf = new Map(names.rows.map((r) => [r.id, r.name]));
  const spend = new Map<string, Map<number, number>>();
  for (const id of ids) spend.set(id, await episodeSpend(orgId, id));
  for (const p of linked) {
    const name = nameOf.get(p.project_id as string);
    if (name === undefined) continue;
    out.set(p.id, { projectId: p.project_id as string, projectName: name, episode: p.episode as number, spendUsd: Math.round((spend.get(p.project_id as string)?.get(p.episode as number) ?? 0) * 100) / 100 });
  }
  return out;
}

/** Sets or clears which episode a post is. A null link clears it. */
export async function linkPost(orgId: string, postId: string, link: { projectId: string; episode: number } | null) {
  const db = getDb();
  const post = await db.query('SELECT 1 FROM ig_posts p JOIN ig_accounts a ON a.id=p.account_id WHERE p.id=$1 AND a.org_id=$2', [postId, orgId]);
  if (post.rowCount === 0) throw notFound('Post not found');
  if (link) {
    if (!Number.isInteger(link.episode) || link.episode < 1 || link.episode > 9999) throw badRequest('The episode is a whole number, 1 or more.');
    const p = await db.query('SELECT 1 FROM projects WHERE id=$1 AND org_id=$2', [link.projectId, orgId]);
    if (p.rowCount === 0) throw notFound('Project not found');
  }
  await db.query('UPDATE ig_posts SET project_id=$2, episode=$3 WHERE id=$1', [postId, link?.projectId ?? null, link?.episode ?? null]);
}
