import { Router } from 'express';
import { z } from 'zod';
import { requireRole } from '../auth';
import { wrap } from '../lib/errors';
import { connectAccount, getPost, listAccounts, listPosts, overview, removeAccount, SORT_KEYS, syncAccount } from '../services/metrics';

export const metrics = Router();

const id = (req: { params: Record<string, string> }) => z.string().uuid().parse(req.params.id);

metrics.get(
  '/accounts',
  wrap(async (req, res) => {
    res.json(await listAccounts(req.user!.orgId, req.workspace!));
  }),
);

/** Connecting hands the app an access token, so it is the admin's job (like keys in Settings). */
metrics.post(
  '/accounts',
  requireRole('admin'),
  wrap(async (req, res) => {
    const { token } = z.object({ token: z.string().min(10).max(700) }).parse(req.body ?? {});
    res.status(201).json(await connectAccount(req.user!.orgId, req.workspace!, token));
  }),
);

metrics.delete(
  '/accounts/:id',
  requireRole('admin'),
  wrap(async (req, res) => {
    await removeAccount(req.user!.orgId, id(req));
    res.status(204).end();
  }),
);

/** Reading from Instagram costs nothing. Anyone on the Team can refresh. */
metrics.post(
  '/accounts/:id/sync',
  wrap(async (req, res) => {
    const b = z.object({ posts: z.number().int().min(5).max(100).optional() }).parse(req.body ?? {});
    res.json(await syncAccount(req.user!.orgId, id(req), b));
  }),
);

metrics.get(
  '/accounts/:id/overview',
  wrap(async (req, res) => {
    res.json(await overview(req.user!.orgId, id(req)));
  }),
);

metrics.get(
  '/accounts/:id/posts',
  wrap(async (req, res) => {
    const q = z.object({ sort: z.enum(SORT_KEYS as [string, ...string[]]).optional(), type: z.enum(['Reel', 'Carousel', 'Photo', 'Video']).optional() }).parse(req.query);
    res.json(await listPosts(req.user!.orgId, id(req), q));
  }),
);

metrics.get(
  '/posts/:id',
  wrap(async (req, res) => {
    res.json(await getPost(req.user!.orgId, id(req)));
  }),
);
