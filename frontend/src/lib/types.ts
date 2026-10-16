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

export type NodeType = 'trigger' | 'llm' | 'generate' | 'foreach' | 'transform' | 'action' | 'output';

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

export interface ListPrice {
  unit: 'image' | 'second';
  min: number;
  max: number;
  byResolution?: Record<string, number>;
  promoEnds?: string;
  assumedSeconds?: number;
}

export interface StudioMode {
  id: string;
  label: string;
  path: string;
  /** Higgsfield's published price for this mode (a snapshot), or null if unknown. */
  price: ListPrice | null;
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
  pricesAsOf: string;
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
  projectId?: string | null;
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
  name: 'anthropic' | 'higgsfield' | 'elevenlabs' | 's3_access_key_id' | 's3_secret_access_key';
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
  higgsfield: { baseUrl: string; baseUrlFromEnv: boolean; prices: Record<string, number | null>; priceCheck: PriceCheck | null; promoEnds: string | null };
}

export interface SearchResults {
  prompts: { id: string; name: string; isTemplate: boolean }[];
  workflows: { id: string; name: string; status: string }[];
  media: { id: string; title: string; type: string; thumbUrl: string }[];
}

// ---- projects (board + director chat) ---------------------------------------------------------------
export type ProjectTypeId = 'micro_drama' | 'ad_campaign';
export type ItemStatus = 'draft' | 'ready' | 'generating' | 'review' | 'approved' | 'rejected';

export interface BriefField {
  key: string;
  label: string;
  placeholder: string;
  rows: number;
}
export interface ProjectTypeDef {
  id: ProjectTypeId;
  label: string;
  description: string;
  itemKind: 'shot' | 'ad_unit';
  itemLabel: string;
  groupLabel: string;
  defaultAspect: string;
  briefFields: BriefField[];
  starters: string[];
}
export interface Project {
  id: string;
  name: string;
  description: string;
  type: ProjectTypeId;
  brief: Record<string, string>;
  budgetUsd: number;
  aspect: string;
  status: 'active' | 'archived';
  createdAt: string;
  updatedAt: string;
  itemCount?: number;
  approvedCount?: number;
  spentUsd?: number;
}
export type ItemEstimate =
  | { itemId: string; ok: true; costUsd: number | null; outputs: number; seconds: number; unitUsd: number | null; basis: 'admin' | 'list' | 'live' | null; precision: 'exact' | 'from' | null; model: string; mode: string; promoEnds: string | null }
  | { itemId: string; ok: false; reason: string };
export interface Take {
  id: string;
  itemId: string;
  type: 'photo' | 'video';
  url: string;
  thumbUrl: string;
  title: string;
  createdAt: string;
}
export interface BoardItem {
  id: string;
  projectId: string;
  kind: 'shot' | 'ad_unit';
  group: string;
  position: number;
  title: string;
  prompt: string;
  notes: string;
  modelId: string;
  mode: string;
  settings: Record<string, any>;
  media: Partial<Record<MediaRole, string[]>>;
  meta: Record<string, any>;
  status: ItemStatus;
  lastError: string | null;
  approvedAssetId: string | null;
  estimate: ItemEstimate;
  takes: Take[];
  takeCount: number;
}
export interface ProjectAsset {
  id: string;
  kind: 'character' | 'product' | 'logo' | 'location' | 'style' | 'reference';
  name: string;
  url: string;
  notes: string;
  characterId: string;
}
export interface ProjectSpend {
  generationUsd: number;
  chatUsd: number;
  inFlightUsd: number;
  totalUsd: number;
}
export interface ProjectSnapshot {
  project: Project;
  type: ProjectTypeDef;
  items: BoardItem[];
  assets: ProjectAsset[];
  workflows: { id: string; name: string; status: string; updatedAt: string }[];
  spend: ProjectSpend;
  totalEstimateUsd: number;
}
export interface EstimateResult {
  estimates: ItemEstimate[];
  totalUsd: number;
  unpriced: string[];
  blocked: { itemId: string; reason: string }[];
  budgetUsd: number;
  spend: ProjectSpend;
  budgetLeftUsd: number | null;
}
export interface ChatBlock {
  type: 'text' | 'tool';
  text?: string;
  name?: string;
  summary?: string;
  error?: boolean;
}
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  blocks: ChatBlock[];
  costUsd: number;
  createdAt: string;
}
export interface ChatChanged {
  board: boolean;
  brief: boolean;
  workflows: boolean;
  assets: boolean;
}

export interface WorkflowEstimate {
  totalUsd: number;
  upTo: boolean;
  steps: { nodeId: string; label: string; items: number; costUsd: number | null; note?: string }[];
  unpriced: boolean;
  problems: string[];
  budget: { budgetUsd: number; spentUsd: number; leftUsd: number | null } | null;
}

export interface PriceRow {
  modelId: string;
  model: string;
  modeId: string;
  mode: string;
  snapshotUsd: number | null;
  liveUsd: number | null;
  diffPct: number | null;
  status: 'match' | 'changed' | 'info' | 'error';
  description?: string;
  note?: string;
}
export interface PriceCheck {
  checkedAt: string;
  snapshotDate: string;
  rows: PriceRow[];
  counts: { match: number; changed: number; info: number; error: number };
}
export interface CreditStatus {
  provider: 'claude' | 'higgsfield';
  set: boolean;
  startingUsd: number | null;
  asOf: string | null;
  usedSinceUsd: number;
  lifetimeUsedUsd: number;
  remainingUsd: number | null;
  low: boolean;
}
