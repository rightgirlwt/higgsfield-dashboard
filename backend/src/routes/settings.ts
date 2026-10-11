import { Router } from 'express';
import { z } from 'zod';
import { requireRole } from '../auth';
import { getDb } from '../ctx';
import { badRequest, conflict, forbidden, notFound, wrap } from '../lib/errors';
import { config } from '../config';
import { getModel, MODELS } from '../lib/pricing';
import { getBaseUrl, normalizeBaseUrl } from '../services/higgsfield';
import { getPrices, setPrices } from '../services/studio';
import { getStudioModel } from '../services/studioCatalog';
import { deleteSecret, getSecret, HIGGSFIELD_KEY_RE, listSecretStatus, SECRET_NAMES, setSecret, type SecretName } from '../services/secrets';
import { getDefaults, getSetting, getStorage, putSetting } from '../services/settings';
import { uuidParam } from './util';

export const settings = Router();
export const team = Router();

settings.get(
  '/',
  wrap(async (req, res) => {
    const org = req.user!.orgId;
    const { rows } = await getDb().query<{ name: string; monthly_budget_usd: number; alert_threshold_pct: number }>(
      'SELECT name, monthly_budget_usd, alert_threshold_pct FROM organizations WHERE id=$1',
      [org],
    );
    res.json({
      organization: { name: rows[0].name },
      defaults: await getDefaults(org),
      storage: await getStorage(org),
      billing: { monthlyBudgetUsd: rows[0].monthly_budget_usd, alertThresholdPct: rows[0].alert_threshold_pct },
      models: MODELS,
      higgsfield: {
        baseUrl: await getBaseUrl(org),
        baseUrlFromEnv: !(await getSetting<{ baseUrl: string }>(org, 'higgsfield', { baseUrl: '' })).baseUrl && !!config.higgsfieldApiBase,
        prices: await getPrices(org),
      },
    });
  }),
);

settings.put(
  '/higgsfield',
  requireRole('admin'),
  wrap(async (req, res) => {
    const { baseUrl } = z.object({ baseUrl: z.string().max(300) }).parse(req.body);
    let clean = '';
    if (baseUrl.trim()) {
      try {
        clean = normalizeBaseUrl(baseUrl);
      } catch (e) {
        throw badRequest(e instanceof Error && !/Invalid URL/.test(e.message) ? e.message : 'That is not a valid URL (include https://)');
      }
    }
    await putSetting(req.user!.orgId, 'higgsfield', { baseUrl: clean });
    res.json({ baseUrl: clean });
  }),
);

/** Studio price per generated output (USD). null clears a price. The platform API doesn't report cost. */
settings.put(
  '/studio-prices',
  requireRole('admin'),
  wrap(async (req, res) => {
    const { prices } = z.object({ prices: z.record(z.string(), z.number().min(0).max(1000).nullable()) }).parse(req.body);
    for (const id of Object.keys(prices)) if (!getStudioModel(id)) throw badRequest(`Unknown Studio model "${id}"`);
    const merged = { ...(await getPrices(req.user!.orgId)), ...prices };
    await setPrices(req.user!.orgId, merged);
    res.json({ prices: merged });
  }),
);

settings.put(
  '/defaults',
  requireRole('admin'),
  wrap(async (req, res) => {
    const b = z
      .object({
        model: z.string().refine((m) => !!getModel(m), 'Unknown model'),
        maxTokens: z.number().int().min(1).max(128_000),
        temperature: z.number().min(0).max(1).nullable(),
      })
      .parse(req.body);
    await putSetting(req.user!.orgId, 'defaults', b);
    res.json(b);
  }),
);

