import { getDb } from '../ctx';
import { checkBudget } from './alerts';

export interface UsageInput {
  orgId: string;
  runId?: string | null;
  provider: 'claude' | 'higgsfield';
  model?: string;
  workflowId?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  units?: number;
  costUsd: number;
  simulated: boolean;
}

export async function recordUsage(u: UsageInput): Promise<void> {
  await getDb().query(
    `INSERT INTO usage_events (org_id, run_id, provider, model, workflow_id, input_tokens, output_tokens, units, cost_usd, simulated)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [u.orgId, u.runId ?? null, u.provider, u.model ?? '', u.workflowId ?? null, u.inputTokens ?? 0, u.outputTokens ?? 0, u.units ?? 0, u.costUsd, u.simulated],
  );
  await checkBudget(u.orgId);
}
