import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { setDb } from '../src/ctx';
import { createDb, type Db } from '../src/db';
import { migrate } from '../src/db/migrations';
import { seedDemo } from '../src/db/seed';

let db: Db;
let server: http.Server;
let base = '';
const tokens: Record<string, string> = {};

async function call(method: string, path: string, opts: { as: string; body?: unknown }) {
  const res = await fetch(base + '/api' + path, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens[opts.as]}` },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt '), Buffer.alloc(200, 7)]);

/** Stand-ins: ElevenLabs (voices, speech, dialogue) and Higgsfield (upload-url only). */
const el = { server: null as http.Server | null, url: '', seen: [] as { method: string; url: string; key: string | undefined; body: any }[], reject: false };
const hf = { server: null as http.Server | null, url: '', puts: [] as { url: string; bytes: number; type: string | null; head?: string }[] };
const realFetch = globalThis.fetch;
const claude = { server: null as http.Server | null, replies: [] as string[], requests: [] as any[] };

beforeAll(async () => {
  el.server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      const body = raw ? JSON.parse(raw) : null;
      el.seen.push({ method: req.method!, url: req.url!, key: req.headers['xi-api-key'] as string | undefined, body });
      const json = (code: number, obj: unknown) => (res.writeHead(code, { 'content-type': 'application/json' }), res.end(JSON.stringify(obj)));
      if (el.reject || String(req.headers['xi-api-key']).startsWith('bad-key')) return json(401, { detail: { status: 'invalid_api_key', message: 'Invalid API key' } });
      if (req.method === 'GET' && req.url!.startsWith('/v2/voices')) {
        if (req.url!.includes('next_page_token=PAGE2')) return json(200, { voices: [{ voice_id: 'premade00000001', name: 'Adam', category: 'premade', preview_url: 'https://p.test/adam.mp3' }], has_more: false });
        return json(200, {
          voices: [
            { voice_id: 'marcusvoice0001', name: 'Marcus', category: 'cloned', description: 'Deep, calm', labels: { gender: 'male' }, preview_url: 'https://p.test/marcus.mp3' },
            { voice_id: 'nyavoice0000001', name: 'Nya', category: 'professional', labels: {} },
            { bogus: true },
          ],
          has_more: true,
          next_page_token: 'PAGE2',
        });
      }
      if (req.method === 'POST' && (req.url!.startsWith('/v1/text-to-speech/') || req.url!.startsWith('/v1/text-to-dialogue'))) {
        res.writeHead(200, { 'content-type': 'audio/wav' });
        return res.end(WAV);
      }
      json(404, { detail: 'not found' });
    });
  });
  await new Promise<void>((r) => el.server!.listen(0, '127.0.0.1', r));
  el.url = `http://127.0.0.1:${(el.server!.address() as AddressInfo).port}`;
  process.env.ELEVENLABS_API_BASE = el.url;

  claude.server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      claude.requests.push(JSON.parse(Buffer.concat(chunks).toString() || '{}'));
      const text = claude.replies.shift() ?? '[]';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg_t', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 400, output_tokens: 60 } }));
    });
  });
  await new Promise<void>((r) => claude.server!.listen(0, '127.0.0.1', r));
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(claude.server!.address() as AddressInfo).port}`;

  hf.server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url === '/files/generate-upload-url') return res.end(JSON.stringify({ public_url: 'https://cdn.test/in/line-1.wav', upload_url: 'https://upload.test/put/line-1', upload_headers: { 'x-amz-meta': 'ok' } }));
      res.end('{}');
    });
  });
  await new Promise<void>((r) => hf.server!.listen(0, '127.0.0.1', r));
  hf.url = `http://127.0.0.1:${(hf.server!.address() as AddressInfo).port}`;

  // The real upload code only PUTs to https addresses; intercept just that host and let everything else through.
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url ?? String(input);
    if (url.startsWith('https://upload.test/')) {
      hf.puts.push({ url, bytes: init?.body?.byteLength ?? 0, type: init?.headers?.['Content-Type'] ?? null, head: init?.body ? Buffer.from(init.body.subarray(0, 4)).toString() : undefined });
      return new Response(null, { status: 200 });
    }
    return realFetch(input, init);
  });

  db = await createDb({ memory: true });
  setDb(db);
  await migrate(db);
  await seedDemo(db);
  server = http.createServer(createApp());
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const users = (await (await realFetch(base + '/api/dev/users')).json()) as { role: string; token: string }[];
  for (const u of users) tokens[u.role] = u.token;
}, 60_000);

