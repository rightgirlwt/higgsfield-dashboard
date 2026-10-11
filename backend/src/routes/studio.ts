import { Router } from 'express';
import { z } from 'zod';
import { notFound, wrap } from '../lib/errors';
import { getBaseUrl, getHfConfig } from '../services/higgsfield';
import { createRun, generationQueue } from '../services/jobs';
import { getPrices, studioWork } from '../services/studio';
import { getStudioModel, publicModel, resolveMedia, resolveSettings, STUDIO_MODELS, type MediaRole } from '../services/studioCatalog';

export const studio = Router();

/** Catalog + live connection state. `connected=false` means Studio runs in simulated mode. */
studio.get(
  '/models',
  wrap(async (req, res) => {
    const org = req.user!.orgId;
    const [prices, cfg, base] = await Promise.all([getPrices(org), getHfConfig(org), getBaseUrl(org)]);
    res.json({
      connected: cfg !== null,
      baseUrlSet: !!base,
      models: STUDIO_MODELS.map((m) => publicModel(m, prices[m.id] ?? null)),
    });
  }),
);

const ROLES = ['start', 'end', 'reference', 'video', 'audio'] as const;
const generateBody = z.object({
  modelId: z.string().min(1).max(60),
  prompt: z.string().trim().min(1, 'Write a prompt first').max(5000),
  settings: z.record(z.string(), z.any()).default({}),
  media: z.partialRecord(z.enum(ROLES), z.array(z.string().max(2100)).max(9)).default({}),
  count: z.number().int().min(1).max(4).default(1),
});

studio.post(
  '/generate',
  wrap(async (req, res) => {
    const b = generateBody.parse(req.body);
    const model = getStudioModel(b.modelId);
    if (!model) throw notFound('Unknown model');
    // Validate up front so mistakes are a 400, not a failed run.
    resolveSettings(model, b.settings);
    resolveMedia(model, b.media as Partial<Record<MediaRole, string[]>>);

    const u = req.user!;
    const run = await createRun({
      orgId: u.orgId,
      kind: 'generation',
      refName: `${model.label}: ${b.prompt.replace(/\s+/g, ' ').slice(0, 60)}`,
      model: model.id,
      createdBy: u.id,
      input: { prompt: b.prompt, settings: b.settings, media: b.media, count: b.count },
    });
    // Fire and return: progress arrives over Socket.IO; results land in the media timeline.
    void generationQueue.enqueue(u.orgId, run.id, studioWork(u.orgId, { modelId: b.modelId, prompt: b.prompt, settings: b.settings, media: b.media as Partial<Record<MediaRole, string[]>>, count: b.count }));
    res.status(202).json({ run });
  }),
);