settings.put(
  '/storage',
  requireRole('admin'),
  wrap(async (req, res) => {
    const b = z
      .object({
        endpoint: z.string().max(300).refine((v) => v === '' || /^https?:\/\//i.test(v), 'Must be http(s)').default(''),
        region: z.string().max(60).default('us-east-1'),
        bucket: z.string().max(120).regex(/^[a-zA-Z0-9.\-_]*$/, 'Invalid bucket name').default(''),
        publicBaseUrl: z.string().max(300).refine((v) => v === '' || /^https?:\/\//i.test(v), 'Must be http(s)').default(''),
        forcePathStyle: z.boolean().default(false),
      })
      .parse(req.body);
    const v = { provider: 's3' as const, ...b };
    await putSetting(req.user!.orgId, 'storage', v);
    res.json(v);
  }),
);

settings.put(
  '/billing',
  requireRole('admin'),
  wrap(async (req, res) => {
    const b = z.object({ monthlyBudgetUsd: z.number().min(0).max(10_000_000), alertThresholdPct: z.number().int().min(1).max(100) }).parse(req.body);
    await getDb().query('UPDATE organizations SET monthly_budget_usd=$2, alert_threshold_pct=$3 WHERE id=$1', [req.user!.orgId, b.monthlyBudgetUsd, b.alertThresholdPct]);
    res.json(b);
  }),
);

settings.get(
  '/secrets',
  requireRole('admin'),
  wrap(async (req, res) => {
    res.json(await listSecretStatus(req.user!.orgId));
  }),
);

const secretName = (v: string): SecretName => {
  if (!(SECRET_NAMES as readonly string[]).includes(v)) throw notFound('Unknown secret');
  return v as SecretName;
};

settings.put(
  '/secrets/:name',
  requireRole('admin'),
  wrap(async (req, res) => {
    const name = secretName(req.params.name);
    const { value } = z.object({ value: z.string().min(8).max(500) }).parse(req.body);
    const clean = value.trim();
    if (name === 'higgsfield' && !HIGGSFIELD_KEY_RE.test(clean)) {
      throw badRequest('A Higgsfield key must be exactly two parts, ID:SECRET, with a single colon between them and no spaces or line breaks. If you pasted more than two parts (for example an extra ID in front), remove the extra piece.');
    }
    await setSecret(req.user!.orgId, name, clean);
    res.json((await listSecretStatus(req.user!.orgId)).find((s) => s.name === name));
  }),
);

settings.delete(
  '/secrets/:name',
  requireRole('admin'),
  wrap(async (req, res) => {
    await deleteSecret(req.user!.orgId, secretName(req.params.name));
    res.status(204).end();
  }),
);

/** Validates the stored/env Anthropic key with a free metadata call (no tokens spent). */
settings.post(
  '/secrets/anthropic/test',
  requireRole('admin'),
  wrap(async (req, res) => {
    const key = await getSecret(req.user!.orgId, 'anthropic');
    if (!key) throw badRequest('No Anthropic API key is configured');
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    try {
      await new Anthropic({ apiKey: key, maxRetries: 0 }).models.list({ limit: 1 });
      res.json({ ok: true });
    } catch (err: any) {
      res.json({ ok: false, status: err?.status ?? null, message: err?.status === 401 ? 'The key was rejected (401).' : 'Could not reach the Anthropic API.' });
    }
  }),
);

// ---- Team -------------------------------------------------------------------------------------------
const mapUser = (u: any) => ({ id: u.id, email: u.email, name: u.name, role: u.role, joinedAt: new Date(u.created_at).toISOString(), linked: !!u.clerk_id });

team.get(
  '/',
  wrap(async (req, res) => {
    const { rows } = await getDb().query('SELECT id, email, name, role, clerk_id, created_at FROM users WHERE org_id=$1 ORDER BY created_at', [req.user!.orgId]);
    res.json(rows.map(mapUser));
  }),
);

team.post(
  '/invite',
  requireRole('admin'),
  wrap(async (req, res) => {
    const b = z.object({ email: z.string().email().max(200), name: z.string().min(1).max(100).optional(), role: z.enum(['admin', 'user', 'viewer']).default('user') }).parse(req.body);
    const email = b.email.toLowerCase();
    const dupe = await getDb().query('SELECT 1 FROM users WHERE lower(email)=$1', [email]);
    if (dupe.rowCount) throw conflict('A user with that email already exists');
    const { rows } = await getDb().query(
      'INSERT INTO users (org_id, email, name, role) VALUES ($1,$2,$3,$4) RETURNING id, email, name, role, clerk_id, created_at',
      [req.user!.orgId, email, b.name ?? email.split('@')[0], b.role],
    );
    res.status(201).json(mapUser(rows[0]));
  }),
);

async function adminCount(orgId: string): Promise<number> {
  return (await getDb().query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM users WHERE org_id=$1 AND role='admin'`, [orgId])).rows[0].n;
}

team.patch(
  '/:id',
  requireRole('admin'),
  wrap(async (req, res) => {
    const id = uuidParam(req);
    const { role } = z.object({ role: z.enum(['admin', 'user', 'viewer']) }).parse(req.body);
    const org = req.user!.orgId;
    const target = (await getDb().query('SELECT id, role FROM users WHERE id=$1 AND org_id=$2', [id, org])).rows[0];
    if (!target) throw notFound('User not found');
    if (target.role === 'admin' && role !== 'admin' && (await adminCount(org)) <= 1) throw conflict('An organization must keep at least one admin');
    const { rows } = await getDb().query('UPDATE users SET role=$3 WHERE id=$1 AND org_id=$2 RETURNING id, email, name, role, clerk_id, created_at', [id, org, role]);
    res.json(mapUser(rows[0]));
  }),
);

team.delete(
  '/:id',
  requireRole('admin'),
  wrap(async (req, res) => {
    const id = uuidParam(req);
    const org = req.user!.orgId;
    if (id === req.user!.id) throw forbidden('You cannot remove yourself');
    const r = await getDb().query('DELETE FROM users WHERE id=$1 AND org_id=$2', [id, org]);
    if (r.rowCount === 0) throw notFound('User not found');
    res.status(204).end();
  }),
);
