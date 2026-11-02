import { Router } from 'express';
import { z } from 'zod';
import { requireRole } from '../auth';
import { wrap } from '../lib/errors';
import { createWorkspace, deleteWorkspace, updateWorkspace, workspaceInput, workspacePatch } from '../services/workspaces';

/** Listing is in app.ts. Adding, renaming and removing a workspace is the admin's job. */
export const workspaces = Router();

workspaces.post(
  '/',
  requireRole('admin'),
  wrap(async (req, res) => {
    res.status(201).json(await createWorkspace(req.user!.orgId, workspaceInput.parse(req.body ?? {})));
  }),
);

workspaces.patch(
  '/:id',
  requireRole('admin'),
  wrap(async (req, res) => {
    res.json(await updateWorkspace(req.user!.orgId, z.string().uuid().parse(req.params.id), workspacePatch.parse(req.body ?? {})));
  }),
);

workspaces.delete(
  '/:id',
  requireRole('admin'),
  wrap(async (req, res) => {
    await deleteWorkspace(req.user!.orgId, z.string().uuid().parse(req.params.id));
    res.status(204).end();
  }),
);
