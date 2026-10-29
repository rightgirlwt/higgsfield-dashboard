import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { authenticate, requireRole, writesRequireUser } from './auth';
import { config } from './config';
import { getDb } from './ctx';
import { errorMiddleware, HttpError, wrap } from './lib/errors';
import { MODELS } from './lib/pricing';
import { dashboard } from './routes/dashboard';
import { exporter } from './routes/export';
import { media } from './routes/media';
import { monitoring } from './routes/monitoring';
import { projects } from './routes/projects';
import { prompts } from './routes/prompts';
import { runs } from './routes/runs';
import { search } from './routes/search';
import { settings, team } from './routes/settings';
import { studio } from './routes/studio';
import { workflows } from './routes/workflows';
import { edit } from './routes/edit';
import { resultPath } from './services/effects';
import { attachWorkspace, listWorkspaces } from './services/workspaces';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(
    cors((req, cb) => {
      const origin = req.headers.origin;
      // No Origin header: curl / server-to-server. Same-origin: the page is served from this very host
      // (browsers still send Origin on same-origin POSTs, e.g. behind the dev proxy or a reverse proxy).
      const sameOrigin = !!origin && (() => { try { return new URL(origin).host === req.headers.host; } catch { return false; } })();
      if (!origin || sameOrigin || config.clientOrigins.includes(origin)) return cb(null, { origin: true });
      cb(new HttpError(403, 'Origin not allowed', 'cors'));
    }),
  );
  app.use(express.json({ limit: '1mb' }));

  const api = express.Router();
  if (!config.isTest) api.use(rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: true, legacyHeaders: false }));

  // ---- public ----------------------------------------------------------------------------------
  api.get(
    '/health',
    wrap(async (_req, res) => {
      await getDb().query('SELECT 1');
      res.json({ status: 'ok', service: 'higgsfield-dashboard-backend', db: getDb().kind, auth: config.authProvider, time: new Date().toISOString() });
    }),
  );
  if (config.authProvider === 'dev' && !config.isProd) {
    // Lets the login screen list the seeded accounts. Never mounted in production.
    api.get(
      '/dev/users',
      wrap(async (_req, res) => {
        const { rows } = await getDb().query('SELECT id, email, name, role FROM users ORDER BY role, name');
        res.json(rows.map((u) => ({ ...u, token: `dev:${u.id}` })));
      }),
    );
  }

  // Finished edits are played by the browser's video player, which cannot send a login header. Each file is named
  // by a random id that cannot be guessed. Supports seeking (Range requests).
  api.get('/edit/files/:name', (req, res, next) => {
    const file = resultPath(req.params.name);
    if (!file) return next(new HttpError(404, 'Not found', 'not_found'));
    res.sendFile(file, (err) => err && !res.headersSent && next(new HttpError(404, 'Not found', 'not_found')));
  });

  // ---- authenticated ---------------------------------------------------------------------------
  api.use(authenticate, writesRequireUser, attachWorkspace);
  api.get('/me', (req, res) => res.json({ ...req.user, authProvider: config.authProvider }));
  api.get(
    '/workspaces',
    wrap(async (req, res) => {
      res.json({ workspaces: await listWorkspaces(req.user!.orgId), current: req.workspace!.id });
    }),
  );
  api.get('/models', (_req, res) => res.json(MODELS));

  const runLimiter = config.isTest ? (_q: any, _r: any, n: any) => n() : rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false });
  api.use('/prompts/run', runLimiter);
  api.use('/prompts/compare', runLimiter);
  api.use('/studio/generate', runLimiter);
  api.use(/^\/projects\/[^/]+\/(chat|generate)$/, runLimiter);
  api.use(/^\/workflows\/[^/]+\/run$/, runLimiter);

  api.use('/dashboard', dashboard);
  api.use('/prompts', prompts);
  api.use('/workflows', workflows);
  api.use('/runs', runs);
  api.use('/media', media);
  api.use('/studio', studio);
  api.use('/edit', edit);
  api.use('/projects', projects);
  api.use('/monitoring', monitoring);
  api.use('/settings', settings);
  api.use('/team', team);
  api.use('/export', exporter);
  api.use('/search', search);
  api.use((_req, _res, next) => next(new HttpError(404, 'Not found', 'not_found')));

  app.use('/api', api);
  app.use(errorMiddleware);
  return app;
}

export { requireRole };
