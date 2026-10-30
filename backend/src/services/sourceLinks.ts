import crypto from 'node:crypto';

/**
 * The browser's video player cannot send a login header, so playing an uploaded source video uses a link that
 * proves itself: signed with a secret that only this server process knows, and good for two hours.
 * (The link stops working when the server restarts; the page asks for a fresh one each time it opens.)
 */
const secret = crypto.randomBytes(32);
const TTL_MS = 2 * 60 * 60_000;

const sign = (id: string, exp: number) => crypto.createHmac('sha256', secret).update(`${id}.${exp}`).digest('hex');

export function signSourceLink(id: string, now = Date.now()): string {
  const exp = now + TTL_MS;
  return `/api/edit/source/${id}?exp=${exp}&sig=${sign(id, exp)}`;
}

export function sourceLinkValid(id: string, exp: unknown, sig: unknown, now = Date.now()): boolean {
  const e = Number(exp);
  if (!Number.isFinite(e) || e < now || typeof sig !== 'string') return false;
  const want = Buffer.from(sign(id, e));
  const got = Buffer.from(sig);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}
