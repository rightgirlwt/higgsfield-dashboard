import type { Server } from 'socket.io';
import type { Db } from './db';

/** Process-wide handles, set once at boot (or per test). Keeps services free of constructor plumbing. */
const state: { db: Db | null; io: Server | null } = { db: null, io: null };

export function setDb(db: Db): void {
  state.db = db;
}
export function getDb(): Db {
  if (!state.db) throw new Error('Database not initialised');
  return state.db;
}
export function setIo(io: Server | null): void {
  state.io = io;
}

/** Broadcast to every socket in an organisation's room. No-op when sockets are not attached (tests). */
export function emitToOrg(orgId: string, event: string, payload: unknown): void {
  state.io?.to(`org:${orgId}`).emit(event, payload);
}

export function connectedOrgIds(): string[] {
  const rooms = state.io?.sockets.adapter.rooms;
  if (!rooms) return [];
  return [...rooms.keys()].filter((k) => k.startsWith('org:')).map((k) => k.slice(4));
}
