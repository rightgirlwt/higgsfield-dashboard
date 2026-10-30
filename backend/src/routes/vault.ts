import express, { Router } from 'express';
import { z } from 'zod';
import { requireRole } from '../auth';
import { HttpError, notFound, wrap } from '../lib/errors';
import { signVaultLink } from '../services/sourceLinks';
import { MAX_UPLOAD_BYTES } from '../services/effects';
import {
  clipExists, clipPatch, deleteClip, deleteReel, getVaultJob, listClips, listDays, listReels, saveVaultUpload, scanFolder, setReelStatus, sortClips, suggestReels, updateClip, UPLOAD_TYPES, VAULT_FOLDERS, vaultStats,
} from '../services/vault';

export const vault = Router();

const typeOf = (req: { headers: Record<string, unknown> }) => String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
const id = (req: { params: Record<string, string> }) => z.string().uuid().parse(req.params.id);
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

vault.get(
  '/stats',
  wrap(async (req, res) => {
    res.json({ ...(await vaultStats(req.user!.orgId, req.workspace!)), folderNames: VAULT_FOLDERS });
  }),
);

vault.get(
  '/clips',
  wrap(async (req, res) => {
    res.json(
      await listClips(req.user!.orgId, req.workspace!, {
        folder: str(req.query.folder), day: str(req.query.day), q: str(req.query.q), duplicates: str(req.query.duplicates), unsorted: req.query.unsorted === '1',
        limit: Number(req.query.limit) || undefined, offset: Number(req.query.offset) || undefined,
      }),
    );
  }),
);

vault.get(
  '/days',
  wrap(async (req, res) => {
    res.json(await listDays(req.user!.orgId, req.workspace!, Number(req.query.limit) || 60, Number(req.query.offset) || 0));
  }),
);

vault.patch(
  '/clips/:id',
  wrap(async (req, res) => {
    res.json(await updateClip(req.user!.orgId, id(req), clipPatch.parse(req.body)));
  }),
);

vault.delete(
  '/clips/:id',
  wrap(async (req, res) => {
    await deleteClip(req.user!.orgId, id(req));
    res.status(204).end();
  }),
);

/** A link the video player can use for this clip (it expires). */
vault.get(
  '/clips/:id/stream-url',
  wrap(async (req, res) => {
    await clipExists(req.user!.orgId, id(req));
    res.json({ url: signVaultLink(id(req)) });
  }),
);

/** Reading a folder on this computer is the admin's job: it lets the Vault see files outside the project. */
vault.post(
  '/scan',
  requireRole('admin'),
  wrap(async (req, res) => {
    const { folder } = z.object({ folder: z.string().trim().min(1).max(500) }).parse(req.body);
    res.status(202).json(await scanFolder(req.user!.orgId, req.workspace!, folder));
  }),
);

vault.post(
  '/upload',
  express.raw({ type: (req) => Object.keys(UPLOAD_TYPES).includes(typeOf(req)), limit: MAX_UPLOAD_BYTES }),
  wrap(async (req, res) => {
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body)) throw new HttpError(415, 'Use an MP4, MOV or WebM video.', 'unsupported');
    const modified = Number(req.query.modified);
    const r = await saveVaultUpload({
      orgId: req.user!.orgId, workspaceId: req.workspace!.id, body, contentType: typeOf(req), name: String(req.query.filename ?? 'clip'),
      // The file's own "last modified" time, from the browser: used when the video does not say when it was filmed.
      shotHint: Number.isFinite(modified) && modified > 0 ? new Date(modified) : undefined,
    });
    res.status(201).json(r);
  }),
);

vault.get(
  '/jobs/:id',
  wrap(async (req, res) => {
    const job = getVaultJob(req.params.id);
    if (!job) throw notFound('That job is not known (the server may have restarted)');
    res.json(job);
  }),
);

/** Step 1 (approved: false) is free and returns the price; step 2 (approved: true) spends it and starts sorting. */
vault.post(
  '/sort',
  wrap(async (req, res) => {
    const { approved } = z.object({ approved: z.boolean().default(false) }).parse(req.body ?? {});
    const r = await sortClips(req.user!.orgId, req.workspace!, approved);
    res.status(r.approved ? 202 : 200).json(r.approved ? r.job : r);
  }),
);

vault.get(
  '/reels',
  wrap(async (req, res) => {
    res.json(await listReels(req.user!.orgId, req.workspace!));
  }),
);

vault.post(
  '/reels/suggest',
  wrap(async (req, res) => {
    const b = z.object({ approved: z.boolean().default(false), day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), count: z.number().int().min(1).max(8).default(5) }).parse(req.body ?? {});
    res.json(await suggestReels(req.user!.orgId, req.workspace!, b));
  }),
);

vault.patch(
  '/reels/:id',
  wrap(async (req, res) => {
    const { status } = z.object({ status: z.enum(['idea', 'saved', 'used']) }).parse(req.body);
    await setReelStatus(req.user!.orgId, id(req), status);
    res.status(204).end();
  }),
);

vault.delete(
  '/reels/:id',
  wrap(async (req, res) => {
    await deleteReel(req.user!.orgId, id(req));
    res.status(204).end();
  }),
);
