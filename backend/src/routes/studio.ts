import express, { Router } from 'express';
import { z } from 'zod';
import { badRequest, HttpError, notFound, wrap } from '../lib/errors';
import { placeholderImage } from '../lib/placeholder';
import { createCharacter, getBaseUrl, getCharacter, getHfConfig, HiggsfieldError, listCharacters, uploadFile, UPLOAD_TYPES } from '../services/higgsfield';
import { createRun, generationQueue } from '../services/jobs';
import { addAudioTags } from '../services/voiceTags';
import { dialogue, DEFAULT_MODEL, DEFAULT_WAV, ElevenLabsError, isVoiceId, listVoices, speak, WAV_FORMATS } from '../services/elevenlabs';
import { getSecret } from '../services/secrets';
import { livePrice } from '../services/livePrice';
import { getPrices, prepareGeneration, studioWork } from '../services/studio';
import { PRICES_AS_OF, publicModel, STUDIO_MODELS, type MediaRole } from '../services/studioCatalog';
import { getDb } from '../ctx';
import { recordUsage } from '../services/usage';

export const studio = Router();

/** Higgsfield's published price for training one Soul ID character (shown on open.higgsfield.ai). */
export const SOUL_ID_PRICE_USD = 2.5;

/** Catalog + live connection state. `connected=false` means Studio runs in simulated mode. */
studio.get(
  '/models',
  wrap(async (req, res) => {
    const org = req.user!.orgId;
    const [prices, cfg, base] = await Promise.all([getPrices(org), getHfConfig(org), getBaseUrl(org)]);
    res.json({
      connected: cfg !== null,
      baseUrlSet: !!base,
      soulIdPriceUsd: SOUL_ID_PRICE_USD,
      pricesAsOf: PRICES_AS_OF,
      models: STUDIO_MODELS.map((m) => publicModel(m, prices[m.id] ?? null)),
    });
  }),
);

const ROLES = ['start', 'end', 'reference', 'video', 'audio'] as const;
const generateBody = z.object({
  modelId: z.string().min(1).max(60),
  mode: z.string().max(40).optional(),
  prompt: z.string().trim().max(5000).default(''),
  settings: z.record(z.string(), z.any()).default({}),
  media: z.partialRecord(z.enum(ROLES), z.array(z.string().max(2100)).max(9)).default({}),
  count: z.number().int().min(1).max(4).default(1),
});

/**
 * Higgsfield's own quote for exactly this request (a free lookup). `usd` is null when it can't be had (not connected, an admin flat
 * price is set, or the model is priced in words), and the page then shows the saved estimate instead.
 */
studio.post(
  '/estimate',
  wrap(async (req, res) => {
    const b = generateBody.parse(req.body);
    const org = req.user!.orgId;
    const p = prepareGeneration({ ...b, media: b.media as Partial<Record<MediaRole, string[]>> });
    const adminPrice = (await getPrices(org))[p.model.id] ?? null;
    const usd = adminPrice === null ? await livePrice(org, p.path, p.body) : null;
    res.json({ usd: usd === null ? null : usd * p.requests });
  }),
);

studio.post(
  '/generate',
  wrap(async (req, res) => {
    const b = generateBody.parse(req.body);
    const params = { ...b, media: b.media as Partial<Record<MediaRole, string[]>> };
    // Validate up front so mistakes are a 400, not a failed run.
    const prepared = prepareGeneration(params);
    const u = req.user!;
    const run = await createRun({
      orgId: u.orgId,
      kind: 'generation',
      refName: `${prepared.model.label}: ${(prepared.prompt || prepared.mode.label).replace(/\s+/g, ' ').slice(0, 60)}`,
      model: prepared.model.id,
      createdBy: u.id,
      input: { mode: prepared.mode.id, prompt: prepared.prompt, settings: prepared.settings, media: prepared.media, count: prepared.requests },
    });
    // Fire and return: progress arrives over Socket.IO; results land in the media timeline.
    void generationQueue.enqueue(u.orgId, run.id, studioWork(u.orgId, params));
    res.status(202).json({ run });
  }),
);

// ---- uploads: host a local image/video/audio file on Higgsfield so it can be a generation input ---------
const rawUpload = express.raw({ type: (req) => !!UPLOAD_TYPES[String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()], limit: '100mb' });

