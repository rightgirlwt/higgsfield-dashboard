import express, { Router } from 'express';
import { z } from 'zod';
import { HttpError, notFound, wrap } from '../lib/errors';
import {
  DEFAULT_LABEL, EDIT_UPLOAD_TYPES, engineStatus, getJob, labelSchema, listEffects, listVideos, MAX_UPLOAD_BYTES, previewFrame, saveUpload, startRender, stepSchema,
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

edit.get(
  '/jobs/:id',
  wrap(async (req, res) => {
    const job = getJob(req.params.id);
    if (!job) throw notFound('That render is not known (the server may have restarted)');
    res.json(job);
  }),
);
