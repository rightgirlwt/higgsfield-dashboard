import { AlertTriangle, Check, Send, Sparkles, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useCan } from '../../auth/context';
import { api, errorMessage } from '../../lib/api';
import { usd } from '../../lib/format';
import { useApi } from '../../lib/hooks';
import type { ChatChanged, ChatMessage, ModelInfo, ProjectTypeDef } from '../../lib/types';
import { Button, cx, IconButton, Select, Spinner } from '../ui';
import { Markdown } from '../Markdown';

const MODEL_KEY = 'hf_director_model';
const readModel = () => {
  try {
    return localStorage.getItem(MODEL_KEY) ?? '';
  } catch {
    return '';
  }
};

/** Chat with the Claude "Director". It edits the brief, board and workflows through tools, and can never start a paid generation. */
export function ChatPanel({ projectId, type, onChanged, onProgress, className }: { projectId: string; type: ProjectTypeDef; onChanged: (c: ChatChanged) => void; onProgress?: () => void; className?: string }) {
  const canWrite = useCan('user');
  const history = useApi<{ messages: ChatMessage[] }>(`/projects/${projectId}/chat`);
  const models = useApi<ModelInfo[]>('/models');
  const [local, setLocal] = useState<ChatMessage[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [model, setModel] = useState(readModel);
  const endRef = useRef<HTMLDivElement>(null);
  const baseCount = useRef(0);
  const setHistory = history.setData;

  // The optimistic copy of the user's message is hidden once the server's own copy shows up in the polled history.
  const serverMessages = history.data?.messages ?? [];
  const messages = [...serverMessages, ...(serverMessages.length > baseCount.current ? [] : local)];
  const chatCost = messages.reduce((s, m) => s + m.costUsd, 0);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, busy]);

  // While Claude is working (a turn can take a minute), show each step as the server saves it and refresh the board behind it.
  useEffect(() => {
    if (!busy) return;
    let alive = true;
    let last = baseCount.current;
    const t = setInterval(() => {
      api.get<{ messages: ChatMessage[] }>(`/projects/${projectId}/chat`).then((h) => {
        if (!alive) return;
        setHistory(h);
        if (h.messages.length !== last) {
          last = h.messages.length;
          onProgress?.();
        }
      }).catch(() => undefined);
    }, 2500);
    return () => { alive = false; clearInterval(t); };
  }, [busy, projectId, setHistory, onProgress]);

  const send = async (msg: string) => {
    const content = msg.trim();
    if (!content || busy) return;
    baseCount.current = serverMessages.length;
    setBusy(true);
    setError(null);
    setText('');
    // Show the user's message straight away.
    const optimistic: ChatMessage = { id: `local-${Date.now()}`, role: 'user', blocks: [{ type: 'text', text: content }], costUsd: 0, createdAt: new Date().toISOString() };
    setLocal([optimistic]);
    try {
      const r = await api.post<{ messages: ChatMessage[]; changed: ChatChanged }>(`/projects/${projectId}/chat`, { message: content, ...(model ? { model } : {}) });
      history.setData(await api.get<{ messages: ChatMessage[] }>(`/projects/${projectId}/chat`));
      setLocal([]);
      if (r.changed.board || r.changed.brief || r.changed.workflows || r.changed.assets) onChanged(r.changed);
    } catch (e) {
      setError(errorMessage(e));
      setLocal([]);
      setText(content);
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    if (!window.confirm('Clear this conversation? The brief and board stay as they are.')) return;
    try {
      await api.del(`/projects/${projectId}/chat`);
      history.reload();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <section aria-label="Chat with the Director" className={cx('flex min-h-0 flex-col rounded-3xl border border-slate-800 bg-slate-900 shadow-card', className)}>
      <header className="flex items-center justify-between gap-2 border-b border-slate-800 px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="grid h-8 w-8 place-items-center rounded-xl bg-cyan-500 text-white"><Sparkles className="h-4 w-4" aria-hidden /></span>
          <div>
            <h2 className="text-sm font-semibold leading-tight">Director</h2>
            <p className="text-[11px] text-slate-500">Plans with you · never spends on its own{chatCost > 0 && <> · chat so far {usd(chatCost)}</>}</p>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <Select
            aria-label="Claude model for the Director"
            className="!w-auto py-1 text-xs"
            value={model}
            onChange={(e) => {
              setModel(e.target.value);
              try { localStorage.setItem(MODEL_KEY, e.target.value); } catch { /* storage unavailable */ }
            }}
          >
            <option value="">Default model</option>
            {models.data?.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </Select>
          {messages.length > 0 && canWrite && <IconButton label="Clear conversation" onClick={() => void clear()}><Trash2 className="h-4 w-4" aria-hidden /></IconButton>}
        </div>
      </header>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4" aria-live="polite">
        {history.loading && messages.length === 0 && <Spinner />}
        {history.error && <p className="text-sm text-rose-300">{history.error}</p>}
        {!history.loading && messages.length === 0 && (
          <div className="space-y-3">
            <p className="text-sm text-slate-400">Tell me what you’re making. I can write the {type.id === 'micro_drama' ? 'story bible' : 'brand kit'}, build the {type.itemLabel.toLowerCase()} board, pick models and tell you what it will cost, and set up workflows.</p>
            {canWrite && (
              <ul className="space-y-2">
                {type.starters.map((s) => (
                  <li key={s}>
                    <button onClick={() => void send(s)} className="w-full rounded-xl border border-slate-700 bg-slate-950/50 px-3 py-2 text-left text-sm text-slate-200 transition hover:border-cyan-500 hover:bg-slate-800">{s}</button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={cx('flex', m.role === 'user' && 'justify-end')}>
            <div className={cx('max-w-[92%] space-y-2 rounded-2xl px-3.5 py-2.5', m.role === 'user' ? 'bg-cyan-500 text-white' : 'border border-slate-800 bg-slate-950/50 text-slate-100')}>
              {m.blocks.map((b, i) =>
                b.type === 'text' ? (
                  m.role === 'user' ? <p key={i} className="whitespace-pre-wrap text-sm">{b.text}</p> : <Markdown key={i} text={b.text ?? ''} />
                ) : (
                  <p key={i} className={cx('flex items-start gap-1.5 rounded-lg px-2 py-1 text-xs', b.error ? 'bg-rose-500/10 text-rose-300' : 'bg-emerald-500/10 text-emerald-300')}>
                    {b.error ? <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden /> : <Check className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />}
                    <span>{b.error ? `Couldn’t do that: ${b.summary}` : b.summary}</span>
                  </p>
                ),
              )}
            </div>
          </div>
        ))}
        {busy && (
          <div className="flex"><div className="rounded-2xl border border-slate-800 bg-slate-950/50 px-3.5 py-2.5"><Spinner label="Thinking" /></div></div>
        )}
        <div ref={endRef} />
      </div>

      {error && <p role="alert" className="mx-4 mb-2 rounded-lg bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{error}</p>}
      <form
        className="flex items-end gap-2 border-t border-slate-800 p-3"
        onSubmit={(e) => {
          e.preventDefault();
          void send(text);
        }}
      >
        <textarea
          aria-label="Message the Director"
          rows={2}
          value={text}
          maxLength={6000}
          disabled={!canWrite || busy}
          placeholder={canWrite ? 'Ask for a story bible, a shot list, a campaign…' : 'Viewers can read the conversation but not send messages.'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send(text);
            }
          }}
          className="max-h-40 min-h-[2.75rem] flex-1 resize-y rounded-xl border border-slate-700 bg-slate-950/70 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-cyan-500 disabled:opacity-60"
        />
        <Button type="submit" variant="primary" loading={busy} disabled={!canWrite || !text.trim()} aria-label="Send message"><Send className="h-4 w-4" aria-hidden /></Button>
      </form>
    </section>
  );
}
