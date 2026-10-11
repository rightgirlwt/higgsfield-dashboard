import { config } from '../config';
import { emitToOrg, getDb } from '../ctx';
import { logger } from '../logger';

export type RunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export type RunKind = 'prompt' | 'workflow' | 'generation';
export const RUN_KINDS: RunKind[] = ['prompt', 'workflow', 'generation'];

export interface RunDto {
  id: string;
  kind: RunKind;
  refId: string | null;
  refName: string;
  status: RunStatus;
  trigger: string;
  model: string | null;
  input: unknown;
  output: unknown;
  error: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number | null;
  simulated: boolean;
  createdBy: string | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);

export function mapRun(r: any): RunDto {
  return {
    id: r.id,
    kind: r.kind,
    refId: r.ref_id,
    refName: r.ref_name,
    status: r.status,
    trigger: r.trigger,
    model: r.model,
    input: r.input,
    output: r.output,
    error: r.error,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    costUsd: r.cost_usd,
    latencyMs: r.latency_ms,
    simulated: r.simulated,
    createdBy: r.created_by,
    queuedAt: iso(r.queued_at)!,
    startedAt: iso(r.started_at),
    finishedAt: iso(r.finished_at),
  };
}

export async function getRun(orgId: string, id: string): Promise<RunDto | null> {
  const { rows } = await getDb().query('SELECT * FROM job_runs WHERE org_id = $1 AND id = $2', [orgId, id]);
  return rows[0] ? mapRun(rows[0]) : null;
}

export async function createRun(p: {
  orgId: string;
  kind: RunKind;
  refId?: string | null;
  refName: string;
  model?: string | null;
  input: unknown;
  createdBy?: string | null;
  trigger?: string;
}): Promise<RunDto> {
  const { rows } = await getDb().query(
    `INSERT INTO job_runs (org_id, kind, ref_id, ref_name, model, input, created_by, trigger)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8) RETURNING *`,
    [p.orgId, p.kind, p.refId ?? null, p.refName, p.model ?? null, JSON.stringify(p.input ?? {}), p.createdBy ?? null, p.trigger ?? 'manual'],
  );
  const run = mapRun(rows[0]);
  runMeta.set(run.id, { kind: run.kind, refId: run.refId, refName: run.refName });
  if (runMeta.size > 2000) runMeta.delete(runMeta.keys().next().value as string);
  emitToOrg(p.orgId, 'job:update', slim(run));
  return run;
}

/** Small in-memory cache so live log events can carry run metadata without a DB lookup per line. */
const runMeta = new Map<string, { kind: RunKind; refId: string | null; refName: string }>();

/** Socket payloads omit the (potentially large) input/output bodies. */
const slim = (r: RunDto) => ({ ...r, input: undefined, output: undefined });

export async function logRun(
  orgId: string,
  runId: string,
  level: 'debug' | 'info' | 'warn' | 'error',
  message: string,
  nodeId?: string,
  data?: unknown,
): Promise<void> {
  const { rows } = await getDb().query<{ id: string; ts: Date }>(
    'INSERT INTO run_logs (run_id, org_id, level, message, node_id, data) VALUES ($1,$2,$3,$4,$5,$6::jsonb) RETURNING id, ts',
    [runId, orgId, level, message, nodeId ?? null, data === undefined ? null : JSON.stringify(data)],
  );
  const meta = runMeta.get(runId);
  emitToOrg(orgId, 'log:new', {
    id: String(rows[0].id), runId, level, message, nodeId: nodeId ?? null, ts: iso(rows[0].ts),
    kind: meta?.kind ?? null, refId: meta?.refId ?? null, refName: meta?.refName ?? null,
  });
}

export interface Outcome {
  output: unknown;
  model?: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  simulated: boolean;
}

export type Work = (ctx: { runId: string; log: (level: 'debug' | 'info' | 'warn' | 'error', msg: string, nodeId?: string, data?: unknown) => Promise<void> }) => Promise<Outcome>;

async function execute(orgId: string, runId: string, work: Work): Promise<RunDto> {
  const db = getDb();
  const started = Date.now();
  // Only a still-queued run may start; a run cancelled while waiting is skipped.
  const claimed = await db.query(`UPDATE job_runs SET status='running', started_at=now() WHERE id=$1 AND status='queued'`, [runId]);
  if (claimed.rowCount === 0) return (await getRun(orgId, runId))!;
  const running = (await getRun(orgId, runId))!;
  emitToOrg(orgId, 'job:update', slim(running));
  const log = (level: 'debug' | 'info' | 'warn' | 'error', msg: string, nodeId?: string, data?: unknown) => logRun(orgId, runId, level, msg, nodeId, data);
  try {
    const o = await work({ runId, log });
    await db.query(
      `UPDATE job_runs SET status='completed', finished_at=now(), latency_ms=$2, output=$3::jsonb, model=COALESCE($4, model),
         input_tokens=$5, output_tokens=$6, cost_usd=$7, simulated=$8 WHERE id=$1`,
      [runId, Date.now() - started, JSON.stringify(o.output ?? null), o.model ?? null, o.inputTokens, o.outputTokens, o.costUsd, o.simulated],
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn('run failed', { runId, message });
    await db.query(`UPDATE job_runs SET status='failed', finished_at=now(), latency_ms=$2, error=$3 WHERE id=$1`, [runId, Date.now() - started, message]);
    await log('error', `Run failed: ${message}`);
  }
  const done = (await getRun(orgId, runId))!;
  emitToOrg(orgId, 'job:update', slim(done));
  return done;
}

interface Pending {
  orgId: string;
  runId: string;
  work: Work;
  resolve: (r: RunDto) => void;
}

/** In-process FIFO queue with bounded concurrency. Run state is persisted so history survives restarts. */
class JobQueue {
  private pending: Pending[] = [];
  private active = 0;

  constructor(private readonly limit: () => number) {}

  enqueue(orgId: string, runId: string, work: Work): Promise<RunDto> {
    return new Promise((resolve) => {
      this.pending.push({ orgId, runId, work, resolve });
      this.pump();
    });
  }

  get size(): number {
    return this.pending.length;
  }
  get running(): number {
    return this.active;
  }

  private pump(): void {
    while (this.active < this.limit() && this.pending.length) {
      const job = this.pending.shift()!;
      this.active++;
      execute(job.orgId, job.runId, job.work)
        .then(job.resolve)
        .catch((e) => logger.error('queue execute crashed', { err: String(e) }))
        .finally(() => {
          this.active--;
          this.pump();
        });
    }
  }
}

export const queue = new JobQueue(() => config.queueConcurrency);

/**
 * Image/video generations spend nearly all their time waiting on the Higgsfield platform (polling),
 * so they get their own, wider lane and never block quick prompt/workflow jobs.
 */
export const generationQueue = new JobQueue(() => config.generationConcurrency);

/** On boot, anything left queued/running by a previous process can never finish — mark it failed. */
export async function recoverInterruptedRuns(): Promise<number> {
  const r = await getDb().query(
    `UPDATE job_runs SET status='failed', error='Interrupted by server restart', finished_at=now()
     WHERE status IN ('queued','running')`,
  );
  return r.rowCount;
}
