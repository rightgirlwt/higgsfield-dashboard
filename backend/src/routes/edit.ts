import express, { Router } from 'express';
import { z } from 'zod';
import { requireRole } from '../auth';
import { HttpError, notFound, wrap } from '../lib/errors';
import { approveBeat, beatCreate, beatPatch, createBeat, deleteBeat, listBeats, requestChanges, setAdjustmentDone, submitBeat, updateBeat } from '../services/beats';
import {
  DEFAULT_LABEL, EDIT_UPLOAD_TYPES, engineStatus, getJob, labelSchema, listEffects, listVideos, MAX_UPLOAD_BYTES, planSchema, previewFrame, saveUpload, savePlan, startRender, stepSchema,
} from '../services/effects';

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
  '/videos',
  wrap(async (req, res) => {
    res.json(await listVideos(req.workspace!.id, req.workspace!.isDefault));
  }),
);

edit.post(
  '/videos',
  express.raw({ type: (req) => EDIT_UPLOAD_TYPES.includes(typeOf(req)), limit: MAX_UPLOAD_BYTES }),
  wrap(async (req, res) => {
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body)) throw new HttpError(415, 'Use an MP4, MOV or WebM video.', 'unsupported');
    res.status(201).json(await saveUpload(body, typeOf(req), String(req.query.filename ?? 'video'), req.workspace!.id));
  }),
);

const noLabel = { enabled: false, text: DEFAULT_LABEL };
const previewBody = z.object({
  videoId: z.string().uuid(), steps: z.array(stepSchema).max(12).default([]), time: z.number().min(0).max(36_000), label: labelSchema.default(noLabel),
});

/** One frame with the effects applied, as a PNG. */
edit.post(
  '/preview',
  wrap(async (req, res) => {
    const b = previewBody.parse(req.body);
    const png = await previewFrame(b.videoId, b.steps, b.time, b.label);
    res.type('image/png').send(png);
  }),
);

const renderBody = z.object({ videoId: z.string().uuid(), steps: z.array(stepSchema).max(12).default([]), label: labelSchema.default(noLabel) });

edit.post(
  '/render',
  wrap(async (req, res) => {
    const b = renderBody.parse(req.body);
    const job = await startRender({ orgId: req.user!.orgId, workspaceId: req.workspace!.id, videoId: b.videoId, steps: b.steps, label: b.label });
    res.status(202).json(job);
  }),
);

// ---- the edit plan and the beats of a video -------------------------------------------------------------
edit.put(
  '/videos/:id/plan',
  wrap(async (req, res) => {
    res.json(await savePlan(req.params.id, planSchema.parse(req.body)));
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
