import { calcCostUsd } from '../lib/pricing';
import { runPrompt } from './claude';
import { getSecret } from './secrets';
import { recordUsage } from './usage';

/**
 * "Auto tags" for Eleven v4. ElevenLabs offers this as an Enhance button in its web app (an LLM adds audio tags such as [whispers]);
 * the API has no equivalent setting, so Claude does the same job here, under one hard rule: it may only ADD tags, never change a word.
 */
const TAG_RE = /\[[^\]\n]{1,80}\]/g;

/** The text with every [tag] removed and whitespace flattened, for comparing spoken words. */
export const stripTags = (s: string) => s.replace(TAG_RE, ' ').replace(/\s+/g, ' ').trim();

/** True when `tagged` says exactly what `original` says (only tags and spacing differ). */
export const sameWords = (original: string, tagged: string) => stripTags(original) === stripTags(tagged);

const TAG_MODEL = 'claude-haiku-5-5';

const SYSTEM = `You add audio tags to dialogue for the Eleven v4 text-to-speech model.

Audio tags are short bracketed directions that shape how a line is spoken, written in square brackets, placed right before the words they affect (or right after, for a reaction). Examples of the kind you may use: [whispers], [sighs], [exhales], [laughs], [curious], [excited], [sarcastic], [crying], [low, steady voice], [calm and deliberate], [firmly], [hesitant], [warm].

Rules, in order of importance:
1. NEVER change, add, remove, reorder or re-punctuate any word of the dialogue. You may only insert [tags]. If you cannot add a tag without touching the words, leave the line unchanged.
2. Tags must describe how the line SOUNDS (voice quality, emotion, delivery, a vocal reaction). Phrase them as a delivery, not as a sound effect (write [low, gravelly voice], not something that could be read as a noise).
3. Match each tag to the speaker's character and voice description. A calm, measured voice should not suddenly shout. Prefer small, believable choices over theatrical ones.
4. Be sparing: usually one tag per line, occasionally two. Plain lines can stay untagged.
5. If a line already contains tags, keep them as they are.

Input is a JSON array of objects {"speaker": string, "voice": string (a description of the voice, may be empty), "text": string}.
Reply with ONLY a JSON array of strings, one per input object, in the same order, each being that line's text with tags inserted. No commentary, no code fences.`;

export interface TagLine {
  speaker?: string;
  voiceDescription?: string;
  text: string;
}

export interface TagResult {
  lines: string[];
  /** Lines that came back with at least one tag added. */
  tagged: number;
  /** Why nothing was done, or any line that was kept as written. */
  note?: string;
  costUsd: number;
}

const stripFence = (s: string) => s.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');

export async function addAudioTags(orgId: string, lines: TagLine[]): Promise<TagResult> {
  const untouched = (note: string): TagResult => ({ lines: lines.map((l) => l.text), tagged: 0, note, costUsd: 0 });
  if (!(await getSecret(orgId, 'anthropic'))) return untouched('Auto tags were skipped because no Anthropic (Claude) key is set.');

  const payload = lines.map((l) => ({ speaker: l.speaker ?? '', voice: (l.voiceDescription ?? '').slice(0, 500), text: l.text }));
  let r;
  try {
    r = await runPrompt(orgId, { model: TAG_MODEL, system: SYSTEM, user: JSON.stringify(payload), maxTokens: 2000, temperature: null });
  } catch (e) {
    return untouched(`Auto tags were skipped (${e instanceof Error ? e.message.slice(0, 120) : 'Claude call failed'}).`);
  }
  if (r.simulated) return untouched('Auto tags were skipped because no Anthropic (Claude) key is set.');
  await recordUsage({ orgId, provider: 'claude', model: r.model, inputTokens: r.inputTokens, outputTokens: r.outputTokens, costUsd: r.costUsd || calcCostUsd(r.model, r.inputTokens, r.outputTokens), simulated: false });

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFence(r.text));
  } catch {
    return { ...untouched('Auto tags were skipped because the reply could not be read.'), costUsd: r.costUsd };
  }
  if (!Array.isArray(parsed) || parsed.length !== lines.length) return { ...untouched('Auto tags were skipped because the reply did not match the script.'), costUsd: r.costUsd };

  let rejected = 0;
  const out = lines.map((l, i) => {
    const t = parsed[i];
    // The guard: keep Claude's version only when every spoken word is exactly as written.
    if (typeof t === 'string' && sameWords(l.text, t)) return t.trim();
    rejected++;
    return l.text;
  });
  const tagged = out.filter((t, i) => t !== lines[i].text).length;
  return { lines: out, tagged, note: rejected ? `${rejected} line${rejected > 1 ? 's were' : ' was'} kept as written because the suggested tags changed the words.` : undefined, costUsd: r.costUsd };
}
