import { AlertTriangle, Check, Film, ImageIcon, Loader2, Plus, Wand2 } from 'lucide-react';
import { useMemo } from 'react';
import { usd } from '../../lib/format';
import type { BoardItem, ItemStatus, ProjectSnapshot, StudioCatalog } from '../../lib/types';
import { Badge, Button, cx, EmptyState, type Tone } from '../ui';

export const STATUS: Record<ItemStatus, { label: string; tone: Tone }> = {
  draft: { label: 'Draft', tone: 'slate' },
  ready: { label: 'Ready to approve', tone: 'amber' },
  generating: { label: 'Generating', tone: 'cyan' },
  review: { label: 'Review takes', tone: 'violet' },
  approved: { label: 'Approved', tone: 'emerald' },
  rejected: { label: 'Rejected', tone: 'rose' },
};

const cost = (i: BoardItem) => (i.estimate.ok ? i.estimate.costUsd : null);
const sum = (items: BoardItem[]) => items.reduce((s, i) => s + (cost(i) ?? 0), 0);
const cssAspect = (a: string) => a.replace(':', ' / ');

function Thumb({ item, aspect, surface }: { item: BoardItem; aspect: string; surface: 'image' | 'video' }) {
  const take = item.takes.find((t) => t.id === item.approvedAssetId) ?? item.takes[0];
  return (
    <div className="relative grid w-full place-items-center overflow-hidden bg-slate-950" style={{ aspectRatio: cssAspect(aspect) }}>
      {take ? (
        <img src={take.thumbUrl} alt="" loading="lazy" className="h-full w-full object-cover" />
      ) : item.status === 'generating' ? (
        <Loader2 className="h-6 w-6 animate-spin text-cyan-500" aria-hidden />
      ) : surface === 'image' ? (
        <ImageIcon className="h-6 w-6 text-slate-600" aria-hidden />
      ) : (
        <Film className="h-6 w-6 text-slate-600" aria-hidden />
      )}
      {take?.type === 'video' && <span className="absolute bottom-2 right-2 rounded-md bg-black/60 p-1 text-white"><Film className="h-3 w-3" aria-hidden /></span>}
      {item.status === 'generating' && take && <span className="absolute inset-0 grid place-items-center bg-black/40"><Loader2 className="h-6 w-6 animate-spin text-white" aria-hidden /></span>}
    </div>
  );
}

