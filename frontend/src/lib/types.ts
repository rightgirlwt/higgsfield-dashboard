export type Role = 'admin' | 'user' | 'viewer';
export type RunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface Me {
  id: string;
  orgId: string;
  email: string;
  name: string;
  role: Role;
  authProvider: 'dev' | 'clerk';
}

export interface ModelInfo {
  id: string;
  label: string;
  inputPerMTok: number;
  outputPerMTok: number;
  supportsTemperature: boolean;
  maxOutputTokens: number;
  tier: 'frontier' | 'balanced' | 'fast';
}

export interface Summary {
  rangeDays: number;
  spend: { value: number; deltaPct: number | null };
  tokens: number;
  promptRuns: { value: number; deltaPct: number | null };
  activeWorkflows: { value: number; total: number };
  mediaAssets: { value: number; added: number; deltaPct: number | null };
  budget: { monthlyUsd: number; monthToDateUsd: number; pct: number | null; alertThresholdPct: number };
  includesSimulatedData: boolean;
}

export interface SpendPoint {
  date: string;
  claude: number;
  higgsfield: number;
  total: number;
}

export interface BreakdownRow {
  key: string;
  label: string;
  costUsd: number;
  events: number;
  tokens: number;
}

export interface Run {
  id: string;
  kind: 'prompt' | 'workflow' | 'generation';
  refId: string | null;
  refName: string;
  status: RunStatus;
  trigger: string;
  model: string | null;
  input?: any;
  output?: any;
  error: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number | null;
  simulated: boolean;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface RunLog {
  id: string;
  runId: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  nodeId: string | null;
  ts: string;
  kind?: 'prompt' | 'workflow' | 'generation' | null;
  refId?: string | null;
  refName?: string | null;
  runStatus?: RunStatus | null;
}

export interface Snapshot {
  apiHealthPct: number;
  latencyMs: number;
  latencyP95Ms: number;
  queueSize: number;
  activeJobs: number;
  runsLastHour: number;
  failuresLastHour: number;
  tokensLastHour: number;
  spendToday: number;
  claudeConfigured: boolean;
  higgsfieldConfigured: boolean;
  lastUpdated: string;
}

export interface Alert {
  id: string;
  kind: string;
  severity: 'info' | 'warning' | 'critical';
  message: string;
  acknowledged: boolean;
  createdAt: string;
}

export interface PromptSummary {
  id: string;
  name: string;
  description: string;
  isTemplate: boolean;
  tags: string[];
  currentVersion: number;
  updatedAt: string;
  model: string;
  preview: string;
}

export interface PromptVersion {
  id: string;
  version: number;
  systemPrompt: string;
  userPrompt: string;
  model: string;
  temperature: number | null;
  maxTokens: number;
  variables: Record<string, string>;
  note: string;
  createdAt: string;
}

export interface PromptDetail {
  prompt: Omit<PromptSummary, 'model' | 'preview'>;
  versions: PromptVersion[];
  variableNames: string[];
}

export type NodeType = 'trigger' | 'llm' | 'generate' | 'transform' | 'action' | 'output';

export type MediaRole = 'start' | 'end' | 'reference' | 'video' | 'audio';

export type ParamSpec =
  | { type: 'enum'; label: string; values: string[]; default: string; numeric?: boolean; advanced?: boolean }
  | { type: 'int'; label: string; min: number; max: number; default: number; advanced?: boolean }
  | { type: 'number'; label: string; min: number; max: number; step: number; default: number; advanced?: boolean }
  | { type: 'boolean'; label: string; default: boolean; as?: 'bool' | 'onoff' | 'yesno'; advanced?: boolean }
  | { type: 'text'; label: string; maxLength: number; advanced?: boolean }
  | { type: 'seed'; label: string; min: number; max: number; advanced?: boolean }
  | { type: 'character'; label: string; advanced?: boolean };

export interface MediaInput {
  param: string;
  role: MediaRole;
  label: string;
  hint?: string;
  required?: boolean;
  max: number;
  array: boolean;
}

export interface StudioMode {
  id: string;
  label: string;
  path: string;
  promptRequired?: boolean;
  params: Record<string, ParamSpec>;
  media: MediaInput[];
}

export interface StudioModel {
  id: string;
  label: string;
  surface: 'image' | 'video';
  family: string;
  description: string;
  priceUnit: 'output' | 'second';
  modes: StudioMode[];
  note?: string;
  priceUsd: number | null;
}

export interface StudioCatalog {
  connected: boolean;
  baseUrlSet: boolean;
  soulIdPriceUsd: number;
  models: StudioModel[];
}

export interface Character {
  id: string;
  name: string;
  status: string;
  thumbnailUrl: string | null;
}

export interface WfNodeData {
  label?: string;
  [k: string]: any;
}
export interface WfNode {
  id: string;
  type: NodeType;
  position: { x: number; y: number };
  data: WfNodeData;
}
export interface WfEdge {
  id: string;
  source: string;
  target: string;
}
export interface WorkflowDefinition {
  nodes: WfNode[];
  edges: WfEdge[];
}
export interface ValidationIssue {
  level: 'error' | 'warning';
  message: string;
  nodeId?: string;
}

export interface WorkflowListItem {
  id: string;
  name: string;
  description: string;
  status: 'draft' | 'active' | 'paused';
  version: number;
  nodeCount: number;
  runCount: number;
  lastStatus: RunStatus | null;
  lastRunAt: string | null;
  updatedAt: string;
}

export interface Workflow {
  id: string;
  name: string;
  description: string;
  status: 'draft' | 'active' | 'paused';
  version: number;
  definition: WorkflowDefinition;
  issues?: ValidationIssue[];
}

export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  category: string;
  nodeCount: number;
}

export interface MediaItem {
  id: string;
  type: 'photo' | 'video';
  title: string;
  url: string;
  thumbUrl: string;
  tags: string[];
  metadata: Record<string, any>;
  workflowId: string | null;
  workflowName: string | null;
  createdAt: string;
}

export interface SecretStatus {
  name: 'anthropic' | 'higgsfield' | 's3_access_key_id' | 's3_secret_access_key';
  configured: boolean;
  source: 'stored' | 'environment' | 'none';
  last4: string | null;
  updatedAt: string | null;
  format?: string;
  formatOk?: boolean;
}

export interface TeamUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  joinedAt: string;
  linked: boolean;
}

export interface SettingsData {
  organization: { name: string };
  defaults: { model: string; maxTokens: number; temperature: number | null };
  storage: { endpoint: string; region: string; bucket: string; publicBaseUrl: string; forcePathStyle: boolean };
  billing: { monthlyBudgetUsd: number; alertThresholdPct: number };
  models: ModelInfo[];
  higgsfield: { baseUrl: string; baseUrlFromEnv: boolean; prices: Record<string, number | null> };
}

export interface SearchResults {
  prompts: { id: string; name: string; isTemplate: boolean }[];
  workflows: { id: string; name: string; status: string }[];
  media: { id: string; title: string; type: string; thumbUrl: string }[];
}
