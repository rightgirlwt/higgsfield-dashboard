import { emitToOrg, getDb } from '../ctx';

export interface AlertRow {
  id: string;
  kind: string;
  severity: 'info' | 'warning' | 'critical';
  message: string;
  acknowledged: boolean;
  created_at: string;
}

export async function createAlert(
  orgId: string,
  a: { kind: string; severity: AlertRow['severity']; message: string; period?: string },
): Promise<AlertRow | null> {
  // `period` makes budget alerts fire once per month per threshold (unique partial index).
  const { rows } = await getDb().query<AlertRow>(
    `INSERT INTO alerts (org_id, kind, severity, message, period) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT DO NOTHING RETURNING id, kind, severity, message, acknowledged, created_at`,
    [orgId, a.kind, a.severity, a.message, a.period ?? null],
  );
  if (rows[0]) emitToOrg(orgId, 'alert:new', rows[0]);
  return rows[0] ?? null;
}

export function monthKey(d = new Date()): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export async function monthToDateSpend(orgId: string): Promise<number> {
  const start = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
  const { rows } = await getDb().query<{ s: number }>(
    'SELECT COALESCE(SUM(cost_usd),0)::float8 AS s FROM usage_events WHERE org_id = $1 AND ts >= $2',
    [orgId, start.toISOString()],
  );
  return rows[0].s;
}

/** Compare month-to-date spend with the org budget and raise threshold/exceeded alerts (once per month). */
export async function checkBudget(orgId: string): Promise<void> {
  const { rows } = await getDb().query<{ monthly_budget_usd: number; alert_threshold_pct: number }>(
    'SELECT monthly_budget_usd, alert_threshold_pct FROM organizations WHERE id = $1',
    [orgId],
  );
  const org = rows[0];
  if (!org || org.monthly_budget_usd <= 0) return;
  const spend = await monthToDateSpend(orgId);
  const pct = (spend / org.monthly_budget_usd) * 100;
  const month = monthKey();
  if (pct >= 100) {
    await createAlert(orgId, {
      kind: 'budget_exceeded',
      severity: 'critical',
      message: `Monthly budget exceeded: $${spend.toFixed(2)} of $${org.monthly_budget_usd.toFixed(2)} (${pct.toFixed(0)}%)`,
      period: `${month}:exceeded`,
    });
  } else if (pct >= org.alert_threshold_pct) {
    await createAlert(orgId, {
      kind: 'budget_threshold',
      severity: 'warning',
      message: `Spend has reached ${pct.toFixed(0)}% of the $${org.monthly_budget_usd.toFixed(2)} monthly budget`,
      period: `${month}:threshold`,
    });
  }
}
