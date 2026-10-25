import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config';
import { hostedMedia, readLocalCopy, refreshExpiredMedia, saveLocalCopy } from '../src/services/mediaStore';

const realFetch = globalThis.fetch;
const cfg = { baseUrl: 'http://hf.test', key: 'id:secret' };
const puts: { url: string; bytes: number; type: string | null }[] = [];
let dir = '';
const wasCopies = config.localCopies;
const wasDir = config.filesDir;
const wasPattern = hostedMedia.pattern;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'media-store-'));
  config.localCopies = true;
  config.filesDir = dir;
  hostedMedia.pattern = /^https:\/\/files\.test\//;
  let n = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url ?? String(input);
    if (url.startsWith('https://files.test/')) return new Response(null, { status: url.includes('/gone') ? 403 : 200 });
    if (url === 'http://hf.test/files/generate-upload-url') {
      n++;
      return new Response(JSON.stringify({ public_url: `https://files.test/fresh-${n}.png`, upload_url: `https://upload.test/put/${n}`, upload_headers: {} }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.startsWith('https://upload.test/')) {
      puts.push({ url, bytes: init?.body?.byteLength ?? 0, type: init?.headers?.['Content-Type'] ?? null });
      return new Response(null, { status: 200 });
    }
    return realFetch(input, init);
  });
});
afterAll(async () => {
  vi.restoreAllMocks();
  config.localCopies = wasCopies;
  config.filesDir = wasDir;
  hostedMedia.pattern = wasPattern;
  await fs.rm(dir, { recursive: true, force: true });
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

describe('local copies of Higgsfield media', () => {
  it('saves a file by its link and reads it back with its type', async () => {
    await saveLocalCopy('https://files.test/a.png', PNG, 'image/png');
    expect(await readLocalCopy('https://files.test/a.png')).toEqual({ data: PNG, contentType: 'image/png' });
    expect(await readLocalCopy('https://files.test/never-saved.png')).toBeNull();
  });

  it('leaves links that still work alone', async () => {
    const media = { reference: ['https://files.test/ok.png'] };
    const r = await refreshExpiredMedia(cfg, media);
    expect(r).toEqual({ media, rehosted: 0 });
    expect(puts).toHaveLength(0);
  });

  it('re-uploads an expired file from the saved copy and swaps the link, keeping the other links', async () => {
    await saveLocalCopy('https://files.test/gone-1.png', PNG, 'image/png');
    const r = await refreshExpiredMedia(cfg, { reference: ['https://files.test/ok.png', 'https://files.test/gone-1.png'], audio: ['https://elsewhere.test/voice.wav'] });
    expect(r.rehosted).toBe(1);
    expect(r.media).toEqual({ reference: ['https://files.test/ok.png', 'https://files.test/fresh-1.png'], audio: ['https://elsewhere.test/voice.wav'] });
    expect(puts).toEqual([{ url: 'https://upload.test/put/1', bytes: PNG.length, type: 'image/png' }]);
    // the new link has its own saved copy, so it can be recovered again next time
    expect(await readLocalCopy('https://files.test/fresh-1.png')).toMatchObject({ contentType: 'image/png' });
  });

  it('stops with a plain message, before anything is sent, when an expired file was never saved', async () => {
    puts.length = 0;
    await expect(refreshExpiredMedia(cfg, { reference: ['https://files.test/gone-2.png'] })).rejects.toThrow(/expired at Higgsfield and no saved copy exists.*nothing was charged.*gone-2\.png/);
    expect(puts).toHaveLength(0);
  });
});
