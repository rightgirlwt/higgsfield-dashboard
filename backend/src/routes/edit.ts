import express, { Router } from 'express';
import { z } from 'zod';
import { requireRole } from '../auth';
import { HttpError, notFound, wrap } from '../lib/errors';
import { approveBeat, beatCounts, beatCreate, beatPatch, createBeat, deleteBeat, listBeats, requestChanges, setAdjustmentDone, submitBeat, suggestBeats, updateBeat } from '../services/beats';
import {
  approveVideoDraft, captionFonts, captionsSchema, DEFAULT_LABEL, getWords, requestVideoDraftChanges, resetWords, saveWords, submitVideoDraft, wordsEdited, getCuts, getVideo, getWordsIfAny, EDIT_UPLOAD_TYPES, engineStatus, getJob, labelSchema, listEffects, listVideos, MAX_UPLOAD_BYTES, planSchema, previewFrame, renameVideo, saveUpload, savePlan, startRender, stepSchema,
} from '../services/effects';

import { signSourceLink } from '../services/sourceLinks';
import { wordsSchema } from '../services/transcript';

export const edit = Router();

const typeOf = (req: { headers: Record<string, unknown> }) => String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();

edit.get(
  '/effects',
  wrap(async (_req, res) => {
    const engine = await engineStatus();
    res.json({ engine, effects: engine.ready ? await listEffects() : [] });
  }),
);

edit.get(
  '/fonts',
  wrap(async (_req, res) => {
    res.json((await captionFonts()).map((f) => ({ family: f.family, source: f.source })));
  }),
);

edit.get(
  '/videos',
  wrap(async (req, res) => {
    const videos = await listVideos(req.workspace!.id, req.workspace!.isDefault);
    const counts = await beatCounts(req.user!.orgId);
    res.json(videos.map((v) => ({ ...v, beats: counts.get(v.id) ?? { total: 0, draft: 0, in_review: 0, changes_needed: 0, approved: 0 } })));
  }),
);

edit.patch(
  '/videos/:id',
  wrap(async (req, res) => {
    const { title } = z.object({ title: z.string().max(120) }).parse(req.body);
    res.json(await renameVideo(req.params.id, title));
  }),
);

edit.post(
  '/videos',
  express.raw({ type: (req) => EDIT_UPLOAD_TYPES.includes(typeOf(req)), limit: MAX_UPLOAD_BYTES }),
  wrap(async (req, res) => {
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body)) throw new HttpError(415, 'Use an MP4, MOV or WebM video.', 'unsupported');
    res.status(201).json(await saveUpload(body, typeOf(req), String(req.query.filename ?? 'video'), req.workspace!.id, req.user!.name));
  }),
);

const noLabel = { enabled: false, text: DEFAULT_LABEL };
const previewBody = z.object({
  videoId: z.string().uuid(), steps: z.array(stepSchema).max(12).default([]), time: z.number().min(0).max(36_000), label: labelSchema.default(noLabel), captions: captionsSchema.optional(),
});

/** One frame with the effects applied, as a PNG. */
edit.post(
  '/preview',
  wrap(async (req, res) => {
    const b = previewBody.parse(req.body);
    const png = await previewFrame(b.videoId, b.steps, b.time, b.label, b.captions);
    res.type('image/png').send(png);
  }),
);

const renderBody = z.object({ videoId: z.string().uuid(), steps: z.array(stepSchema).max(12).default([]), label: labelSchema.default(noLabel), captions: captionsSchema.optional() });

edit.post(
  '/render',
  wrap(async (req, res) => {
    const b = renderBody.parse(req.body);
    const job = await startRender({ orgId: req.user!.orgId, workspaceId: req.workspace!.id, videoId: b.videoId, steps: b.steps, label: b.label, captions: b.captions, createdBy: req.user!.name });
    res.status(202).json(job);
  }),
);

// ---- numbered drafts (every render is kept as v1, v2, ...) -------------------------------------------------
const draftNumber = (req: { params: Record<string, string> }) => z.coerce.number().int().min(1).parse(req.params.n);

edit.post(
  '/videos/:id/drafts/:n/submit',
  wrap(async (req, res) => {
    res.json(await submitVideoDraft(req.params.id, draftNumber(req)));
  }),
);

/** Reviewing is the admin's job, as with beats. */
edit.post(
  '/videos/:id/drafts/:n/approve',
  requireRole('admin'),
  wrap(async (req, res) => {
    res.json(await approveVideoDraft(req.params.id, draftNumber(req)));
  }),
);