export function Board({
  snap, catalog, selected, onSelect, onOpen, onGenerate, onAdd, onAsk, canWrite,
}: {
  snap: ProjectSnapshot;
  catalog: StudioCatalog | null;
  selected: Set<string>;
  onSelect: (ids: string[], on: boolean) => void;
  onOpen: (item: BoardItem) => void;
  onGenerate: (items: BoardItem[]) => void;
  onAdd: (group: string) => void;
  onAsk: () => void;
  canWrite: boolean;
}) {
  const { items, type, project } = snap;
  const groups = useMemo(() => {
    const m = new Map<string, BoardItem[]>();
    for (const i of items) (m.get(i.group) ?? m.set(i.group, []).get(i.group)!).push(i);
    return [...m.entries()];
  }, [items]);
  const ready = items.filter((i) => i.status === 'ready');
  const picked = items.filter((i) => selected.has(i.id));
  const label = type.itemLabel.toLowerCase();
  const modelLabel = (id: string) => catalog?.models.find((m) => m.id === id)?.label ?? id;

  if (items.length === 0) {
    return (
      <EmptyState
        title={`No ${label}s yet`}
        hint={`Ask the Director to draft the ${type.id === 'micro_drama' ? 'shot list' : 'ad units'} from your brief, or add one yourself.`}
        action={canWrite ? <div className="flex flex-wrap justify-center gap-2"><Button variant="primary" onClick={onAsk}>Ask the Director to draft them</Button><Button onClick={() => onAdd('')}><Plus className="h-4 w-4" aria-hidden /> Add one myself</Button></div> : undefined}
      />
    );
  }

  return (
    <div className="space-y-6">
      {ready.length > 0 && canWrite && (
        <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4">
          <p className="text-sm text-amber-900 dark:text-amber-100">
            <strong>{ready.length} {label}{ready.length > 1 ? 's are' : ' is'} ready for your approval.</strong> Estimated {usd(sum(ready))}. Nothing is generated until you confirm.
          </p>
          <Button variant="primary" onClick={() => onGenerate(ready)}><Wand2 className="h-4 w-4" aria-hidden /> Review cost and generate</Button>
        </div>
      )}

      {groups.map(([group, list]) => {
        const selectable = list.filter((i) => i.status !== 'generating');
        const allOn = selectable.length > 0 && selectable.every((i) => selected.has(i.id));
        return (
          <section key={group || '_'} aria-label={group || `Ungrouped ${label}s`}>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-3">
                {canWrite && <input type="checkbox" className="h-4 w-4 accent-cyan-500" aria-label={`Select all in ${group || 'ungrouped'}`} checked={allOn} onChange={(e) => onSelect(selectable.map((i) => i.id), e.target.checked)} />}
                <h3 className="text-base font-semibold">{group || `No ${type.groupLabel.toLowerCase()}`}</h3>
                <span className="text-xs text-slate-500">{list.length} {label}{list.length > 1 ? 's' : ''} · {list.filter((i) => i.status === 'approved').length} approved · about {usd(sum(list))}</span>
              </div>
              {canWrite && <Button size="sm" variant="ghost" onClick={() => onAdd(group)}><Plus className="h-3.5 w-3.5" aria-hidden /> Add {label}</Button>}
            </div>
            <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-4">
              {list.map((i) => {
                const st = STATUS[i.status];
                const c = cost(i);
                const isSel = selected.has(i.id);
                return (
                  <li key={i.id} className={cx('group relative overflow-hidden rounded-2xl border bg-slate-900 shadow-card transition', isSel ? 'border-cyan-500 ring-2 ring-cyan-500/40' : 'border-slate-800 hover:border-slate-600')}>
                    {canWrite && i.status !== 'generating' && (
                      <input type="checkbox" aria-label={`Select ${i.title}`} className="absolute left-2 top-2 z-10 h-4 w-4 accent-cyan-500" checked={isSel} onChange={(e) => onSelect([i.id], e.target.checked)} />
                    )}
                    <button onClick={() => onOpen(i)} className="block w-full text-left" aria-label={`Open ${i.title}`}>
                      <Thumb item={i} aspect={project.aspect} surface={catalog?.models.find((m) => m.id === i.modelId)?.surface ?? 'video'} />
                      <div className="space-y-1.5 p-3">
                        <div className="flex items-start justify-between gap-2">
                          <span className="line-clamp-2 text-sm font-medium">{i.title}</span>
                        </div>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Badge tone={st.tone}>{i.status === 'approved' && <Check className="h-3 w-3" aria-hidden />}{st.label}</Badge>
                          {i.takeCount > 0 && <span className="text-[11px] text-slate-500">{i.takeCount} take{i.takeCount > 1 ? 's' : ''}</span>}
                        </div>
                        <p className="line-clamp-2 text-xs text-slate-500">{i.prompt || 'No prompt yet'}</p>
                        <div className="flex items-center justify-between gap-2 text-[11px] text-slate-500">
                          <span className="truncate">{i.modelId ? modelLabel(i.modelId) : 'No model yet'}</span>
                          <span className="shrink-0 tabular-nums">{c !== null ? usd(c) : i.estimate.ok ? 'no price' : ''}</span>
                        </div>
                        {i.lastError && <p className="flex items-start gap-1 text-[11px] text-rose-600"><AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden /><span className="line-clamp-2">{i.lastError}</span></p>}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}

      {picked.length > 0 && canWrite && (
        <div className="sticky bottom-4 z-20 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-700 bg-slate-900 p-3 shadow-2xl">
          <p className="text-sm"><strong>{picked.length}</strong> selected · about <strong>{usd(sum(picked))}</strong></p>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => onSelect(picked.map((i) => i.id), false)}>Clear</Button>
            <Button variant="primary" onClick={() => onGenerate(picked)}><Wand2 className="h-4 w-4" aria-hidden /> Review cost and generate</Button>
          </div>
        </div>
      )}
    </div>
  );
}
