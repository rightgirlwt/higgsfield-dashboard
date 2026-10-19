import { Copy, Mic, Square, Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useCan } from '../auth/context';
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, Field, PageHeader, Select, Skeleton, Tabs, Textarea } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { useApi, useDocumentTitle } from '../lib/hooks';
import { useToast } from '../state/Toast';

interface Voice {
  id: string;
  name: string;
  category: string;
  description: string;
}
interface VoiceList {
  connected: boolean;
  voices: Voice[];
}
interface Take {
  id: number;
  kind: 'Voice line' | 'Voice change';
  voice: string;
  url: string;
  note?: string;
}

type Mode = 'speak' | 'change';
const AUDIO_ACCEPT = '.wav,.mp3,.m4a,.aac,.ogg,.flac,.webm,audio/*';

export default function Voices() {
  useDocumentTitle('Voices');
  const toast = useToast();
  const canWrite = useCan('user');
  const voices = useApi<VoiceList>('/studio/voices');
  const [mode, setMode] = useState<Mode>('speak');
  const [voiceId, setVoiceId] = useState('');
  const [text, setText] = useState('');
  const [autoTags, setAutoTags] = useState(true);
  const [removeNoise, setRemoveNoise] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [takes, setTakes] = useState<Take[]>([]);
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const nextId = useRef(1);

  const list = voices.data?.voices ?? [];
  useEffect(() => {
    if (!voiceId && list.length) setVoiceId(list[0].id);
  }, [list, voiceId]);
  useEffect(() => () => recorder.current?.stream.getTracks().forEach((t) => t.stop()), []);
  const voiceName = (id: string) => list.find((v) => v.id === id)?.name ?? 'Voice';

  const addTake = (t: Omit<Take, 'id'>) => setTakes((p) => [{ ...t, id: nextId.current++ }, ...p]);

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      chunks.current = [];
      rec.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const type = rec.mimeType || 'audio/webm';
        setFile(new File([new Blob(chunks.current, { type })], `recording.${type.includes('ogg') ? 'ogg' : type.includes('mp4') ? 'm4a' : 'webm'}`, { type }));
      };
      rec.start();
      recorder.current = rec;
      setRecording(true);
    } catch {
      toast.error('Could not use the microphone. Allow it in the browser, or upload a recording instead.');
    }
  }
  function stopRecording() {
    recorder.current?.stop();
    setRecording(false);
  }

  async function speak() {
    setBusy(true);
    try {
      const r = await api.post<{ url: string; spokenText?: string }>('/studio/speech', { voiceId, text, autoTags });
      addTake({ kind: 'Voice line', voice: voiceName(voiceId), url: r.url, note: r.spokenText });
      toast.success('Voice line ready.');
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function change() {
    if (!file) return;
    setBusy(true);
    try {
      const q = new URLSearchParams({ voiceId, removeNoise: String(removeNoise) });
      const r = await api.upload<{ url: string }>(`/studio/voice-change?${q}`, file, (file.type || 'audio/webm').split(';')[0]);
      addTake({ kind: 'Voice change', voice: voiceName(voiceId), url: r.url, note: file.name });
      toast.success('Voice changed.');
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      toast.success('Link copied.');
    } catch {
      toast.error('Could not copy. Select the link and copy it by hand.');
    }
  }

  return (
    <div>
      <PageHeader eyebrow="ElevenLabs" title="Voices" />
      {voices.loading ? (
        <Skeleton className="h-64 w-full" />
      ) : voices.error ? (
        <ErrorState message={voices.error} onRetry={voices.reload} />
      ) : !voices.data?.connected ? (
        <EmptyState title="Add your ElevenLabs key first" hint="Voice lines and voice changing are off until a key is saved." action={<Link to="/settings" className="text-sm underline">Open Settings</Link>} />
      ) : (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <Card>
            <CardHeader eyebrow="Make audio" title={mode === 'speak' ? 'Make a voice line' : 'Change a voice'} />
            <div className="space-y-4">
              <Tabs<Mode> label="Voice tools" value={mode} onChange={setMode} tabs={[{ id: 'speak', label: 'Voice line (text)' }, { id: 'change', label: 'Change a voice (recording)' }]} />
              <Field label="Voice" htmlFor="voice">
                <Select id="voice" value={voiceId} onChange={(e) => setVoiceId(e.target.value)}>
                  {list.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name} ({v.category})
                    </option>
                  ))}
                </Select>
              </Field>

              {mode === 'speak' ? (
                <>
                  <Field label="Line" htmlFor="line" hint="Up to 2,000 characters. Written for Eleven v4.">
                    <Textarea id="line" rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder="You beat me here." />
                  </Field>
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={autoTags} onChange={(e) => setAutoTags(e.target.checked)} />
                    Let Claude add delivery tags like [softly] (it never changes your words)
                  </label>
                  <Button onClick={speak} loading={busy} disabled={!canWrite || !voiceId || !text.trim()}>
                    Make voice line
                  </Button>
                </>
              ) : (
                <>
                  <p className="text-sm text-slate-400">Record or upload yourself saying the line. It keeps your timing and emotion and swaps in the chosen voice.</p>
                  <div className="flex flex-wrap items-center gap-2">
                    {recording ? (
                      <Button variant="danger" onClick={stopRecording}>
                        <Square className="mr-1.5 h-4 w-4" aria-hidden /> Stop
                      </Button>
                    ) : (
                      <Button variant="secondary" onClick={startRecording} disabled={!canWrite}>
                        <Mic className="mr-1.5 h-4 w-4" aria-hidden /> Record
                      </Button>
                    )}
                    <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl border border-slate-700 px-3 py-2 text-sm hover:bg-slate-900">
                      <Upload className="h-4 w-4" aria-hidden /> Upload a file
                      <input type="file" accept={AUDIO_ACCEPT} className="sr-only" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
                    </label>
                    {file && <Badge tone="cyan">{file.name}</Badge>}
                  </div>
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={removeNoise} onChange={(e) => setRemoveNoise(e.target.checked)} />
                    Remove background noise
                  </label>
                  <Button onClick={change} loading={busy} disabled={!canWrite || !voiceId || !file || recording}>
                    Change voice
                  </Button>
                </>
              )}
              {!canWrite && <p className="text-xs text-amber-300">This account can look but not make audio.</p>}
              <p className="text-xs text-slate-500">Each take uses ElevenLabs credits on your ElevenLabs plan. The dashboard does not track that spend yet.</p>
            </div>
          </Card>

          <Card>
            <CardHeader eyebrow="This session" title="Your takes" />
            {takes.length === 0 ? (
              <EmptyState title="Nothing yet" hint="Finished takes appear here with a player and a link you can use as audio." />
            ) : (
              <ul className="space-y-4">
                {takes.map((t) => (
                  <li key={t.id} className="space-y-2 rounded-xl border border-slate-800 p-3">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <Badge tone="cyan">{t.kind}</Badge>
                      <span className="font-medium">{t.voice}</span>
                    </div>
                    {t.note && <p className="text-sm text-slate-400">{t.note}</p>}
                    <audio controls src={t.url} className="w-full" />
                    <Button variant="secondary" size="sm" onClick={() => void copy(t.url)}>
                      <Copy className="mr-1.5 h-3.5 w-3.5" aria-hidden /> Copy audio link
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-4 text-xs text-slate-500">Seedance does not lip-sync to supplied audio. Use these as the voice-over under a clip.</p>
          </Card>
        </div>
      )}
    </div>
  );
}
