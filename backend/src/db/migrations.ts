import type { Db } from './index';
import { logger } from '../logger';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/** Append-only. Never edit an applied migration — add a new one. */
export const migrations: Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    sql: `
CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  monthly_budget_usd double precision NOT NULL DEFAULT 0,
  alert_threshold_pct integer NOT NULL DEFAULT 80,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  clerk_id text UNIQUE,
  email text NOT NULL UNIQUE,
  name text NOT NULL,
  role text NOT NULL DEFAULT 'viewer' CHECK (role IN ('admin','user','viewer')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX users_org_idx ON users(org_id);

CREATE TABLE org_settings (
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key text NOT NULL,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, key)
);

CREATE TABLE secrets (
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  ciphertext text NOT NULL,
  last4 text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, name)
);

CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE prompts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  is_template boolean NOT NULL DEFAULT false,
  tags text[] NOT NULL DEFAULT '{}',
  current_version integer NOT NULL DEFAULT 1,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX prompts_org_idx ON prompts(org_id, updated_at DESC);

CREATE TABLE prompt_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prompt_id uuid NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
  version integer NOT NULL,
  system_prompt text NOT NULL DEFAULT '',
  user_prompt text NOT NULL DEFAULT '',
  model text NOT NULL,
  temperature double precision,
  max_tokens integer NOT NULL DEFAULT 1024,
  variables jsonb NOT NULL DEFAULT '{}'::jsonb,
  note text NOT NULL DEFAULT '',
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (prompt_id, version)
);

CREATE TABLE workflows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  definition jsonb NOT NULL DEFAULT '{"nodes":[],"edges":[]}'::jsonb,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused')),
  version integer NOT NULL DEFAULT 1,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workflows_org_idx ON workflows(org_id, updated_at DESC);

CREATE TABLE job_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('prompt','workflow')),
  ref_id uuid,
  ref_name text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed','cancelled')),
  trigger text NOT NULL DEFAULT 'manual',
  model text,
  input jsonb NOT NULL DEFAULT '{}'::jsonb,
  output jsonb,
  error text,
  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  cost_usd double precision NOT NULL DEFAULT 0,
  latency_ms integer,
  simulated boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  queued_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);
CREATE INDEX job_runs_org_idx ON job_runs(org_id, queued_at DESC);
CREATE INDEX job_runs_status_idx ON job_runs(org_id, status);
CREATE INDEX job_runs_ref_idx ON job_runs(ref_id);

CREATE TABLE run_logs (
  id bigserial PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES job_runs(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  level text NOT NULL DEFAULT 'info' CHECK (level IN ('debug','info','warn','error')),
  message text NOT NULL,
  node_id text,
  data jsonb,
  ts timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX run_logs_run_idx ON run_logs(run_id, id);
CREATE INDEX run_logs_org_idx ON run_logs(org_id, id DESC);

CREATE TABLE media_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('photo','video')),
  title text NOT NULL,
  url text NOT NULL,
  thumb_url text NOT NULL DEFAULT '',
  tags text[] NOT NULL DEFAULT '{}',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  workflow_id uuid REFERENCES workflows(id) ON DELETE SET NULL,
  run_id uuid REFERENCES job_runs(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX media_org_idx ON media_assets(org_id, created_at DESC, id DESC);

CREATE TABLE usage_events (
  id bigserial PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  run_id uuid REFERENCES job_runs(id) ON DELETE SET NULL,
  provider text NOT NULL CHECK (provider IN ('claude','higgsfield')),
  model text NOT NULL DEFAULT '',
  workflow_id uuid REFERENCES workflows(id) ON DELETE SET NULL,
  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  units double precision NOT NULL DEFAULT 0,
  cost_usd double precision NOT NULL DEFAULT 0,
  simulated boolean NOT NULL DEFAULT false,
  ts timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX usage_org_ts_idx ON usage_events(org_id, ts DESC);

CREATE TABLE alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind text NOT NULL,
  severity text NOT NULL DEFAULT 'warning' CHECK (severity IN ('info','warning','critical')),
  message text NOT NULL,
  period text,
  acknowledged boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX alerts_org_idx ON alerts(org_id, created_at DESC);
CREATE UNIQUE INDEX alerts_once_per_period ON alerts(org_id, kind, period) WHERE period IS NOT NULL;
`,
  },
  {
    version: 2,
    name: 'studio_generation_runs',
    sql: `
ALTER TABLE job_runs DROP CONSTRAINT IF EXISTS job_runs_kind_check;
ALTER TABLE job_runs ADD CONSTRAINT job_runs_kind_check CHECK (kind IN ('prompt','workflow','generation'));
CREATE INDEX media_source_idx ON media_assets (org_id, (metadata->>'source'), created_at DESC);
`,
  },
  {
    version: 3,
    name: 'projects_board_and_chat',
    sql: `
ALTER TABLE projects ADD COLUMN type text NOT NULL DEFAULT 'micro_drama' CHECK (type IN ('micro_drama','ad_campaign'));
ALTER TABLE projects ADD COLUMN description text NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN brief jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE projects ADD COLUMN budget_usd double precision NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN aspect text NOT NULL DEFAULT '9:16';
ALTER TABLE projects ADD COLUMN status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived'));
ALTER TABLE projects ADD COLUMN created_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE projects ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX projects_org_idx ON projects(org_id, updated_at DESC);

CREATE TABLE project_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'shot' CHECK (kind IN ('shot','ad_unit')),
  group_name text NOT NULL DEFAULT '',
  position integer NOT NULL DEFAULT 0,
  title text NOT NULL,
  prompt text NOT NULL DEFAULT '',
  notes text NOT NULL DEFAULT '',
  model_id text NOT NULL DEFAULT '',
  mode text NOT NULL DEFAULT '',
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  media jsonb NOT NULL DEFAULT '{}'::jsonb,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','ready','generating','review','approved','rejected')),
  last_error text,
  approved_asset_id uuid REFERENCES media_assets(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX project_items_project_idx ON project_items(project_id, position, created_at);

CREATE TABLE project_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'reference' CHECK (kind IN ('character','product','logo','location','style','reference')),
  name text NOT NULL,
  url text NOT NULL DEFAULT '',
  notes text NOT NULL DEFAULT '',
  character_id text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX project_assets_project_idx ON project_assets(project_id, created_at);

CREATE TABLE chat_threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX chat_threads_project_idx ON chat_threads(project_id);

CREATE TABLE chat_messages (
  id bigserial PRIMARY KEY,
  thread_id uuid NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user','assistant')),
  content jsonb NOT NULL,
  model text,
  cost_usd double precision NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chat_messages_thread_idx ON chat_messages(thread_id, id);
`,
  },
];

export async function migrate(db: Db): Promise<number> {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version integer PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
  const { rows } = await db.query<{ version: number }>('SELECT version FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.version));
  let count = 0;
  for (const m of migrations) {
    if (applied.has(m.version)) continue;
    await db.tx(async (t) => {
      // PGlite's query() runs a single statement; split on the statement terminator we control.
      for (const stmt of splitSql(m.sql)) await t.query(stmt);
      await t.query('INSERT INTO schema_migrations (version, name) VALUES ($1,$2)', [m.version, m.name]);
    });
    logger.info('applied migration', { version: m.version, name: m.name });
    count++;
  }
  return count;
}

/** Split on `;` at end of line. Migrations must not contain `;` inside strings/functions. */
export function splitSql(sql: string): string[] {
  return sql
    .split(/;\s*(?:\r?\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}