studio.post(
  '/uploads',
  rawUpload,
  wrap(async (req, res) => {
    const contentType = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    const spec = UPLOAD_TYPES[contentType];
    if (!spec) throw badRequest('Unsupported file type. Use JPG, PNG, WebP or GIF images, MP4 video, or WAV audio.');
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || body.length === 0) throw badRequest('The file is empty');
    if (body.length > spec.maxBytes) throw new HttpError(413, `That ${spec.kind} is too large (limit ${Math.round(spec.maxBytes / 1024 / 1024)} MB)`, 'too_large');
    const org = req.user!.orgId;
    const cfg = await getHfConfig(org);
    if (!cfg) throw badRequest('Connect Higgsfield (Settings → API keys and Settings → Higgsfield) before uploading reference files.');
    let url: string;
    try {
      url = await uploadFile(cfg, body, contentType);
    } catch (e) {
      if (e instanceof HiggsfieldError) throw new HttpError(502, e.message, 'upstream');
      throw e;
    }
    const name = String(req.query.filename ?? 'upload').replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'upload';
    let id: string | null = null;
    if (spec.kind !== 'audio') {
      // Keep it in the library so it can be reused as a start frame / reference.
      const type = spec.kind === 'video' ? 'video' : 'photo';
      const { rows } = await getDb().query<{ id: string }>(
        `INSERT INTO media_assets (org_id, type, title, url, thumb_url, tags, metadata) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING id`,
        [org, type, name, url, type === 'photo' ? url : placeholderImage(name, 'video'), ['upload', 'reference'], JSON.stringify({ source: 'upload', bytes: body.length, retention: 'temporary' })],
      );
      id = rows[0].id;
    }
    res.status(201).json({ url, kind: spec.kind, name, bytes: body.length, mediaId: id });
  }),
);

// ---- characters (Soul ID) ----------------------------------------------------------------------------------
studio.get(
  '/characters',
  wrap(async (req, res) => {
    const cfg = await getHfConfig(req.user!.orgId);
    if (!cfg) return void res.json({ connected: false, characters: [] });
    try {
      res.json({ connected: true, characters: await listCharacters(cfg) });
    } catch (e) {
      if (e instanceof HiggsfieldError) throw new HttpError(502, e.message, 'upstream');
      throw e;
    }
  }),
);

