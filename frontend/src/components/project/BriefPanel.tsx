import { useEffect, useState } from 'react';
import { useCan } from '../../auth/context';
import { api, errorMessage } from '../../lib/api';
import type { ProjectSnapshot } from '../../lib/types';
import { useToast } from '../../state/Toast';
import { Button, Card, CardHeader, Field, Input, Select, Textarea } from '../ui';

const ASPECTS = ['9:16', '16:9', '1:1', '4:5', '3:4', '4:3', '21:9'];

/** The story bible / brand kit and the project's basic settings. The Director reads this on every turn, and can write to it. */
export function BriefPanel({ snap, onSaved, onAsk }: { snap: ProjectSnapshot; onSaved: () => void; onAsk: (text: string) => void }) {
  const toast = useToast();
  const canWrite = useCan('user');
  const { project, type } = snap;
  const [brief, setBrief] = useState<Record<string, string>>(project.brief);
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description);
  const [aspect, setAspect] = useState(project.aspect);
  const [budget, setBudget] = useState(String(project.budgetUsd || ''));
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);

  // Pick up changes made elsewhere (e.g. by the Director) unless there are unsaved edits here.
  useEffect(() => {
    if (dirty) return;
    setBrief(project.brief);
    setName(project.name);
    setDescription(project.description);
    setAspect(project.aspect);
    setBudget(String(project.budgetUsd || ''));
  }, [project.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  const edit = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setDirty(true);
  };

  const save = async () => {
    const b = budget.trim() === '' ? 0 : Number(budget);
    if (!Number.isFinite(b) || b < 0) return toast.error('Budget must be a number, or empty for no cap');
    setBusy(true);
    try {
      await api.put(`/projects/${project.id}`, { name: name.trim(), description, aspect, budgetUsd: b, brief });
      setDirty(false);
      toast.success('Saved');
      onSaved();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <Card className="p-5">
        <CardHeader eyebrow="Settings" title="Project" />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" htmlFor="pj-name"><Input id="pj-name" value={name} maxLength={120} onChange={(e) => edit(setName)(e.target.value)} disabled={!canWrite} /></Field>
          <Field label="Default format" htmlFor="pj-aspect" hint="Used for the card previews. Each card picks its own format in its settings.">
            <Select id="pj-aspect" value={aspect} onChange={(e) => edit(setAspect)(e.target.value)} disabled={!canWrite}>{ASPECTS.map((a) => <option key={a} value={a}>{a}</option>)}</Select>
          </Field>
          <Field label="Description" htmlFor="pj-desc"><Input id="pj-desc" value={description} maxLength={500} onChange={(e) => edit(setDescription)(e.target.value)} disabled={!canWrite} /></Field>
          <Field label="Budget (USD)" htmlFor="pj-budget" hint="Generation is blocked when a batch would go over this. Leave empty for no cap.">
            <Input id="pj-budget" type="number" min={0} step="0.01" inputMode="decimal" placeholder="No cap" value={budget} onChange={(e) => edit(setBudget)(e.target.value)} disabled={!canWrite} />
          </Field>
        </div>
      </Card>

      <Card className="p-5">
        <CardHeader
          eyebrow="Background the Director reads every time"
          title={type.id === 'micro_drama' ? 'Story bible' : 'Brand kit'}
          action={canWrite && <Button variant="primary" onClick={() => onAsk(type.id === 'micro_drama' ? 'Ask me a few questions about my story, then fill in the whole story bible for me.' : 'Ask me a few questions about the brand and product, then fill in the whole brand kit for me.')}>Fill this in with the Director</Button>}
        />
        <p className="-mt-2 mb-4 max-w-2xl text-sm text-slate-500">You don’t have to write all of this. Even a sentence or two in the first box is enough to start, or press the button and answer a few questions. Nothing here is sent to Higgsfield by itself; it just helps the Director write better prompts.</p>
        <div className="grid gap-4 lg:grid-cols-2">
          {type.briefFields.map((f) => (
            <Field key={f.key} label={f.label} htmlFor={`br-${f.key}`}>
              <Textarea id={`br-${f.key}`} rows={f.rows} maxLength={6000} placeholder={f.placeholder} value={brief[f.key] ?? ''} onChange={(e) => edit(setBrief)({ ...brief, [f.key]: e.target.value })} disabled={!canWrite} className="font-sans" />
            </Field>
          ))}
        </div>
        <div className="mt-5 flex items-center justify-end gap-3">
          {dirty && <span className="text-xs text-amber-600">Unsaved changes</span>}
          <Button variant="primary" loading={busy} disabled={!canWrite || !dirty} onClick={() => void save()}>Save</Button>
        </div>
      </Card>
    </div>
  );
}
