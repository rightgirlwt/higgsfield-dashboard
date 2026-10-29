import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config';

/** Fonts that can be used for captions: the ones that came with the effects skill, plus any the team drops into the project's fonts folder. */

export interface FontInfo {
  family: string;
  file: string;
  /** 'team' for the project's fonts folder, 'skill' for the ones bundled with the effects skill */
  source: 'team' | 'skill';
}

/** The family name stored in a font file, read from its "name" table. */
export function readFamily(buf: Buffer): string | null {
  try {
    const tag = buf.toString('latin1', 0, 4);
    if (tag === 'ttcf') return null; // font collections are not supported
    const tables = buf.readUInt16BE(4);
    let nameOffset = -1;
    for (let i = 0; i < tables; i++) {
      const rec = 12 + i * 16;
      if (buf.toString('latin1', rec, rec + 4) === 'name') nameOffset = buf.readUInt32BE(rec + 8);
    }
    if (nameOffset < 0) return null;
    const count = buf.readUInt16BE(nameOffset + 2);
    const strings = nameOffset + buf.readUInt16BE(nameOffset + 4);
    const found: Record<number, string> = {};
    const windows = new Set<number>();
    for (let i = 0; i < count; i++) {
      const r = nameOffset + 6 + i * 12;
      const platform = buf.readUInt16BE(r);
      const id = buf.readUInt16BE(r + 6);
      if (id !== 1 && id !== 16) continue;
      const len = buf.readUInt16BE(r + 8);
      const start = strings + buf.readUInt16BE(r + 10);
      if (platform === 3 || platform === 0) {
        // The Windows names win: UTF-16, big endian
        found[id] = Buffer.from(buf.subarray(start, start + len)).swap16().toString('utf16le');
        windows.add(id);
      } else if (platform === 1 && !windows.has(id) && !found[id]) {
        found[id] = buf.toString('latin1', start, start + len);
      }
    }
    // ffmpeg's subtitle renderer matches on the file's own family name (e.g. "Trirong Medium"), not the wider family
    return (found[1] ?? found[16])?.trim() || null;
  } catch {
    return null;
  }
}

async function scan(dir: string, source: FontInfo['source']): Promise<FontInfo[]> {
  let names: string[] = [];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: FontInfo[] = [];
  for (const n of names.filter((x) => /\.(ttf|otf)$/i.test(x))) {
    const file = path.join(dir, n);
    const family = readFamily(await fs.readFile(file));
    if (family) out.push({ family, file, source });
  }
  return out;
}

/** One entry per family, team fonts first so they win over a skill font with the same name. Sorted by name. */
export async function listFonts(skillFontsDir: string): Promise<FontInfo[]> {
  const all = [...(await scan(config.fontsDir, 'team')), ...(await scan(skillFontsDir, 'skill'))];
  const seen = new Set<string>();
  return all
    .filter((f) => (seen.has(f.family.toLowerCase()) ? false : (seen.add(f.family.toLowerCase()), true)))
    .sort((a, b) => a.family.localeCompare(b.family));
}