afterAll(async () => {
  vi.restoreAllMocks();
  delete process.env.ELEVENLABS_API_BASE;
  delete process.env.ANTHROPIC_BASE_URL;
  claude.server?.close();
  server.close();
  el.server?.close();
  hf.server?.close();
  await db.close();
});
afterEach(() => {
  claude.requests.length = 0;
  el.seen.length = 0;
  hf.puts.length = 0;
});

describe('ElevenLabs voices', () => {
  it('is off until a key is saved, and says how to turn it on', async () => {
    expect((await call('GET', '/studio/voices', { as: 'viewer' })).json).toEqual({ connected: false, voices: [] });
    const r = await call('POST', '/studio/speech', { as: 'user', body: { voiceId: 'marcusvoice0001', text: 'Hello.' } });
    expect(r.status).toBe(400);
    expect(r.json.error.message).toMatch(/ElevenLabs API key/);
    expect((await call('PUT', '/settings/secrets/elevenlabs', { as: 'user', body: { value: 'sk_test_voicekey_1234' } })).status).toBe(403); // admins only
    const saved = await call('PUT', '/settings/secrets/elevenlabs', { as: 'admin', body: { value: 'sk_test_voicekey_1234' } });
    expect(saved.status).toBe(200);
    expect(saved.json).toMatchObject({ name: 'elevenlabs', configured: true, last4: '1234' });
  });

  it('lists your voices across pages, custom voices first, skipping malformed entries', async () => {
    const r = await call('GET', '/studio/voices', { as: 'viewer' });
    expect(r.status).toBe(200);
    expect(r.json.connected).toBe(true);
    expect(r.json.voices.map((v: any) => v.name)).toEqual(['Marcus', 'Nya', 'Adam']); // cloned/professional before premade
    expect(r.json.voices[0]).toMatchObject({ id: 'marcusvoice0001', category: 'cloned', previewUrl: 'https://p.test/marcus.mp3', labels: { gender: 'male' } });
    expect(el.seen.map((s) => s.url)).toEqual(['/v2/voices', '/v2/voices?next_page_token=PAGE2']);
    expect(el.seen.every((s) => s.key === 'sk_test_voicekey_1234')).toBe(true); // sent as xi-api-key
  });

  it('turns an error from ElevenLabs into a clear message that never contains the key', async () => {
    await call('PUT', '/settings/secrets/elevenlabs', { as: 'admin', body: { value: 'bad-key-12345' } });
    const r = await call('GET', '/studio/voices', { as: 'viewer' });
    expect(r.status).toBe(401);
    expect(r.json.error.message).toMatch(/Invalid API key.*check it in Settings/);
    expect(JSON.stringify(r.json)).not.toContain('bad-key-12345');
    await call('PUT', '/settings/secrets/elevenlabs', { as: 'admin', body: { value: 'sk_test_voicekey_1234' } });
  });
});