edit.post(
  '/videos/:id/drafts/:n/request-changes',
  requireRole('admin'),
  wrap(async (req, res) => {
    const { note } = z.object({ note: z.string().trim().min(1).max(2000) }).parse(req.body);
    res.json(await requestVideoDraftChanges(req.params.id, draftNumber(req), note));
  }),
);

// ---- the edit plan and the beats of a video -------------------------------------------------------------
edit.put(
  '/videos/:id/plan',
  wrap(async (req, res) => {
    res.json(await savePlan(req.params.id, planSchema.parse(req.body)));
  }),
);

/** What the timeline shows besides the beats: where the shots cut, and where speech is (only once transcribed). */
edit.get(
  '/videos/:id/cuts',
  wrap(async (req, res) => {
    res.json(await getCuts(req.params.id));
  }),
);

edit.get(
  '/videos/:id/words',
  wrap(async (req, res) => {
    res.json({ words: await getWordsIfAny(req.params.id), edited: await wordsEdited(req.params.id) });
  }),
);

/** Listen to the video on this computer (free). The first time takes about a minute. */
edit.post(
  '/videos/:id/transcribe',
  wrap(async (req, res) => {
    const words = await getWords(req.params.id);
    res.json({ words, edited: await wordsEdited(req.params.id) });
  }),
);

/** The corrected transcript. Captions and Suggest beats read it from here on. */
edit.put(
  '/videos/:id/words',
  wrap(async (req, res) => {
    const words = await saveWords(req.params.id, wordsSchema.parse(req.body?.words));
    res.json({ words, edited: true });
  }),
);

edit.post(
  '/videos/:id/words/reset',
  wrap(async (req, res) => {
    res.json({ words: await resetWords(req.params.id), edited: false });
  }),
);

/** A link the video player can use for this uploaded video (it expires). */
edit.get(
  '/videos/:id/stream-url',
  wrap(async (req, res) => {
    await getVideo(req.params.id); // 404 for an unknown video
    res.json({ url: signSourceLink(req.params.id) });
  }),
);

edit.get(
  '/videos/:id/beats',
  wrap(async (req, res) => {
    res.json(await listBeats(req.user!.orgId, req.params.id));
  }),
);

edit.post(
  '/videos/:id/beats',
  wrap(async (req, res) => {
    res.status(201).json(await createBeat(req.user!.orgId, req.user!.id, req.params.id, beatCreate.parse(req.body)));
  }),
);

/** Step 1 (approved: false) transcribes for free and returns the price; step 2 (approved: true) spends it. */
edit.post(
  '/videos/:id/suggest-beats',
  wrap(async (req, res) => {
    const { approved } = z.object({ approved: z.boolean().default(false) }).parse(req.body ?? {});
    res.json(await suggestBeats(req.user!.orgId, req.params.id, approved));
  }),
);

const beatId = (req: { params: Record<string, string> }) => z.string().uuid().parse(req.params.id);

edit.patch(
  '/beats/:id',
  wrap(async (req, res) => {
    res.json(await updateBeat(req.user!.orgId, req.user!.id, beatId(req), beatPatch.parse(req.body)));
  }),
);

edit.delete(
  '/beats/:id',
  wrap(async (req, res) => {
    await deleteBeat(req.user!.orgId, beatId(req));
    res.status(204).end();
  }),
);

/** The editor hands a beat over for review. */
edit.post(
  '/beats/:id/submit',
  wrap(async (req, res) => {
    res.json(await submitBeat(req.user!.orgId, req.user!.id, beatId(req)));
  }),
);

/** Reviewing is the admin's job: only the admin login can approve or send a beat back. */
edit.post(
  '/beats/:id/approve',
  requireRole('admin'),
  wrap(async (req, res) => {
    res.json(await approveBeat(req.user!.orgId, req.user!.id, beatId(req)));
  }),
);

edit.post(
  '/beats/:id/request-changes',
  requireRole('admin'),
  wrap(async (req, res) => {
    const { request } = z.object({ request: z.string().trim().min(1).max(2000) }).parse(req.body);
    res.json(await requestChanges(req.user!.orgId, req.user!.id, beatId(req), request));
  }),
);

edit.patch(
  '/beats/:id/adjustments/:adjustmentId',
  wrap(async (req, res) => {
    const { done } = z.object({ done: z.boolean() }).parse(req.body);
    res.json(await setAdjustmentDone(req.user!.orgId, req.user!.id, beatId(req), z.string().uuid().parse(req.params.adjustmentId), done));
  }),
);

edit.get(
  '/jobs/:id',
  wrap(async (req, res) => {
    const job = getJob(req.params.id);
    if (!job) throw notFound('That render is not known (the server may have restarted)');
    res.json(job);
  }),
);
