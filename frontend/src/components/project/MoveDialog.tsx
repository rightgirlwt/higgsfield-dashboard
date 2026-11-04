import { useState } from 'react';
import { api, errorMessage } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import { useToast } from '../../state/Toast';
import { Button, Field, Modal, Select, Skeleton } from '../ui';

interface Listing {
  workspaces: { id: string; name: string }[];
  current: string;
}

/** Moves a project, and the media it generated, to another workspace. Admin only. */
export function MoveDialog({ open, projectId, projectName, onClose, onMoved }: { open: boolean; projectId: string; projectName: string; onClose: () => void; onMoved: () => void }) {
  const toast = useToast();
  const list = useApi<Listing>(open ? '/workspaces' : null);
  const others = list.data?.workspaces.filter((w) => w.id !== list.data!.current) ?? [];
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);
  const target = others.find((w) => w.id === pick) ?? others[0];

  async function move() {
    if (!target) return;
    setBusy(true);
    try {
      const r = await api.post<{ movedMedia: number; workspace: { name: string } }>(`/projects/${projectId}/move`, { workspaceId: target.id });
      toast.success(`Moved to ${r.workspace.name}${r.movedMedia ? ` with ${r.movedMedia} generated item${r.movedMedia === 1 ? '' : 's'}` : ''}.`);
      onMoved();
    } catch (e) {
      toast.error(errorMessage(e));
    }
    setBusy(false);
  }

  return (
    <Modal open={open} onClose={onClose} title="Move to another workspace">
      {!list.data ? (
        <Skeleton className="h-24" />
      ) : others.length === 0 ? (
        <p className="text-sm text-slate-400">There is no other workspace yet. Add one in Settings, Workspaces.</p>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-slate-400">
            “{projectName}” moves with its shots, notes, assets and everything it generated. Nothing is deleted or run again, and what was spent stays with it. It will no longer show in this workspace.
          </p>
          <Field label="Move to">
            <Select value={target?.id ?? ''} onChange={(e) => setPick(e.target.value)}>
              {others.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </Select>
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button variant="primary" onClick={() => void move()} loading={busy}>Move project</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