describe('speaking a line', () => {
  it('needs Higgsfield to be connected, because the audio is hosted there', async () => {
    const r = await call('POST', '/studio/speech', { as: 'user', body: { voiceId: 'marcusvoice0001', text: 'Hello.' } });
    expect(r.status).toBe(400);
    expect(r.json.error.message).toMatch(/Connect Higgsfield/);
    expect(el.seen).toHaveLength(0); // no ElevenLabs credits spent when it can't be used
    await call('PUT', '/settings/secrets/higgsfield', { as: 'admin', body: { value: 'keyid:keysecret' } });
    await call('PUT', '/settings/higgsfield', { as: 'admin', body: { baseUrl: hf.url } });
  });

  it('speaks one line as WAV and hosts it on Higgsfield', async () => {
    const r = await call('POST', '/studio/speech', { as: 'user', body: { voiceId: 'marcusvoice0001', text: 'I told you not to come here.', autoTags: false } });
    expect(r.status).toBe(201);
    expect(r.json).toEqual({ url: 'https://cdn.test/in/line-1.wav', bytes: WAV.length, format: 'wav_24000', model: 'eleven_v4', speakers: 1, spokenText: 'I told you not to come here.', autoTags: { enabled: false, linesTagged: 0 } });
    expect(el.seen[0]).toMatchObject({ method: 'POST', url: '/v1/text-to-speech/marcusvoice0001?output_format=wav_24000', body: { text: 'I told you not to come here.', model_id: 'eleven_v4' } });
    expect(hf.puts).toMatchObject([{ url: 'https://upload.test/put/line-1', bytes: WAV.length, type: 'audio/wav' }]);
  });

  it('speaks a multi-voice scene in one request', async () => {
    const r = await call('POST', '/studio/speech', {
      as: 'user',
      body: { format: 'wav_22050', autoTags: false, lines: [{ voiceId: 'marcusvoice0001', text: '[calm] You came.' }, { voiceId: 'nyavoice0000001', text: '[nervous] I had to.' }, { voiceId: 'marcusvoice0001', text: 'Sit.' }] },
    });
    expect(r.status).toBe(201);
    expect(r.json.speakers).toBe(2);
    expect(el.seen[0].url).toBe('/v1/text-to-dialogue?output_format=wav_22050');
    expect(el.seen[0].body).toEqual({ inputs: [{ text: '[calm] You came.', voice_id: 'marcusvoice0001' }, { text: '[nervous] I had to.', voice_id: 'nyavoice0000001' }, { text: 'Sit.', voice_id: 'marcusvoice0001' }], model_id: 'eleven_v4' });
  });

  it('validates input before spending anything', async () => {
    const bad = async (body: unknown) => (await call('POST', '/studio/speech', { as: 'user', body })).status;
    expect(await bad({})).toBe(400);
    expect(await bad({ voiceId: 'marcusvoice0001' })).toBe(400); // no text
    expect(await bad({ voiceId: '../etc/passwd', text: 'x' })).toBe(400); // not a voice id
    expect(await bad({ voiceId: 'marcusvoice0001', text: 'x', format: 'mp3_44100_128' })).toBe(400); // Higgsfield takes WAV
    expect(await bad({ voiceId: 'marcusvoice0001', text: 'x'.repeat(2001) })).toBe(400);
    expect(await bad({ lines: [{ voiceId: 'marcusvoice0001', text: 'x'.repeat(1500) }, { voiceId: 'nyavoice0000001', text: 'y'.repeat(600) }] })).toBe(400); // over ~2,000 characters in total
    expect((await call('POST', '/studio/speech', { as: 'viewer', body: { voiceId: 'marcusvoice0001', text: 'Hi' } })).status).toBe(403);
    expect(el.seen).toHaveLength(0);
  });
});

