import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { api, errorMessage, setWorkspaceId } from '../lib/api';
import { useApi } from '../lib/hooks';
import { useToast } from '../state/Toast';
import { Badge, Button, Card, CardHeader, ErrorState, Field, Input, Skeleton, Textarea } from './ui';

interface Workspace {
  id: string;
  name: string;
  voice: string;
  isDefault: boolean;
}
interface Listing {
  workspaces: Workspace[];
  current: string;
}

/** Tells the sidebar's workspace picker to read the list again. */
const announce = () => window.dispatchEvent(new Event('workspaces-changed'));

/** Add, rename and remove workspaces, and say how each one should sound. Admin only. */
export function WorkspacesCard() {
  const toast = useToast();
  const list = useApi<Listing>('/workspaces');
  const [name, setName] = useState('');
  const [voice, setVoice] = useState('');
  const [busy, setBusy] = useState(false);

  async function add() {
    setBusy(true);
    try {
      await api.post('/workspaces', { name, voice });
      toast.success(`Added "${name.trim()}". Pick it from the workspace menu in the sidebar.`);
      setName('');
      setVoice('');
      list.reload();
      announce();
    } catch (e) {
      toast.error(errorMessage(e));
    }
    setBusy(false);
  }

  return (
    <div className="space-y-4">
      <Card className="p-5">
        <CardHeader eyebrow="Admin" title="Add a workspace" />
        <p className="mt-2 text-sm text-slate-400">One workspace per account or client. Each keeps its own projects, media, Vault, studied reels and connected Instagram, Facebook and ad accounts, and nothing from one shows in another.</p>
        <form className="mt-3 grid gap-3 md:grid-cols-[minmax(0,16rem)_minmax(0,1fr)_auto] md:items-end" onSubmit={(e) => (e.preventDefault(), name.trim().length >= 2 && !busy && void add())}>
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="e.g. Nya Studio" />
          </Field>
          <Field label="How should it sound?" hint="Optional. Reels, scripts and captions written in this workspace follow it. You can change it any time.">
            <Textarea rows={2} value={voice} onChange={(e) => setVoice(e.target.value)} maxLength={1500} className="font-sans" placeholder="Warm and funny, short lines, all lowercase, never salesy." />
          </Field>
          <Button type="submit" variant="primary" loading={busy} disabled={name.trim().length < 2}>
            <Plus className="h-4 w-4" aria-hidden /> Add
          </Button>
        </form>
      </Card>

      {list.error ? (
        <ErrorState message={list.error} onRetry={list.reload} />
      ) : !list.data ? (
        <Skeleton className="h-40" />
      ) : (
        list.data.workspaces.map((w) => <Row key={w.id} w={w} current={w.id === list.data!.current} onChanged={() => (list.reload(), announce())} />)
      )}
    </div>
  );
}

function Row({ w, current, onChanged }: { w: Workspace; current: boolean; onChanged: () => void }) {
  const toast = useToast();
  const [name, setName] = useState(w.name);
  const [voice, setVoice] = useState(w.voice);
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const dirty = name.trim() !== w.name || voice.trim() !== w.voice;
  // The two starter accounts have their own built-in voices, which her notes are added to
  const builtIn = /greene|glg|right girl|rgm/i.test(w.name);

  async function save() {
    setSaving(true);
    try {
      await api.patch(`/workspaces/${w.id}`, { name, voice });
      toast.success('Saved.');
      onChanged();
    } catch (e) {
      toast.error(errorMessage(e));
    }
    setSaving(false);
  }
  async function remove() {
    try {
      await api.del(`/workspaces/${w.id}`);
      toast.success(`Removed "${w.name}".`);
      setConfirm(false);
      onChanged();
    } catch (e) {
      toast.error(errorMessage(e));
      setConfirm(false);
    }
  }
  const open = () => {
    setWorkspaceId(w.id);
    window.location.assign('/');
  };

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-base font-semibold">{w.name}</h3>
        {current && <Badge tone="cyan">Open now</Badge>}
        {w.isDefault && <Badge>First</Badge>}
      </div>
      <div className="mt-3 grid gap-3 md:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
        </Field>
        <Field label={builtIn ? 'Extra notes on how it sounds' : 'How it sounds'} hint={builtIn ? 'Added to this account\'s built-in voice. The law firm\'s legal rules always stay.' : 'Without notes, writing here uses a plain, neutral voice.'}>
          <Textarea rows={2} value={voice} onChange={(e) => setVoice(e.target.value)} maxLength={1500} className="font-sans" />
        </Field>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button variant="primary" onClick={() => void save()} loading={saving} disabled={!dirty || name.trim().length < 2}>Save</Button>
        {!current && <Button onClick={open}>Open this workspace</Button>}
        <span className="grow" />
        {!w.isDefault &&
          (confirm ? (
            <>
              <Button variant="danger" onClick={() => void remove()}>Yes, remove it</Button>
              <Button variant="ghost" onClick={() => setConfirm(false)}>Keep it</Button>
            </>
          ) : (
            <Button variant="ghost" onClick={() => setConfirm(true)} aria-label={`Remove ${w.name}`}><Trash2 className="h-4 w-4" aria-hidden /></Button>
          ))}
      </div>
    </Card>
  );
}
