import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { listFonts, readFamily } from '../src/services/fonts';

const trirong = path.resolve(__dirname, '..', '..', 'fonts', 'Trirong-Medium.ttf');
let dir = '';
const was = config.fontsDir;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fonts-'));
  await fs.copyFile(trirong, path.join(dir, 'Trirong-Medium.ttf'));
  await fs.writeFile(path.join(dir, 'notes.txt'), 'not a font');
  await fs.writeFile(path.join(dir, 'broken.ttf'), 'not really a font');
  config.fontsDir = dir;
});
afterAll(async () => {
  config.fontsDir = was;
  await fs.rm(dir, { recursive: true, force: true });
});

describe('caption fonts', () => {
  it('reads the family name ffmpeg matches on from a font file', async () => {
    expect(readFamily(await fs.readFile(trirong))).toBe('Trirong Medium');
    expect(readFamily(Buffer.from('garbage'))).toBeNull();
  });

  it('lists the fonts in the team folder and ignores files that are not fonts', async () => {
    const list = await listFonts(path.join(dir, 'missing'));
    expect(list.map((f) => f.family)).toEqual(['Trirong Medium']);
    expect(list[0].source).toBe('team');
  });
});