const characterBody = z.object({
  name: z.string().trim().min(1).max(60),
  imageUrls: z.array(z.string().max(2100).regex(/^https?:\/\//i, 'Images must be public http(s) URLs')).min(1).max(30),
  confirmedCost: z.literal(true, { message: 'Confirm the training cost first' }),
});

/** Trains a Soul ID. Billed by Higgsfield (~$2.50/request), so the caller must confirm the cost explicitly. */
studio.post(
  '/characters',
  wrap(async (req, res) => {
    const b = characterBody.parse(req.body);
    const org = req.user!.orgId;
    const cfg = await getHfConfig(org);
    if (!cfg) throw badRequest('Connect Higgsfield before creating a character.');
    try {
      const c = await createCharacter(cfg, b.name, b.imageUrls);
      await recordUsage({ orgId: org, provider: 'higgsfield', model: 'soul-id', units: 1, costUsd: SOUL_ID_PRICE_USD, simulated: false });
      res.status(201).json(c);
    } catch (e) {
      if (e instanceof HiggsfieldError) throw new HttpError(502, e.message, 'upstream');
      throw e;
    }
  }),
);

studio.get(
  '/characters/:id',
  wrap(async (req, res) => {
    const cfg = await getHfConfig(req.user!.orgId);
    if (!cfg) throw notFound('Not connected');
    try {
      res.json(await getCharacter(cfg, req.params.id));
    } catch (e) {
      if (e instanceof HiggsfieldError) throw new HttpError(e.status === 404 ? 404 : 502, e.message, 'upstream');
      throw e;
    }
  }),
);

// ---- voices (ElevenLabs) -----------------------------------------------------------------------------------
const elevenKey = async (org: string) => {
  const key = await getSecret(org, 'elevenlabs');
  if (!key) throw badRequest('Add your ElevenLabs API key in Settings → API keys first.');
  return key;
};
const upstream = (e: unknown): never => {
  if (e instanceof ElevenLabsError) throw new HttpError(e.status, e.message, 'upstream');
  throw e;
};

/** Your ElevenLabs voices (cloned ones first). */
studio.get(
  '/voices',
  wrap(async (req, res) => {
    const key = await getSecret(req.user!.orgId, 'elevenlabs');
    if (!key) return void res.json({ connected: false, voices: [] });
    try {
      const voices = await listVoices(key);
      // Voices you made or were shared with you come before ElevenLabs' stock ones.
      voices.sort((a, b) => Number(a.category === 'premade') - Number(b.category === 'premade') || a.name.localeCompare(b.name));
      res.json({ connected: true, voices });
    } catch (e) {
      upstream(e);
    }
  }),
);

const speechBody = z.object({
  format: z.enum(WAV_FORMATS).default(DEFAULT_WAV),
  /** One speaker: { voiceId, text }. A scene: { lines: [{ voiceId, text }, ...] } (up to 10 different voices). */
  voiceId: z.string().max(64).optional(),
  text: z.string().trim().min(1).max(2000).optional(),
  modelId: z.string().max(60).default(DEFAULT_MODEL),
  /** Add Eleven v4 audio tags ([whispers], [sighs]...) to the text first. Never changes a word. */
  autoTags: z.boolean().default(true),
  /** Only show the tagged text; spend nothing on ElevenLabs and host nothing. */
  dryRun: z.boolean().default(false),
  lines: z.array(z.object({ voiceId: z.string().max(64), text: z.string().trim().min(1).max(2000) })).min(1).max(40).optional(),
});

/**
 * Speaks a line (or a short multi-voice scene) and hosts the WAV on Higgsfield so it can be used as a generation's audio input.
 * Spends ElevenLabs credits (not tracked in this dashboard yet).
 */
studio.post(
  '/speech',
  wrap(async (req, res) => {
    const b = speechBody.parse(req.body);
    const org = req.user!.orgId;
    const single = b.voiceId && b.text;
    if (!single && !b.lines) throw badRequest('Send either voiceId + text, or lines.');
    // Reject a bad voice id before anything is sent to ElevenLabs.
    for (const id of single ? [b.voiceId!] : b.lines!.map((l) => l.voiceId)) if (!isVoiceId(id)) throw badRequest('That is not a valid ElevenLabs voice id.');
    if (b.lines && b.lines.reduce((n, l) => n + l.text.length, 0) > 2000) throw badRequest('A scene can be at most about 2,000 characters in total. Split it into several takes.');
    const [key, hf] = await Promise.all([elevenKey(org), getHfConfig(org)]);
    if (!hf && !b.dryRun) throw badRequest('Connect Higgsfield first: the audio is hosted there so video models can use it.');

    // Optional: let Claude add Eleven v4 audio tags, matched to each voice's character. Words are never changed.
    const script = single ? [{ voiceId: b.voiceId!, text: b.text! }] : b.lines!;
    let spoken = script.map((l) => l.text);
    let tagNote: string | undefined;
    let taggedCount = 0;
    if (b.autoTags) {
      let known: Awaited<ReturnType<typeof listVoices>> = [];
      try {
        known = await listVoices(key);
      } catch (e) {
        return upstream(e);
      }
      const byId = new Map(known.map((v) => [v.id, v]));
      const t = await addAudioTags(org, script.map((l) => ({ speaker: byId.get(l.voiceId)?.name, voiceDescription: byId.get(l.voiceId)?.description, text: l.text })));
      spoken = t.lines;
      tagNote = t.note;
      taggedCount = t.tagged;
    }
    const tagInfo = { enabled: b.autoTags, linesTagged: taggedCount, ...(tagNote ? { note: tagNote } : {}) };
    if (b.dryRun) return void res.json({ dryRun: true, model: b.modelId, spokenText: single ? spoken[0] : undefined, spokenLines: single ? undefined : script.map((l, i) => ({ voiceId: l.voiceId, text: spoken[i] })), autoTags: tagInfo });

    let wav: Buffer;
    try {
      wav = single ? await speak(key, { voiceId: b.voiceId!, text: spoken[0], modelId: b.modelId, format: b.format }) : await dialogue(key, { inputs: script.map((l, i) => ({ voiceId: l.voiceId, text: spoken[i] })), modelId: b.modelId, format: b.format });
    } catch (e) {
      return upstream(e);
    }
    let url: string;
    try {
      url = await uploadFile(hf!, wav, 'audio/wav');
    } catch (e) {
      if (e instanceof HiggsfieldError) throw new HttpError(502, e.message, 'upstream');
      throw e;
    }
    res.status(201).json({ url, bytes: wav.length, format: b.format, model: b.modelId, speakers: single ? 1 : new Set(b.lines!.map((l) => l.voiceId)).size, spokenText: single ? spoken[0] : undefined, spokenLines: single ? undefined : script.map((l, i) => ({ voiceId: l.voiceId, text: spoken[i] })), autoTags: tagInfo });
  }),
);
