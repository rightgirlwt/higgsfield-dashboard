import { Router } from 'express';
import { z } from 'zod';
import { requireRole } from '../auth';
import { wrap } from '../lib/errors';
import { adOverview, connectAdAccounts, listAdAccounts, removeAdAccount, syncAdAccount } from '../services/ads';
import { connectPages, FB_SORT_KEYS, listFbPosts, listPages, pageOverview, removePage, syncPage } from '../services/facebook';
import { connectAccount, getPost, listAccounts, listPosts, overview, removeAccount, SORT_KEYS, syncAccount } from '../services/metrics';
import { linkPost } from '../services/metricsEpisodes';
import { allChannels } from '../services/metricsSummary';

export const metrics = Router();

const id = (req: { params: Record<string, string> }) => z.string().uuid().parse(req.params.id);
const tokenBody = z.object({ token: z.string().min(10).max(700) });

/** Everything connected for this workspace, in one answer (reads what is already stored). */
metrics.get(
  '/summary',
  wrap(async (req, res) => {
    res.json(await allChannels(req.user!.orgId, req.workspace!));
  }),
);

// ---- Instagram ------------------------------------------------------------------------------------------------

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
    const { token, igUserId } = tokenBody.extend({ igUserId: z.string().trim().max(40).optional() }).parse(req.body ?? {});
    res.status(201).json(await connectAccount(req.user!.orgId, req.workspace!, token, igUserId));
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

/** Says which episode of a project a post is (or clears it), so the cost of making it can sit beside what it earned. */
metrics.put(
  '/posts/:id/episode',
  wrap(async (req, res) => {
    const b = z.object({ link: z.object({ projectId: z.string().uuid(), episode: z.number().int().min(1).max(9999) }).nullable() }).parse(req.body ?? {});
    await linkPost(req.user!.orgId, id(req), b.link);
    res.json(await getPost(req.user!.orgId, id(req)));
  }),
);

// ---- Facebook Pages -------------------------------------------------------------------------------------------

metrics.get(
  '/facebook/pages',
  wrap(async (req, res) => {
    res.json(await listPages(req.user!.orgId, req.workspace!));
  }),
);

metrics.post(
  '/facebook/pages',
  requireRole('admin'),
  wrap(async (req, res) => {
    const { token, pageId } = tokenBody.extend({ pageId: z.string().trim().max(40).optional() }).parse(req.body ?? {});
    res.status(201).json(await connectPages(req.user!.orgId, req.workspace!, token, pageId));
  }),
);

metrics.delete(
  '/facebook/pages/:id',
  requireRole('admin'),
  wrap(async (req, res) => {
    await removePage(req.user!.orgId, id(req));
    res.status(204).end();
  }),
);

metrics.post(
  '/facebook/pages/:id/sync',
  wrap(async (req, res) => {
    const b = z.object({ posts: z.number().int().min(5).max(100).optional() }).parse(req.body ?? {});
    res.json(await syncPage(req.user!.orgId, id(req), b));
  }),
);

metrics.get(
  '/facebook/pages/:id/overview',
  wrap(async (req, res) => {
    res.json(await pageOverview(req.user!.orgId, id(req)));
  }),
);

metrics.get(
  '/facebook/pages/:id/posts',
  wrap(async (req, res) => {
    const q = z.object({ sort: z.enum(FB_SORT_KEYS as [string, ...string[]]).optional() }).parse(req.query);
    res.json(await listFbPosts(req.user!.orgId, id(req), q));
  }),
);

// ---- Ads ------------------------------------------------------------------------------------------------------

metrics.get(
  '/ads/accounts',
  wrap(async (req, res) => {
    res.json(await listAdAccounts(req.user!.orgId, req.workspace!));
  }),
);

metrics.post(
  '/ads/accounts',
  requireRole('admin'),
  wrap(async (req, res) => {
    const { token, adAccountId } = tokenBody.extend({ adAccountId: z.string().trim().max(40).optional() }).parse(req.body ?? {});
    res.status(201).json(await connectAdAccounts(req.user!.orgId, req.workspace!, token, adAccountId));
  }),
);

metrics.delete(
  '/ads/accounts/:id',
  requireRole('admin'),
  wrap(async (req, res) => {
    await removeAdAccount(req.user!.orgId, id(req));
    res.status(204).end();
  }),
);

metrics.post(
  '/ads/accounts/:id/sync',
  wrap(async (req, res) => {
    res.json(await syncAdAccount(req.user!.orgId, id(req)));
  }),
);

metrics.get(
  '/ads/accounts/:id/overview',
  wrap(async (req, res) => {
    const { days } = z.object({ days: z.coerce.number().int().default(30) }).parse(req.query);
    res.json(await adOverview(req.user!.orgId, id(req), days));
  }),
);
