/**
 * ElevenLabs client (https://elevenlabs.io/docs/api-reference). Auth is the `xi-api-key` header.
 * Endpoints used: GET /v2/voices, POST /v1/text-to-speech/{voice_id}, POST /v1/text-to-dialogue.
 * Output is requested as WAV, which is what Higgsfield accepts for audio inputs.
 */
export class ElevenLabsError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Read at call time so tests (and a changed environment) can point it elsewhere. */
const base = () => (process.env.ELEVENLABS_API_BASE || 'https://api.elevenlabs.io').replace(/\/$/, '');

/** WAV formats from the docs. 44.1 kHz WAV needs ElevenLabs' Pro plan; the lower rates don't. */
export const WAV_FORMATS = ['wav_16000', 'wav_22050', 'wav_24000', 'wav_32000', 'wav_44100', 'wav_48000'] as const;
export type WavFormat = (typeof WAV_FORMATS)[number];
export const DEFAULT_WAV: WavFormat = 'wav_24000';

/** Eleven v4: the highest-quality model, follows audio tags well and supports professional voice clones. */
export const DEFAULT_MODEL = 'eleven_v4';

const VOICE_ID = /^[A-Za-z0-9_-]{6,64}$/;
export const isVoiceId = (v: unknown): v is string => typeof v === 'string' && VOICE_ID.test(v);

async function call(key: string, method: 'GET' | 'POST', path: string, body?: unknown, accept = 'application/json'): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${base()}${path}`, {
      method,
      headers: { 'xi-api-key': key, Accept: accept, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(90_000),
    });
  } catch (err) {
    // Never leak the key or internals: just say what happened.
    throw new ElevenLabsError(502, (err as Error)?.name === 'TimeoutError' ? 'ElevenLabs did not respond in time' : 'Could not reach ElevenLabs');
  }
  if (res.ok) return res;
  let detail = '';
  try {
    const j: any = await res.json();
    const d = j?.detail;
    detail = typeof d === 'string' ? d : typeof d?.message === 'string' ? d.message : d ? JSON.stringify(d) : '';
  } catch {
    /* non-JSON error body */
  }
  const hint =
    res.status === 401 ? ' (ElevenLabs rejected the API key: check it in Settings → API keys)'
    : res.status === 402 || /quota|credit|subscription|tier|plan/i.test(detail) ? ' (this looks like a plan or credit limit on your ElevenLabs account)'
    : '';
  throw new ElevenLabsError(res.status === 401 ? 401 : res.status === 404 ? 404 : 502, `ElevenLabs responded ${res.status}${detail ? `: ${detail.slice(0, 220)}` : ''}${hint}`);
}

export interface Voice {
  id: string;
  name: string;
  /** premade = ElevenLabs' own; cloned / professional / generated / ... = made by you or shared with you. */
  category: string;
  description: string;
  previewUrl: string | null;
  labels: Record<string, string>;
}

export async function listVoices(key: string): Promise<Voice[]> {
  const out: Voice[] = [];
  let token: string | null = null;
  for (let page = 0; page < 6; page++) {
    const r = await call(key, 'GET', `/v2/voices${token ? `?next_page_token=${encodeURIComponent(token)}` : ''}`);
    const j: any = await r.json();
    for (const v of Array.isArray(j?.voices) ? j.voices : []) {
      if (typeof v?.voice_id !== 'string' || typeof v?.name !== 'string') continue;
      out.push({
        id: v.voice_id, name: v.name, category: typeof v.category === 'string' ? v.category : 'unknown', description: typeof v.description === 'string' ? v.description : '',
        previewUrl: typeof v.preview_url === 'string' ? v.preview_url : null, labels: v.labels && typeof v.labels === 'object' ? v.labels : {},
      });
    }
    token = j?.has_more && typeof j?.next_page_token === 'string' ? j.next_page_token : null;
    if (!token) break;
  }
  return out;
}

const MAX_AUDIO_BYTES = 30 * 1024 * 1024;
async function audio(res: Response): Promise<Buffer> {
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw new ElevenLabsError(502, 'ElevenLabs returned empty audio');
  if (buf.length > MAX_AUDIO_BYTES) throw new ElevenLabsError(502, 'The audio is larger than 30 MB, which Higgsfield will not accept');
  return buf;
}

/** One speaker, one line. */
export async function speak(key: string, p: { voiceId: string; text: string; modelId?: string; format?: WavFormat }): Promise<Buffer> {
  if (!isVoiceId(p.voiceId)) throw new ElevenLabsError(400, 'That is not a valid ElevenLabs voice id');
  const res = await call(key, 'POST', `/v1/text-to-speech/${p.voiceId}?output_format=${p.format ?? DEFAULT_WAV}`, { text: p.text, model_id: p.modelId ?? DEFAULT_MODEL }, 'audio/*');
  return audio(res);
}

/** Several speakers in one take (up to 10 voices; ElevenLabs advises at most ~2,000 characters per request). */
export async function dialogue(key: string, p: { inputs: { voiceId: string; text: string }[]; modelId?: string; format?: WavFormat }): Promise<Buffer> {
  for (const i of p.inputs) if (!isVoiceId(i.voiceId)) throw new ElevenLabsError(400, 'That is not a valid ElevenLabs voice id');
  const res = await call(key, 'POST', `/v1/text-to-dialogue?output_format=${p.format ?? DEFAULT_WAV}`, { inputs: p.inputs.map((i) => ({ text: i.text, voice_id: i.voiceId })), model_id: p.modelId ?? DEFAULT_MODEL }, 'audio/*');
  return audio(res);
}
