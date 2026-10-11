import { BookmarkPlus, Columns2, GitCommitVertical, Play, Plus, Save, Search, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useCan } from '../auth/context';
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, Field, Input, Modal, PageHeader, Select, Skeleton, StatusBadge, Textarea } from '../components/ui';
import { api, errorMessage, qs } from '../lib/api';
import { estimateTokens, extractVariables, ms, num, price, timeAgo, usd } from '../lib/format';
import { useApi, useDebounced, useDocumentTitle } from '../lib/hooks';
import type { ModelInfo, PromptDetail, PromptSummary, PromptVersion, Run } from '../lib/types';
import { useToast } from '../state/Toast';

interface RunResponse {
  run: Run;
  missingVariables: string[];
  temperatureIgnored: boolean;
}
interface CompareResponse {
  results: { label: string; run: Run; missingVariables: string[] }[];
}

interface Draft {
  name: string;
  description: string;
  system: string;
  user: string;
  model: string;
  temperature: number | null;
  maxTokens: number;
  variables: Record<string, string>;
  isTemplate: boolean;
  note: string;
}

const EMPTY: Draft = {
  name: '',
  description: '',
  system: '',
  user: '',
  model: 'claude-sonnet-5-5',
  temperature: null,
  maxTokens: 1024,
  variables: {},
  isTemplate: false,
  note: '',
};

function fromVersion(p: PromptDetail['prompt'], v: PromptVersion): Draft {
  return { name: p.name, description: p.description, system: v.systemPrompt, user: v.userPrompt, model: v.model, temperature: v.temperature, maxTokens: v.maxTokens, variables: v.variables ?? {}, isTemplate: p.isTemplate, note: '' };
}

