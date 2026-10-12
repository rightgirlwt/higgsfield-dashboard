import { Layers } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api, errorMessage } from '../../lib/api';
import { usd } from '../../lib/format';
import { useDebounced } from '../../lib/hooks';
import type { BoardItem, ItemEstimate, StudioCatalog } from '../../lib/types';
import { useToast } from '../../state/Toast';
import { Button, Field, Modal, Select, Skeleton, Textarea } from '../ui';

interface Preview {
  count: number;
  totalUsd: number;
  preview: { title: string; hook: string | null; aspect: string | null; estimate: ItemEstimate }[];
}

/** Ad campaigns: turn one base unit into a hooks x formats matrix, with the whole cost shown before anything is created. */
export function VariantDialog({
  projectId, open, items, catalog, onClose, onCreated,
}: { projectId: string; open: boolean; items: BoardItem[]; catalog: StudioCatalog | null; onClose: () => void; onCreated: () => void }) {
  const toast = useToast();
  const candidates = items.filter((i) => i.modelId && !i.meta?.variantOf);
  const [baseId, setBaseId] = useState('');
  const [hooksText, setHooksText] = useState('');
  const [aspects, setAspects] = useState<string[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open && !baseId && candidates[0]) setBaseId(candidates[0].id);
  }, [open, baseId, candidates]);

  const base = items.find((i) => i.id === baseId);
  const model = catalog?.models.find((m) => m.id === base?.modelId);
  const mode = model?.modes.find((m) => m.id === base?.mode) ?? model?.modes[0];
  const aspectSpec = mode?.params.aspect_ratio;
  const available = aspectSpec && aspectSpec.type === 'enum' ? aspectSpec.values : [];
  const hooks = useMemo(() => hooksText.split('\n').map((h) => h.trim()).filter(Boolean).slice(0, 20), [hooksText]);
  const debounced = useDebounced(JSON.stringify({ baseId, hooks, aspects }), 400);

  useEffect(() => setAspects((a) => a.filter((x) => available.includes(x))), [baseId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open || !baseId) return;
    const { hooks: h, aspects: a } = JSON.parse(debounced) as { hooks: string[]; aspects: string[] };
    if (h.length === 0 && a.length === 0) return setPreview(null);
    let live = true;
    setError(null);
    api.post<Preview>(`/projects/${projectId}/variants`, { baseItemId: baseId, hooks: h, aspects: a }).then((r) => live && setPreview(r)).catch((e) => { if (live) { setPreview(null); setError(errorMessage(e)); } });
    return () => { live = false; };
  }, [debounced, open, baseId, projectId]);

  const create = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ count: number }>(`/projects/${projectId}/variants`, { baseItemId: baseId, hooks, aspects, create: true });
      toast.success(`Created ${r.count} variants. Review and approve them on the board.`);
      setHooksText('');
      setAspects([]);
      onCreated();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Variant matrix" wide>
      {candidates.length === 0 ? (
        <p className="text-sm text-slate-400">Make a base ad unit with a model first. Variants copy its prompt and settings, swapping the hook and format.</p>
      ) : (
        <div className="space-y-4">
          <Field label="Base ad unit" htmlFor="vm-base">
            <Select id="vm-base" value={baseId} onChange={(e) => setBaseId(e.target.value)}>
              {candidates.map((i) => <option key={i.id} value={i.id}>{i.group ? `${i.group} · ` : ''}{i.title}</option>)}
            </Select>
          </Field>
          <Field label="Hooks (one per line)" htmlFor="vm-hooks" hint={<>Put <code>{'{{hook}}'}</code> in the base prompt where the hook goes; otherwise it’s added at the end.</>}>
            <Textarea id="vm-hooks" rows={5} value={hooksText} onChange={(e) => setHooksText(e.target.value)} placeholder={'Stop scrolling: your mornings are about to change\nThree minutes. That’s all it takes.'} className="font-sans" />
          </Field>
          <fieldset>
            <legend className="mb-1.5 text-xs font-medium uppercase tracking-wider text-slate-400">Formats</legend>
            {available.length === 0 ? (
              <p className="text-sm text-slate-500">This model doesn’t offer a choice of format.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {available.map((a) => (
                  <label key={a} className="flex items-center gap-1.5 rounded-lg border border-slate-700 px-2.5 py-1.5 text-sm">
                    <input type="checkbox" className="accent-cyan-500" checked={aspects.includes(a)} onChange={(e) => setAspects((cur) => (e.target.checked ? [...cur, a] : cur.filter((x) => x !== a)))} />
                    {a}
                  </label>
                ))}
              </div>
            )}
          </fieldset>

          <div className="rounded-2xl bg-slate-950/60 p-4" aria-live="polite">
            {error ? <p role="alert" className="text-sm text-rose-300">{error}</p> : !preview ? (
              hooks.length === 0 && aspects.length === 0 ? <p className="text-sm text-slate-500">Add hooks and/or formats to see what the set would cost.</p> : <Skeleton className="h-10" />
            ) : (
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <div className="text-xs uppercase tracking-wider text-slate-500">{preview.count} variants</div>
                  <div className="text-2xl font-semibold tabular-nums">{usd(preview.totalUsd)}</div>
                </div>
                <p className="max-w-sm text-xs text-slate-500">This is the cost to <em>generate</em> them all. Creating the variants spends nothing; you choose what to generate afterwards.</p>
              </div>
            )}
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>Close</Button>
            <Button variant="primary" loading={busy} disabled={!preview || preview.count === 0} onClick={() => void create()}><Layers className="h-4 w-4" aria-hidden /> Create {preview?.count ?? ''} variants</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