describe('auto tags for Eleven v4', () => {
  const speech = (body: Record<string, unknown>) => call('POST', '/studio/speech', { as: 'user', body: { voiceId: 'marcusvoice0001', ...body } });

  it('only ever adds tags: the word check ignores tags and spacing but nothing else', async () => {
    const { sameWords, stripTags } = await import('../src/services/voiceTags');
    expect(stripTags('[whispers] I told you  [sighs] not to come here.')).toBe('I told you not to come here.');
    expect(sameWords('I told you not to come here.', '[low, steady voice] I told you not to come here. [exhales]')).toBe(true);
    expect(sameWords('I told you not to come here.', 'I told you never to come here.')).toBe(false); // a word changed
    expect(sameWords('I told you not to come here.', 'I told you not to come here!')).toBe(false); // punctuation changed
    expect(sameWords('Wait.', '[curious] Wait?')).toBe(false);
  });

  it('is skipped, with a reason, when there is no Claude key, and the line is still spoken as written', async () => {
    const r = await speech({ text: 'I told you not to come here.' });
    expect(r.status).toBe(201);
    expect(r.json.spokenText).toBe('I told you not to come here.');
    expect(r.json.autoTags).toMatchObject({ enabled: true, linesTagged: 0, note: expect.stringMatching(/no Anthropic/) });
    expect(claude.requests).toHaveLength(0);
  });

  it('adds tags matched to the voice, shows them in a dry run, and spends nothing on ElevenLabs', async () => {
    await call('PUT', '/settings/secrets/anthropic', { as: 'admin', body: { value: 'sk-ant-test-key-12345678' } });
    claude.replies.push(JSON.stringify(['[low, steady voice] I told you not to come here.']));
    const r = await speech({ text: 'I told you not to come here.', dryRun: true });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ dryRun: true, model: 'eleven_v4', spokenText: '[low, steady voice] I told you not to come here.', autoTags: { enabled: true, linesTagged: 1 } });
    // Claude was told who is speaking and what the voice is like
    const sent = JSON.parse(claude.requests[0].messages[0].content);
    expect(sent).toEqual([{ speaker: 'Marcus', voice: 'Deep, calm', text: 'I told you not to come here.' }]);
    expect(claude.requests[0].model).toBe('claude-haiku-5-5');
    expect(claude.requests[0].system).toMatch(/NEVER change/);
    // only the voice list was fetched from ElevenLabs: no speech was generated, nothing uploaded
    expect(el.seen.map((x) => x.url)).toEqual(['/v2/voices', '/v2/voices?next_page_token=PAGE2']);
    expect(hf.puts).toHaveLength(0);
  });

  it('speaks the tagged text on Eleven v4, and bills the tagging to Claude usage', async () => {
    const before = (await db.query(`SELECT COUNT(*)::int AS n FROM usage_events WHERE provider='claude' AND model='claude-haiku-5-5'`)).rows[0].n;
    claude.replies.push(JSON.stringify(['[firmly] I told you not to come here.']));
    const r = await speech({ text: 'I told you not to come here.' });
    expect(r.status).toBe(201);
    expect(r.json.spokenText).toBe('[firmly] I told you not to come here.');
    const tts = el.seen.find((x) => x.url.startsWith('/v1/text-to-speech/'))!;
    expect(tts.body).toEqual({ text: '[firmly] I told you not to come here.', model_id: 'eleven_v4' });
    expect((await db.query(`SELECT COUNT(*)::int AS n FROM usage_events WHERE provider='claude' AND model='claude-haiku-5-5'`)).rows[0].n).toBe(before + 1);
  });

  it('keeps a line exactly as written when the suggested tags changed its words', async () => {
    claude.replies.push(JSON.stringify(['[angry] I told you NEVER to come here.']));
    const r = await speech({ text: 'I told you not to come here.', dryRun: true });
    expect(r.json.spokenText).toBe('I told you not to come here.');
    expect(r.json.autoTags).toMatchObject({ linesTagged: 0, note: expect.stringMatching(/kept as written/) });
  });

  it('tags a whole scene in one call, per speaker, and ignores a reply that does not match the script', async () => {
    claude.replies.push(JSON.stringify(['[calm] You came.', '[nervous] I had to.']));
    const scene = { lines: [{ voiceId: 'marcusvoice0001', text: 'You came.' }, { voiceId: 'nyavoice0000001', text: 'I had to.' }] };
    const r = await call('POST', '/studio/speech', { as: 'user', body: { ...scene, dryRun: true } });
    expect(r.json.spokenLines).toEqual([{ voiceId: 'marcusvoice0001', text: '[calm] You came.' }, { voiceId: 'nyavoice0000001', text: '[nervous] I had to.' }]);
    expect(JSON.parse(claude.requests[0].messages[0].content).map((l: any) => l.speaker)).toEqual(['Marcus', 'Nya']);
    claude.replies.push(JSON.stringify(['only one line back']));
    const bad = await call('POST', '/studio/speech', { as: 'user', body: { ...scene, dryRun: true } });
    expect(bad.json.spokenLines.map((l: any) => l.text)).toEqual(['You came.', 'I had to.']);
    expect(bad.json.autoTags.note).toMatch(/did not match/);
  });

  it('can be switched off', async () => {
    const r = await speech({ text: 'Plain.', dryRun: true, autoTags: false });
    expect(r.json).toMatchObject({ spokenText: 'Plain.', autoTags: { enabled: false, linesTagged: 0 } });
    expect(claude.requests).toHaveLength(0);
  });
});

