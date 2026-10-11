import type http from 'node:http';
import { Server } from 'socket.io';
import { resolveToken } from './auth';
import { config } from './config';
import { setIo } from './ctx';
import { logger } from './logger';
import { snapshot } from './services/monitoring';

/** Socket.IO with the same auth as the REST API; each socket joins its organisation's room only. */
export function attachRealtime(server: http.Server): Server {
  const io = new Server(server, { cors: { origin: config.clientOrigins } });

  io.use(async (socket, next) => {
    try {
      const token = typeof socket.handshake.auth?.token === 'string' ? socket.handshake.auth.token : '';
      if (!token) return next(new Error('unauthorized'));
      socket.data.user = await resolveToken(token);
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', async (socket) => {
    const user = socket.data.user as { orgId: string; id: string };
    await socket.join(`org:${user.orgId}`);
    logger.debug('socket connected', { user: user.id });
    try {
      socket.emit('monitoring:update', await snapshot(user.orgId));
    } catch (err) {
      logger.warn('initial snapshot failed', { err: String(err) });
    }
  });

  setIo(io);
  return io;
}
