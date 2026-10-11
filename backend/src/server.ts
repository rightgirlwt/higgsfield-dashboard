import http from 'node:http';
import { createApp } from './app';
import { assertProductionConfig, config } from './config';
import { setDb } from './ctx';
import { createDb } from './db';
import { migrate } from './db/migrations';
import { seedDemo } from './db/seed';
import { logger } from './logger';
import { attachRealtime } from './realtime';
import { recoverInterruptedRuns } from './services/jobs';
import { startMonitoringBroadcast, stopMonitoringBroadcast } from './services/monitoring';
import { startScheduler, stopScheduler } from './services/scheduler';

async function main() {
  assertProductionConfig();
  const db = await createDb();
  setDb(db);
  await migrate(db);
  if (config.seedDemo && config.authProvider === 'dev') await seedDemo(db);
  const recovered = await recoverInterruptedRuns();
  if (recovered) logger.warn('marked interrupted runs as failed', { count: recovered });

  const server = http.createServer(createApp());
  attachRealtime(server);
  startMonitoringBroadcast();
  startScheduler();

  server.listen(config.port, () => logger.info(`Higgsfield dashboard API listening on http://localhost:${config.port}`, { db: db.kind, auth: config.authProvider }));

  const shutdown = async (signal: string) => {
    logger.info(`${signal} received, shutting down`);
    stopMonitoringBroadcast();
    stopScheduler();
    server.close();
    await db.close().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
