import express, { Router } from 'express';
import { z } from 'zod';
import { HttpError, wrap } from '../lib/errors';
import { MAX_UPLOAD_BYTES } from '../services/effects';
import { signStudyLink } from '../services/sourceLinks';
import { addFromLink, analyseStudy, refreshMeta, deleteScript, deleteStudy, getStudy, listStudies, saveStudyUpload, scriptFromStudy, studyPatch, STUDY_TYPES, updateStudy } from '../services/study';

export const study = Router();

const typeOf = (req: { headers: Record<string, unknown> }) => String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
const id = (req: { params: Record<string, string> }) => z.string().uuid().parse(req.params.id);

study.get(
  '/',
  wrap(async (req, res) => {
    res.json(await listStudies(req.user!.orgId, req.workspace!));
  }),
);

study.post(
  '/upload',
  express.raw({ type: (req) => Object.keys(STUDY_TYPES).includes(typeOf(req)), limit: MAX_UPLOAD_BYTES }),
  wrap(async (req, res) => {
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body)) throw new HttpError(415, 'Use an MP4, MOV or WebM video.', 'unsupported');
    const r = await saveStudyUpload({ orgId: req.user!.orgId, workspaceId: req.workspace!.id, body, contentType: typeOf(req), name: String(req.query.filename ?? 'reference.mp4') });
    res.status(r.duplicate ? 200 : 201).json({ ...r, study: await getStudy(req.user!.orgId, r.id) });
  }),
);

/** Paste a link to a reel: it is downloaded to this computer with its caption and public numbers. Free. */
study.post(
  '/from-link',
  wrap(async (req, res) => {
    const { url } = z.object({ url: z.string().trim().min(8).max(500) }).parse(req.body ?? {});
    const orgId = req.user!.orgId;
    const r = await addFromLink({ orgId, workspaceId: req.workspace!.id, url });
    // Pasting a link is the go-ahead to study it too (cost shown afterwards). A failed study never loses the download.
    let costUsd = 0;
    let studyError = '';
    if (!(await getStudy(orgId, r.id)).analysis) {
      try {
        costUsd = (await analyseStudy(orgId, r.id, true) as { costUsd: number }).costUsd;
      } catch (e) {
        studyError = e instanceof Error ? e.message : String(e);
      }
    }
    res.status(r.duplicate ? 200 : 201).json({ ...r, costUsd, studyError, study: await getStudy(orgId, r.id) });
  }),
);

study.post(
  '/:id/refresh',
  wrap(async (req, res) => {
    res.json(await refreshMeta(req.user!.orgId, id(req)));
  }),
);

study.get(
  '/:id',
  wrap(async (req, res) => {
    res.json(await getStudy(req.user!.orgId, id(req)));
  }),
);

/** A link the video player can use (it expires). */
study.get(
  '/:id/stream-url',
  wrap(async (req, res) => {
    await getStudy(req.user!.orgId, id(req));
    res.json({ url: signStudyLink(id(req)) });
  }),
);

study.patch(
  '/:id',
  wrap(async (req, res) => {
    res.json(await updateStudy(req.user!.orgId, id(req), studyPatch.parse(req.body)));
  }),
);

study.delete(
  '/:id',
  wrap(async (req, res) => {
    await deleteStudy(req.user!.orgId, id(req));
    res.status(204).end();
  }),
);

/** Step 1 (approved: false) is free and returns the price; step 2 (approved: true) spends it and has Claude analyse the video. */
study.post(
  '/:id/analyse',
  wrap(async (req, res) => {
    const { approved } = z.object({ approved: z.boolean().default(false) }).parse(req.body ?? {});
    res.json(await analyseStudy(req.user!.orgId, id(req), approved));
  }),
);

/** The same two steps, for writing a new script on the studied structure. */
study.post(
  '/:id/script',
  wrap(async (req, res) => {
    const b = z.object({ topic: z.string().trim().min(3).max(500), approved: z.boolean().default(false) }).parse(req.body ?? {});
    res.json(await scriptFromStudy(req.user!.orgId, req.workspace!, id(req), b));
  }),
);

study.delete(
  '/:id/scripts/:scriptId',
  wrap(async (req, res) => {
    await deleteScript(req.user!.orgId, id(req), z.string().uuid().parse(req.params.scriptId));
    res.status(204).end();
  }),
);
