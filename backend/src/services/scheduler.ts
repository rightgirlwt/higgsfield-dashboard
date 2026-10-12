import { getDb } from '../ctx';
import { logger } from '../logger';
import { createAlert } from './alerts';
import { createRun, queue } from './jobs';
import { estimateWorkflow, workflowWork, type WorkflowDefinition } from './workflowEngine';

let timer: NodeJS.Timeout | null = null;

/** Once a minute, start any ACTIVE workflow whose schedule trigger is due. */
export async function tick(now = Date.now()): Promise<number> {
  const db = getDb();
  const { rows } = await db.query<{ id: string; org_id: string; name: string; definition: WorkflowDefinition; project_id: string | null; last: Date | null }>(
    `SELECT w.id, w.org_id, w.name, w.definition, w.project_id,
            (SELECT MAX(queued_at) FROM job_runs r WHERE r.ref_id = w.id AND r.trigger = 'schedule') AS last
     FROM workflows w WHERE w.status = 'active'`,
  );
  let started = 0;
  for (const w of rows) {
    const trig = w.definition.nodes.find((n) => n.type === 'trigger');
    if (!trig || trig.data.source !== 'schedule') continue;
    const minutes = Math.max(1, Number(trig.data.intervalMinutes) || 60);
    if (w.last && now - new Date(w.last).getTime() < minutes * 60_000) continue;
    const rec = { id: w.id, name: w.name, definition: w.definition, projectId: w.project_id };
    // Nobody is watching a scheduled run, so it must never spend money on its own: those workflows are run by hand, after the cost is confirmed.
    const est = await estimateWorkflow(w.org_id, rec).catch(() => null);
    if (!est || est.steps.length > 0) {
      await createAlert(w.org_id, {
        kind: 'schedule_skipped',
        severity: 'warning',
        message: `Scheduled run of "${w.name}" was skipped because it generates media (about $${(est?.totalUsd ?? 0).toFixed(2)}). Run it manually to confirm the cost.`,
        period: `skip:${w.id}:${new Date(now).toISOString().slice(0, 10)}`,
      });
      continue;
    }
    const run = await createRun({ orgId: w.org_id, kind: 'workflow', refId: w.id, refName: w.name, input: {}, trigger: 'schedule' });
    void queue.enqueue(w.org_id, run.id, workflowWork(w.org_id, rec, {}));
    started++;
  }
  return started;
}

export function startScheduler(): void {
  if (timer) return;
  timer = setInterval(() => {
    tick().catch((e) => logger.error('scheduler tick failed', { err: String(e) }));
  }, 60_000);
  timer.unref();
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