export default function PromptStudio() {
  useDocumentTitle('Prompt Studio');
  const toast = useToast();
  const canWrite = useCan('user');
  const [params, setParams] = useSearchParams();
  const selectedId = params.get('id');

  const models = useApi<ModelInfo[]>('/models');
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const [onlyTemplates, setOnlyTemplates] = useState(false);
  const library = useApi<PromptSummary[]>(`/prompts${qs({ q: dq, template: onlyTemplates && 'true' })}`);
  const detail = useApi<PromptDetail>(selectedId ? `/prompts/${selectedId}` : null);
  const history = useApi<Run[]>('/prompts/runs?limit=8');

  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [loadedVersion, setLoadedVersion] = useState<number | null>(null);
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<RunResponse | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [compareOpen, setCompareOpen] = useState(false);

  // Load the selected prompt's current version into the editor.
  useEffect(() => {
    if (!selectedId) return;
    const d = detail.data;
    if (d && d.prompt.id === selectedId) {
      setDraft(fromVersion(d.prompt, d.versions[0]));
      setLoadedVersion(d.versions[0].version);
      setResult(null);
      setRunError(null);
    }
  }, [selectedId, detail.data]);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const model = models.data?.find((m) => m.id === draft.model);
  const varNames = useMemo(() => extractVariables(draft.system, draft.user), [draft.system, draft.user]);

  const rendered = useMemo(() => {
    const sub = (t: string) => t.replace(/\{\{\s*([a-zA-Z_][\w.-]*)\s*\}\}/g, (_m, n: string) => draft.variables[n] ?? '');
    return sub(draft.system) + sub(draft.user);
  }, [draft.system, draft.user, draft.variables]);
  const inTok = estimateTokens(rendered);
  const maxCost = model ? (inTok / 1e6) * model.inputPerMTok + (draft.maxTokens / 1e6) * model.outputPerMTok : 0;

  const newPrompt = () => {
    setParams({});
    setDraft(EMPTY);
    setLoadedVersion(null);
    setResult(null);
    setRunError(null);
  };

  const body = useCallback(
    () => ({ system: draft.system, user: draft.user, model: draft.model, temperature: model?.supportsTemperature ? draft.temperature : null, maxTokens: draft.maxTokens, variables: Object.fromEntries(varNames.map((n) => [n, draft.variables[n] ?? ''])) }),
    [draft, model, varNames],
  );

  const run = async () => {
    setRunning(true);
    setRunError(null);
    try {
      const r = await api.post<RunResponse>('/prompts/run', { ...body(), promptId: selectedId ?? undefined });
      setResult(r);
      history.reload();
    } catch (e) {
      setResult(null);
      setRunError(errorMessage(e));
    } finally {
      setRunning(false);
    }
  };

  const save = async () => {
    if (!draft.name.trim() && !selectedId) {
      toast.error('Give the prompt a name first');
      return;
    }
    setSaving(true);
    try {
      if (!selectedId) {
        const c = await api.post<PromptDetail>('/prompts', { ...body(), name: draft.name.trim(), description: draft.description, isTemplate: draft.isTemplate, note: draft.note });
        toast.success('Prompt saved');
        setParams({ id: c.prompt.id });
      } else {
        const v = await api.post<PromptVersion>(`/prompts/${selectedId}/versions`, { ...body(), note: draft.note });
        if (detail.data && (draft.isTemplate !== detail.data.prompt.isTemplate || draft.name !== detail.data.prompt.name)) {
          await api.patch(`/prompts/${selectedId}`, { isTemplate: draft.isTemplate, name: draft.name.trim() || undefined });
        }
        toast.success(`Saved as version ${v.version}`);
        detail.reload();
      }
      set('note', '');
      library.reload();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!selectedId || !window.confirm(`Delete "${draft.name}" and all its versions?`)) return;
    try {
      await api.del(`/prompts/${selectedId}`);
      toast.success('Prompt deleted');
      newPrompt();
      library.reload();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const tempOk = model?.supportsTemperature ?? false;

  return (
    <div>
      <PageHeader
        eyebrow="Prompt engineering"
        title="Prompt Studio"
        actions={
          canWrite && (
            <Button onClick={newPrompt}>
              <Plus className="h-4 w-4" aria-hidden /> New prompt
            </Button>
          )
        }
      />

      <div className="grid gap-6 xl:grid-cols-[18rem_minmax(0,1fr)_minmax(0,26rem)]">
        {/* Library */}
        <Card className="h-fit p-4">
          <CardHeader eyebrow="Library" title="Prompts & templates" />
          <div className="relative mb-3">
            <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-500" aria-hidden />
            <Input aria-label="Search prompts" className="pl-9" placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <label className="mb-3 flex items-center gap-2 text-sm text-slate-300">
            <input type="checkbox" checked={onlyTemplates} onChange={(e) => setOnlyTemplates(e.target.checked)} className="h-4 w-4 accent-cyan-500" />
            Templates only
          </label>
          {library.error ? (
            <ErrorState message={library.error} onRetry={library.reload} />
          ) : !library.data ? (
            <Skeleton className="h-40" />
          ) : library.data.length === 0 ? (
            <EmptyState title="Nothing here yet" hint="Write a prompt and save it." />
          ) : (
            <ul className="max-h-[28rem] space-y-1.5 overflow-auto">
              {library.data.map((p) => (
                <li key={p.id}>
                  <button onClick={() => setParams({ id: p.id })} aria-current={p.id === selectedId} className={`w-full rounded-xl border p-3 text-left transition ${p.id === selectedId ? 'border-cyan-500/50 bg-slate-800' : 'border-slate-800 bg-slate-950/50 hover:bg-slate-800/60'}`}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium">{p.name}</span>
                      {p.isTemplate && <Badge tone="violet">template</Badge>}
                    </div>
                    <p className="mt-1 line-clamp-2 text-xs text-slate-500">{p.preview}</p>
                    <p className="mt-1 text-[11px] text-slate-600">v{p.currentVersion} · {p.model} · {timeAgo(p.updatedAt)}</p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* Editor */}
        <div className="min-w-0 space-y-4">
          {selectedId && detail.error ? (
            <ErrorState message={detail.error} onRetry={detail.reload} />
          ) : (
            <Card className="p-5">
              <div className="grid gap-4 md:grid-cols-2">
                <Field label="Name" htmlFor="p-name">
                  <Input id="p-name" value={draft.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Scene captioning" maxLength={120} disabled={!canWrite} />
                </Field>
                <Field label="Model" htmlFor="p-model">
                  <Select id="p-model" value={draft.model} onChange={(e) => set('model', e.target.value)}>
                    {(models.data ?? []).map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label} — {price(m.inputPerMTok)}/{price(m.outputPerMTok)} per 1M
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              <div className="mt-4 space-y-4">
                <Field label="System prompt" htmlFor="p-sys" hint="Optional. Sets role and constraints.">
                  <Textarea id="p-sys" rows={3} value={draft.system} onChange={(e) => set('system', e.target.value)} />
                </Field>
                <Field label="User prompt" htmlFor="p-user" hint={<>Use <code className="text-cyan-300">{'{{variable}}'}</code> to inject values.</>}>
                  <Textarea id="p-user" rows={7} value={draft.user} onChange={(e) => set('user', e.target.value)} />
                </Field>
              </div>

              <div className="mt-4 grid gap-4 md:grid-cols-2">
                <Field
                  label={`Temperature${tempOk && draft.temperature !== null ? `: ${draft.temperature.toFixed(2)}` : ''}`}
                  htmlFor="p-temp"
                  hint={tempOk ? 'Claude accepts 0–1. Leave at default for the model’s own setting.' : `${model?.label ?? 'This model'} does not accept a temperature setting, so it is not sent.`}
                >
                  <div className="flex items-center gap-3">
                    <input id="p-temp" type="range" min={0} max={1} step={0.05} disabled={!tempOk} value={draft.temperature ?? 1} onChange={(e) => set('temperature', Number(e.target.value))} className="w-full accent-cyan-500 disabled:opacity-40" aria-valuetext={draft.temperature === null ? 'default' : String(draft.temperature)} />
                    <Button size="sm" variant="ghost" disabled={!tempOk || draft.temperature === null} onClick={() => set('temperature', null)}>
                      Default
                    </Button>
                  </div>
                </Field>
                <Field label="Max output tokens" htmlFor="p-max" hint={model ? `Up to ${num(model.maxOutputTokens)} · requests are capped at 16,000 per call` : undefined}>
                  <Input id="p-max" type="number" min={1} max={128000} value={draft.maxTokens} onChange={(e) => set('maxTokens', Math.max(1, Number(e.target.value) || 1))} />
                </Field>
              </div>

              <section aria-label="Variables" className="mt-5 rounded-xl border border-slate-800 bg-slate-950/50 p-4">
                <h3 className="mb-3 text-xs font-medium uppercase tracking-wider text-slate-400">Variables</h3>
                {varNames.length === 0 ? (
                  <p className="text-sm text-slate-500">No variables yet — add <code>{'{{name}}'}</code> to your prompt.</p>
                ) : (
                  <div className="grid gap-3 md:grid-cols-2">
                    {varNames.map((n) => (
                      <Field key={n} label={n} htmlFor={`var-${n}`}>
                        <Textarea id={`var-${n}`} rows={2} value={draft.variables[n] ?? ''} onChange={(e) => setDraft((d) => ({ ...d, variables: { ...d.variables, [n]: e.target.value } }))} />
                      </Field>
                    ))}
                  </div>
                )}
              </section>

              <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
                <p className="text-xs text-slate-500" aria-live="polite">
                  ≈ {num(inTok)} input tokens · up to {usd(maxCost)} per run (estimate)
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button variant="primary" loading={running} disabled={!canWrite || !draft.user.trim()} onClick={run}>
                    <Play className="h-4 w-4" aria-hidden /> Run test
                  </Button>
                  <Button disabled={!canWrite || !draft.user.trim()} onClick={() => setCompareOpen(true)}>
                    <Columns2 className="h-4 w-4" aria-hidden /> Compare
                  </Button>
                </div>
              </div>
              {!canWrite && <p className="mt-3 text-xs text-amber-300">Viewers can browse prompts but not run or save them.</p>}
            </Card>
          )}

          {canWrite && (
            <Card className="p-5">
              <CardHeader eyebrow={selectedId ? `Editing · loaded v${loadedVersion}` : 'New prompt'} title="Save" />
              <div className="grid gap-4 md:grid-cols-[1fr_auto]">
                <Field label="Version note" htmlFor="p-note">
                  <Input id="p-note" value={draft.note} onChange={(e) => set('note', e.target.value)} placeholder="What changed? (optional)" maxLength={200} />
                </Field>
                <label className="flex items-center gap-2 self-end pb-2 text-sm text-slate-200">
                  <input type="checkbox" checked={draft.isTemplate} onChange={(e) => set('isTemplate', e.target.checked)} className="h-4 w-4 accent-violet-500" />
                  <BookmarkPlus className="h-4 w-4 text-violet-300" aria-hidden /> Save as template
                </label>
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                <Button variant="primary" loading={saving} onClick={save}>
                  <Save className="h-4 w-4" aria-hidden /> {selectedId ? 'Save new version' : 'Save prompt'}
                </Button>
                {selectedId && (
                  <Button variant="ghost" onClick={remove}>
                    <Trash2 className="h-4 w-4 text-rose-300" aria-hidden /> Delete
                  </Button>
                )}
              </div>
            </Card>
          )}
        </div>

        {/* Result + history */}
        <div className="min-w-0 space-y-4">
          <Card className="p-5" aria-live="polite">
            <CardHeader eyebrow="Test runner" title="Result" />
            {running && <Skeleton className="h-40" />}
            {runError && <ErrorState message={runError} onRetry={run} />}
            {!running && !runError && !result && <EmptyState title="Run a test" hint="Output, token usage and estimated cost appear here." />}
            {!running && result && <ResultView r={result} />}
          </Card>

          {detail.data && (
            <Card className="p-5">
              <CardHeader eyebrow="Versioning" title="History" />
              <ul className="space-y-2">
                {detail.data.versions.map((v) => (
                  <li key={v.id} className="rounded-xl border border-slate-800 bg-slate-950/50 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex items-center gap-2 text-sm font-medium">
                        <GitCommitVertical className="h-4 w-4 text-cyan-300" aria-hidden /> v{v.version}
                        {v.version === detail.data!.prompt.currentVersion && <Badge tone="emerald">current</Badge>}
                      </span>
                      <Button size="sm" variant="ghost" onClick={() => (setDraft(fromVersion(detail.data!.prompt, v)), setLoadedVersion(v.version))}>
                        Load
                      </Button>
                    </div>
                    <p className="mt-1 text-xs text-slate-500">{v.note || 'No note'} · {v.model} · {timeAgo(v.createdAt)}</p>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Card className="p-5">
            <CardHeader eyebrow="Latest" title="Recent test runs" />
            {!history.data ? (
              <Skeleton className="h-24" />
            ) : history.data.length === 0 ? (
              <p className="text-sm text-slate-500">No runs yet.</p>
            ) : (
              <ul className="space-y-2">
                {history.data.map((r) => (
                  <li key={r.id} className="flex items-center justify-between gap-2 text-sm">
                    <span className="min-w-0 truncate text-slate-300">{r.refName}</span>
                    <span className="flex shrink-0 items-center gap-2">
                      <StatusBadge status={r.status} />
                      <span className="tabular-nums text-slate-400">{usd(r.costUsd)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>

      <CompareModal open={compareOpen} onClose={() => setCompareOpen(false)} draft={draft} models={models.data ?? []} body={body} promptId={selectedId} versions={detail.data?.versions ?? []} />
    </div>
  );
}

function ResultView({ r }: { r: RunResponse }) {
  const run = r.run;
  const text = typeof run.output?.text === 'string' ? run.output.text : '';
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={run.status} />
        {run.simulated && <Badge tone="amber">simulated</Badge>}
        {run.output?.stopReason === 'max_tokens' && <Badge tone="amber">hit max tokens</Badge>}
      </div>
      {run.error ? (
        <p role="alert" className="rounded-xl border border-rose-500/30 bg-rose-500/5 p-3 text-sm text-rose-100">{run.error}</p>
      ) : (
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-xl border border-slate-800 bg-slate-950/70 p-3 text-sm leading-relaxed text-slate-100">{text || '(empty response)'}</pre>
      )}
      <dl className="grid grid-cols-2 gap-2 text-sm">
        {[
          ['Input tokens', num(run.inputTokens)],
          ['Output tokens', num(run.outputTokens)],
          ['Est. cost', usd(run.costUsd)],
          ['Latency', ms(run.latencyMs)],
        ].map(([k, v]) => (
          <div key={k} className="rounded-xl border border-slate-800 bg-slate-950/50 px-3 py-2">
            <dt className="text-xs text-slate-500">{k}</dt>
            <dd className="font-medium tabular-nums">{v}</dd>
          </div>
        ))}
      </dl>
      {r.missingVariables.length > 0 && <p className="text-xs text-amber-300">Unfilled variables rendered empty: {r.missingVariables.join(', ')}</p>}
      {r.temperatureIgnored && <p className="text-xs text-amber-300">This model ignores temperature, so it was not sent.</p>}
    </div>
  );
}

function CompareModal({ open, onClose, draft, models, body, promptId, versions }: { open: boolean; onClose: () => void; draft: Draft; models: ModelInfo[]; body: () => Record<string, unknown>; promptId: string | null; versions: PromptVersion[] }) {
  const toast = useToast();
  const [mode, setMode] = useState<'models' | 'versions'>('models');
  const [picked, setPicked] = useState<string[]>([]);
  const [versionNo, setVersionNo] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<CompareResponse | null>(null);

  useEffect(() => {
    if (open) {
      setRes(null);
      setPicked((p) => (p.length >= 2 ? p : [draft.model, models.find((m) => m.id !== draft.model)?.id ?? draft.model]));
      setVersionNo((v) => v ?? versions[1]?.version ?? versions[0]?.version ?? null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length < 4 ? [...p, id] : p));

  const run = async () => {
    setBusy(true);
    try {
      let variants: Record<string, unknown>[];
      if (mode === 'models') {
        variants = picked.map((id) => ({ model: id, label: models.find((m) => m.id === id)?.label ?? id }));
      } else {
        const v = versions.find((x) => x.version === versionNo);
        if (!v) throw new Error('Pick a saved version to compare against');
        variants = [
          { model: draft.model, label: 'Current editor' },
          { model: v.model, system: v.systemPrompt, user: v.userPrompt, label: `Version ${v.version}` },
        ];
      }
      const { variables, maxTokens, temperature, system, user } = body() as any;
      setRes(await api.post<CompareResponse>('/prompts/compare', { promptId: promptId ?? undefined, system, user, variables, maxTokens, temperature, variants }));
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const canRun = mode === 'models' ? picked.length >= 2 : versionNo !== null && versions.length > 0;
  return (
    <Modal open={open} onClose={onClose} title="Compare outputs" wide>
      <div className="mb-4 flex flex-wrap gap-2">
        <Button variant={mode === 'models' ? 'primary' : 'secondary'} size="sm" onClick={() => setMode('models')}>Across models</Button>
        <Button variant={mode === 'versions' ? 'primary' : 'secondary'} size="sm" disabled={versions.length === 0} onClick={() => setMode('versions')}>Editor vs saved version</Button>
      </div>
      {mode === 'models' ? (
        <fieldset className="mb-4">
          <legend className="mb-2 text-xs uppercase tracking-wider text-slate-400">Pick 2–4 models</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {models.map((m) => (
              <label key={m.id} className="flex items-center gap-2 rounded-xl border border-slate-800 p-2.5 text-sm">
                <input type="checkbox" className="h-4 w-4 accent-cyan-500" checked={picked.includes(m.id)} onChange={() => toggle(m.id)} />
                {m.label}
              </label>
            ))}
          </div>
        </fieldset>
      ) : (
        <Field label="Compare the editor against" htmlFor="cmp-ver">
          <Select id="cmp-ver" value={versionNo ?? ''} onChange={(e) => setVersionNo(Number(e.target.value))}>
            {versions.map((v) => (
              <option key={v.id} value={v.version}>v{v.version} — {v.note || 'no note'}</option>
            ))}
          </Select>
        </Field>
      )}
      <Button variant="primary" loading={busy} disabled={!canRun} onClick={run}>
        <Columns2 className="h-4 w-4" aria-hidden /> Run comparison
      </Button>
      <p className="mt-2 text-xs text-slate-500">Each variant is a real run and incurs its own cost.</p>

      {res && (
        <div className="mt-5 grid gap-3 md:grid-cols-2">
          {res.results.map((r) => (
            <div key={r.label} className="min-w-0 rounded-xl border border-slate-800 bg-slate-950/50 p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="truncate text-sm font-semibold">{r.label}</span>
                <StatusBadge status={r.run.status} />
              </div>
              <pre className="mb-2 max-h-56 overflow-auto whitespace-pre-wrap text-xs leading-relaxed text-slate-200">{r.run.error ?? r.run.output?.text ?? ''}</pre>
              <p className="text-xs tabular-nums text-slate-400">{num(r.run.inputTokens)} in · {num(r.run.outputTokens)} out · {usd(r.run.costUsd)} · {ms(r.run.latencyMs)}{r.run.simulated ? ' · simulated' : ''}</p>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