describe('uploading audio files (MP3, M4A... are converted to WAV)', () => {
  const upload = async (body: Uint8Array, type: string) => {
    const res = await realFetch(base + '/api/studio/uploads?filename=line.' + type.split('/')[1], { method: 'POST', headers: { 'content-type': type, authorization: `Bearer ${tokens.user}` }, body });
    return { status: res.status, json: await res.json() };
  };
  const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
  const makeMp3 = async () => {
    const { execFileSync } = await import('node:child_process');
    return new Uint8Array(execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-f', 'mp3', 'pipe:1'], { maxBuffer: 5_000_000 }));
  };
  let haveFfmpeg = true;
  beforeAll(async () => {
    try {
      await makeMp3();
    } catch {
      haveFfmpeg = false;
    }
  });

  it('converts an MP3 to WAV before hosting it on Higgsfield', async (ctx) => {
    if (!haveFfmpeg) return ctx.skip();
    const mp3 = await makeMp3();
    expect([...mp3.subarray(0, 3)]).not.toEqual([0x52, 0x49, 0x46]); // really not a WAV to begin with
    const r = await upload(mp3, 'audio/mpeg');
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ kind: 'audio', url: 'https://cdn.test/in/line-1.wav' });
    expect(hf.puts).toHaveLength(1);
    expect(hf.puts[0].type).toBe('audio/wav');
    expect(hf.puts[0].head).toBe('RIFF'); // what Higgsfield received is a WAV
    expect(hf.puts[0].bytes).toBeGreaterThan(80_000); // about 1 second of 44.1 kHz mono 16-bit
  });

  it('still takes WAV files as they are', async () => {
    const r = await upload(new Uint8Array(WAV), 'audio/wav');
    expect(r.status).toBe(201);
    expect(hf.puts[0].bytes).toBe(WAV.length); // not re-encoded
  });

  it('refuses a file that is not really audio, with a plain message', async (ctx) => {
    if (!haveFfmpeg) return ctx.skip();
    const r = await upload(new Uint8Array(Buffer.from('this is definitely not audio '.repeat(50))), 'audio/mpeg');
    expect(r.status).toBe(400);
    expect(r.json.error.message).toMatch(/could not be read as audio/);
    expect(hf.puts).toHaveLength(0);
  });

  it('says so plainly when ffmpeg is not installed', async () => {
    const saved = process.env.FFMPEG_PATH;
    process.env.FFMPEG_PATH = 'definitely-not-ffmpeg-xyz';
    try {
      const r = await upload(new Uint8Array(Buffer.alloc(500, 1)), 'audio/mp4');
      expect(r.status).toBe(400);
      expect(r.json.error).toMatchObject({ code: 'ffmpeg_missing' });
      expect(r.json.error.message).toMatch(/Upload a WAV file instead/);
    } finally {
      if (saved === undefined) delete process.env.FFMPEG_PATH;
      else process.env.FFMPEG_PATH = saved;
    }
  });

  it('still rejects types it cannot use', async () => {
    const r = await upload(new Uint8Array(10), 'application/pdf');
    expect(r.status).toBeGreaterThanOrEqual(400);
  });
});
