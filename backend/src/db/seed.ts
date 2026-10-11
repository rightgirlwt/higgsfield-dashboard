import type { Db } from './index';
import { calcCostUsd } from '../lib/pricing';
import { placeholderImage } from '../lib/placeholder';
import { WORKFLOW_TEMPLATES } from '../services/templates';
import { logger } from '../logger';

/** Small deterministic PRNG so demo data is stable between boots. */
function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

const DAY = 86_400_000;

/**
 * Demo seed (dev only). Every usage event / run it creates is flagged `simulated = true`,
 * so the UI can label it as demo data rather than passing it off as real spend.
 */
export async function seedDemo(db: Db): Promise<boolean> {
  const existing = await db.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM users');
  if (existing.rows[0].n > 0) return false;
  const rand = rng(42);
  const pick = <T>(a: T[]) => a[Math.floor(rand() * a.length)];

  const org = (await db.query<{ id: string }>(`INSERT INTO organizations (name, monthly_budget_usd, alert_threshold_pct) VALUES ('Demo Studio', 400, 80) RETURNING id`)).rows[0].id;
  const mkUser = async (email: string, name: string, role: string) =>
    (await db.query<{ id: string }>('INSERT INTO users (org_id, email, name, role) VALUES ($1,$2,$3,$4) RETURNING id', [org, email, name, role])).rows[0].id;
  const admin = await mkUser('admin@demo.local', 'Demo Admin', 'admin');
  const user = await mkUser('user@demo.local', 'Demo User', 'user');
  await mkUser('viewer@demo.local', 'Demo Viewer', 'viewer');

  const project = (await db.query<{ id: string }>(`INSERT INTO projects (org_id, name) VALUES ($1,'Default project') RETURNING id`, [org])).rows[0].id;

  // Prompts + versions
  const prompts = [
    { name: 'Scene captioning', tpl: true, model: 'claude-sonnet-5-5', sys: 'You write concise captions for generated media.', usr: 'Write a caption for a {{style}} scene showing {{subject}}.' },
    { name: 'Customer QA review', tpl: false, model: 'claude-opus-5-5', sys: 'You are a meticulous QA reviewer.', usr: 'Review this support transcript and list issues:\n\n{{transcript}}' },
    { name: 'Workflow summary', tpl: true, model: 'claude-haiku-5-5', sys: '', usr: 'Summarize this workflow log in two sentences:\n{{log}}' },
  ];
  for (const p of prompts) {
    const id = (await db.query<{ id: string }>(
      `INSERT INTO prompts (org_id, name, is_template, current_version, created_by, tags) VALUES ($1,$2,$3,2,$4,$5) RETURNING id`,
      [org, p.name, p.tpl, admin, p.tpl ? ['template'] : []],
    )).rows[0].id;
    for (const v of [1, 2]) {
      await db.query(
        `INSERT INTO prompt_versions (prompt_id, version, system_prompt, user_prompt, model, max_tokens, note, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, v, p.sys, v === 2 ? p.usr : p.usr.replace('concise ', ''), p.model, 512, v === 1 ? 'First draft' : 'Tightened wording', admin],
      );
    }
  }

  // Workflows from templates (two active)
  const wfIds: { id: string; name: string }[] = [];
  for (const [i, t] of WORKFLOW_TEMPLATES.slice(0, 3).entries()) {
    const id = (await db.query<{ id: string }>(
      `INSERT INTO workflows (org_id, project_id, name, description, definition, status, created_by) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7) RETURNING id`,
      [org, project, t.name, t.description, JSON.stringify(t.definition), i < 2 ? 'active' : 'draft', user],
    )).rows[0].id;
    wfIds.push({ id, name: t.name });
  }

  // 45 days of runs + usage (all flagged simulated)
  const models = ['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5-5', 'claude-sonnet-5-5'];
  const now = Date.now();
  for (let d = 44; d >= 0; d--) {
    const perDay = 2 + Math.floor(rand() * 5);
    for (let k = 0; k < perDay; k++) {
      const ts = new Date(now - d * DAY - Math.floor(rand() * 18) * 3600_000);
      const model = pick(models);
      const inT = 300 + Math.floor(rand() * 4000);
      const outT = 100 + Math.floor(rand() * 1500);
      const cost = calcCostUsd(model, inT, outT) * (6 + rand() * 10); // scaled up so a demo month has visible spend
      const isWf = rand() < 0.5;
      const wf = isWf ? pick(wfIds) : null;
      const failed = rand() < 0.07;
      const latency = 600 + Math.floor(rand() * 2600);
      const run = (await db.query<{ id: string }>(
        `INSERT INTO job_runs (org_id, kind, ref_id, ref_name, status, model, input, output, error, input_tokens, output_tokens, cost_usd, latency_ms, simulated, created_by, queued_at, started_at, finished_at)
         VALUES ($1,$2,$3,$4,$5,$6,'{}'::jsonb,$7::jsonb,$8,$9,$10,$11,$12,true,$13,$14,$14,$15) RETURNING id`,
        [org, isWf ? 'workflow' : 'prompt', wf?.id ?? null, wf?.name ?? pick(prompts).name, failed ? 'failed' : 'completed', model, failed ? null : JSON.stringify({ result: 'Demo output' }), failed ? 'Upstream timeout (demo)' : null, failed ? 0 : inT, failed ? 0 : outT, failed ? 0 : cost, latency, user, ts.toISOString(), new Date(ts.getTime() + latency).toISOString()],
      )).rows[0].id;
      await db.query(`INSERT INTO run_logs (run_id, org_id, level, message, ts) VALUES ($1,$2,$3,$4,$5)`, [run, org, failed ? 'error' : 'info', failed ? 'Run failed: upstream timeout (demo)' : 'Run completed (demo)', ts.toISOString()]);
      if (!failed) {
        await db.query(
          `INSERT INTO usage_events (org_id, run_id, provider, model, workflow_id, input_tokens, output_tokens, cost_usd, simulated, ts) VALUES ($1,$2,'claude',$3,$4,$5,$6,$7,true,$8)`,
          [org, run, model, wf?.id ?? null, inT, outT, cost, ts.toISOString()],
        );
      }
      if (rand() < 0.25) {
        await db.query(
          `INSERT INTO usage_events (org_id, run_id, provider, model, workflow_id, units, cost_usd, simulated, ts) VALUES ($1,$2,'higgsfield','generation',$3,$4,$5,true,$6)`,
          [org, run, wf?.id ?? null, 20 + Math.floor(rand() * 60), 0.3 + rand() * 1.4, ts.toISOString()],
        );
      }
    }
  }

  // Media timeline
  const subjects = ['Warehouse scan', 'Dock camera frame', 'Operator walkthrough', 'Inspection snapshot', 'Product hero shot', 'Studio b-roll', 'Packaging review', 'Lobby feed'];
  const tagPool = ['motion', 'inventory', 'dock', 'alerts', 'ops', 'review', 'quality', 'marketing', 'hero'];
  for (let i = 0; i < 64; i++) {
    const type = rand() < 0.4 ? 'video' : 'photo';
    const title = `${pick(subjects)} #${100 + i}`;
    const ts = new Date(now - i * 0.7 * DAY - Math.floor(rand() * 10) * 3600_000);
    const tags = [...new Set([pick(tagPool), pick(tagPool)])];
    const wf = rand() < 0.6 ? pick(wfIds) : null;
    const thumb = placeholderImage(title, type as 'photo' | 'video', String(i));
    await db.query(
      `INSERT INTO media_assets (org_id, type, title, url, thumb_url, tags, metadata, workflow_id, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)`,
      [org, type, title, type === 'video' ? 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4' : thumb, thumb, tags, JSON.stringify({ width: 1920, height: 1080, ...(type === 'video' ? { durationSec: 5 + Math.floor(rand() * 40) } : {}), demo: true }), wf?.id ?? null, ts.toISOString()],
    );
  }

  await db.query(`INSERT INTO alerts (org_id, kind, severity, message) VALUES ($1,'demo','info','Welcome! This workspace is pre-loaded with demo data (flagged as simulated).')`, [org]);
  logger.info('seeded demo data', { org });
  return true;
}
